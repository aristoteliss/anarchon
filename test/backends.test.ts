/**
 * The contract every backend must meet, run against real servers:
 * one winner per run, retry-safe claims, and history that names the winner.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { GlideClient, Logger as GlideLogger } from '@valkey/valkey-glide';
import IoValkey from 'iovalkey';
import { createClient } from 'redis';
import { describe, test } from 'vitest';

import { type Backend, RedisBackend } from '../src';
import { availableSpecs, makeBackend, probeRedis, REDIS_OLD_URL, REDIS_URL, uniqueId, VALKEY_URL } from './helpers';

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

describe('every backend', async () => {
  for (const { label, spec, skip } of await availableSpecs()) {
    describe.skipIf(skip)(label, () => {
      test('3 instances race for 40 runs: exactly one winner each', async () => {
        const id = uniqueId('race');
        const backends = [0, 1, 2].map(() => makeBackend({ ...spec, id }));
        try {
          await race(backends);
        } finally {
          await Promise.all(backends.map((b) => b.close()));
        }
      });

      test('the same claim sent twice is still a win; another instance loses', async () => {
        const backend = makeBackend({ ...spec, id: uniqueId('retry') });
        try {
          await backend.init();
          await backend.prepareJob('job', 1000);
          const slot = futureSlot(120);
          const mine = input(slot, 'A');
          assert.equal(await backend.claim(mine), true);
          assert.equal(await backend.claim(mine), true, 'resent with the same token');
          assert.equal(await backend.claim(input(slot, 'B')), false);
        } finally {
          await backend.close();
        }
      });

      test('history joins claims and results, newest first', async () => {
        const backend = makeBackend({ ...spec, id: uniqueId('hist') });
        try {
          await backend.init();
          await backend.prepareJob('job', 1000);
          const first = futureSlot(30);
          const second = first + 1000;
          for (const [slot, who] of [
            [first, 'A'],
            [second, 'B'],
          ] as const) {
            const claim = input(slot, who);
            assert.equal(await backend.claim(claim), true);
            await backend.recordClaim?.(claim);
          }
          await backend.saveResult(
            'job',
            { slot: first, by: 'A', status: 'failed', startedAt: first, finishedAt: first + 5, durationMs: 5, error: 'Error: boom' },
            1000,
          );
          const history = await backend.history('job', 10);
          assert.deepEqual(
            history.map((r) => [r.slot, r.instanceId, r.status, r.error]),
            [
              [second, 'B', 'running', undefined],
              [first, 'A', 'failed', 'Error: boom'],
            ],
          );
          assert.deepEqual(await backend.history('never-ran', 10), []);
        } finally {
          await backend.close();
        }
      });
    });
  }
});

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
          const backends = clients.map((redis) => new RedisBackend({ redis: redis as never, strategy, prefix }));
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

  test('script strategy: a run outside the window could be claimed again, so the scheduler refuses unsafe settings', () => {
    const backend = new RedisBackend({ strategy: 'script', scriptWindowMs: 30_000, redis: REDIS_URL });
    assert.equal(backend.dedupeWindowMs, 30_000);
    assert.throws(
      () => backend.checkJob({ name: 'x', jitterMs: 2_000, maxLateMs: 60_000, minGapMs: 10, historySize: 1_000 }),
      /historySize/,
    );
  });
});
