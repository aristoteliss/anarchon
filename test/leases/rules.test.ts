/* Copyright (C) 2026-present Aristotelis — see repository license. */

/**
 * The lease rules, step by step, on every backend that has leases: Redis 'lease' (Redis 8.6, 7.0,
 * Valkey), Postgres, and SQLite with each driver. The scheduler on top of them is in scheduler.test.ts.
 */
import assert from 'node:assert/strict';
import { Redis } from 'ioredis';
import { describe, test } from 'vitest';

import { type Backend, type LeaseStore, RedisBackend, type RunClaim, type RunStore, Scheduler } from '../../src';
import { leaseSpecs, makeBackend, type Spec, sleep, uniqueId } from '../support';

const T = 1_000_000;

describe('lease rules', async () => {
  for (const { label, spec, skip } of await leaseSpecs()) {
    /** A fresh backend (own keys / table) for one test, and its RunStore. */
    const fresh = (name: string, id = uniqueId(name)): { backend: Backend; runs: RunStore; spec: Spec } => {
      const full = { ...spec, id };
      const backend = makeBackend(full);
      return { backend, runs: backend.runs!, spec: full };
    };

    describe.skipIf(skip)(label, () => {
      test('state machine: claim, resend, backup, takeover, fencing, give up', async () => {
        const { backend, runs } = fresh('lease');
        const claim = (slot: number, token: string, instanceId: string, extra: Partial<RunClaim> = {}) =>
          runs.claim({
            job: 'j',
            slot,
            token,
            instanceId,
            historySize: 100,
            leaseMs: 400,
            overlap: 'skip',
            maxAttempts: 2,
            mode: 'new',
            reason: 'scheduled',
            ...extra,
          });
        try {
          await backend.init();
          assert.deepEqual(await claim(T, 'a1', 'A'), { kind: 'won', attempt: 1 }, 'first claim wins');
          assert.deepEqual(await claim(T, 'a1', 'A'), { kind: 'won', attempt: 1 }, 'the same claim sent again is still ours');
          assert.deepEqual(await claim(T, 'b1', 'B'), { kind: 'running', attempt: 1 }, 'others see it running');
          assert.deepEqual(await claim(T + 1, 'b2', 'B'), { kind: 'overlap', slot: T }, 'the next run waits for this one');
          assert.equal(await runs.heartbeat('j', T, 'a1', 400), true, 'the runner renews its lease');

          await sleep(500); // A stops renewing: it "died"
          assert.deepEqual(await runs.active('j'), [{ slot: T, attempt: 1, alive: false }]);
          assert.deepEqual(
            await claim(T, 'b3', 'B', { mode: 'takeover', reason: 'takeover' }),
            { kind: 'won', attempt: 2 },
            'a backup takes over',
          );
          assert.deepEqual(
            await claim(T, 'c0', 'C', { mode: 'takeover', reason: 'takeover' }),
            { kind: 'running', attempt: 2 },
            'only one backup',
          );
          assert.equal(await runs.heartbeat('j', T, 'a1', 400), false, 'the old runner learns it lost the run');
          assert.equal(await runs.finish('j', T, 'a1', 'success'), false, 'and cannot finish it');

          await sleep(500); // B dies too; maxAttempts is 2
          assert.deepEqual(await claim(T, 'c1', 'C', { mode: 'takeover', reason: 'takeover' }), { kind: 'done' }, 'no third attempt');
          assert.deepEqual(await claim(T + 5, 'c2', 'C'), { kind: 'won', attempt: 1 }, 'the next run is not blocked by a dead one');
          assert.equal(await runs.finish('j', T + 5, 'c2', 'success'), true);
          assert.deepEqual(await runs.active('j'), []);
          assert.deepEqual(await claim(T + 9, 'x', 'C', { mode: 'takeover', reason: 'takeover' }), { kind: 'none' });

          await backend.saveResult(
            'j',
            { slot: T + 5, by: 'C', attempt: 1, status: 'success', startedAt: 1, finishedAt: 2, durationMs: 1 },
            100,
          );
          const history = await backend.history('j', 10);
          assert.deepEqual(
            history.map((r) => [r.slot - T, r.instanceId, r.attempt, r.status]),
            [
              [5, 'C', 1, 'success'],
              [0, 'B', 2, 'interrupted'],
              [0, 'A', 1, 'interrupted'],
            ],
          );
        } finally {
          await backend.close();
        }
      });

      test('overlap "allow" lets runs of the same job run side by side', async () => {
        const { backend, runs } = fresh('allow');
        const base = {
          job: 'j',
          instanceId: 'A',
          historySize: 100,
          leaseMs: 5_000,
          overlap: 'allow' as const,
          maxAttempts: 1,
          mode: 'new' as const,
          reason: 'scheduled' as const,
        };
        try {
          assert.equal((await runs.claim({ ...base, slot: T, token: 't1' })).kind, 'won');
          assert.equal((await runs.claim({ ...base, slot: T + 1, token: 't2' })).kind, 'won');
        } finally {
          await backend.close();
        }
      });

      test('a crashed manual run is never retried by a backup', async () => {
        const { backend, runs } = fresh('manual');
        const base = { job: 'j', historySize: 100, leaseMs: 300, overlap: 'allow' as const };
        try {
          const manual = await runs.claim({ ...base, slot: T, token: 'm', instanceId: 'A', maxAttempts: 1, mode: 'new', reason: 'manual' });
          assert.equal(manual.kind, 'won');
          await sleep(400); // the instance running it died
          const takeover = await runs.claim({
            ...base,
            slot: T,
            token: 'b',
            instanceId: 'B',
            maxAttempts: 3,
            mode: 'takeover',
            reason: 'takeover',
          });
          assert.deepEqual(takeover, { kind: 'done' });
        } finally {
          await backend.close();
        }
      });

      test('a run handed over on stop() is taken over at once, and a hand-over is not a failed attempt', async () => {
        const { backend, runs } = fresh('release');
        const base = { job: 'j', historySize: 100, leaseMs: 60_000, overlap: 'skip' as const, maxAttempts: 1 };
        const takeover = (token: string, instanceId: string) =>
          runs.claim({ ...base, slot: T, token, instanceId, mode: 'takeover', reason: 'takeover' });
        try {
          assert.equal((await runs.claim({ ...base, slot: T, token: 'a', instanceId: 'A', mode: 'new', reason: 'scheduled' })).kind, 'won');
          assert.deepEqual(await takeover('b', 'B'), { kind: 'running', attempt: 1 }, 'alive: nothing to take over');
          assert.equal(await runs.release('j', T, 'a'), true, 'A stops and gives the run up');
          assert.equal(await runs.release('j', T, 'a'), false, 'only once');
          assert.deepEqual(await takeover('b', 'B'), { kind: 'won', attempt: 2 }, 'B takes over at once, though maxAttempts is 1');
          assert.equal(await runs.heartbeat('j', T, 'a', 60_000), false, 'A no longer owns it');
          assert.equal(await runs.release('j', T, 'a'), false);
          assert.equal(await runs.finish('j', T, 'b', 'success'), true);
        } finally {
          await backend.close();
        }
      });

      test('a new run is refused when its claim arrives later than maxLateMs, by the server clock', async () => {
        const { backend, runs } = fresh('late');
        const base = {
          job: 'j',
          instanceId: 'A',
          historySize: 100,
          leaseMs: 5_000,
          overlap: 'allow' as const,
          maxAttempts: 1,
          mode: 'new' as const,
          reason: 'scheduled' as const,
        };
        try {
          const now = Date.now();
          const stale = await runs.claim({ ...base, slot: now - 30_000, token: 'x', maxLateMs: 10_000 });
          assert.equal(stale.kind, 'late');
          assert.ok(stale.kind === 'late' && stale.lateMs >= 30_000);
          assert.equal((await runs.claim({ ...base, slot: now - 1_000, token: 'y', maxLateMs: 10_000 })).kind, 'won');
        } finally {
          await backend.close();
        }
      });

      test('on start, a dead run is retried only if it is still the latest run of its job', async () => {
        const id = uniqueId('recover');
        const interval = 10_000;
        // Stay inside one interval for the whole test, so "the latest run" doesn't change under it
        const toNext = interval - (Date.now() % interval);
        if (toNext < 3_000) await sleep(toNext + 50);
        const latest = Math.floor(Date.now() / interval) * interval;
        const old = latest - 3 * interval;
        const { backend: setup, runs } = fresh('recover', id);
        const claim = (slot: number, token: string) =>
          runs.claim({
            job: 'job',
            slot,
            token,
            instanceId: 'dead',
            historySize: 100,
            leaseMs: 200,
            overlap: 'allow',
            maxAttempts: 3,
            mode: 'new',
            reason: 'scheduled',
          });
        await claim(old, 'o');
        await claim(latest, 'l');
        await sleep(300); // both runners are gone
        await setup.close();

        const scheduler = new Scheduler({ backend: makeBackend({ ...spec, id }), leaseMs: 1_000, heartbeatMs: 200, instanceId: 'new' });
        const started: Array<[number, number, string]> = [];
        scheduler.every('job', interval, (ctx) => void started.push([ctx.slot, ctx.attempt, ctx.reason]), { jitterMs: 100, catchUpMs: 0 });
        await scheduler.start();
        await sleep(500);
        await scheduler.stop();
        assert.deepEqual(
          started.filter(([slot]) => slot <= latest),
          [[latest, 2, 'takeover']],
          `started: ${JSON.stringify(started)}`,
        );
      });

      test('trimming never drops a run in progress, or one a late claim could still ask for', async () => {
        const { backend, runs } = fresh('trim');
        const base = {
          job: 'j',
          instanceId: 'A',
          historySize: 2,
          leaseMs: 60_000,
          overlap: 'allow' as const,
          maxAttempts: 1,
          mode: 'new' as const,
          keepMs: 60_000,
        };
        const run = async (slot: number, token: string, reason: 'scheduled' | 'manual' = 'scheduled') => {
          const outcome = await runs.claim({ ...base, slot, token, reason });
          if (outcome.kind === 'won') await runs.finish('j', slot, token, 'success');
          return outcome.kind;
        };
        try {
          const now = Date.now();
          assert.equal((await runs.claim({ ...base, slot: now - 400_000, token: 'long', reason: 'scheduled' })).kind, 'won'); // a long run
          await run(now - 300_000, 'old1');
          await run(now - 200_000, 'old2');
          assert.equal(await run(now, 'due'), 'won');
          for (let i = 1; i <= 5; i++) assert.equal(await run(now + i, `m${i}`, 'manual'), 'won');
          assert.equal(await runs.heartbeat('j', now - 400_000, 'long', 60_000), true, 'the long run still owns its lease');
          // Another instance's claim for the due run arrives late (but within maxLateMs): it must not run it again
          assert.equal((await runs.claim({ ...base, slot: now, token: 'late', reason: 'scheduled', maxLateMs: 60_000 })).kind, 'done');
          if (backend instanceof RedisBackend) {
            const redis = new Redis(spec.url);
            const kept = (await redis.zrange((runs as LeaseStore).key('j', 'slots'), '0', '-1')).map((slot) => Number(slot) - now);
            redis.disconnect();
            assert.deepEqual(kept, [-400_000, 0, 1, 2, 3, 4, 5], 'old finished runs are trimmed; young and running ones stay');
          }
        } finally {
          await backend.close();
        }
      });
    });
  }
});
