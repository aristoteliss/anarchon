/* Copyright (C) 2026-present Aristotelis — see repository license. */

import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';

const COPIES = Symbol.for('anarchon.copies');
const globals = globalThis as unknown as Record<
  symbol,
  Set<string> | undefined
>;

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

test('a second copy of anarchon in the process is reported: decorators of one are not seen by the other', async () => {
  globals[COPIES] = new Set([
    '/app/node_modules/some-lib/node_modules/anarchon/dist/registry.js',
  ]);
  const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
  vi.resetModules();
  await import('../../src/registry.js');
  assert.equal(warn.mock.calls.length, 1);
  const [message, options] = warn.mock.calls[0] as [string, { code: string }];
  assert.match(message, /loaded from 2 places.*some-lib.*decorated jobs/s);
  assert.equal(options.code, 'ANARCHON_DUPLICATE_COPY');
});

test('loading the same copy again, as test runners do, is not reported', async () => {
  globals[COPIES] = undefined;
  const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
  vi.resetModules();
  await import('../../src/registry.js');
  vi.resetModules();
  await import('../../src/registry.js');
  assert.equal(warn.mock.calls.length, 0);
});
