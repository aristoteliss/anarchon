/* Copyright (C) 2026-present Aristotelis — see repository license. */

/**
 * Failover, in one process and with no server: three instances share one job, and the instance
 * running it is taken away twice.
 *
 *   npx tsx examples/failover.ts                 # SQLite file in the temp folder
 *   BACKEND=redis npx tsx examples/failover.ts   # see examples/shared.ts
 *
 * 1. Rolling deploy: the runner is stopped mid-run. The job throws when ctx.signal aborts, so the
 *    run is handed over and another instance starts attempt 2 within two heartbeats.
 * 2. Crash: the runner stops renewing its lease without giving the run up (here: a job that ignores
 *    ctx.signal, stopped with a short timeout). A backup takes over once the lease runs out.
 *
 * It takes about 40 s and ends with the history of the job.
 */
import { type JobContext, Scheduler } from '../src';
import { backendFromEnv, say, sleep, work } from './shared';

const INTERVAL_MS = 10_000;
const JOB_MS = 5_000;
/** Short, so the takeover is quick to watch. The defaults are 30 s and 5 s. */
const LEASE = { leaseMs: 3_000, heartbeatMs: 500 };

async function main() {
  const instances = new Map(
    ['A', 'B', 'C'].map((id) => [id, new Scheduler({ backend: backendFromEnv('failover'), instanceId: id, ...LEASE })]),
  );
  let ignoreSignal = false;
  let running: { by: string; slot: number } | undefined;

  for (const scheduler of instances.values()) {
    scheduler.every(
      'report',
      INTERVAL_MS,
      async (ctx: JobContext) => {
        running = { by: ctx.instanceId, slot: ctx.slot };
        if (ignoreSignal && ctx.attempt === 1) await sleep(JOB_MS);
        else await work(ctx.signal, JOB_MS);
      },
      // No catch-up of the run before start: the example begins with the next scheduled run.
      { jitterMs: 300, catchUpMs: 0 },
    );
    scheduler.on('start', (e) => say(`${e.instanceId} started the ${at(e.slot)} run (attempt ${e.attempt}, ${e.reason})`));
    scheduler.on('success', (r) => say(`${r.instanceId} finished it in ${r.durationMs} ms`));
    scheduler.on('interrupted', (r) => say(`${r.instanceId} was interrupted${r.handedOver ? ' and handed the run over' : ''}`));
    scheduler.on('skip', (e) => say(`${e.instanceId} skipped the ${at(e.slot)} run (${e.reason})`));
    scheduler.on('error', (e) => say(`error: ${String(e.error)}`));
  }
  await Promise.all([...instances.values()].map((s) => s.start()));
  say(`3 instances on ${instances.get('A')?.backend.name}; "report" runs every ${INTERVAL_MS / 1000} s and takes ${JOB_MS / 1000} s`);

  const nextRunner = async (after?: number) => {
    while (!running || running.slot === after) await sleep(50);
    return running;
  };

  const first = await nextRunner();
  await sleep(1_500);
  say(`--- stopping ${first.by} mid-run, like a rolling deploy`);
  await instances.get(first.by)?.stop();

  ignoreSignal = true;
  const second = await nextRunner(first.slot);
  await sleep(1_500);
  say(`--- ${second.by} stops renewing its lease, like a crash; a backup needs up to ${LEASE.leaseMs + 2 * LEASE.heartbeatMs} ms`);
  await instances.get(second.by)?.stop({ timeoutMs: 100 });

  await sleep(LEASE.leaseMs + JOB_MS + 2_000);
  const survivor = [...instances.entries()].find(([id]) => id !== first.by && id !== second.by)?.[1];
  if (!survivor) throw new Error('the same instance ran both runs; run the example again');
  console.table(
    (await survivor.history('report', 10)).map((r) => ({
      scheduled: at(r.slot),
      by: r.instanceId,
      attempt: r.attempt,
      reason: r.reason,
      status: r.status,
      ms: r.durationMs ?? '-',
    })),
  );
  await survivor.stop();
}

const at = (slot: number) => new Date(slot).toISOString().slice(11, 19);

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
