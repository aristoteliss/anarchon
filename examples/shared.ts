/**
 * Shared by the examples: the backend comes from the environment, so every example runs on any of them.
 *
 *   (nothing)          SQLite file in the temp folder: no server needed, same machine only
 *   BACKEND=redis      REDIS_URL (default redis://localhost:6379), STRATEGY (default lease)
 *   BACKEND=postgres   POSTGRES_URL
 *   BACKEND=sqlite     SQLITE_FILE
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Backend, PostgresBackend, RedisBackend, type RedisStrategyName, SqliteBackend } from '../src';

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A new backend object per instance; all of them point at the same store. `name` keeps examples apart. */
export function backendFromEnv(name: string): Backend {
  switch (process.env.BACKEND ?? 'sqlite') {
    case 'redis':
      return new RedisBackend({
        redis: process.env.REDIS_URL ?? 'redis://localhost:6379',
        strategy: (process.env.STRATEGY as RedisStrategyName | undefined) ?? 'lease',
        prefix: `example:${name}:`,
      });
    case 'postgres':
      return new PostgresBackend({ connection: process.env.POSTGRES_URL, table: `example_${name}` });
    case 'sqlite':
      return new SqliteBackend({ database: process.env.SQLITE_FILE ?? join(tmpdir(), 'anarchon-examples.db'), table: `example_${name}` });
    default:
      throw new Error(`BACKEND must be redis, postgres or sqlite (got "${process.env.BACKEND}")`);
  }
}

/** Seconds since the example started, for log lines. */
const startedAt = Date.now();
export const say = (line: string) => console.log(`${((Date.now() - startedAt) / 1000).toFixed(1).padStart(5)}s  ${line}`);

/** Works for a job that stops when its signal aborts: it throws, so the run counts as unfinished. */
export async function work(signal: AbortSignal, ms: number): Promise<void> {
  for (let done = 0; done < ms; done += 250) {
    signal.throwIfAborted();
    await sleep(250);
  }
}
