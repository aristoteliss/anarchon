import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
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
