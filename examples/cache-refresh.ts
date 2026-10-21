/* Copyright (C) 2026-present Aristotelis — see repository license. */

/**
 * Refreshing a cache every few seconds on three instances: a cheap job where a missed run doesn't
 * matter, because the next one comes soon, but a stale one does.
 *
 *   npx tsx examples/cache-refresh.ts                 # SQLite file in the temp folder
 *   BACKEND=redis npx tsx examples/cache-refresh.ts   # see examples/shared.ts
 *
 * The options, and why:
 *   jitterMs: 1_000      each instance waits a random 0-1 s before claiming, so the work spreads
 *                        over the instances instead of always landing on the fastest one
 *   maxLateMs: 2_000     a refresh that can't start within 2 s of its time is dropped: a process
 *                        that was frozen (GC pause, suspended VM) must not refresh with old inputs
 *   catchUpMs: 0         nothing to catch up after a restart: the next refresh is 3 s away
 *   historySize: 50      a frequent job would otherwise keep 1000 runs it nobody reads
 *   overlap (default)    a refresh that runs long makes the next one skip ('overlap'), so two
 *                        refreshes never write the cache at the same time
 *
 * It runs for 30 s and prints which instance refreshed how often, and what was skipped and why.
 * Every 5th refresh is slow (4 s) to show the overlap skip.
 */
import { randomInt } from 'node:crypto';
import { type JobContext, Scheduler } from '../src';
import { backendFromEnv, say, sleep } from './shared';

const RUN_MS = 30_000;
const cache = {
  prices: new Map<string, number>(),
  refreshedAt: 0,
  refreshes: 0,
};

async function refreshPrices(ctx: JobContext): Promise<void> {
  const slow = ++cache.refreshes % 5 === 0;
  const upstreamMs = slow ? 4_000 : 150;
  await sleep(upstreamMs); // the upstream call
  ctx.signal.throwIfAborted();

  cache.prices.set('EURUSD', 1.08 + randomInt(100) / 10_000);
  cache.refreshedAt = Date.now();

  const note = slow ? ' (slow upstream: 4 s)' : '';
  say(`${ctx.instanceId}: prices refreshed${note}`);
}

async function main() {
  const instances = ['web-1', 'web-2', 'web-3'].map((id) => {
    const scheduler = new Scheduler({
      backend: backendFromEnv('cache'),
      instanceId: id,
    });

    scheduler.every('refresh-prices', '3s', refreshPrices, {
      jitterMs: 1_000,
      maxLateMs: 2_000,
      catchUpMs: 0,
      historySize: 50,
    });
    return scheduler;
  });

  const ran = new Map<string, number>();
  const skipped = new Map<string, number>();
  for (const scheduler of instances) {
    scheduler.on('start', (e) =>
      ran.set(e.instanceId, (ran.get(e.instanceId) ?? 0) + 1),
    );
    scheduler.on('skip', (e) => {
      skipped.set(e.reason, (skipped.get(e.reason) ?? 0) + 1);
      if (e.reason !== 'taken') {
        say(
          `${e.instanceId}: skipped ${e.scheduledAt.toISOString().slice(11, 19)} (${e.reason})`,
        );
      }
    });
  }

  await Promise.all(instances.map((s) => s.start()));
  say('three instances, one refresh every 3 s');
  await sleep(RUN_MS);
  await Promise.all(instances.map((s) => s.stop()));

  say(
    `refreshes per instance: ${[...ran].map(([id, n]) => `${id} ${n}`).join(', ')}`,
  );
  say(
    `skips: ${[...skipped].map(([reason, n]) => `${reason} ${n}`).join(', ')}`,
  );
  say(
    "'taken' is the normal case: for every refresh, the two instances that didn't win skip it",
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
