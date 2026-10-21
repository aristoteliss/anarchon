/* Copyright (C) 2026-present Aristotelis — see repository license. */

import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';

import {
  type Backend,
  NatsBackend,
  PostgresBackend,
  RabbitMQBackend,
  RedisBackend,
  Scheduler,
  type SchedulerOptions,
  SqliteBackend,
  ValkeyBackend,
} from '../../src';

const memoryBackend = (): Backend => ({
  name: 'memory',
  dedupeWindowMs: Infinity,
  runs: undefined,
  init: async () => {},
  prepareJob: async () => {},
  claim: async () => true,
  recordManualRun: async () => undefined,
  saveResult: async () => {},
  history: async () => [],
  close: async () => {},
});

/** Options as they arrive from configuration or JavaScript: not checked by the compiler. */
const loose = <T = never>(options: object) => options as T;

afterEach(() => {
  Scheduler.reset();
});

test('a misspelled scheduler or configure() option is refused, with the name it was probably meant to be', () => {
  assert.throws(
    () =>
      new Scheduler(
        loose<SchedulerOptions>({ backend: memoryBackend(), timeZone: 'UTC' }),
      ),
    /new Scheduler\(\): unknown option "timeZone" \(did you mean "timezone"\?\)/,
  );
  assert.throws(
    () =>
      Scheduler.configure(loose({ backend: memoryBackend(), autostart: true })),
    /unknown option "autostart" \(did you mean "autoStart"\?\)/,
  );
});

test('a misspelled or misplaced job option is refused, for every kind of job', () => {
  const scheduler = new Scheduler({ backend: memoryBackend() });
  assert.throws(
    () => scheduler.every('a', '1m', () => {}, loose({ timeoutMS: 1_000 })),
    /Job "a": unknown option "timeoutMS" \(did you mean "timeoutMs"\?\)/,
  );
  assert.throws(
    () =>
      scheduler.cron('b', '0 * * * *', () => {}, loose({ offsetMs: 1_000 })),
    /Job "b": unknown option "offsetMs"/,
  );
  assert.throws(
    () =>
      scheduler.at(
        'c',
        new Date(Date.now() + 60_000),
        () => {},
        loose({ timezone: 'UTC' }),
      ),
    /Job "c": unknown option "timezone"/,
  );
  assert.deepEqual(scheduler.jobs(), []);
});

test('register(), runNow() and stop() refuse options they do not have', async () => {
  const scheduler = new Scheduler({ backend: memoryBackend() });
  assert.throws(
    () => scheduler.register({}, loose({ prefx: 'a:' })),
    /register\(\): unknown option "prefx" \(did you mean "prefix"\?\)/,
  );
  assert.throws(
    () => scheduler.register({}, loose({ defaults: { offsetMs: 1 } })),
    /register\(\) defaults: unknown option "offsetMs"/,
  );
  scheduler.every('a', '1h', () => {});
  await scheduler.start();
  await assert.rejects(
    scheduler.runNow('a', loose({ dat: {} })),
    /runNow\(\): unknown option "dat" \(did you mean "data"\?\)/,
  );
  assert.throws(
    () => scheduler.stop(loose({ timeout: 1 })),
    /stop\(\): unknown option "timeout" \(did you mean "timeoutMs"\?\)/,
  );
  await scheduler.stop();
});

test('every backend refuses options it does not have, so a setting is never silently dropped', () => {
  assert.throws(
    () => new RedisBackend(loose({ prefx: 'a:' })),
    /RedisBackend: unknown option "prefx" \(did you mean "prefix"\?\)/,
  );
  assert.throws(
    () => new ValkeyBackend(loose({ redis: 'redis://localhost' })),
    /ValkeyBackend: unknown option "redis" \(did you mean "valkey"\?\)/,
  );
  assert.throws(
    () => new PostgresBackend(loose({ connectionString: 'postgres://x' })),
    /PostgresBackend: unknown option "connectionString" \(did you mean "connection"\?\)/,
  );
  assert.throws(
    () => new SqliteBackend(loose({ file: './x.db' })),
    /SqliteBackend: unknown option "file"/,
  );
  assert.throws(
    () => new RabbitMQBackend(loose({ uri: 'amqp://x' })),
    /RabbitMQBackend: unknown option "uri" \(did you mean "url"\?\)/,
  );
  assert.throws(
    () => new NatsBackend(loose({ server: 'nats://x' })),
    /NatsBackend: unknown option "server" \(did you mean "servers"\?\)/,
  );
});

test('Redis connection options refuse what they do not support, such as tls (use a rediss:// URL)', () => {
  assert.throws(
    () => new RedisBackend({ redis: loose({ host: 'cache', tls: true }) }),
    /redis: unknown option "tls".*rediss:\/\//,
  );
  assert.throws(
    () => new ValkeyBackend({ valkey: loose({ hots: 'cache' }) }),
    /valkey: unknown option "hots" \(did you mean "host"\?\)/,
  );
  new RedisBackend({
    redis: { host: 'cache', port: 6379, username: 'u', password: 'p', db: 1 },
  });
});
