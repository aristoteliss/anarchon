/* Copyright (C) 2026-present Aristotelis — see repository license. */

/** What is specific to RabbitMQ and NATS (claim only, no leases). */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { jetstreamManager } from '@nats-io/jetstream';
import { connect } from '@nats-io/transport-node';
import { describe, test } from 'vitest';

import { type Backend, NatsBackend, RabbitMQBackend, Scheduler } from '../../src';
import { makeBackend, NATS_URL, probeNats, probeRabbit, queueSpecs, RABBITMQ_URL, sleep, uniqueId } from '../support';

const futureSlot = (seconds: number) => Math.ceil(Date.now() / 1000) * 1000 + seconds * 1000;
const input = (slot: number, instanceId: string, token = randomUUID()) => ({ job: 'job', slot, token, instanceId, historySize: 1000 });

async function _race(backends: Backend[], runs = 10): Promise<void> {
  await Promise.all(backends.map((b) => b.init()));
  const base = futureSlot(60);
  for (let i = 0; i < runs; i++) {
    const wins = await Promise.all(backends.map((b, n) => b.claim(input(base + i * 1000, `i${n}`))));
    assert.equal(wins.filter(Boolean).length, 1, `run ${i}: exactly one winner, got ${JSON.stringify(wins)}`);
  }
}

describe('RabbitMQ and NATS (simple claim)', () => {
  test('a RabbitMQ gate queue holds one claim and deletes itself after slotTtlMs', async (t) => {
    if (!(await probeRabbit(RABBITMQ_URL))) return t.skip(`nothing at ${RABBITMQ_URL}`);
    const id = uniqueId('gate');
    const backend = new RabbitMQBackend({ url: RABBITMQ_URL, prefix: `${id}.`, slotTtlMs: 1_500 });
    const amqp = await import('amqplib');
    const connection = await amqp.connect(RABBITMQ_URL);
    try {
      await backend.init();
      const slot = futureSlot(10);
      const mine = input(slot, 'A');
      assert.equal(await backend.claim(mine), true);
      assert.equal(await backend.claim(mine), true, 'the same claim again is still ours');
      assert.equal(await backend.claim(input(slot, 'B')), false);
      const queue = `${id}.job.slot.${slot}`;
      const channel = await connection.createChannel();
      assert.equal((await channel.checkQueue(queue)).messageCount, 1, 'the gate holds exactly one claim');
      await channel.close();
      await sleep(3_000);
      const after = await connection.createChannel();
      after.on('error', () => {});
      await assert.rejects(after.checkQueue(queue), /404|NOT_FOUND/, 'the gate deleted itself');
    } finally {
      await connection.close().catch(() => {});
      await backend.close();
    }
  });

  test('RabbitMQ instances with different slotTtlMs or historySize share a job, and a refused declaration fails no other claim', async (t) => {
    if (!(await probeRabbit(RABBITMQ_URL))) return t.skip(`nothing at ${RABBITMQ_URL}`);
    const prefix = `${uniqueId('args')}.`;
    const a = new RabbitMQBackend({ url: RABBITMQ_URL, prefix, slotTtlMs: 60_000 });
    const b = new RabbitMQBackend({ url: RABBITMQ_URL, prefix, slotTtlMs: 120_000 });
    try {
      const slot = futureSlot(10);
      assert.equal(await a.claim(input(slot, 'A')), true);
      const claims = await Promise.all([b.claim(input(slot, 'B')), b.claim({ ...input(slot, 'B'), job: 'other' })]);
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
    const backend = new NatsBackend({ servers: NATS_URL, prefix: `${id}.`, stream });
    const nc = await connect({ servers: NATS_URL });
    try {
      await backend.init();
      assert.equal(await backend.claim(input(futureSlot(10), 'A')), true);
      for (let i = 0; i < 3; i++) assert.equal((await backend.history('job', 10)).length, 1);
      const jsm = await jetstreamManager(nc);
      assert.deepEqual(await jsm.consumers.list(stream).next(), []);
    } finally {
      await backend.close();
      await nc.close();
    }
  });

  test('RabbitMQ and NATS job names must be simple (they become queue names and subjects)', () => {
    const backend = new RabbitMQBackend();
    assert.throws(() => backend.checkJob({ name: 'a.b', jitterMs: 0, maxLateMs: 1, minGapMs: 1000, historySize: 1 }), /letters, digits/);
  });

  describe('runNow and history work on RabbitMQ and NATS', async () => {
    for (const { label, spec, skip } of await queueSpecs()) {
      test.skipIf(skip)(label, async () => {
        const scheduler = new Scheduler({ backend: makeBackend({ ...spec, id: uniqueId('now') }), instanceId: 'api-1' });
        scheduler.every('slow', '1h', () => sleep(400));
        await scheduler.start();
        try {
          const run = scheduler.runNow('slow');
          await sleep(250);
          assert.equal((await scheduler.lastRun('slow'))?.status, 'running', 'running while it runs');
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
