/* Copyright (C) 2026-present Aristotelis — see repository license. */

/** What is specific to Redis and Valkey: server versions, client libraries and strategy limits. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { GlideClient, Logger as GlideLogger } from '@valkey/valkey-glide';
import IoValkey from 'iovalkey';
import { createClient } from 'redis';
import { describe, test } from 'vitest';

import { type Backend, type KeyValueStrategyName, RedisBackend, ValkeyBackend } from '../../src';
import { probeRedis, REDIS_OLD_URL, REDIS_URL, supportsIdmp, uniqueId, VALKEY_URL } from '../support';

// GLIDE logs every server error (expected here: losers' XADDs are refused) to stdout.
GlideLogger.setLoggerConfig('off');

const futureSlot = (seconds: number) => Math.ceil(Date.now() / 1000) * 1000 + seconds * 1000;
const input = (slot: number, instanceId: string, token = randomUUID()) => ({ job: 'job', slot, token, instanceId, historySize: 1000 });

async function race(backends: Backend[], runs = 40): Promise<void> {
  await Promise.all(backends.map((b) => b.init()));
  await Promise.all(backends.map((b) => b.prepareJob('job', 1000)));
  const base = futureSlot(60);
  for (let i = 0; i < runs; i++) {
    const slot = base + i * 1000;
    const wins = await Promise.all(backends.map((b, n) => b.claim(input(slot, `i${n}`))));
    assert.equal(wins.filter(Boolean).length, 1, `run ${i}: exactly one winner, got ${JSON.stringify(wins)}`);
  }
}

describe('Redis / Valkey specifics', () => {
  test('idmp refuses Valkey and Redis older than 8.6, and points to the other strategies', async (t) => {
    let checked = 0;
    for (const url of [VALKEY_URL, REDIS_OLD_URL]) {
      const server = await probeRedis(url);
      if (!server) continue;
      const backend = new RedisBackend({ redis: url, strategy: 'idmp' });
      await assert.rejects(backend.init(), new RegExp(`needs Redis 8\\.6.*${server.product} ${server.version}.*"stream-id" or "script"`));
      await backend.close();
      checked++;
    }
    if (checked === 0) t.skip('no Valkey or older Redis to check');
  });

  test('ValkeyBackend refuses idmp when compiling and when constructed', () => {
    // @ts-expect-error Valkey has no 'idmp'
    const strategy: KeyValueStrategyName<'valkey'> = 'idmp';
    assert.throws(() => new ValkeyBackend({ strategy }), /"idmp" strategy needs Redis 8\.6.*Valkey.*"stream-id" or "script"/);
    // @ts-expect-error nor its settings
    assert.throws(() => new ValkeyBackend({ strategy: { name: 'idmp', durationSec: 60 } }), /"idmp" strategy needs Redis 8\.6/);
    assert.equal(new ValkeyBackend().name, 'valkey:lease');
    assert.equal(new ValkeyBackend({ valkey: VALKEY_URL, strategy: { name: 'script', windowMs: 60_000 } }).name, 'valkey:script');
  });

  test('a strategy takes only its own settings, when compiling and when constructed', () => {
    // @ts-expect-error 'lease' has no settings
    assert.throws(() => new RedisBackend({ strategy: { name: 'lease', windowMs: 60_000 } }), /"lease" strategy has no setting "windowMs"/);
    assert.throws(
      // @ts-expect-error durationSec belongs to 'idmp'
      () => new RedisBackend({ strategy: { name: 'script', durationSec: 60 } }),
      /"script" strategy has no setting "durationSec"/,
    );
    // @ts-expect-error settings go inside the strategy
    new RedisBackend({ strategy: 'script', windowMs: 60_000 });
    assert.equal(new RedisBackend({ strategy: { name: 'idmp', durationSec: 60 } }).dedupeWindowMs, 60_000);
    assert.equal(new RedisBackend({ strategy: { name: 'script', windowMs: 90_000 } }).dedupeWindowMs, 90_000);
    assert.equal(new RedisBackend({ strategy: 'stream-id' }).dedupeWindowMs, Infinity);
  });

  test('Valkey clients: iovalkey, Valkey GLIDE and node-redis', async (t) => {
    if (!(await probeRedis(VALKEY_URL))) return t.skip(`nothing at ${VALKEY_URL}`);
    const port = Number(new URL(VALKEY_URL).port || 6379);
    const iovalkey = [0, 1, 2].map(() => new IoValkey({ port }));
    const glide = await Promise.all([0, 1, 2].map(() => GlideClient.createClient({ addresses: [{ host: 'localhost', port }] })));
    const nodeRedis = [0, 1, 2].map(() => createClient({ url: VALKEY_URL }));
    await Promise.all(nodeRedis.map((c) => c.connect()));
    try {
      for (const [name, clients] of [
        ['iovalkey', iovalkey],
        ['glide', glide],
        ['node-redis', nodeRedis],
      ] as const) {
        for (const strategy of ['stream-id', 'script'] as const) {
          const prefix = `test:${uniqueId(name)}:`;
          const backends = clients.map((redis) => new ValkeyBackend({ valkey: redis as never, strategy, prefix }));
          await race(backends, 10);
          const [one] = backends;
          await one!.saveResult(
            'job',
            { slot: futureSlot(60), by: 'i0', status: 'success', startedAt: 1, finishedAt: 2, durationMs: 1 },
            1000,
          );
          assert.ok((await one!.history('job', 5)).length > 0, `${name}/${strategy}: history readable`);
        }
      }
    } finally {
      await Promise.all(iovalkey.map((c) => c.quit()));
      for (const c of glide) c.close();
      await Promise.all(nodeRedis.map((c) => c.quit()));
    }
  });

  test('a manual run recorded after a run is due does not take that run from the instances that claim it', async (t) => {
    const server = await probeRedis(REDIS_URL);
    if (!server) return t.skip(`nothing at ${REDIS_URL}`);
    const strategies = supportsIdmp(server) ? (['stream-id', 'idmp', 'script'] as const) : (['stream-id', 'script'] as const);
    for (const strategy of strategies) {
      const backend = new RedisBackend({ redis: REDIS_URL, strategy, prefix: `test:${uniqueId('manual')}:` });
      try {
        await backend.init();
        await backend.prepareJob('job');
        const slot = Date.now() - 500;
        await backend.recordManualRun(input(Date.now(), 'A'));
        assert.equal(await backend.claim(input(slot, 'B')), true, `${strategy}: the run can still be claimed`);
        const history = await backend.history('job', 10);
        assert.deepEqual(
          history.map((r) => [r.instanceId, r.manual]),
          [
            ['A', true],
            ['B', false],
          ],
          `${strategy}: history shows both runs`,
        );
      } finally {
        await backend.close();
      }
    }
  });

  test('script strategy: a run outside the window could be claimed again, so the scheduler refuses unsafe settings', () => {
    const backend = new RedisBackend({ strategy: { name: 'script', windowMs: 30_000 }, redis: REDIS_URL });
    assert.equal(backend.dedupeWindowMs, 30_000);
    assert.throws(
      () => backend.checkJob({ name: 'x', jitterMs: 2_000, maxLateMs: 60_000, minGapMs: 10, historySize: 1_000 }),
      /historySize/,
    );
  });
});
