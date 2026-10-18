/* Copyright (C) 2026-present Aristotelis — see repository license. */

/**
 * A long nightly export that survives a deploy: the instance running it is stopped halfway, and
 * another instance continues the same run from where it was, not from the start.
 *
 *   npx tsx examples/nightly-export.ts                 # SQLite file in the temp folder
 *   BACKEND=redis npx tsx examples/nightly-export.ts   # see examples/shared.ts
 *
 * Needs a backend with leases (SQLite, PostgreSQL, Redis or Valkey 'lease'): that is what lets a
 * second instance take a run over.
 *
 * The approach, and why:
 *   ctx.signal          checked between pages: when the instance is stopped, the handler throws
 *                       there, so the run is handed over instead of counting as finished
 *   a checkpoint        the last page written, kept per run (`ctx.slot`) in the store the export
 *                       writes to; the next attempt reads it and resumes
 *   ctx.attempt         1 for the first try, 2 for the instance that took over
 *   timeoutMs           a run that hangs is cut off before the next night's run is due
 *   overlap (default)   'skip': if a night's export is still running, the next one doesn't start
 *   stop({ timeoutMs }) on deploy, running jobs get this long to stop before they are handed over
 *   leaseMs, heartbeatMs  short here so the takeover is quick to watch; the defaults are 30 s and 5 s
 *
 * Real life: `scheduler.cron('export-orders', '0 2 * * *', ...)`. Here the job runs every 30 s and
 * the first run is 2 s after start.
 */
import { type JobContext, Scheduler } from '../src';
import { backendFromEnv, say, sleep, work } from './shared';

const PAGES = 10;
/** Stands in for a table in the export's own database: the last page written, per run. */
const checkpoints = new Map<number, number>();

async function exportOrders(ctx: JobContext): Promise<void> {
  const from = checkpoints.get(ctx.slot) ?? 0;
  say(`${ctx.instanceId}: attempt ${ctx.attempt} (${ctx.reason}) starts at page ${from + 1}`);
  for (let page = from + 1; page <= PAGES; page++) {
    ctx.signal.throwIfAborted();
    await work(ctx.signal, 1_000); // fetch the page and write it; both take the signal
    checkpoints.set(ctx.slot, page);
    say(`${ctx.instanceId}: page ${page}/${PAGES} written`);
  }
}

async function main() {
  const startedAt = Date.now();
  const firstRunAt = startedAt + 2_000;
  const instance = (id: string) => {
    const scheduler = new Scheduler({ backend: backendFromEnv('export'), instanceId: id, leaseMs: 3_000, heartbeatMs: 500 });
    scheduler.every('export-orders', '30s', exportOrders, { offsetMs: firstRunAt % 30_000, timeoutMs: 25_000, catchUpMs: 0 });
    scheduler.on('interrupted', (run) => say(`${run.instanceId}: stopped mid-run, ${run.handedOver ? 'handed over' : 'not handed over'}`));
    return scheduler;
  };
  const [a, b] = [instance('worker-a'), instance('worker-b')];
  const instances = [a, b];

  let runner: Scheduler | undefined;
  for (const scheduler of instances) scheduler.on('start', () => (runner ??= scheduler));
  await Promise.all(instances.map((s) => s.start()));
  say('two workers up; the export starts in 2 s');

  while ((checkpoints.values().next().value ?? 0) < 4) await sleep(100);
  say(`deploy: ${runner?.instanceId} is stopped, with 1 s for its job to stop`);
  await runner?.stop({ timeoutMs: 1_000 });

  while ((checkpoints.values().next().value ?? 0) < PAGES) await sleep(100);
  const survivor = runner === a ? b : a;
  const history = (await survivor.history('export-orders', 10)).filter((run) => run.startedAt.getTime() >= startedAt).reverse();
  await survivor.stop();

  for (const run of history) {
    say(`  attempt ${run.attempt} on ${run.instanceId}: ${run.status} (${run.reason})`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
