/* Copyright (C) 2026-present Aristotelis — see repository license. */

/**
 * NATS with the 'lease' strategy, in real processes that are stopped and killed for real. Needs a
 * NATS server with JetStream (nats-server 2.10 or newer) and the `@nats-io/kv` package.
 *
 *   docker compose -f test/docker-compose.test.yml --profile brokers up -d nats   # or your own
 *   npx tsx examples/nats-leases.ts                    # NATS at nats://localhost:4222
 *   NATS_URL=nats://nats.internal:4222 npx tsx examples/nats-leases.ts
 *
 * Three processes share one job that runs every 10 s and takes 4 s:
 * 1. Rolling deploy: the runner gets SIGTERM mid-run. It hands the run over on stop(), and another
 *    process starts the same run again as attempt 2 within two heartbeats.
 * 2. Crash: the next runner gets SIGKILL. Nothing is handed over: once its lease runs out on the
 *    NATS server's clock, another process takes the run over as attempt 2.
 * 3. Downtime: every process is killed while a run falls due. A new process with the default
 *    `catchUpMs` (5 min) runs it when it starts (reason 'catch-up').
 *
 * It takes about 40 s and ends with the job's history. Each run of the example uses a job of its
 * own, so what an earlier run left in the bucket doesn't show up.
 */
import { type ChildProcess, spawn } from 'node:child_process';

import { NatsBackend, type RunRecord, Scheduler } from '../src';
import { say, sleep, work } from './shared';

const NATS_URL = process.env.NATS_URL ?? 'nats://localhost:4222';
const INTERVAL_MS = 10_000;
const JOB_MS = 4_000;
/** Short, so the takeover is quick to watch. The defaults are 30 s and 5 s. */
const LEASE = { leaseMs: 2_000, heartbeatMs: 500 };

type InstanceEvent = {
  type: 'start' | 'success';
  instance: string;
  attempt: number;
  reason?: string;
  history?: RunRecord[];
};

type Waiter = {
  matches: (event: InstanceEvent) => boolean;
  resolve: (event: InstanceEvent) => void;
};

/** One instance of the service: a process of its own, reporting to the parent over IPC. */
async function runInstance(name: string, job: string, catchUp: boolean) {
  const scheduler = new Scheduler({
    backend: new NatsBackend({
      servers: NATS_URL,
      strategy: 'lease',
      stream: 'EXAMPLES',
      prefix: 'examples.',
    }),
    instanceId: name,
    ...LEASE,
  });

  // The job stops when ctx.signal aborts, so a stopped runner hands its run over.
  scheduler.every(
    job,
    INTERVAL_MS,
    (ctx) => work(ctx.signal, JOB_MS),
    catchUp ? {} : { catchUpMs: 0 },
  );

  scheduler.on('start', ({ attempt, reason }) => {
    process.send?.({ type: 'start', instance: name, attempt, reason });
  });
  scheduler.on('success', async ({ attempt, reason }) => {
    const history = await scheduler.history(job, 10);
    process.send?.({
      type: 'success',
      instance: name,
      attempt,
      reason,
      history,
    });
  });

  process.on('SIGTERM', async () => {
    await scheduler.stop();
    process.exit(0);
  });

  await scheduler.start();
}

async function main() {
  const job = `report-${Date.now().toString(36)}`;
  const instances = new Map<string, ChildProcess>();
  const waiting: Waiter[] = [];

  function startInstance(name: string, catchUp: boolean) {
    const mode = catchUp ? 'catch-up' : 'no-catch-up';
    const args = ['--import', 'tsx', __filename, name, job, mode];
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });

    child.on('message', (event: InstanceEvent) => {
      say(
        `${event.instance}: ${event.type} (attempt ${event.attempt}, ${event.reason})`,
      );
      const index = waiting.findIndex((waiter) => waiter.matches(event));
      if (index >= 0) waiting.splice(index, 1)[0]?.resolve(event);
    });

    instances.set(name, child);
  }

  const waitFor = (matches: (event: InstanceEvent) => boolean) =>
    new Promise<InstanceEvent>((resolve) => waiting.push({ matches, resolve }));
  const started = (reason: string) => (event: InstanceEvent) =>
    event.type === 'start' && event.reason === reason;
  const finished = (event: InstanceEvent) => event.type === 'success';

  process.on('exit', () => {
    for (const child of instances.values()) child.kill('SIGKILL');
  });

  // No catch-up for the first three, so their first run is a scheduled one.
  for (const name of ['A', 'B', 'C']) startInstance(name, false);

  const first = await waitFor(started('scheduled'));
  await sleep(1_000);
  say(`--- SIGTERM ${first.instance} mid-run: it hands the run over`);
  instances.get(first.instance)?.kill('SIGTERM');
  await waitFor(started('takeover'));
  await waitFor(finished);

  const second = await waitFor(started('scheduled'));
  await sleep(1_000);
  say(
    `--- SIGKILL ${second.instance} mid-run: a backup waits for its lease to run out`,
  );
  instances.get(second.instance)?.kill('SIGKILL');
  await waitFor(started('takeover'));
  await waitFor(finished);

  say('--- SIGKILL every instance; the next run falls due while none is up');
  for (const child of instances.values()) child.kill('SIGKILL');
  await sleep(INTERVAL_MS);
  startInstance('D', true);

  const caughtUp = await waitFor(
    (event) => finished(event) && event.instance === 'D',
  );
  console.table(
    caughtUp.history?.map((run) => ({
      scheduled: new Date(run.slot).toISOString().slice(11, 19),
      by: run.instanceId,
      attempt: run.attempt,
      reason: run.reason,
      status: run.status,
    })),
  );

  process.exit(0);
}

const [instanceName, jobName, catchUp] = process.argv.slice(2);
const program =
  instanceName && jobName
    ? runInstance(instanceName, jobName, catchUp === 'catch-up')
    : main();

program.catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
