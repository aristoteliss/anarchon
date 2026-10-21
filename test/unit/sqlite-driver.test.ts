/* Copyright (C) 2026-present Aristotelis — see repository license. */

import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, vi } from 'vitest';

import { SqliteBackend } from '../../src';

vi.mock('node:sqlite', () => {
  throw Object.assign(new Error('No such built-in module: node:sqlite'), {
    code: 'ERR_UNKNOWN_BUILTIN_MODULE',
  });
});
vi.mock('better-sqlite3', () => {
  throw new Error("Cannot find module 'better-sqlite3'");
});

test('without a SQLite driver, the error names the Node versions that have node:sqlite and the alternative', async () => {
  const backend = new SqliteBackend({
    database: join(tmpdir(), 'anarchon-no-driver.db'),
  });
  await assert.rejects(backend.init(), (error: Error) => {
    assert.match(error.message, /Node 22\.13\+/);
    assert.match(error.message, /22\.5\+ with --experimental-sqlite/);
    assert.match(error.message, /"better-sqlite3" isn't installed/);
    return true;
  });
});
