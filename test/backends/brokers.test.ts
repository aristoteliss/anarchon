/* Copyright (C) 2026-present Aristotelis — see repository license. */

/** What is specific to RabbitMQ and NATS: the simple claim, and NATS with the 'lease' strategy. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { jetstreamManager } from '@nats-io/jetstream';
import { Kvm } from '@nats-io/kv';
import { connect } from '@nats-io/transport-node';
import { describe, test } from 'vitest';

import {
  isAnarchonError,
  NatsBackend,
  RabbitMQBackend,
  type RabbitMQConnectionLike,
  type RunClaim,
  type RunStore,
  Scheduler,
} from '../../src';
import {
  makeBackend,
  NATS_URL,
  probeNats,
  probeRabbit,
  queueSpecs,
  RABBITMQ_URL,
  sleep,
  uniqueId,
} from '../support';

const futureSlot = (seconds: number) =>
  Math.ceil(Date.now() / 1000) * 1000 + seconds * 1000;
const input = (slot: number, instanceId: string, token = randomUUID()) => ({
  job: 'job',
  slot,
  token,
  instanceId,
  historySize: 1000,
});

describe('RabbitMQ and NATS (simple claim)', () => {
  test('a RabbitMQ gate queue holds one claim and deletes itself after slotTtlMs', async (t) => {
    if (!(await probeRabbit(RABBITMQ_URL)))
      return t.skip(`nothing at ${RABBITMQ_URL}`);
    const id = uniqueId('gate');
    const backend = new RabbitMQBackend({
      url: RABBITMQ_URL,
      prefix: `${id}.`,
      slotTtlMs: 1_500,
    });
    const amqp = await import('amqplib');
    const connection = await amqp.connect(RABBITMQ_URL);
    try {
      await backend.init();
      const slot = futureSlot(10);
      const mine = input(slot, 'A');
      assert.equal(await backend.claim(mine), true);
      assert.equal(
        await backend.claim(mine),
        true,
        'the same claim again is still ours',
      );
      assert.equal(await backend.claim(input(slot, 'B')), false);
      const queue = `${id}.job.slot.${slot}`;
      const channel = await connection.createChannel();
      assert.equal(
        (await channel.checkQueue(queue)).messageCount,
        1,
        'the gate holds exactly one claim',
      );
      await channel.close();
      await sleep(3_000);
      const after = await connection.createChannel();
      after.on('error', () => {});
      await assert.rejects(
        after.checkQueue(queue),
        /404|NOT_FOUND/,
        'the gate deleted itself',
      );
    } finally {
      await connection.close().catch(() => {});
      await backend.close();
    }
  });

  test('RabbitMQ instances with different slotTtlMs or historySize share a job, and a refused declaration fails no other claim', async (t) => {
    if (!(await probeRabbit(RABBITMQ_URL)))
      return t.skip(`nothing at ${RABBITMQ_URL}`);
    const prefix = `${uniqueId('args')}.`;
    const a = new RabbitMQBackend({
      url: RABBITMQ_URL,
      prefix,
      slotTtlMs: 60_000,
    });
    const b = new RabbitMQBackend({
      url: RABBITMQ_URL,
      prefix,
      slotTtlMs: 120_000,
    });
    try {
      const slot = futureSlot(10);
      assert.equal(await a.claim(input(slot, 'A')), true);
      const claims = await Promise.all([
        b.claim(input(slot, 'B')),
        b.claim({ ...input(slot, 'B'), job: 'other' }),
      ]);
      assert.deepEqual(claims, [false, true]);
      await a.prepareJob('job', 100);
      await b.prepareJob('job', 5_000);
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });

  test('NATS history() leaves no consumer behind on the server', async (t) => {
    if (!(await probeNats(NATS_URL))) return t.skip(`nothing at ${NATS_URL}`);
    const id = uniqueId('consumers');
    const stream = id.toUpperCase();
    const backend = new NatsBackend({
      servers: NATS_URL,
      prefix: `${id}.`,
      stream,
    });
    const nc = await connect({ servers: NATS_URL });
    try {
      await backend.init();
      assert.equal(await backend.claim(input(futureSlot(10), 'A')), true);
      for (let i = 0; i < 3; i++)
        assert.equal((await backend.history('job', 10)).length, 1);
      const jsm = await jetstreamManager(nc);
      assert.deepEqual(await jsm.consumers.list(stream).next(), []);
    } finally {
      await backend.close();
      await nc.close();
    }
  });

  test('RabbitMQ and NATS keep history by count only, so they refuse historyTtlMs', () => {
    for (const backend of [new RabbitMQBackend(), new NatsBackend()]) {
      const scheduler = new Scheduler({ backend });
      assert.throws(
        () => scheduler.every('a', '1m', () => {}, { historyTtlMs: 60_000 }),
        new RegExp(`Job "a": historyTtlMs.*${backend.name}`),
      );
      assert.throws(
        () =>
          new Scheduler({ backend, historyTtlMs: 60_000 }).every(
            'b',
            '1m',
            () => {},
          ),
        /Job "b": historyTtlMs/,
      );
    }
  });

  test('NATS keeps as many runs per job as the job that asks for the most', async (t) => {
    if (!(await probeNats(NATS_URL))) return t.skip(`nothing at ${NATS_URL}`);
    const id = uniqueId('history_size');
    const stream = id.toUpperCase();
    const scheduler = new Scheduler({
      backend: new NatsBackend({
        servers: NATS_URL,
        prefix: `${id}.`,
        stream,
        historySize: 100,
      }),
    });
    scheduler
      .every('small', '1h', () => {}, { historySize: 50 })
      .every('big', '1h', () => {}, { historySize: 300 });
    const nc = await connect({ servers: NATS_URL });
    const jsm = await jetstreamManager(nc);
    const kept = async () =>
      (await jsm.streams.info(stream)).config.max_msgs_per_subject;
    try {
      await scheduler.start();
      assert.equal(await kept(), 300);
      scheduler.every('bigger', '1h', () => {}, { historySize: 500 });
      await scheduler.runNow('bigger');
      assert.equal(await kept(), 500);
    } finally {
      await scheduler.stop();
      await jsm.streams.delete(stream);
      await nc.close();
    }
  });

  test('RabbitMQ and NATS job names must be simple (they become queue names and subjects)', () => {
    const backend = new RabbitMQBackend();
    assert.throws(
      () =>
        backend.checkJob({
          name: 'a.b',
          jitterMs: 0,
          maxLateMs: 1,
          minGapMs: 1000,
          historySize: 1,
        }),
      /letters, digits/,
    );
  });

  test('RabbitMQ reopens its confirm channel and connection after a failure or close', async (t) => {
    if (!(await probeRabbit(RABBITMQ_URL)))
      return t.skip(`nothing at ${RABBITMQ_URL}`);
    const amqp = await import('amqplib');
    const raw = await amqp.connect(RABBITMQ_URL);
    const channels: Array<{ close(): Promise<void> }> = [];
    let failFirst = true;
    const connection: RabbitMQConnectionLike = {
      connection: raw.connection,
      createChannel: () => raw.createChannel(),
      createConfirmChannel: async () => {
        if (failFirst) {
          failFirst = false;
          throw new Error('temporary channel failure');
        }
        const ch = await raw.createConfirmChannel();
        channels.push(ch);
        return ch;
      },
      close: () => raw.close(),
      on: (event, listener) =>
        raw.on(event, listener as (...args: unknown[]) => void),
    };
    const prefix = `${uniqueId('recover')}.`;
    const withCustom = new RabbitMQBackend({ connection, prefix });
    const withOwned = new RabbitMQBackend({
      url: RABBITMQ_URL,
      prefix: `${uniqueId('reconnect')}.`,
    });
    try {
      const slot = futureSlot(10);
      await assert.rejects(
        withCustom.claim(input(slot, 'A')),
        /temporary channel failure/,
      );
      assert.equal(await withCustom.claim(input(slot, 'A')), true);
      assert.equal(channels.length, 1);
      await channels[0]?.close();
      assert.equal(await withCustom.claim(input(slot + 1000, 'A')), true);
      assert.equal(channels.length, 2);

      assert.equal(await withOwned.claim(input(slot, 'A')), true);
      const firstConn = await (
        withOwned as unknown as {
          connection: Promise<{ close(): Promise<void> }>;
        }
      ).connection;
      await firstConn.close();
      assert.equal(await withOwned.claim(input(slot + 1000, 'A')), true);
    } finally {
      await Promise.all([
        withCustom.close(),
        withOwned.close(),
        raw.close().catch(() => {}),
      ]);
    }
  });

  test('NATS updates the replicas of an existing stream when replicas is given', async (t) => {
    if (!(await probeNats(NATS_URL))) return t.skip(`nothing at ${NATS_URL}`);
    const id = uniqueId('replicas');
    const stream = id.toUpperCase();
    const first = new NatsBackend({
      servers: NATS_URL,
      prefix: `${id}.`,
      stream,
      replicas: 1,
    });
    const second = new NatsBackend({
      servers: NATS_URL,
      prefix: `${id}.`,
      stream,
      replicas: 3,
    });
    const nc = await connect({ servers: NATS_URL });
    const jsm = await jetstreamManager(nc);
    try {
      await first.init();
      await assert.rejects(second.init(), /replicas > 1 not supported/);
    } finally {
      await Promise.all([first.close(), second.close()]);
      await jsm.streams.delete(stream).catch(() => {});
      await nc.close();
    }
  });

  test('NATS leaves the replicas of an existing stream alone unless replicas is given', async () => {
    const updates: Array<{ num_replicas?: number }> = [];
    const jsm = {
      streams: {
        info: async () => ({
          config: {
            subjects: ['cron.>'],
            duplicate_window: 300_000 * 1_000_000,
            max_msgs_per_subject: 1_000,
            num_replicas: 3,
          },
        }),
        update: async (_name: string, config: { num_replicas?: number }) => {
          updates.push(config);
        },
      },
    };
    const ensureStream = (backend: NatsBackend) =>
      (
        backend as unknown as { ensureStream(j: unknown): Promise<void> }
      ).ensureStream(jsm);
    await ensureStream(new NatsBackend());
    assert.equal(updates.length, 0);
    await ensureStream(new NatsBackend({ replicas: 3 }));
    assert.equal(updates.length, 0);
    await ensureStream(new NatsBackend({ replicas: 1 }));
    assert.equal(updates[0]?.num_replicas, 1);
  });

  describe('runNow and history work on RabbitMQ and NATS', async () => {
    for (const { label, spec, skip } of await queueSpecs()) {
      test.skipIf(skip)(label, async () => {
        const scheduler = new Scheduler({
          backend: makeBackend({ ...spec, id: uniqueId('now') }),
          instanceId: 'api-1',
        });
        scheduler.every('slow', '1h', () => sleep(400));
        await scheduler.start();
        try {
          const run = scheduler.runNow('slow');
          await sleep(250);
          assert.equal(
            (await scheduler.lastRun('slow'))?.status,
            'running',
            'running while it runs',
          );
          await run;
          const last = await scheduler.lastRun('slow');
          assert.equal(last?.status, 'success');
          assert.equal(last?.manual, true);
          assert.equal(last?.instanceId, 'api-1');
        } finally {
          await scheduler.stop();
        }
      });
    }
  });
});

describe("NATS with the 'lease' strategy", () => {
  /** A lease backend with its own stream, subjects and bucket. */
  const fresh = (name: string, id = uniqueId(name)) => {
    const backend = new NatsBackend({
      servers: NATS_URL,
      prefix: `${id}.`,
      stream: id.toUpperCase(),
      strategy: 'lease',
    });
    return { backend, runs: backend.runs, bucket: `${id.toUpperCase()}_RUNS` };
  };
  const claim = (slot: number, token: string, extra: Partial<RunClaim> = {}) =>
    ({
      job: 'job',
      slot,
      token,
      instanceId: 'A',
      historySize: 100,
      leaseMs: 60_000,
      overlap: 'allow',
      maxAttempts: 3,
      mode: 'new',
      reason: 'scheduled',
      ...extra,
    }) satisfies RunClaim;

  test('the runs of a job are one key in the bucket <stream>_RUNS, and history stays in the stream', async (t) => {
    if (!(await probeNats(NATS_URL))) return t.skip(`nothing at ${NATS_URL}`);
    const { backend, runs, bucket } = fresh('bucket');
    const nc = await connect({ servers: NATS_URL });
    try {
      await backend.init();
      const slot = futureSlot(10);
      assert.equal((await runs.claim(claim(slot, 'a'))).kind, 'won');

      const kv = await new Kvm(nc).open(bucket);
      const keys: string[] = [];
      for await (const key of await kv.keys()) keys.push(key);
      assert.deepEqual(keys.sort(), ['job', 'meta.format']);
      const [record] = await backend.history('job', 10);
      assert.deepEqual(
        [record?.slot, record?.attempt, record?.reason, record?.status],
        [slot, 1, 'scheduled', 'running'],
      );
    } finally {
      await backend.close();
      await nc.close();
    }
  });

  test('a takeover keeps the fields it does not know, so an older instance never drops what a newer one wrote', async (t) => {
    if (!(await probeNats(NATS_URL))) return t.skip(`nothing at ${NATS_URL}`);
    const { backend, runs, bucket } = fresh('fields');
    const nc = await connect({ servers: NATS_URL });
    try {
      const slot = Date.now();
      assert.equal(
        (await runs.claim(claim(slot, 'a', { leaseMs: 50 }))).kind,
        'won',
      );
      const kv = await new Kvm(nc).open(bucket);
      const entry = await kv.get('job');
      const stored = entry?.json<{ runs: Record<string, object> }>();
      const run = { ...stored?.runs[slot], future: 'kept' };
      const value = { ...stored, runs: { [slot]: run }, later: 'kept' };
      await kv.update('job', JSON.stringify(value), entry?.revision ?? 0);
      await sleep(100);

      assert.deepEqual(
        await runs.claim(
          claim(slot, 'b', { instanceId: 'B', mode: 'takeover' }),
        ),
        { kind: 'won', attempt: 2 },
      );
      const after = (await kv.get('job'))?.json<{
        later: string;
        runs: Record<string, { future: string; a: number; i: string }>;
      }>();
      assert.equal(after?.later, 'kept');
      assert.deepEqual(
        [after?.runs[slot]?.future, after?.runs[slot]?.a, after?.runs[slot]?.i],
        ['kept', 2, 'B'],
      );
    } finally {
      await backend.close();
      await nc.close();
    }
  });

  test('a bucket that records a newer store format is refused', async (t) => {
    if (!(await probeNats(NATS_URL))) return t.skip(`nothing at ${NATS_URL}`);
    const id = uniqueId('format');
    const first = fresh('format', id);
    const nc = await connect({ servers: NATS_URL });
    try {
      await first.backend.init();
      const kv = await new Kvm(nc).open(first.bucket);
      await kv.put('meta.format', '2');

      const later = fresh('format', id).backend;
      await assert.rejects(later.init(), (error) =>
        isAnarchonError(error, 'ANARCHON_STORE_FORMAT'),
      );
      await later.close();
    } finally {
      await first.backend.close();
      await nc.close();
    }
  });

  test('writes to one job from many instances at once all land, each decided again after losing a race', async (t) => {
    if (!(await probeNats(NATS_URL))) return t.skip(`nothing at ${NATS_URL}`);
    const id = uniqueId('races');
    const instances = Array.from({ length: 4 }, () => fresh('races', id));
    const stores: RunStore[] = instances.map(({ runs }) => runs);
    const first = futureSlot(10);
    try {
      const won = await Promise.all(
        stores.flatMap((runs, n) =>
          [0, 1, 2].map((k) =>
            runs.claim(claim(first + n * 10 + k, `t${n}${k}`)),
          ),
        ),
      );
      assert.deepEqual(
        new Set(won.map((outcome) => outcome.kind)),
        new Set(['won']),
      );

      const renewed = await Promise.all(
        stores.flatMap((runs, n) =>
          [0, 1, 2].map((k) =>
            runs.heartbeat('job', first + n * 10 + k, `t${n}${k}`, 60_000),
          ),
        ),
      );
      assert.deepEqual(new Set(renewed), new Set([true]));
      assert.equal((await stores[0]?.active('job'))?.length, 12);
    } finally {
      await Promise.all(instances.map(({ backend }) => backend.close()));
    }
  });

  test('the stream name must fit a bucket name, and an unknown strategy is refused', () => {
    assert.throws(
      () => new NatsBackend({ stream: 'cron.jobs', strategy: 'lease' }),
      /stream name "cron.jobs" may only contain/,
    );
    assert.throws(
      // @ts-expect-error not a NATS strategy
      () => new NatsBackend({ strategy: 'stream-id' }),
      /unknown strategy "stream-id" \(use "msg-id" or "lease"\)/,
    );
    assert.equal(new NatsBackend().name, 'nats');
    assert.equal(new NatsBackend({ strategy: 'lease' }).name, 'nats:lease');
  });
});
