/* Copyright (C) 2026-present Aristotelis — see repository license. */

/**
 * Every job option and every event, on one instance. Runs for 30 s, then prints what happened.
 *
 *   npx tsx examples/options-and-events.ts                 # SQLite file in the temp folder
 *   BACKEND=redis npx tsx examples/options-and-events.ts   # see examples/shared.ts
 *
 * Jobs:
 *   tick      every 5 s, the plain case
 *   slow      takes 8 s every 5 s, overlap 'skip' (the default): runs due meanwhile are skipped
 *   parallel  takes 8 s every 5 s, overlap 'allow': runs side by side
 *   stuck     never returns, timeoutMs 2 s: ctx.signal aborts and the run is recorded as failed
 *   flaky     throws half the time: 'failure' events, and the error in history
 *   digest    a cron expression in a time zone (every 10 s here, so it shows up)
 *   welcome   a one-off job, 3 s after start
 *   manual    never due on its own in this example: started with runNow()
 */
import { randomInt } from 'node:crypto';
import { type JobContext, Scheduler } from '../src';
import { backendFromEnv, say, sleep, work } from './shared';

const RUN_MS = 30_000;

async function main() {
  const scheduler = new Scheduler({
    backend: backendFromEnv('options'),
    instanceId: 'api-1',
    timezone: 'Europe/Athens',
    // Defaults for every job; each job can set its own
    jitterMs: 200,
    historySize: 200,
    historyTtlMs: 24 * 60 * 60_000,
    leaseMs: 6_000,
    heartbeatMs: 1_000,
  });

  addJobs(scheduler);
  const counts = countEvents(scheduler);

  await scheduler.start();
  say(`started on ${scheduler.backend.name}`);
  console.table(
    scheduler
      .jobs()
      .map((j) => ({ ...j, nextRunAt: j.nextRunAt?.toISOString() })),
  );

  await sleep(6_000);
  const record = await scheduler.runNow('manual');
  say(
    `runNow('manual'): ${record.status} in ${record.durationMs} ms, manual ${record.manual}`,
  );

  await sleep(6_000);
  say(`remove('parallel'): ${scheduler.remove('parallel')}; its history stays`);
  const next = scheduler.nextRun('tick')?.toISOString().slice(11, 19);
  const last = await scheduler.lastRun('flaky');
  say(`next "tick" at ${next}; last "flaky" was ${last?.status}`);

  await sleep(RUN_MS - 12_000);
  // "slow" is mid-run here: it throws on abort, so stop() records it as interrupted
  await scheduler.stop({ timeoutMs: 5_000 });
  say('stopped');
  console.table(counts);

  await printHistory('stuck');
}

/** One job per option worth seeing: overlap, timeout, retries, time zone, a one-off and a manual job. */
function addJobs(scheduler: Scheduler): void {
  scheduler.every('tick', '5s', (ctx: JobContext) => {
    // What a job gets: its scheduled time, which try this is, and why it runs
    say(
      `tick: scheduled ${ctx.scheduledAt.toISOString().slice(11, 19)}, attempt ${ctx.attempt}, reason ${ctx.reason}, on ${ctx.instanceId}`,
    );
  });

  scheduler
    .every('slow', '5s', (ctx) => work(ctx.signal, 8_000))
    .every('parallel', '5s', (ctx) => work(ctx.signal, 8_000), {
      overlap: 'allow',
    })
    .every('stuck', '10s', (ctx) => work(ctx.signal, 60_000), {
      timeoutMs: 2_000,
      overlap: 'allow',
    });

  scheduler.every(
    'flaky',
    '5s',
    () => {
      if (randomInt(2) === 0) throw new Error('upstream returned 503');
    },
    { maxLateMs: 3_000, maxAttempts: 2 },
  );

  scheduler
    .cron('digest', '*/10 * * * * *', () => sleep(100), {
      timezone: 'Europe/Athens',
    })
    .at('welcome', new Date(Date.now() + 3_000), () =>
      say('welcome: a one-off job, on one instance'),
    )
    .every('manual', '1h', () => sleep(300), { catchUpMs: 0 });
}

/** Counts every event per job, and says the ones worth reading as they happen. */
function countEvents(scheduler: Scheduler): Record<string, number> {
  const counts: Record<string, number> = {};
  const count = (event: string, job: string) => {
    counts[`${job} ${event}`] = (counts[`${job} ${event}`] ?? 0) + 1;
  };

  scheduler.on('start', (e) => count('start', e.job));
  scheduler.on('success', (r) => count('success', r.job));
  scheduler.on('failure', (r) => {
    count('failure', r.job);
    say(`${r.job} failed after ${r.durationMs} ms: ${r.error}`);
  });
  scheduler.on('skip', (e) => {
    count(`skip (${e.reason})`, e.job);
    if (e.reason === 'overlap') {
      say(
        `${e.job}: the ${e.scheduledAt.toISOString().slice(11, 19)} run is skipped, the previous one is still going`,
      );
    }
  });
  scheduler.on('interrupted', (r) => count('interrupted', r.job));
  scheduler.on('lost', (e) =>
    say(`${e.job}: attempt ${e.attempt} was taken over by a backup`),
  );
  scheduler.on('error', (e) => say(`backend error: ${String(e.error)}`));

  return counts;
}

/** Prints a job's latest runs, read from the store by a scheduler that has no jobs. */
async function printHistory(job: string): Promise<void> {
  // History is read from the store, so any process can ask, with or without the jobs registered
  const reader = new Scheduler({ backend: backendFromEnv('options') });
  const runs = await reader.history(job, 5);

  console.table(
    runs.map((r) => ({
      scheduled: r.scheduledAt.toISOString().slice(11, 19),
      by: r.instanceId,
      status: r.status,
      ms: r.durationMs ?? '-',
      error: r.error ?? '',
    })),
  );
  await reader.stop();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
