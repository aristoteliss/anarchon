/* Copyright (C) 2026-present Aristotelis — see repository license. */

/**
 * Real processes, killed for real, and no server: they share one SQLite file.
 *
 *   npx tsx examples/crash-proof.ts
 *
 * 1. Crash: two processes run "report". The one running it is killed with SIGKILL mid-run, and
 *    the other takes that same run over (attempt 2, reason 'takeover') and finishes it.
 * 2. Downtime: every process is killed and the next run falls due while none is up. A new process
 *    with the default `catchUpMs` (5 min) runs it when it starts (reason 'catch-up').
 *
 * It takes 20 to 40 s and ends with the job's history.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type RunRecord, Scheduler, SqliteBackend } from '../src';
import { say, sleep } from './shared';

const INTERVAL_MS = 10_000;
const JOB_MS = 4_000;
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

async function runInstance(name: string, database: string, catchUp: boolean) {
  const scheduler = new Scheduler({
    backend: new SqliteBackend({ database }),
    instanceId: name,
    ...LEASE,
  });

  scheduler.every(
    'report',
    INTERVAL_MS,
    () => sleep(JOB_MS),
    catchUp ? {} : { catchUpMs: 0 },
  );

  scheduler.on('start', ({ attempt, reason }) => {
    process.send?.({ type: 'start', instance: name, attempt, reason });
  });

  scheduler.on('success', async ({ attempt, reason }) => {
    const history = await scheduler.history('report', 10);
    process.send?.({
      type: 'success',
      instance: name,
      attempt,
      reason,
      history,
    });
  });

  await scheduler.start();
}

async function main() {
  const database = join(tmpdir(), `anarchon-crash-proof-${process.pid}.db`);
  const instances = new Map<string, ChildProcess>();
  const waiting: Waiter[] = [];

  function startInstance(name: string, { catchUp }: { catchUp: boolean }) {
    const args = [
      '--import',
      'tsx',
      __filename,
      name,
      database,
      catchUp ? 'catch-up' : 'no-catch-up',
    ];
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

  function waitFor(matches: (event: InstanceEvent) => boolean) {
    return new Promise<InstanceEvent>((resolve) => {
      waiting.push({ matches, resolve });
    });
  }

  process.on('exit', () => {
    for (const child of instances.values()) child.kill('SIGKILL');
    rmSync(database, { force: true });
  });

  // A and B skip the catch-up of a run due just before they start, so their first run is a scheduled one.
  startInstance('A', { catchUp: false });
  startInstance('B', { catchUp: false });

  const firstRun = await waitFor((event) => event.type === 'start');
  await sleep(1_000);

  say(`--- SIGKILL ${firstRun.instance} mid-run`);
  instances.get(firstRun.instance)?.kill('SIGKILL');

  const takeover = await waitFor((event) => event.type === 'success');

  say('--- SIGKILL every instance; the next run falls due while none is up');
  instances.get(takeover.instance)?.kill('SIGKILL');
  await sleep(INTERVAL_MS);

  startInstance('C', { catchUp: true });

  const catchUpRun = await waitFor(
    (event) => event.type === 'success' && event.instance === 'C',
  );

  console.table(
    catchUpRun.history?.map((run) => ({
      scheduled: new Date(run.slot).toISOString().slice(11, 19),
      by: run.instanceId,
      attempt: run.attempt,
      reason: run.reason,
      status: run.status,
    })),
  );

  process.exit(0);
}

const [instanceName, database, catchUp] = process.argv.slice(2);
const program =
  instanceName && database
    ? runInstance(instanceName, database, catchUp === 'catch-up')
    : main();

program.catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
