/* Copyright (C) 2026-present Aristotelis — see repository license. */

/**
 * For the debugger: one run from the timer to the history record, slowly enough to follow.
 *
 * In VS Code pick "Example: walkthrough (step through one run)" in Run and Debug and press F5. It
 * pauses on the `debugger` line below. From there use F11 (step into) to enter the library, or set
 * breakpoints on the methods listed here and press F5 to jump from one to the next.
 *
 * The flow of one run, with the file under src/scheduler/ each step lives in:
 *
 *   scheduler.ts      start()            connects (backend.init), then for each job: schedule()
 *   timers.ts         arm()              computes the next run time and sets a timer for it, plus a random jitter
 *   lease-runner.ts   recover()          on start: takes over dead runs, catches up a missed run
 *   scheduler.ts      fire()             the timer fired: the run is due
 *   lease-runner.ts   run()              asks the backend for the run; exactly one instance gets 'won'
 *                       the claim        src/backends/sql/base.ts claimRun(), or the CLAIM script in src/backends/redis/lease.ts
 *                       'won'            -> executeLeased()
 *                       'running'        -> watch(): this instance is now a backup of that run
 *   lease-runner.ts   executeLeased()    starts the heartbeat that renews the lease, then execute()
 *   executor.ts       execute()          emits 'start', calls your handler, then stores the result (finish, saveResult)
 *   lease-runner.ts   watch()            a backup's timer: every 1 to 2 heartbeats it calls run(..., 'takeover')
 *   scheduler.ts      stop()             doStop(): aborts ctx.signal, waits for running jobs, closes the backend
 *
 * Two instances (A and B) run in this process, so you see both sides of one claim: the winner in
 * executeLeased() and the other one in watch(). `this.core.instanceId` tells you which one you are in.
 *
 * Pausing in a debugger stops the clock for the process but not for the store, so the timings here
 * are long on purpose: a 10 minute lease and lateness limit, so a run is not lost or skipped while
 * you read. No jitter on A, a fixed one on B, so A always wins.
 *
 *   npx tsx examples/walkthrough.ts     # without a debugger it just prints the same flow
 */
import { type JobContext, Scheduler } from '../src';
import { backendFromEnv, say, sleep } from './shared';

const PATIENT = { leaseMs: 10 * 60_000, heartbeatMs: 60_000, maxLateMs: 10 * 60_000 };

async function main() {
  const [a, b] = ['A', 'B'].map((id) => new Scheduler({ backend: backendFromEnv('walkthrough'), instanceId: id, ...PATIENT })) as [
    Scheduler,
    Scheduler,
  ];
  let runs = 0;

  for (const scheduler of [a, b]) {
    scheduler.every(
      'job',
      '10s',
      async (ctx: JobContext) => {
        // A breakpoint here stops inside your job. The call stack shows execute() <- executeLeased() <- run() <- fire().
        say(
          `${ctx.instanceId}: the job runs (scheduled ${ctx.scheduledAt.toISOString().slice(11, 19)}, attempt ${ctx.attempt}, ${ctx.reason})`,
        );
        await sleep(500);
        runs++;
      },
      { jitterMs: scheduler === a ? 0 : 400, catchUpMs: 0 },
    );
    scheduler.on('start', (e) => say(`${e.instanceId}: event 'start'`));
    scheduler.on('success', (r) => say(`${r.instanceId}: event 'success' after ${r.durationMs} ms`));
    scheduler.on('skip', (e) => say(`${e.instanceId}: event 'skip' (${e.reason}): it is now the backup of that run`));
    scheduler.on('error', (e) => say(`error: ${String(e.error)}`));
  }

  // biome-ignore lint/suspicious/noDebugger: the starting point of the walkthrough; does nothing without a debugger
  debugger;
  await a.start(); // F11 here: start() -> ensureReady() -> schedule() -> arm(), recover()
  await b.start();
  say(`both started on ${a.backend.name}; the next run is at ${a.nextRun('job')?.toISOString().slice(11, 19)}`);

  while (runs < 2) await sleep(100);
  console.table(
    (await b.history('job', 5)).map((r) => ({
      scheduled: r.scheduledAt.toISOString().slice(11, 19),
      by: r.instanceId,
      attempt: r.attempt,
      status: r.status,
      ms: r.durationMs ?? '-',
    })),
  );
  await Promise.all([a.stop(), b.stop()]); // F11 here: stop() -> doStop()
  say('stopped');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
