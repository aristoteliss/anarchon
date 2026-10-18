/* Copyright (C) 2026-present Aristotelis — see repository license. */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'vitest';

import { type Backend, type ErrorCode, isAnarchonError, RabbitMQBackend, Scheduler, type SqlClient, SqliteBackend } from '../../src';

const memoryBackend = (): Backend => ({
  name: 'memory',
  dedupeWindowMs: Infinity,
  init: async () => {},
  prepareJob: async () => {},
  claim: async () => true,
  recordManualRun: async () => undefined,
  saveResult: async () => {},
  history: async () => [],
  close: async () => {},
});

function code(action: () => unknown): ErrorCode | undefined {
  try {
    action();
  } catch (error) {
    return isAnarchonError(error) ? error.code : undefined;
  }
  return undefined;
}

afterEach(() => {
  Scheduler.reset();
});

test('errors carry a stable code, so callers need not match on the message', async () => {
  const scheduler = new Scheduler({ backend: memoryBackend() });
  const rabbit = new Scheduler({ backend: new RabbitMQBackend() });
  scheduler.every('a', '1h', () => {});

  assert.equal(
    code(() => scheduler.every('b', '500ms', () => {})),
    'ANARCHON_INVALID_ARGUMENT',
  );
  assert.equal(
    code(() => scheduler.every('b', '1m', () => {}, { timeoutMS: 1 } as never)),
    'ANARCHON_UNKNOWN_OPTION',
  );
  assert.equal(
    code(() => rabbit.every('b', '1m', () => {}, { overlap: 'allow' } as never)),
    'ANARCHON_UNSUPPORTED',
  );
  assert.equal(
    code(() => rabbit.every('c', '1h', () => {}, { maxLateMs: 3_600_000 })),
    'ANARCHON_UNSAFE_JOB',
  );
  assert.equal(
    code(() => scheduler.every('a', '1h', () => {})),
    'ANARCHON_JOB_EXISTS',
  );
  assert.equal(
    code(() => scheduler.nextRun('missing')),
    'ANARCHON_UNKNOWN_JOB',
  );
  assert.equal(
    code(() => new Scheduler({ name: 'x', backend: memoryBackend() }) && new Scheduler({ name: 'x', backend: memoryBackend() })),
    'ANARCHON_SCHEDULER_EXISTS',
  );
  assert.equal(
    code(() => Scheduler.get('nobody')),
    'ANARCHON_NO_SCHEDULER',
  );
  await assert.rejects(scheduler.runNow('a'), (error) => isAnarchonError(error, 'ANARCHON_STATE'));

  const oldClient: SqlClient = {
    all: async () => [{ v: '3.30.0' }],
    transaction: async (fn) => fn({ all: async () => [] }),
    close: async () => {},
  };
  await assert.rejects(new SqliteBackend({ database: oldClient }).init(), (error) => isAnarchonError(error, 'ANARCHON_SERVER'));

  const futureClient: SqlClient = {
    all: async (sql) => (sql.includes('sqlite_version') ? [{ v: '3.35.0' }] : sql.includes('SELECT value FROM') ? [{ value: '999' }] : []),
    transaction: async (fn) => fn({ all: async () => [] }),
    close: async () => {},
  };
  await assert.rejects(new SqliteBackend({ database: futureClient }).init(), (error) => isAnarchonError(error, 'ANARCHON_STORE_FORMAT'));

  const refusedManual = new Scheduler({
    backend: {
      ...memoryBackend(),
      runs: {
        claim: async () => ({ kind: 'done' }),
        heartbeat: async () => true,
        finish: async () => true,
        release: async () => true,
        active: async () => [],
      },
    },
  });
  refusedManual.every('a', '1h', () => {});
  await refusedManual.start();
  await assert.rejects(refusedManual.runNow('a'), (error) => isAnarchonError(error, 'ANARCHON_STORE'));
  await refusedManual.stop();

  const error = (() => {
    try {
      scheduler.every('b', '500ms', () => {});
    } catch (caught) {
      return caught;
    }
  })();
  assert.ok(error instanceof RangeError, 'the error class is kept');
});

test('a named scheduler that default settings with one backend object cannot create is ANARCHON_NO_SCHEDULER', () => {
  Scheduler.configure({ backend: memoryBackend() });
  assert.equal(
    code(() => Scheduler.get('billing')),
    'ANARCHON_NO_SCHEDULER',
  );
});

test('every Error constructed and thrown in src/ is wrapped in coded(), and every ErrorCode is used', () => {
  const srcDir = join(__dirname, '../../src');
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
    });
  const allFiles = files(srcDir);
  const stripComments = (source: string): string =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ''))
      .split('\n')
      .map((line) => (line.trimStart().startsWith('//') ? '' : line))
      .join('\n');
  const uncoded = allFiles.flatMap((file) => {
    const clean = stripComments(readFileSync(file, 'utf8'));
    return [...clean.matchAll(/\bthrow\s+new\s+\w*Error\b/g)].map((m) => `${file}:${clean.slice(0, m.index).split('\n').length}`);
  });
  assert.deepEqual(uncoded, []);

  const errorsSource = readFileSync(join(srcDir, 'errors.ts'), 'utf8');
  const declaredCodes = [...errorsSource.matchAll(/\|\s*'(ANARCHON_[A-Z_]+)'/g)].map((m) => m[1]);
  assert.ok(declaredCodes.length > 0);
  const nonErrorsSource = allFiles
    .filter((file) => !file.endsWith('/errors.ts'))
    .map((file) => stripComments(readFileSync(file, 'utf8')))
    .join('\n');
  const unusedCodes = declaredCodes.filter((name) => !nonErrorsSource.includes(`'${name}'`));
  assert.deepEqual(unusedCodes, []);
});
