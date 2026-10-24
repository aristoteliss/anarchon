/* Copyright (C) 2026-present Aristotelis — see repository license. */

/** The scheduler on every backend with leases: hand-over on stop(), takeover, catch-up and backups. */
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, test } from 'vitest';

import {
  type JobContext,
  type LostEvent,
  RedisBackend,
  type RunClaim,
  type RunRecord,
  type RunStore,
  Scheduler,
  type SkipEvent,
} from '../../src';
import {
  leaseSpecs,
  makeBackend,
  probeRedis,
  REDIS_URL,
  sleep,
  uniqueId,
} from '../support';

describe('scheduler with leases', async () => {
  for (const { label, spec, skip } of await leaseSpecs()) {
    describe.skipIf(skip)(label, () => {
      /** Two instances of one service, in this process. */
      const pair = (id: string) =>
        ['A', 'B'].map(
          (name) =>
            new Scheduler({
              backend: makeBackend({ ...spec, id }),
              instanceId: name,
              leaseMs: 1_000,
              heartbeatMs: 200,
            }),
        );

      test('stop() hands a running job to another instance when the job throws on abort', async () => {
        const [a, b] = pair(uniqueId('handover')) as [Scheduler, Scheduler];
        const starts: Array<{
          by: string;
          attempt: number;
          reason: string;
          at: number;
        }> = [];
        const interrupted: Array<{ by: string; handedOver: boolean }> = [];
        const at = Date.now() + 300;
        for (const s of [a, b]) {
          s.at(
            'job',
            at,
            async (ctx: JobContext) => {
              starts.push({
                by: ctx.instanceId,
                attempt: ctx.attempt,
                reason: ctx.reason,
                at: Date.now(),
              });
              await delay(1_500, undefined, { signal: ctx.signal }); // throws when ctx.signal aborts
            },
            { jitterMs: 100 },
          );
          s.on('interrupted', (e) =>
            interrupted.push({ by: e.instanceId, handedOver: e.handedOver }),
          );
          s.on('error', () => {});
        }
        await Promise.all([a.start(), b.start()]);
        try {
          while (starts.length === 0) await sleep(20);
          const [winner, backup] = starts[0]!.by === 'A' ? [a, b] : [b, a];
          await sleep(200);
          const stoppedAt = Date.now();
          await winner.stop();
          while (starts.length < 2 && Date.now() - stoppedAt < 3_000)
            await sleep(20);
          assert.deepEqual(interrupted, [
            { by: winner.instanceId, handedOver: true },
          ]);
          assert.equal(starts.length, 2, `starts: ${JSON.stringify(starts)}`);
          assert.deepEqual(
            [starts[1]!.by, starts[1]!.attempt, starts[1]!.reason],
            [backup.instanceId, 2, 'takeover'],
          );
          assert.ok(
            starts[1]!.at - stoppedAt < 1_200,
            `taken over ${starts[1]!.at - stoppedAt} ms after stop(), within one lease`,
          );
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
        a.every('job', 2_000, () => void ran++, {
          jitterMs: 100,
          catchUpMs: 0,
        });
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

      test('with yieldAfterFailure, a healthy instance runs every run after another instance failed one', async () => {
        const [a, b] = pair(uniqueId('yield')) as [Scheduler, Scheduler];
        const ran: string[] = [];
        const failed = new Promise((resolve) => a.once('failure', resolve));
        for (const s of [a, b]) {
          s.every(
            'job',
            '1s',
            (ctx: JobContext) => {
              ran.push(ctx.instanceId);
              if (ctx.instanceId === 'A') throw new Error('A is sick');
            },
            { jitterMs: 100, catchUpMs: 0, yieldAfterFailure: true },
          );
          s.on('error', () => {});
        }

        await a.start();
        try {
          await failed;
          await b.start();
          ran.length = 0;
          const until = Date.now() + 4_200;
          while (ran.length < 3 && Date.now() < until) await sleep(20);
          assert.ok(ran.length >= 3, `ran: ${JSON.stringify(ran)}`);
          assert.deepEqual([...new Set(ran)], ['B']);
        } finally {
          await Promise.all([a.stop(), b.stop()]);
        }
      });

      test('with yieldAfterFailure, an instance with no healthy peer still runs, jitterMs + heartbeatMs after the slot', async () => {
        // jitterMs + heartbeatMs, less a little: a timer can fire a few ms before Date.now() says.
        const WAITED_MS = 290;
        const [a] = pair(uniqueId('alone')) as [Scheduler];
        const lateMs: number[] = [];
        a.every(
          'job',
          '1s',
          (ctx: JobContext) => {
            lateMs.push(Date.now() - ctx.slot);
            throw new Error('A is sick');
          },
          { jitterMs: 100, catchUpMs: 0, yieldAfterFailure: true },
        );
        a.on('error', () => {});

        await a.start();
        try {
          while (lateMs.length < 3) await sleep(20);
          const [first = 0, ...afterFailure] = lateMs;
          assert.ok(first < WAITED_MS, `first run ${first} ms late`);
          for (const ms of afterFailure) {
            assert.ok(ms >= WAITED_MS, `a run after a failure ${ms} ms late`);
          }
        } finally {
          await a.stop();
        }
      });

      /**
       * A runs a one-off job; once it started, `fault` breaks A's store, then B starts and backs
       * the run up. Returns when A's signal aborted, when B took over, and A's 'lost' events.
       */
      async function breakRunner(
        id: string,
        fault: (runs: RunStore) => void,
      ): Promise<{ abortedAt?: number; takenOverAt?: number; lost: number }> {
        const [a, b] = pair(uniqueId(id)) as [Scheduler, Scheduler];
        const seen: { abortedAt?: number; takenOverAt?: number; lost: number } =
          { lost: 0 };
        let started = false;
        const job = async (ctx: JobContext) => {
          if (ctx.instanceId === 'B') {
            seen.takenOverAt = Date.now();
            return;
          }
          started = true;
          ctx.signal.addEventListener('abort', () => {
            seen.abortedAt = Date.now();
          });
          await delay(3_000, undefined, { signal: ctx.signal }).catch(() => {});
        };
        const at = Date.now() + 300;
        for (const s of [a, b]) {
          s.at('job', at, job, { jitterMs: 0 });
          s.on('error', () => {});
        }
        a.on('lost', () => seen.lost++);

        await a.start();
        try {
          while (!started) await sleep(20);
          fault(a.backend.runs!);
          await b.start();
          const until = Date.now() + 3_000;
          while (!seen.takenOverAt && Date.now() < until) await sleep(20);
          await sleep(200);
          return { ...seen }; // before stop() aborts the run
        } finally {
          await Promise.all([a.stop({ timeoutMs: 500 }), b.stop()]);
        }
      }

      test('an instance whose heartbeats never answer aborts its run by the time a backup takes it over', async () => {
        const seen = await breakRunner('hang', (runs) => {
          runs.heartbeat = () => new Promise(() => {});
        });

        const report = `A aborted ${seen.abortedAt ? `${seen.abortedAt - (seen.takenOverAt ?? 0)} ms after` : 'never, until stop(), after'} B took over; 'lost' events on A: ${seen.lost}`;
        assert.ok(seen.takenOverAt, 'B took the run over');
        assert.ok(seen.abortedAt && seen.abortedAt <= seen.takenOverAt, report);
        assert.equal(seen.lost, 1, report);
      });

      test('an instance whose heartbeats fail aborts its run by the time a backup takes it over', async () => {
        const seen = await breakRunner('reject', (runs) => {
          runs.heartbeat = async () => {
            throw new Error('the store is unreachable from this instance');
          };
        });

        const report = `A aborted ${seen.abortedAt ? `${seen.abortedAt - (seen.takenOverAt ?? 0)} ms after` : 'never, until stop(), after'} B took over; 'lost' events on A: ${seen.lost}`;
        assert.ok(seen.takenOverAt, 'B took the run over');
        assert.ok(seen.abortedAt && seen.abortedAt <= seen.takenOverAt, report);
        assert.equal(seen.lost, 1, report);
      });

      test('a finish() that never answers neither blocks the next runs nor stop()', async () => {
        const [a, b] = pair(uniqueId('finish')) as [Scheduler, Scheduler];
        const starts: string[] = [];
        const overlaps: string[] = [];
        for (const s of [a, b]) {
          s.every(
            'job',
            '1s',
            (ctx: JobContext) => {
              starts.push(ctx.instanceId);
            },
            { catchUpMs: 0 },
          );
          s.on('skip', (e: SkipEvent) => {
            if (e.reason === 'overlap') overlaps.push(e.instanceId);
          });
          s.on('error', () => {});
        }
        const runs = a.backend.runs!;
        runs.finish = () => new Promise(() => {});

        await a.start();
        let stopMs = 0;
        try {
          while (starts.length === 0) await sleep(20);
          await b.start();
          starts.length = 0;
          const until = Date.now() + 4_200;
          while (starts.length < 2 && Date.now() < until) await sleep(20);
        } finally {
          const stopAt = Date.now();
          await a.stop({ timeoutMs: 500 });
          stopMs = Date.now() - stopAt;
          await b.stop();
        }

        const report = `runs started in 4.2 s: ${JSON.stringify(starts)}; overlap skips: ${overlaps.length}; stop({ timeoutMs: 500 }) took ${stopMs} ms`;
        assert.ok(starts.length >= 2, report);
        assert.ok(stopMs < 1_500, report);
      });

      test('a claim that never answers neither holds back the next slots nor stop()', async () => {
        const [a, b] = pair(uniqueId('claim')) as [Scheduler, Scheduler];
        const starts: string[] = [];
        let claims = 0;
        const runs = a.backend.runs!;
        runs.claim = () => {
          claims++;
          return new Promise(() => {});
        };
        for (const s of [a, b]) {
          s.every(
            'job',
            '1s',
            (ctx: JobContext) => {
              starts.push(ctx.instanceId);
            },
            { catchUpMs: 0 },
          );
          s.on('error', () => {});
        }

        await Promise.all([a.start(), b.start()]);
        let stopMs = 0;
        try {
          await sleep(2_200);
        } finally {
          const stopAt = Date.now();
          await a.stop({ timeoutMs: 500 });
          stopMs = Date.now() - stopAt;
          await b.stop();
        }

        assert.ok(claims >= 2, `A sent ${claims} claims in 2.2 s`);
        assert.ok(starts.length >= 2, `B ran ${starts.length} runs in 2.2 s`);
        assert.ok(stopMs < 1_500, `stop({ timeoutMs: 500 }) took ${stopMs} ms`);
      });
    });
  }
});

test('an instance that skipped a run as an overlap backs it up when another instance starts it', async (t) => {
  if (!(await probeRedis(REDIS_URL))) return t.skip('no Redis');
  const interval = 2_000;
  const prefix = `test:${uniqueId('overlap-backup')}:`;
  const backends = [0, 1].map(
    () => new RedisBackend({ redis: REDIS_URL, prefix }),
  );
  const [a, b] = backends.map(
    (backend, i) =>
      new Scheduler({
        backend,
        instanceId: 'AB'[i]!,
        leaseMs: 400,
        heartbeatMs: 100,
      }),
  ) as [Scheduler<RedisBackend>, Scheduler<RedisBackend>];
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
        starts.push({
          by: ctx.instanceId,
          run: (ctx.slot - first) / interval,
          attempt: ctx.attempt,
        });
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
    while (starts.length < 3 && Date.now() < first! + 2 * interval - 200)
      await sleep(20);
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
  const scheduler = new Scheduler({
    backend: new RedisBackend({
      redis: REDIS_URL,
      prefix: `test:${uniqueId('leak')}:`,
    }),
  });
  scheduler.every('job', '1h', () => {}, { catchUpMs: 0 });
  await scheduler.start();
  try {
    for (let i = 0; i < 25; i++) await scheduler.runNow('job');
    const signal = (scheduler as unknown as { abort: AbortController }).abort
      .signal;
    assert.equal(getEventListeners(signal, 'abort').length, 0);
  } finally {
    await scheduler.stop();
  }
});

test('a run that ends while stop() waits is recorded as ended despite a store error', async (t) => {
  if (!(await probeRedis(REDIS_URL))) return t.skip('no Redis');
  const prefix = `test:${uniqueId('stop-finish')}:`;
  const backend = new RedisBackend({ redis: REDIS_URL, prefix });
  const runs = backend.runs!;
  const finish = runs.finish.bind(runs);
  let failures = 1;
  runs.finish = async (...args) => {
    if (failures-- > 0) throw new Error('connection reset');
    return finish(...args);
  };
  const scheduler = new Scheduler({
    backend,
    leaseMs: 1_000,
    heartbeatMs: 200,
  });
  let started = false;
  // Ignores ctx.signal on purpose
  scheduler.at(
    'job',
    Date.now() + 100,
    async () => {
      started = true;
      await sleep(300);
    },
    { jitterMs: 0 },
  );
  scheduler.on('error', () => {});
  await scheduler.start();
  while (!started) await sleep(20);
  await scheduler.stop();
  const reader = new RedisBackend({ redis: REDIS_URL, prefix });
  try {
    assert.deepEqual(
      await reader.runs!.active('job'),
      [],
      'the run is ended in the store, so no backup runs it again',
    );
  } finally {
    await reader.close();
  }
});

test('a heartbeat that reaches the store after the run ended raises no "lost" and leaves ctx.signal alone', async (t) => {
  if (!(await probeRedis(REDIS_URL))) return t.skip('no Redis');
  const backend = new RedisBackend({
    redis: REDIS_URL,
    prefix: `test:${uniqueId('late-beat')}:`,
  });
  const runs = backend.runs!;
  const finish = runs.finish.bind(runs);
  runs.finish = async (...args) => {
    const ended = await finish(...args);
    await sleep(500);
    return ended;
  };
  const scheduler = new Scheduler({
    backend,
    leaseMs: 1_000,
    heartbeatMs: 200,
  });
  const lost: unknown[] = [];
  let signal: AbortSignal | undefined;
  scheduler.every(
    'job',
    '1h',
    (ctx: JobContext) => {
      signal = ctx.signal;
    },
    { catchUpMs: 0 },
  );
  scheduler.on('lost', (e) => lost.push(e));
  await scheduler.start();
  try {
    assert.equal((await scheduler.runNow('job')).status, 'success');
    assert.deepEqual(lost, []);
    assert.equal(signal?.aborted, false);
  } finally {
    await scheduler.stop();
  }
});

test('a run taken over by a backup raises "lost" with the run, its due time and the attempt', async (t) => {
  if (!(await probeRedis(REDIS_URL))) return t.skip('no Redis');
  const backend = new RedisBackend({
    redis: REDIS_URL,
    prefix: `test:${uniqueId('lost')}:`,
  });
  backend.runs!.heartbeat = async () => false;
  const scheduler = new Scheduler({
    backend,
    leaseMs: 1_000,
    heartbeatMs: 100,
    instanceId: 'A',
  });
  const due = Date.now() + 100;
  scheduler.at(
    'job',
    due,
    (ctx: JobContext) =>
      delay(5_000, undefined, { signal: ctx.signal }).catch(() => {}),
    { jitterMs: 0 },
  );
  const lost = new Promise<LostEvent>((resolve) =>
    scheduler.on('lost', resolve),
  );
  await scheduler.start();
  try {
    const event = await lost;
    assert.deepEqual(event, {
      job: 'job',
      slot: event.slot,
      scheduledAt: new Date(event.slot),
      attempt: 1,
      instanceId: 'A',
    });
    assert.ok(Math.abs(event.slot - due) < 1_000);
  } finally {
    await scheduler.stop();
  }
});

test('a heartbeat still on its way when stop() hands the run over does not renew the released lease', async (t) => {
  if (!(await probeRedis(REDIS_URL))) return t.skip('no Redis');
  const prefix = `test:${uniqueId('release-beat')}:`;
  const backend = new RedisBackend({ redis: REDIS_URL, prefix });
  const runs = backend.runs!;
  const heartbeat = runs.heartbeat.bind(runs);
  let sent = () => {};
  const inFlight = new Promise<void>((resolve) => {
    sent = resolve;
  });
  runs.heartbeat = async (...args) => {
    sent();
    await sleep(300);
    return heartbeat(...args);
  };
  const scheduler = new Scheduler({
    backend,
    leaseMs: 2_000,
    heartbeatMs: 200,
  });
  const handedOver: boolean[] = [];
  scheduler.at(
    'job',
    Date.now() + 100,
    (ctx: JobContext) => delay(5_000, undefined, { signal: ctx.signal }),
    { jitterMs: 0 },
  );
  scheduler.on('interrupted', (e) => handedOver.push(e.handedOver));
  scheduler.on('error', () => {});
  await scheduler.start();
  await inFlight;
  await scheduler.stop();
  await sleep(400);
  const reader = new RedisBackend({ redis: REDIS_URL, prefix });
  try {
    assert.deepEqual(handedOver, [true]);
    const [run] = await reader.runs!.active('job');
    assert.equal(
      run?.alive,
      false,
      'the lease stays released, so a backup takes over at once',
    );
  } finally {
    await reader.close();
  }
});

test('a slow heartbeat does not hold back the next one', async (t) => {
  if (!(await probeRedis(REDIS_URL))) return t.skip('no Redis');
  const backend = new RedisBackend({
    redis: REDIS_URL,
    prefix: `test:${uniqueId('slow-beat')}:`,
  });
  const runs = backend.runs!;
  const heartbeat = runs.heartbeat.bind(runs);
  let sent = 0;
  runs.heartbeat = async (...args) => {
    sent++;
    await sleep(500);
    return heartbeat(...args);
  };
  const scheduler = new Scheduler({
    backend,
    leaseMs: 2_000,
    heartbeatMs: 200,
  });
  scheduler.every('job', '1h', () => sleep(1_500), { catchUpMs: 0 });
  await scheduler.start();
  try {
    await scheduler.runNow('job');
    assert.ok(
      sent >= 5,
      `${sent} heartbeats sent in 1.5 s at a 200 ms interval`,
    );
  } finally {
    await scheduler.stop();
  }
});
