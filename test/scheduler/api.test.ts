/* Copyright (C) 2026-present Aristotelis — see repository license. */

import assert from 'node:assert/strict';
import { Redis } from 'ioredis';
import { beforeAll, test } from 'vitest';

import { RedisBackend, type RunRecord, Scheduler, type SkipEvent } from '../../src';
import { probeRedis, REDIS_URL, type ServerInfo, sleep, supportsIdmp, uniqueId } from '../support';

const uniquePrefix = (label: string) => `test:${uniqueId(label)}:`;

let main: ServerInfo | null;
beforeAll(async () => {
  main = await probeRedis(REDIS_URL);
  assert.ok(main, `No Redis at ${REDIS_URL}`);
});

test('defaults to localhost:6379 and reports jobs and next runs', async (t) => {
  // The library's own default, not the test Redis: skipped when nothing listens there.
  if (!(await probeRedis('redis://localhost:6379'))) return t.skip('nothing at redis://localhost:6379');
  const scheduler = new Scheduler({ prefix: uniquePrefix('defaults') });
  scheduler.every('sync', '10s', () => {}).cron('report', '0 */2 * * *', () => {}, { timezone: 'Europe/Athens' });
  await scheduler.start();
  try {
    const jobs = scheduler.jobs();
    assert.deepEqual(
      jobs.map((j) => [j.name, j.type, j.schedule]),
      [
        ['sync', 'every', 'every 10s'],
        ['report', 'cron', 'cron "0 */2 * * *" (Europe/Athens)'],
      ],
    );
    const next = scheduler.nextRun('sync')!;
    assert.equal(next.getTime() % 10_000, 0);
    assert.ok(next.getTime() > Date.now() && next.getTime() <= Date.now() + 10_000);
  } finally {
    await scheduler.stop();
  }
});

test('runNow runs on this instance and shows up in history as manual', async () => {
  const prefix = uniquePrefix('manual');
  const scheduler = new Scheduler({ redis: REDIS_URL, prefix, instanceId: 'api-1' });
  let ranWith: { manual: boolean; instanceId: string } | undefined;
  scheduler.every('backup', '1h30m', (ctx) => {
    ranWith = { manual: ctx.manual, instanceId: ctx.instanceId };
  });
  await scheduler.start();
  try {
    const record = await scheduler.runNow('backup');
    assert.equal(record.status, 'success');
    assert.deepEqual(ranWith, { manual: true, instanceId: 'api-1' });
    const [last] = await scheduler.history('backup');
    assert.equal(last?.manual, true);
    assert.equal(last?.instanceId, 'api-1');
    assert.equal(last?.status, 'success');
  } finally {
    await scheduler.stop();
  }
});

test('a run that is still going shows as running, then success', async () => {
  const prefix = uniquePrefix('running');
  const scheduler = new Scheduler({ redis: REDIS_URL, prefix });
  scheduler.every('slow', '1h', () => sleep(500));
  await scheduler.start();
  try {
    const run = scheduler.runNow('slow');
    await sleep(150);
    assert.equal((await scheduler.lastRun('slow'))?.status, 'running');
    await run;
    const last = await scheduler.lastRun('slow');
    assert.equal(last?.status, 'success');
    assert.ok(last!.durationMs! >= 450);
  } finally {
    await scheduler.stop();
  }
});

test('success/failure events carry who ran it and the error', async () => {
  const prefix = uniquePrefix('events');
  const scheduler = new Scheduler({ redis: REDIS_URL, prefix, instanceId: 'X' });
  const seen: RunRecord[] = [];
  let cause: unknown;
  scheduler
    .every('ok', '1h', () => 'done')
    .every('bad', '1h', () => {
      throw new TypeError('nope');
    })
    .on('success', (r) => seen.push(r))
    .on('failure', (r) => {
      seen.push(r);
      cause = r.cause;
    });
  await scheduler.start();
  try {
    await scheduler.runNow('ok');
    await scheduler.runNow('bad');
    assert.deepEqual(
      seen.map((r) => [r.job, r.status, r.instanceId, r.error]),
      [
        ['ok', 'success', 'X', undefined],
        ['bad', 'failed', 'X', 'TypeError: nope'],
      ],
    );
    assert.ok(cause instanceof TypeError);
  } finally {
    await scheduler.stop();
  }
});

test('stop() aborts ctx.signal and waits for running jobs', async () => {
  const scheduler = new Scheduler({ redis: REDIS_URL, prefix: uniquePrefix('stop') });
  let aborted = false;
  let finished = false;
  scheduler.every('long', '1h', async (ctx) => {
    await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve(), { once: true }));
    aborted = ctx.signal.aborted;
    await sleep(100);
    finished = true;
  });
  await scheduler.start();
  const run = scheduler.runNow('long');
  await sleep(50);
  await scheduler.stop();
  assert.equal(aborted, true);
  assert.equal(finished, true, 'stop waited for the job');
  await run;
});

