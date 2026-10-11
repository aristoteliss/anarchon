/* Copyright (C) 2026-present Aristotelis — see repository license. */

/**
 * One "service instance" for the cluster test. The test starts three of these at once with the same
 * jobs and the same backend, like three copies of one app.
 */
import { Scheduler } from '../../../src';
import { makeBackend, type Spec } from '../../support';

const log = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(event)}\n`);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const spec = JSON.parse(process.env.SPEC ?? '{}') as Spec;
const scheduler = new Scheduler({ backend: makeBackend(spec), instanceId: process.env.INSTANCE_ID });

scheduler
  .every('every2s', '2s', () => sleep(50), { jitterMs: 400 })
  .cron('cron3s', '*/3 * * * * *', () => sleep(20), { jitterMs: 400 })
  .every(
    'failing',
    '2s',
    () => {
      throw new Error('boom');
    },
    { jitterMs: 400 },
  );

scheduler.on('start', (e) => log({ type: 'start', job: e.job, slot: e.slot, instanceId: e.instanceId }));
scheduler.on('failure', (r) => log({ type: 'failure', job: r.job, slot: r.slot, error: r.error }));
scheduler.on('error', (e) => log({ type: 'error', job: e.job, error: String(e.error) }));

(async () => {
  await scheduler.start();
  log({ type: 'ready' });
  await sleep(Number(process.env.RUN_MS ?? 8_000));
  // Stop between runs: every job is due on a whole second and starts up to 400 ms later. A run
  // claimed while stop() is aborting is recorded as interrupted, even when the job itself threw.
  await sleep((1_700 - (Date.now() % 1_000)) % 1_000);
  await scheduler.stop();
  log({ type: 'stopped' });
})().catch((error: unknown) => {
  log({ type: 'fatal', error: String(error) });
  process.exit(1);
});
