/** The scheduler on every backend with leases: hand-over on stop(), takeover, catch-up and backups. */
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, test } from 'vitest';

import { type JobContext, RedisBackend, type RunClaim, type RunRecord, Scheduler, type SkipEvent } from '../../src';
import { leaseSpecs, makeBackend, probeRedis, REDIS_URL, sleep, uniqueId } from '../support';

describe('scheduler with leases', async () => {
  for (const { label, spec, skip } of await leaseSpecs()) {
    describe.skipIf(skip)(label, () => {
      /** Two instances of one service, in this process. */
      const pair = (id: string) =>
        ['A', 'B'].map(
          (name) => new Scheduler({ backend: makeBackend({ ...spec, id }), instanceId: name, leaseMs: 1_000, heartbeatMs: 200 }),
        );

      test('stop() hands a running job to another instance when the job throws on abort', async () => {
        const [a, b] = pair(uniqueId('handover')) as [Scheduler, Scheduler];
        const starts: Array<{ by: string; attempt: number; reason: string; at: number }> = [];
        const interrupted: Array<{ by: string; handedOver: boolean }> = [];
        const at = Date.now() + 300;
        for (const s of [a, b]) {
          s.at(
            'job',
            at,
            async (ctx: JobContext) => {
              starts.push({ by: ctx.instanceId, attempt: ctx.attempt, reason: ctx.reason, at: Date.now() });
              await delay(1_500, undefined, { signal: ctx.signal }); // throws when ctx.signal aborts
            },
            { jitterMs: 100 },
          );
          s.on('interrupted', (e) => interrupted.push({ by: e.instanceId, handedOver: e.handedOver }));
          s.on('error', () => {});
        }
        await Promise.all([a.start(), b.start()]);
        try {
          while (starts.length === 0) await sleep(20);
          const [winner, backup] = starts[0]!.by === 'A' ? [a, b] : [b, a];
          await sleep(200);
          const stoppedAt = Date.now();
          await winner.stop();
          while (starts.length < 2 && Date.now() - stoppedAt < 3_000) await sleep(20);
          assert.deepEqual(interrupted, [{ by: winner.instanceId, handedOver: true }]);
          assert.equal(starts.length, 2, `starts: ${JSON.stringify(starts)}`);
          assert.deepEqual([starts[1]!.by, starts[1]!.attempt, starts[1]!.reason], [backup.instanceId, 2, 'takeover']);
          assert.ok(starts[1]!.at - stoppedAt < 1_200, `taken over ${starts[1]!.at - stoppedAt} ms after stop(), within one lease`);
          await sleep(1_700);
          const history = await backup.history('job');
          assert.deepEqual(
            history.map((r: RunRecord) => [r.instanceId, r.attempt, r.status]),
            [
              [backup.instanceId, 2, 'success'],
              [winner.instanceId, 1, 'interrupted'],
            ],
          );
        } finally {
          await Promise.all([a.stop(), b.stop()]);
        }
      });

      test('a job still running when the stop timeout passes is taken over once its lease runs out', async () => {
        const [a, b] = pair(uniqueId('zombie')) as [Scheduler, Scheduler];
        const starts: Array<{ by: string; attempt: number }> = [];
        const at = Date.now() + 300;
        for (const s of [a, b]) {
          // Ignores ctx.signal on purpose
          s.at(
            'job',
            at,
            async (ctx: JobContext) => {
              starts.push({ by: ctx.instanceId, attempt: ctx.attempt });
              await sleep(ctx.attempt === 1 ? 2_500 : 100);
            },
            { jitterMs: 100 },
          );
          s.on('error', () => {});
        }
        await Promise.all([a.start(), b.start()]);
        try {
          while (starts.length === 0) await sleep(20);
          const [winner, backup] = starts[0]!.by === 'A' ? [a, b] : [b, a];
          await winner.stop({ timeoutMs: 100 }); // returns while the job is still going
          await sleep(2_800); // the lease (1 s) runs out, a backup takes over; the old job ends and writes nothing
          assert.deepEqual(starts, [
            { by: winner.instanceId, attempt: 1 },
            { by: backup.instanceId, attempt: 2 },
          ]);
          const history = await backup.history('job');
          assert.deepEqual(
            history.map((r: RunRecord) => [r.instanceId, r.attempt, r.status]),
            [
              [backup.instanceId, 2, 'success'],
              [winner.instanceId, 1, 'interrupted'],
            ],
          );
        } finally {
          await Promise.all([a.stop(), b.stop()]);
        }
      });

      test('catching up on start is silent when the latest run already happened', async () => {
        const [a, b] = pair(uniqueId('silent')) as [Scheduler, Scheduler];
        const skips: SkipEvent[] = [];
        let ran = 0;
        a.every('job', 2_000, () => void ran++, { jitterMs: 100, catchUpMs: 0 });
        b.every('job', 2_000, () => void ran++, { jitterMs: 100 });
        b.on('skip', (e) => skips.push(e));
        await a.start();
        try {
          while (ran === 0) await sleep(20);
          await b.start(); // the latest run is done: nothing to catch up, nothing to report
          await sleep(400);
          assert.deepEqual(skips, []);
          assert.equal(ran, 1);
        } finally {
          await Promise.all([a.stop(), b.stop()]);
        }
      });
    });
  }
});

