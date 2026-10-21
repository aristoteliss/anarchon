/* Copyright (C) 2026-present Aristotelis — see repository license. */

import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  fromSqliteDatabase,
  Scheduler,
  SqlBackend,
  type SqlClient,
  type SqlDialect,
} from '../../src';

/** A SQL backend of its own, built only from what the package exports. */
class EmbeddedSqlBackend extends SqlBackend {
  readonly name = 'embedded-sql';
  protected readonly dialect: SqlDialect = {
    bigint: 'INTEGER',
    nowMs: `CAST(ROUND((julianday('now') - 2440587.5) * 86400000.0) AS INTEGER)`,
    forUpdate: '',
    placeholders: (sql) => sql,
    extraTables: () => [],
    serialize: async () => {},
    isAlreadyCreated: () => false,
  };

  constructor() {
    super('embedded_runs');
  }

  protected async connect(): Promise<{ client: SqlClient; owned: boolean }> {
    const { DatabaseSync } = await import('node:sqlite');
    return {
      client: fromSqliteDatabase(new DatabaseSync(':memory:')),
      owned: true,
    };
  }

  protected async checkServer(): Promise<void> {}
}

test('a SQL backend for another database can be built on SqlBackend, with leases and history', async (t) => {
  try {
    await import('node:sqlite');
  } catch {
    return t.skip('this Node has no node:sqlite');
  }
  const scheduler = new Scheduler({
    backend: new EmbeddedSqlBackend(),
    instanceId: 'A',
  });
  scheduler.every('job', '1h', () => {}, { maxAttempts: 2 });
  await scheduler.start();
  try {
    assert.equal((await scheduler.runNow('job')).status, 'success');
    const [run] = await scheduler.history('job', 1);
    assert.equal(run?.instanceId, 'A');
    assert.equal(run?.status, 'success');
  } finally {
    await scheduler.stop();
  }
});
