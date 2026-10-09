/**
 * What is specific to the Postgres, SQLite, RabbitMQ and NATS backends. (The shared contract is in
 * backends.test.ts, the lease rules in lease.test.ts.)
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Client, Pool } from 'pg';
import postgres from 'postgres';
import { describe, test } from 'vitest';

import { type Backend, PostgresBackend, RabbitMQBackend, Scheduler, type SqlClient, SqliteBackend, type SqlRow } from '../src';
import {
  makeBackend,
  POSTGRES_URL,
  probePostgres,
  probeRabbit,
  probeSqlite,
  queueSpecs,
  RABBITMQ_URL,
  SQLITE_DIR,
  sleep,
  sqlSpecs,
  uniqueId,
} from './helpers';

const futureSlot = (seconds: number) => Math.ceil(Date.now() / 1000) * 1000 + seconds * 1000;
const input = (slot: number, instanceId: string, token = randomUUID()) => ({ job: 'job', slot, token, instanceId, historySize: 1000 });

async function race(backends: Backend[], runs = 10): Promise<void> {
  await Promise.all(backends.map((b) => b.init()));
  const base = futureSlot(60);
  for (let i = 0; i < runs; i++) {
    const wins = await Promise.all(backends.map((b, n) => b.claim(input(base + i * 1000, `i${n}`))));
    assert.equal(wins.filter(Boolean).length, 1, `run ${i}: exactly one winner, got ${JSON.stringify(wins)}`);
  }
}

describe('Postgres and SQLite', () => {
  test('Postgres with your own pg Pool, pg Client or postgres.js (not closed on stop)', async (t) => {
    if (!(await probePostgres(POSTGRES_URL))) return t.skip(`nothing at ${POSTGRES_URL}`);
    const pools = [0, 1, 2].map(() => new Pool({ connectionString: POSTGRES_URL }));
    const clients = [0, 1, 2].map(() => new Client({ connectionString: POSTGRES_URL }));
    await Promise.all(clients.map((c) => c.connect()));
    const sqls = [0, 1, 2].map(() => postgres(POSTGRES_URL, { onnotice: () => {} }));
    try {
      for (const [name, connections] of [
        ['pool', pools],
        ['client', clients],
        ['postgresjs', sqls],
      ] as const) {
        const table = `t_${uniqueId(name)}`;
        const backends = connections.map((connection) => new PostgresBackend({ connection: connection as never, table }));
        await race(backends);
        await Promise.all(backends.map((b) => b.close()));
      }
      assert.equal((await pools[0]!.query('SELECT 1 AS one')).rows[0].one, 1, 'pg Pool still open');
      assert.equal((await clients[0]!.query('SELECT 1 AS one')).rows[0].one, 1, 'pg Client still open');
      assert.equal((await sqls[0]!`SELECT 1 AS one`)[0]!.one, 1, 'postgres.js still open');
    } finally {
      await Promise.all(pools.map((p) => p.end()));
      await Promise.all(clients.map((c) => c.end()));
      await Promise.all(sqls.map((s) => s.end()));
    }
  });

  test('table names are checked, and a custom client must support transactions', () => {
    assert.throws(() => new SqliteBackend({ table: 'runs; DROP TABLE x' }), /Invalid table name/);
    assert.doesNotThrow(() => new PostgresBackend({ table: 'jobs.cron_runs' }));
    const backend = new PostgresBackend({ connection: { all: async () => [] } as never });
    return assert.rejects(backend.init(), /needs both all\(\) and transaction\(\)/);
  });

  test('SQLite waits when a new file is locked by another instance that is starting too', async (t) => {
    if (!(await probeSqlite())) return t.skip('this Node has no node:sqlite');
    const { DatabaseSync } = await import('node:sqlite');
    const file = join(SQLITE_DIR, `anarchon-${uniqueId('newfile')}.db`);
    const other = new DatabaseSync(file);
    other.exec('BEGIN IMMEDIATE; CREATE TABLE other (a)');
    setTimeout(() => other.exec('COMMIT'), 200);
    const backend = new SqliteBackend({ database: file, table: 't_newfile' });
    try {
      await backend.init();
      assert.equal(await backend.claim(input(futureSlot(60), 'A')), true);
    } finally {
      await backend.close();
      other.close();
    }
  });

  test('a backup checking on a live run reads only: no write transaction', async (t) => {
    if (!(await probeSqlite())) return t.skip('this Node has no node:sqlite');
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    let transactions = 0;
    const client: SqlClient = {
      all: async (sql, params) => db.prepare(sql).all(...params) as SqlRow[],
      transaction: async (fn) => {
        transactions++;
        db.exec('BEGIN IMMEDIATE');
        try {
          const result = await fn(client);
          db.exec('COMMIT');
          return result;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
    };
    const backend = new SqliteBackend({ database: client, table: 't_reads' });
    const slot = futureSlot(60);
    const base = { historySize: 100, leaseMs: 5_000, overlap: 'skip' as const, maxAttempts: 3 };
    const takeover = { ...base, mode: 'takeover' as const, reason: 'takeover' as const };
    await backend.init();
    assert.deepEqual(await backend.claim({ ...input(slot, 'A'), ...base, mode: 'new', reason: 'scheduled' }), { kind: 'won', attempt: 1 });
    assert.equal(transactions, 1);
    assert.deepEqual(await backend.claim({ ...input(slot, 'B'), ...takeover }), { kind: 'running', attempt: 1 });
    assert.deepEqual(await backend.claim({ ...input(slot + 1_000, 'B'), ...takeover }), { kind: 'none' });
    assert.equal(transactions, 1);
  });

  describe('history keeps one record per attempt, and a small historySize is fine', async () => {
    for (const { label, spec, skip } of await sqlSpecs()) {
      test.skipIf(skip)(label, async () => {
        const scheduler = new Scheduler({ backend: makeBackend({ ...spec, id: uniqueId('small') }), instanceId: 'api-1' });
        // With leases, history can be smaller than the time a late claim may take (this used to be refused)
        scheduler.every('job', '1s', () => {}, { historySize: 3, jitterMs: 0, catchUpMs: 0 });
        await scheduler.start();
        try {
          for (let i = 0; i < 5; i++) await scheduler.runNow('job');
          const history = await scheduler.history('job', 20);
          assert.ok(history.length >= 3 && history.length <= 6, `kept ${history.length}`);
          assert.ok(history.every((r) => r.manual && r.status === 'success' && r.instanceId === 'api-1'));
        } finally {
          await scheduler.stop();
        }
      });
    }
  });
});

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
