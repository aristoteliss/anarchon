/* Copyright (C) 2026-present Aristotelis — see repository license. */

/**
 * The demo recorded in assets/quick-start.gif: three processes share one SQLite file and one job,
 * and the process running the job is taken away twice.
 *
 *   npx tsx examples/quick-start.ts
 *
 * 1. Graceful stop: the runner gets SIGINT (Ctrl+C). It hands the run over, and another process
 *    starts the same run again as attempt 2 within two heartbeats.
 * 2. Crash: the next runner gets SIGKILL (kill -9). Nothing is handed over; another process starts
 *    the same run again as attempt 2 once the lease runs out.
 *
 * It takes about 23 s. The lease is 3 s so the takeover is quick to watch; the default is 30 s.
 * One SQLite file coordinates processes on one machine only: use Redis or PostgreSQL across machines.
 */
import { type ChildProcess, fork } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Scheduler, SqliteBackend } from '../src';

const INTERVAL_MS = 10_000;
const JOB_MS = 4_000;
const LEASE = { leaseMs: 3_000, heartbeatMs: 500 };
/** How long a run is left alone before its runner is stopped or killed. */
const MID_RUN_MS = 1_500;

type Report =
  | { type: 'start'; slot: number; attempt: number; reason: string }
  | { type: 'skip'; reason: string }
  | { type: 'interrupted'; handedOver: boolean }
  | { type: 'success'; durationMs: number }
  | { type: 'error'; message: string };

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One instance of the service: a scheduler with the job, reporting its events to the demo. */
async function instance(
  id: string,
  database: string,
  offsetMs: number,
): Promise<void> {
  const scheduler = new Scheduler({
    backend: new SqliteBackend({ database }),
    instanceId: id,
    ...LEASE,
  });

  scheduler.every(
    'report',
    INTERVAL_MS,
    async (ctx) => {
      for (let done = 0; done < JOB_MS; done += 250) {
        ctx.signal.throwIfAborted(); // a stopped run is handed over instead of counting as finished
        await sleep(250);
      }
    },
    // No catch-up of the run before start: the demo begins with the next scheduled run.
    { offsetMs, jitterMs: 300, catchUpMs: 0 },
  );
  forwardEvents(scheduler);

  process.on('SIGINT', async () => {
    await scheduler.stop();
    process.disconnect?.();
  });
  await scheduler.start();
}

/** Sends each event of an instance's scheduler to the demo process, which narrates it. */
function forwardEvents(scheduler: Scheduler): void {
  const report = (message: Report) => process.send?.(message);

  scheduler.on('start', (e) =>
    report({
      type: 'start',
      slot: e.slot,
      attempt: e.attempt,
      reason: e.reason,
    }),
  );
  scheduler.on('skip', (e) => report({ type: 'skip', reason: e.reason }));
  scheduler.on('interrupted', (r) =>
    report({ type: 'interrupted', handedOver: r.handedOver }),
  );
  scheduler.on('success', (r) =>
    report({ type: 'success', durationMs: r.durationMs ?? 0 }),
  );
  scheduler.on('error', (e) =>
    report({ type: 'error', message: String(e.error) }),
  );
}

const seconds = (ms: number) => `${ms / 1000}s`;
const at = (slot: number) =>
  `\x1b[33m${new Date(slot).toISOString().slice(11, 19)}\x1b[0m`;
const name = (id: string) => `\x1b[1m${id}\x1b[0m`;

/** The two faults the demo injects: a graceful stop of the first run, then a crash of the next one. */
interface Faults {
  graceful?: { slot: number };
  crash?: { slot: number; killedAt: number; takenOverBy?: string };
}

