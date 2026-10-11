/* Copyright (C) 2026-present Aristotelis — see repository license. */

import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';

import { type Backend, Scheduler, type SchedulerOptions } from '../../src';

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

afterEach(() => {
  Scheduler.reset();
});

test('a scheduler needs a backend: none is assumed, and nothing connects to a store you did not name', () => {
  const without: Array<SchedulerOptions | undefined> = [
    undefined,
    {},
    { prefix: 'app:' },
    { strategy: 'lease' },
    { leaseMs: 10_000, timezone: 'UTC' },
  ];
  for (const options of without) {
    assert.throws(
      () => new Scheduler(options as SchedulerOptions),
      (error: Error) => error instanceof TypeError && /backend/.test(error.message) && /redis/.test(error.message),
      `new Scheduler(${JSON.stringify(options)}) should need a backend`,
    );
  }

  assert.equal(new Scheduler({ redis: 'redis://localhost:6381' }).backend.name, 'redis:lease');
  assert.equal(new Scheduler({ backend: memoryBackend() }).backend.name, 'memory');
});
