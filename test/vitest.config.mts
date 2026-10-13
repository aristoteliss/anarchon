/* Copyright (C) 2026-present Aristotelis — see repository license. */

import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The repository, whatever folder vitest is started from: the paths below are relative to it.
  root: resolve(import.meta.dirname, '..'),
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/support/require-servers.ts'],
    // The files share the same servers and measure timing, so they run one at a time.
    fileParallelism: false,
    // Tests marked concurrent (the scenario and cluster files) run up to this many at a time:
    // they spend their time waiting on schedule slots, not on the CPU.
    maxConcurrency: 8,
    testTimeout: 60_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reportOnFailure: true,
    },
  },
});
