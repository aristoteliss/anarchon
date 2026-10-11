/* Copyright (C) 2026-present Aristotelis — see repository license. */

/**
 * Using connections your app already has. The scheduler never closes a client you pass in, so
 * stop() leaves it open for the rest of the app.
 *
 *   npx tsx examples/own-clients.ts                                    # your ioredis client
 *   BACKEND=postgres POSTGRES_URL=... npx tsx examples/own-clients.ts  # your pg Pool
 *
 * Also accepted: node-redis and Valkey GLIDE clients, a pg Client, a postgres.js instance, a
 * node:sqlite or better-sqlite3 database, a @libsql/client client, or your own
 * `{ send }` (Redis) and `{ all, transaction }` (SQL) adapters.
 */
import { Redis } from 'ioredis';
import { Pool } from 'pg';

import { PostgresBackend, Scheduler } from '../src';
import { say, sleep } from './shared';

async function main() {
  const usePostgres = process.env.BACKEND === 'postgres';
  const redis = usePostgres ? undefined : new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const pool = usePostgres ? new Pool({ connectionString: process.env.POSTGRES_URL }) : undefined;

  const scheduler = pool
    ? new Scheduler({ backend: new PostgresBackend({ connection: pool, table: 'example_own_clients' }) })
    : new Scheduler({ redis, prefix: 'example:own-clients:' });

  scheduler.every('sync', '2s', () => sleep(100), { jitterMs: 100, catchUpMs: 0 });
  scheduler.on('success', (r) => say(`sync ran on ${r.instanceId} in ${r.durationMs} ms`));

  await scheduler.start();
  say(`started on ${scheduler.backend.name}`);
  await sleep(7_000);
  await scheduler.stop();

  // Still usable after stop()
  if (redis) say(`redis after stop(): ${await redis.ping()}`);
  if (pool) say(`pg pool after stop(): ${(await pool.query('SELECT 1 AS one')).rows[0].one}`);
  redis?.disconnect();
  await pool?.end();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
