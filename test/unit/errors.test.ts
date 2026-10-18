/* Copyright (C) 2026-present Aristotelis — see repository license. */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'vitest';

import { type Backend, type ErrorCode, isAnarchonError, RabbitMQBackend, Scheduler } from '../../src';

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

test('every error thrown by the library has a code', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
    });
  const uncoded = files(join(__dirname, '../../src')).flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .map((line, i) => ({ line, at: `${file}:${i + 1}` }))
      .filter(({ line }) => /^\s*(?:if .*\)\s*)?throw new (?:Type|Range)?Error\(/.test(line))
      .map(({ at }) => at),
  );
  assert.deepEqual(uncoded, []);
});