test('every second, one process: one run per slot and skip events for late or taken runs', async () => {
  const prefix = uniquePrefix('single');
  const a = new Scheduler({ redis: REDIS_URL, prefix, instanceId: 'A' });
  const b = new Scheduler({ redis: REDIS_URL, prefix, instanceId: 'B' });
  const runs: Array<[string, number]> = [];
  const skips: SkipEvent[] = [];
  for (const [s, id] of [
    [a, 'A'],
    [b, 'B'],
  ] as const) {
    s.every(
      'tick',
      '1s',
      (ctx) => {
        runs.push([id, ctx.slot]);
      },
      { jitterMs: 200, catchUpMs: 0 },
    ); // only scheduled runs (a catch-up at start reports no skip)
    s.on('skip', (e) => skips.push(e));
  }
  await Promise.all([a.start(), b.start()]);
  await sleep(4_200);
  await Promise.all([a.stop(), b.stop()]);
  const slots = runs.map(([, slot]) => slot);
  assert.equal(new Set(slots).size, slots.length, `no slot ran twice: ${JSON.stringify(runs)}`);
  assert.ok(slots.length >= 3, `ran ${slots.length} times`);
  assert.ok(skips.every((s) => s.reason === 'taken'));
  // The loser reports each slot it lost (except possibly the last one, if stop() came first).
  assert.ok(skips.length >= slots.length - 1 && skips.length <= slots.length, `${skips.length} skips for ${slots.length} runs`);
});

test('validation errors are clear', () => {
  const s = new Scheduler({ redis: REDIS_URL });
  assert.throws(() => s.every('x', '500ms', () => {}), /at least 1s/);
  assert.throws(() => s.every('x', '10s', () => {}, { jitterMs: 6_000 }), /under half the time between runs/);
  assert.throws(() => s.every('x', '10s', () => {}, { jitterMs: 2_000, maxLateMs: 1_000 }), /bigger than jitterMs/);
  assert.throws(() => s.cron('x', 'nope', () => {}), /invalid cron/);
  s.every('dup', '10s', () => {});
  assert.throws(() => s.every('dup', '10s', () => {}), /already registered/);
  const idmp = new Scheduler({ redis: REDIS_URL, strategy: 'idmp', idmp: { durationSec: 30 } });
  assert.throws(() => idmp.every('x', '10m', () => {}), /shorter than how long redis:idmp remembers a run/);
  assert.throws(() => new Scheduler({ backend: new RedisBackend(), redis: REDIS_URL }), /either backend/);
  assert.throws(() => new Scheduler({ strategy: 'nope' as never }), /Unknown strategy/);
});

test('idmp scheduler refuses to start on Redis < 8.6, and works on 8.6+', async (t) => {
  const scheduler = new Scheduler({ redis: REDIS_URL, strategy: 'idmp', prefix: uniquePrefix('idmp-start') });
  scheduler.every('x', '1h', () => {});
  if (!supportsIdmp(main)) {
    await assert.rejects(scheduler.start(), /needs Redis 8\.6/);
    return t.skip('server has no IDMP');
  }
  await scheduler.start();
  const record = await scheduler.runNow('x');
  assert.equal(record.status, 'success');
  await scheduler.stop();
});

test('does not close a client it did not open', async () => {
  const redis = new Redis(REDIS_URL);
  const scheduler = new Scheduler({ redis, prefix: uniquePrefix('owned') });
  scheduler.every('x', '1h', () => {});
  await scheduler.start();
  await scheduler.stop();
  assert.equal(await redis.ping(), 'PONG');
  await redis.quit();
});

test('at(): a one-off job runs once, on one instance', async () => {
  const prefix = uniquePrefix('at');
  const when = Date.now() + 1_200;
  const ran: string[] = [];
  const schedulers = ['A', 'B', 'C'].map((id) => {
    const s = new Scheduler({ redis: REDIS_URL, prefix, instanceId: id, leaseMs: 2_000, heartbeatMs: 300 });
    s.at('once', new Date(when), (ctx) => void ran.push(`${ctx.instanceId}@${ctx.slot}`), { jitterMs: 200 });
    return s;
  });
  await Promise.all(schedulers.map((s) => s.start()));
  try {
    await sleep(2_000);
    assert.equal(ran.length, 1, `ran: ${ran}`);
    assert.equal(ran[0]!.split('@')[1], String(when));
    assert.equal(schedulers[0]!.nextRun('once'), null, 'nothing left to run');
    assert.equal(schedulers[0]!.jobs()[0]!.type, 'once');
  } finally {
    await Promise.all(schedulers.map((s) => s.stop()));
  }
});

test('log: true writes one line per start and finish', async () => {
  const lines: string[] = [];
  const logger = {
    info: (m: string) => void lines.push(m),
    warn: (m: string) => void lines.push(m),
    error: (m: string) => void lines.push(m),
  };
  const scheduler = new Scheduler({ redis: REDIS_URL, prefix: uniquePrefix('log'), log: true, logger });
  scheduler.every('job', '1h', () => {});
  await scheduler.start();
  try {
    await scheduler.runNow('job');
  } finally {
    await scheduler.stop();
  }
  assert.ok(
    lines.some((l) => /^\[anarchon\] job @ .*: started on .* \(attempt 1, manual\)$/.test(l)),
    lines.join('\n'),
  );
  assert.ok(
    lines.some((l) => /^\[anarchon\] job @ .*: finished in \d+ ms$/.test(l)),
    lines.join('\n'),
  );
});

test('historyTtlMs drops history older than the limit', async () => {
  const scheduler = new Scheduler({ redis: REDIS_URL, prefix: uniquePrefix('ttl'), historyTtlMs: 1_000 });
  scheduler.every('job', '1h', () => {});
  await scheduler.start();
  try {
    await scheduler.runNow('job');
    await sleep(1_200);
    await scheduler.runNow('job');
    const history = await scheduler.history('job', 10);
    assert.equal(history.filter((r) => r.status === 'success').length, 1, JSON.stringify(history));
  } finally {
    await scheduler.stop();
  }
});
