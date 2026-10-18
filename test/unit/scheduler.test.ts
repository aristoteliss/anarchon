/* Copyright (C) 2026-present Aristotelis — see repository license. */

import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';

import { type Backend, NatsBackend, RabbitMQBackend, RedisBackend, Scheduler, type SchedulerOptions, ValkeyBackend } from '../../src';

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

afterEach(() => {
  Scheduler.reset();
});

test('a scheduler needs a backend: none is assumed, and nothing connects to a store you did not name', () => {
  const without: Array<Partial<SchedulerOptions> | undefined> = [undefined, {}, { leaseMs: 10_000, timezone: 'UTC' }];
  for (const options of without) {
    assert.throws(
      () => new Scheduler(options as SchedulerOptions),
      (error: Error) => error instanceof TypeError && /backend/.test(error.message),
      `new Scheduler(${JSON.stringify(options)}) should need a backend`,
    );
  }

  assert.equal(new Scheduler({ backend: memoryBackend() }).backend.name, 'memory');
});

test('a one-off job takes no overlap', () => {
  const scheduler = new Scheduler({ backend: memoryBackend() });
  // @ts-expect-error a one-off job has no previous run to overlap
  assert.throws(() => scheduler.at('once', new Date(Date.now() + 60_000), () => {}, { overlap: 'allow' }), /one-off job takes no overlap/);
});

test('a backend without leases takes no lease options: they fail to compile and throw', () => {
  const noLeases = /needs a backend with leases.*rabbitmq has none/;
  // @ts-expect-error RabbitMQ has no leases
  assert.throws(() => new Scheduler({ backend: new RabbitMQBackend(), leaseMs: 10_000 }), noLeases);
  // @ts-expect-error RabbitMQ has no leases
  assert.throws(() => new Scheduler({ backend: new RabbitMQBackend(), heartbeatMs: 1_000 }), noLeases);

  const rabbit = new Scheduler({ backend: new RabbitMQBackend() });
  // @ts-expect-error no overlap without leases
  assert.throws(() => rabbit.every('a', '1m', () => {}, { overlap: 'allow' }), /Job "a": overlap needs a backend with leases/);
  // @ts-expect-error no retries without leases
  assert.throws(() => rabbit.cron('b', '0 * * * *', () => {}, { maxAttempts: 1 }), /Job "b": maxAttempts needs/);
  // @ts-expect-error no catch-up without leases
  assert.throws(() => rabbit.at('c', new Date(Date.now() + 60_000), () => {}, { catchUpMs: 0 }), /Job "c": catchUpMs needs/);
  rabbit.every('d', '1m', () => {}, { timeoutMs: 1_000 });

  const script = new Scheduler({ backend: new ValkeyBackend({ strategy: { name: 'script' } }) });
  // @ts-expect-error the 'script' strategy has no leases
  assert.throws(() => script.every('e', '1m', () => {}, { overlap: 'skip' }), /valkey:script has none/);
  // @ts-expect-error NATS has no leases
  assert.throws(() => new Scheduler({ backend: new NatsBackend(), leaseMs: 10_000 }), /nats has none/);
});

test('lease options stay available on a lease backend, and wherever the backend is not known', () => {
  const lease = new Scheduler({ backend: new RedisBackend(), leaseMs: 10_000, heartbeatMs: 1_000 });
  lease.every('a', '1m', () => {}, { overlap: 'allow', maxAttempts: 1, catchUpMs: 0 });
  new Scheduler({ backend: new ValkeyBackend({ strategy: 'lease' }), leaseMs: 10_000 }).every('b', '1m', () => {}, { overlap: 'allow' });

  const any: Backend = new RedisBackend();
  new Scheduler({ backend: any, leaseMs: 10_000 }).every('c', '1m', () => {}, { maxAttempts: 2 });
  const asDefault: Scheduler = new Scheduler({ backend: new RabbitMQBackend() });
  assert.equal(asDefault.backend.name, 'rabbitmq');
});
