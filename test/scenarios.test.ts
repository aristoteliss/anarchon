/**
 * Failure scenarios with real processes (kill -9, freeze, SIGTERM, restart everything) on every
 * backend with leases: Redis 'lease', Postgres and SQLite. `pnpm scenarios` prints the same
 * scenarios side by side with the simpler 'stream-id' strategy, which has none of these protections.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';

import { LIBSQL_URL, POSTGRES_URL, probeLibsql, probePostgres, probeRedis, probeSqlite, REDIS_URL } from './helpers';
import {
  allDownAtRunTime,
  allRestartMidRun,
  longRuns,
  nonWinnerRestarts,
  type ScenarioConfig,
  winnerCrashes,
  winnerFreezes,
  winnerStopsGracefully,
} from './scenarios/harness';

const BACKENDS = [
  { strategy: 'lease', label: 'Redis, lease strategy', probe: () => probeRedis(REDIS_URL), missing: `nothing at ${REDIS_URL}` },
  { strategy: 'postgres', label: 'PostgreSQL', probe: () => probePostgres(POSTGRES_URL), missing: `nothing at ${POSTGRES_URL}` },
  { strategy: 'sqlite', label: 'SQLite', probe: () => probeSqlite(), missing: 'this Node has no node:sqlite' },
  {
    strategy: 'libsql',
    label: 'libSQL server',
    probe: () => probeLibsql(LIBSQL_URL),
    missing: `nothing at ${LIBSQL_URL}`,
  },
];

// Every scenario has its own keys, tables and processes, and mostly waits on the clock, so they run
// side by side (up to maxConcurrency in vitest.config.mts).
describe.concurrent('failure scenarios', () => {
  for (const backend of BACKENDS) {
    const config = (name: string): ScenarioConfig => ({
      strategy: backend.strategy,
      redisUrl: REDIS_URL,
      prefix: `scenario:${backend.strategy}:${name}:${Date.now()}:`,
      intervalMs: 10_000,
      jobMs: 1_000,
      leaseMs: 1_500,
      heartbeatMs: 300,
    });

    describe(backend.label, async () => {
      const available = !!(await backend.probe());
      test('a job longer than its interval never runs twice at once', async (t) => {
        if (!available) return t.skip(backend.missing);
        const { facts } = await longRuns(config('long'));
        assert.equal(facts.maxRunningAtOnce, 1);
        assert.ok((facts.overlapSkips as number) > 0, 'runs due during a long run are skipped');
        assert.equal(facts.errors, 0);
      });

      test('when the winner crashes mid-run, a backup takes over and finishes it', async (t) => {
        if (!available) return t.skip(backend.missing);
        const { facts } = await winnerCrashes(config('crash'));
        assert.ok(facts.finishedBy, 'someone finished the run');
        assert.match(String(facts.finishedBy), /#2\(takeover\)$/);
        assert.ok((facts.takeoverAfterMs as number) < 4_000, `took over after ${facts.takeoverAfterMs} ms`);
        assert.deepEqual(
          (facts.history as string[]).map((h) => h.split(':')[1]),
          ['success', 'interrupted'],
        );
      });

      test('a non-winner restarting mid-run does not run it again', async (t) => {
        if (!available) return t.skip(backend.missing);
        const { facts } = await nonWinnerRestarts(config('restart'));
        assert.equal((facts.executionsOfThatRun as string[]).length, 1);
        assert.equal(facts.finishedOnce, true);
      });

      test('when all instances restart mid-run, the run is finished after they come back', async (t) => {
        if (!available) return t.skip(backend.missing);
        const { facts } = await allRestartMidRun(config('all-restart'));
        assert.equal((facts.finished as string[]).length, 1, `finished: ${facts.finished}`);
        assert.match((facts.finished as string[])[0]!, /#2\(takeover\)$/);
      });

      test('a run that was due while every instance was down runs once when they start', async (t) => {
        if (!available) return t.skip(backend.missing);
        const { facts } = await allDownAtRunTime(config('all-down'));
        assert.equal((facts.executions as string[]).length, 1);
        assert.match((facts.executions as string[])[0]!, /\(catch-up\)$/);
      });

      test('a frozen winner loses the run to a backup and sees ctx.signal abort when it wakes up', async (t) => {
        if (!available) return t.skip(backend.missing);
        const { facts } = await winnerFreezes(config('freeze'));
        assert.ok(facts.backup, 'a backup took over');
        assert.equal(facts.backupFinished, true);
        assert.equal(facts.originalAbortedAfterWaking, true);
        assert.ok((facts.lostEvents as number) >= 1, 'the frozen instance emitted "lost"');
      });

      test('a winner stopped gracefully (rolling deploy) hands the run to a backup', async (t) => {
        if (!available) return t.skip(backend.missing);
        const { facts } = await winnerStopsGracefully(config('graceful'));
        assert.match(String(facts.finishedBy), /#2\(takeover\)$/);
        // Released at once, so a backup picks it up at its next check (within one lease), not after the lease runs out
        assert.ok((facts.handoverAfterMs as number) < 2_000, `handed over after ${facts.handoverAfterMs} ms`);
        assert.deepEqual(
          (facts.history as string[]).map((h) => h.split(':')[1]),
          ['success', 'interrupted'],
        );
      });
    });
  }
});
