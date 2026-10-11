/* Copyright (C) 2026-present Aristotelis — see repository license. */

/**
 * Runs every failure scenario for the given strategies and prints what happened.
 *
 *   pnpm exec tsx test/scenarios/report.ts stream-id lease postgres sqlite libsql
 *
 * Each argument is a Redis strategy, or 'postgres' / 'sqlite' / 'libsql'.
 */
import { REDIS_URL } from '../../support';
import { SCENARIOS, type ScenarioConfig } from './harness';

async function main() {
  const strategies = process.argv.slice(2);
  if (strategies.length === 0) strategies.push('stream-id');
  const redisUrl = REDIS_URL;
  const results: Record<string, Array<{ name: string; summary: string; facts: unknown }>> = {};
  for (const strategy of strategies) {
    results[strategy] = [];
    for (const scenario of SCENARIOS) {
      const base: ScenarioConfig = {
        strategy,
        redisUrl,
        prefix: `scenario:${strategy}:${scenario.name}:${Date.now()}:`,
        intervalMs: 10_000,
        jobMs: 1_000,
        leaseMs: 1_500,
        heartbeatMs: 300,
      };
      const result = await scenario(base);
      results[strategy].push(result);
      console.log(`[${strategy}] ${result.name}: ${result.summary}`);
    }
  }
  console.log(JSON.stringify(results, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
