/* Copyright (C) 2026-present Aristotelis — see repository license. */

/**
 * Start this file 3 times (3 terminals) to see it work like 3 instances of one service:
 *
 *   npx tsx examples/basic.ts
 *   REDIS_URL=redis://localhost:6390 npx tsx examples/basic.ts   # Valkey works the same
 *   BACKEND=postgres POSTGRES_URL=postgres://localhost/app npx tsx examples/basic.ts
 *   BACKEND=sqlite npx tsx examples/basic.ts                       # ./anarchon.db, same machine only
 *
 * Each run happens on exactly one of them, and different runs land on different instances.
 * "report" runs for 40 s every minute: stop the instance running it with Ctrl+C (it hands the run
 * over at once) or kill -9 (a backup takes over when its lease runs out), and watch another one
 * finish it as attempt 2.
 */
import { randomInt } from 'node:crypto';
import { type Backend, type KeyValueStrategyName, PostgresBackend, RedisBackend, Scheduler, SqliteBackend } from '../src';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Redis / Valkey by default; BACKEND=postgres or BACKEND=sqlite for the others. */
function backend(): Backend {
  if (process.env.BACKEND === 'postgres') return new PostgresBackend({ connection: process.env.POSTGRES_URL });
  if (process.env.BACKEND === 'sqlite') return new SqliteBackend({ database: process.env.SQLITE_FILE ?? './anarchon.db' });
  return new RedisBackend({
    redis: process.env.REDIS_URL ?? 'redis://localhost:6379',
    strategy: (process.env.STRATEGY as KeyValueStrategyName | undefined) ?? 'lease',
  });
}

async function main() {
  const scheduler = new Scheduler({
    backend: backend(),
    timezone: 'Europe/Athens', // for cron jobs
    log: true, // one line per start / finish / skip, like SyncedCron
  });

  scheduler
    .every('sync', '10s', () => sleep(200))
    .every('report', '1m', (ctx) => longJob(ctx.signal, 40_000), { timeoutMs: 5 * 60_000 })
    .every('cleanup', '35m', () => sleep(1_000))
    .every('backup', '1h30m', () => sleep(1_000))
    .cron('digest', '0 */2 * * *', () => sleep(500)) // 00:00, 02:00, 04:00 ... Athens time
    .at('welcome', new Date(Date.now() + 15_000), () => console.log('a one-off job, on one instance'))
    .every('flaky', '10s', () => {
      if (randomInt(10) < 3) throw new Error('random failure');
    });

  await scheduler.start();
  console.log(`Started as ${scheduler.instanceId} on ${scheduler.backend.name}`);
  for (const job of scheduler.jobs())
    console.log(`  ${job.name.padEnd(8)} ${job.schedule.padEnd(40)} next ${job.nextRunAt?.toISOString()}`);

  // Who ran "sync" lately, and how it ended
  setInterval(async () => {
    const runs = await scheduler.history('sync', 5);
    console.table(
      runs.map((r) => ({
        scheduled: r.scheduledAt.toISOString(),
        by: r.instanceId,
        attempt: r.attempt,
        status: r.status,
        ms: r.durationMs ?? '-',
      })),
    );
  }, 30_000);

  const shutdown = async () => {
    await scheduler.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * A long job that stops when ctx.signal aborts (stop, timeout, or a backup took over). It throws
 * rather than returning, so a stopped run is handed to another instance instead of counting as done.
 */
async function longJob(signal: AbortSignal, ms: number): Promise<void> {
  for (let done = 0; done < ms; done += 1_000) {
    signal.throwIfAborted();
    await sleep(1_000);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
