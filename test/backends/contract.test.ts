/**
 * The contract every backend must meet, run against real servers:
 * one winner per run, retry-safe claims, and history that names the winner.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Logger as GlideLogger } from '@valkey/valkey-glide';
import { describe, test } from 'vitest';

import type { Backend } from '../../src';
import { availableSpecs, makeBackend, uniqueId } from '../support';

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