test('an instance that skipped a run as an overlap backs it up when another instance starts it', async (t) => {
  if (!(await probeRedis(REDIS_URL))) return t.skip('no Redis');
  const interval = 2_000;
  const prefix = `test:${uniqueId('overlap-backup')}:`;
  const backends = [0, 1].map(() => new RedisBackend({ redis: REDIS_URL, prefix }));
  const [a, b] = backends.map((backend, i) => new Scheduler({ backend, instanceId: 'AB'[i]!, leaseMs: 400, heartbeatMs: 100 })) as [
    Scheduler,
    Scheduler,
  ];
  // B's claims of new runs arrive late: A decides first, and B asks for the second run after the first has ended.
  const runs = backends[1]!.runs!;
  const claim = runs.claim.bind(runs);
  runs.claim = async (input: RunClaim) => {
    if (input.mode === 'new') await sleep(300);
    return claim(input);
  };

  const starts: Array<{ by: string; run: number; attempt: number }> = [];
  let first: number | undefined;
  for (const s of [a, b]) {
    s.every(
      'job',
      interval,
      async (ctx: JobContext) => {
        first ??= ctx.slot;
        starts.push({ by: ctx.instanceId, run: (ctx.slot - first) / interval, attempt: ctx.attempt });
        if (ctx.slot === first)
          await sleep(first + interval + 150 - Date.now()); // still going when the second run is due
        else if (ctx.attempt === 1) await sleep(2_500); // ignores ctx.signal
      },
      { jitterMs: 0, catchUpMs: 0 },
    );
    s.on('error', () => {});
  }
  await Promise.all([a.start(), b.start()]);
  try {
    while (starts.length < 2) await sleep(20);
    await b.stop({ timeoutMs: 100 }); // returns while the job is still going: its lease runs out
    while (starts.length < 3 && Date.now() < first! + 2 * interval - 200) await sleep(20);
    assert.deepEqual(starts, [
      { by: 'A', run: 0, attempt: 1 },
      { by: 'B', run: 1, attempt: 1 },
      { by: 'A', run: 1, attempt: 2 },
    ]);
  } finally {
    await Promise.all([a.stop({ timeoutMs: 100 }), b.stop()]);
  }
});

test('runs leave no listeners behind (no leak on long-running services)', async (t) => {
  if (!(await probeRedis(REDIS_URL))) return t.skip('no Redis');
  const scheduler = new Scheduler({ backend: new RedisBackend({ redis: REDIS_URL, prefix: `test:${uniqueId('leak')}:` }) });
  scheduler.every('job', '1h', () => {}, { catchUpMs: 0 });
  await scheduler.start();
  try {
    for (let i = 0; i < 25; i++) await scheduler.runNow('job');
    const signal = (scheduler as unknown as { abort: AbortController }).abort.signal;
    assert.equal(getEventListeners(signal, 'abort').length, 0);
  } finally {
    await scheduler.stop();
  }
});
