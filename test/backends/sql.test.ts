/** What is specific to Postgres and SQLite. (The shared contract is in contract.test.ts, the lease rules in ../leases.) */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Client, Pool } from 'pg';
import postgres from 'postgres';
import { describe, test } from 'vitest';

import { type Backend, PostgresBackend, Scheduler, type SqlClient, SqliteBackend, type SqlRow } from '../../src';
import { makeBackend, POSTGRES_URL, probePostgres, probeSqlite, SQLITE_DIR, sqlSpecs, uniqueId } from '../support';

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

  test('SQLite: the server clock never reads earlier than the real one', async (t) => {
    if (!(await probeSqlite())) return t.skip('this Node has no node:sqlite');
    const backend = new SqliteBackend({ database: ':memory:', table: 't_clock' });
    const base = {
      historySize: 100,
      leaseMs: 5_000,
      overlap: 'allow' as const,
      maxAttempts: 1,
      mode: 'new' as const,
      reason: 'scheduled' as const,
    };
    try {
      for (let i = 0; i < 2_000; i++) {
        const outcome = await backend.claim({ ...input(Date.now() - 30_000, 'A'), ...base, maxLateMs: 10_000 });
        assert.ok(outcome.kind === 'late' && outcome.lateMs >= 30_000, `claim ${i}: ${JSON.stringify(outcome)}`);
      }
    } finally {
      await backend.close();
    }
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
          // The job is also due every second, so a scheduled run can be among them (and still running)
          assert.ok(history.every((r) => r.instanceId === 'api-1'));
          assert.ok(history.filter((r) => r.manual).every((r) => r.status === 'success'));
        } finally {
          await scheduler.stop();
        }
      });
    }
  });
});
