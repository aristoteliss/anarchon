/* Copyright (C) 2026-present Aristotelis — see repository license. */

import assert from 'node:assert/strict';
import { beforeEach, test } from 'vitest';

import { type Backend, type JobContext, Scheduler } from '../../src';

const memoryBackend = (): Backend => ({
  name: 'memory',
  dedupeWindowMs: Infinity,
  init: async () => {},
  prepareJob: async () => {},
  claim: async () => true,
  recordManualRun: async () => undefined,
  saveResult: async () => {},
  history: async () => [],
  close: async () => {},
});

beforeEach(() => {
  Scheduler.reset();
});

/** Starts the scheduler, runs what the test asks, and stops it. */
async function running(scheduler: Scheduler, body: () => Promise<void>): Promise<void> {
  await scheduler.start();
  try {
    await body();
  } finally {
    await scheduler.stop();
  }
}

test("ctx.data is the scheduler's data, with the job's on top and runNow()'s on top of both", async () => {
  interface Tenant {
    tenant: string;
    region: string;
    permission?: string;
    user?: number;
  }
  const seen: unknown[] = [];
  const scheduler = new Scheduler({ backend: memoryBackend(), data: { tenant: 'acme', region: 'eu' } });
  scheduler
    .every('export', '1h', (ctx: JobContext<Tenant>) => void seen.push(ctx.data), { data: { region: 'us', permission: 'export' } })
    .every('plain', '1h', (ctx) => void seen.push(ctx.data));

  await running(scheduler, async () => {
    await scheduler.runNow('export');
    await scheduler.runNow('plain');
    await scheduler.runNow('export', { data: { permission: 'admin', user: 7 } });
  });
  assert.deepEqual(seen, [
    { tenant: 'acme', region: 'us', permission: 'export' },
    { tenant: 'acme', region: 'eu' },
    { tenant: 'acme', region: 'us', permission: 'admin', user: 7 },
  ]);
});

test('without any data given, ctx.data is undefined', async () => {
  const seen: unknown[] = ['not called'];
  const scheduler = new Scheduler({ backend: memoryBackend() }).every('job', '1h', (ctx) => void seen.push(ctx.data));
  await running(scheduler, async () => void (await scheduler.runNow('job')));
  assert.deepEqual(seen, ['not called', undefined]);
});

test('a data function is called when each run starts, with the run, and may be async', async () => {
  let calls = 0;
  const seen: unknown[] = [];
  const scheduler = new Scheduler({
    backend: memoryBackend(),
    data: async (run) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { call: ++calls, job: run.name, manual: run.manual, attempt: run.attempt };
    },
  });
  scheduler.every('job', '1h', (ctx) => void seen.push(ctx.data), { data: (run) => ({ at: run.scheduledAt instanceof Date }) });

  await running(scheduler, async () => {
    await scheduler.runNow('job');
    await scheduler.runNow('job');
  });
  assert.deepEqual(seen, [
    { call: 1, job: 'job', manual: true, attempt: 1, at: true },
    { call: 2, job: 'job', manual: true, attempt: 1, at: true },
  ]);
});

test('a data function that throws fails the run, and one that is too slow times it out', async () => {
  let handled = 0;
  const scheduler = new Scheduler({ backend: memoryBackend() });
  scheduler
    .every('denied', '1h', () => void handled++, {
      data: () => {
        throw new Error('no permission for this job');
      },
    })
    .every('slow', '1h', () => void handled++, { timeoutMs: 20, data: () => new Promise((resolve) => setTimeout(resolve, 200)) });

  await running(scheduler, async () => {
    const denied = await scheduler.runNow('denied');
    assert.equal(denied.status, 'failed');
    assert.match(denied.error ?? '', /no permission for this job/);
    const slow = await scheduler.runNow('slow');
    assert.equal(slow.status, 'failed');
    assert.match(slow.error ?? '', /Timed out/);
  });
  assert.equal(handled, 0);
});

test("setData() replaces the scheduler's data for later runs, and a value that is not a plain object replaces", async () => {
  const seen: unknown[] = [];
  const scheduler = new Scheduler({ backend: memoryBackend(), data: 'everyone' });
  scheduler
    .every('plain', '1h', (ctx) => void seen.push(ctx.data))
    .every('own', '1h', (ctx) => void seen.push(ctx.data), {
      data: { role: 'admin' },
    });

  await running(scheduler, async () => {
    await scheduler.runNow('plain');
    await scheduler.runNow('own');
    scheduler.setData({ tenant: 'acme' });
    await scheduler.runNow('own');
    await scheduler.runNow('own', { data: 0 });
    scheduler.setData(undefined);
    await scheduler.runNow('plain');
  });
  assert.deepEqual(seen, ['everyone', { role: 'admin' }, { tenant: 'acme', role: 'admin' }, 0, undefined]);
});