/** Stops the first runner gracefully mid-run, and kills the runner of the next new run. */
function injectFault(
  faults: Faults,
  children: Map<string, ChildProcess>,
  id: string,
  slot: number,
): void {
  if (!faults.graceful) {
    faults.graceful = { slot };
    setTimeout(() => {
      console.log(
        `\n\x1b[35m⚡ Graceful stop: Ctrl+C (SIGINT) on ${id}...\x1b[0m`,
      );
      children.get(id)?.kill('SIGINT');
    }, MID_RUN_MS);
    return;
  }

  if (faults.crash || slot === faults.graceful.slot) return;
  const crash = { slot, killedAt: 0 };
  faults.crash = crash;
  setTimeout(() => {
    console.log(
      `\n\x1b[35m⚡ Crash: kill -9 (SIGKILL) on ${id}, waiting for the ${seconds(LEASE.leaseMs)} lease...\x1b[0m`,
    );
    crash.killedAt = Date.now();
    children.get(id)?.kill('SIGKILL');
  }, MID_RUN_MS);
}

/** Says which instance won a run, and how long after the kill a takeover came; injects the faults. */
function narrateStart(
  id: string,
  message: Extract<Report, { type: 'start' }>,
  faults: Faults,
  children: Map<string, ChildProcess>,
): void {
  const { crash } = faults;
  const takeover =
    crash?.slot === message.slot && message.attempt > 1 && crash.killedAt;
  const after = takeover
    ? ` \x1b[35m${((Date.now() - takeover) / 1000).toFixed(1)}s after the kill\x1b[0m`
    : '';

  if (message.attempt === 1) console.log('');
  console.log(
    `  \x1b[32m✔\x1b[0m ${name(id)} won lease (slot ${at(message.slot)}, attempt ${message.attempt}, ${message.reason})${after}`,
  );

  if (takeover && crash) crash.takenOverBy = id;
  if (message.attempt === 1) injectFault(faults, children, id, message.slot);
}

/** Starts the three instances, stops one runner gracefully and kills the next, and narrates what they report. */
async function demo(): Promise<void> {
  const database = join(tmpdir(), `anarchon-quick-start-${process.pid}.db`);
  // Every process computes the same grid; this shift puts the first run 2.5 s from now.
  const offsetMs = (Date.now() + 2_500) % INTERVAL_MS;

  console.log(
    `\x1b[1;36m▶ 3 processes, one SQLite file. Lease ${seconds(LEASE.leaseMs)}, heartbeat ${seconds(LEASE.heartbeatMs)} (defaults: 30s, 5s)\x1b[0m`,
  );

  const children = new Map<string, ChildProcess>();
  const faults: Faults = {};

  const finish = async () => {
    for (const child of children.values()) {
      child.kill('SIGINT');
    }
    await sleep(1_000);
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(database + suffix, { force: true });
    }
    process.exit(0);
  };

  const onReport = (id: string, message: Report) => {
    switch (message.type) {
      case 'start':
        return narrateStart(id, message, faults, children);

      case 'skip': {
        const run =
          message.reason === 'taken'
            ? 'taken by another instance'
            : message.reason;
        return console.log(`  \x1b[90m- ${id} skipped (run ${run})\x1b[0m`);
      }

      case 'interrupted': {
        const note = message.handedOver ? ' \x1b[33m(handed over)\x1b[0m' : '';
        return console.log(
          `  \x1b[31m✖\x1b[0m ${name(id)} interrupted mid-run${note}`,
        );
      }

      case 'success':
        console.log(
          `  \x1b[32m✔\x1b[0m ${name(id)} finished successfully in ${message.durationMs}ms`,
        );
        if (faults.crash?.takenOverBy === id) void finish();
        return;

      case 'error':
        return console.log(
          `  \x1b[31merror on ${id}: ${message.message}\x1b[0m`,
        );
    }
  };

  for (const id of ['node-1', 'node-2', 'node-3']) {
    const child = fork(
      __filename,
      ['instance', id, database, String(offsetMs)],
      {
        // The built-in SQLite prints an ExperimentalWarning in every process.
        execArgv: [
          ...process.execArgv,
          '--disable-warning=ExperimentalWarning',
        ],
      },
    );
    child.on('message', (message) => onReport(id, message as Report));
    child.on('exit', () => children.delete(id));
    children.set(id, child);
  }

  process.on('SIGINT', () => void finish());
}

const [role, id, database, offsetMs] = process.argv.slice(2);
const main =
  role === 'instance' && id && database
    ? instance(id, database, Number(offsetMs))
    : demo();
main.catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
