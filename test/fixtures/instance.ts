/**
 * One "service instance" for the cluster test. The test starts three of these at once with the same
 * jobs and the same backend, like three copies of one app.
 */
import { Scheduler } from '../../src';
import { makeBackend, type Spec } from '../helpers';

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
  await scheduler.stop();
  log({ type: 'stopped' });
})().catch((error: unknown) => {
  log({ type: 'fatal', error: String(error) });
  process.exit(1);
});
