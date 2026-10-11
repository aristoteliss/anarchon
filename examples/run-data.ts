/* Copyright (C) 2026-present Aristotelis — see repository license. */

/**
 * Run data: what you give a scheduler or a job, which every run reads as `ctx.data`. It is
 * for what a handler can't take from its surroundings: the tenant it runs for, the permission it
 * runs with, a token that must be fresh.
 *
 *   npx tsx examples/run-data.ts
 *
 * The example shows where the data comes from, from the most general to the most specific:
 *
 *   1. the scheduler's `data`               for every job
 *   2. a job's `data`                       on top of it; two plain objects are merged
 *   3. a function instead of a value        called when each run starts, so the value is current
 *   4. `runNow(name, { data })`             for one manual run
 *
 * and `setData()`, which replaces the scheduler's data while it runs.
 */
import { type JobContext, Scheduler } from '../src';
import { backendFromEnv, say, sleep } from './shared';

interface Tenant {
  tenant: string;
  plan: string;
}

/** Stands for a call to an auth service: a token that is only valid for a short time. */
let issued = 0;
async function freshToken(job: string): Promise<string> {
  await sleep(20);
  return `${job}-token-${++issued}`;
}

async function main() {
  // 1. For every job of this scheduler.
  const scheduler = new Scheduler({
    backend: backendFromEnv('run_data'),
    data: { tenant: 'acme', plan: 'free' },
  });

  // No data of its own: it gets the scheduler's.
  scheduler.every('usage', '5s', (ctx: JobContext<Tenant>) => {
    say(`usage      for ${ctx.data.tenant} on the ${ctx.data.plan} plan`);
  });

  // 2. Its own keys go on top of the scheduler's: tenant and plan stay, permission is added.
  scheduler.every(
    'export',
    '5s',
    (ctx: JobContext<Tenant & { permission: string }>) => {
      say(`export     for ${ctx.data.tenant}, allowed to ${ctx.data.permission}`);
    },
    { data: { permission: 'reports:export' } },
  );

  // 3. A function is called when each run starts. It gets the run, and may be async. If it
  //    throws, the run fails with that error and the handler isn't called.
  scheduler.every(
    'sync',
    '5s',
    (ctx: JobContext<Tenant & { token: string; startedBy: string }>) => {
      say(`sync       with ${ctx.data.token}, started by ${ctx.data.startedBy}`);
    },
    { data: async (run) => ({ token: await freshToken(run.name), startedBy: run.manual ? 'an operator' : 'the schedule' }) },
  );

  await scheduler.start();
  say(`started on ${scheduler.backend.name}`);

  // 4. For this run only, on top of everything else: who asked for it.
  await scheduler.runNow('export', { data: { permission: 'admin', requestedBy: 'maria' } });
  await scheduler.runNow('sync');

  // The scheduler's data can be replaced while it runs: later runs see the new plan.
  setTimeout(() => {
    say('the tenant upgraded: setData({ plan: "pro" })');
    scheduler.setData({ tenant: 'acme', plan: 'pro' });
  }, 7_000);

  const shutdown = async () => {
    await scheduler.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
