/** Where the test servers are, and whether each one answers. The default ports are docker-compose.test.yml's. */
import { tmpdir } from 'node:os';

import { createClient as createLibsqlClient } from '@libsql/client';
import { Redis } from 'ioredis';
import { Pool } from 'pg';

/** Redis 8.6+ (the only server with IDMP). The default ports below are docker-compose.test.yml's. */
export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6381';
/** Optional older Redis (e.g. 7.x). */
export const REDIS_OLD_URL = process.env.REDIS_OLD_URL ?? 'redis://localhost:6380';
/** Optional Valkey. */
export const VALKEY_URL = process.env.VALKEY_URL ?? 'redis://localhost:6390';
export const POSTGRES_URL = process.env.POSTGRES_URL ?? 'postgres://postgres:postgres@localhost:5433/anarchon_test';
export const RABBITMQ_URL = process.env.RABBITMQ_URL ?? 'amqp://localhost';
export const NATS_URL = process.env.NATS_URL ?? 'nats://localhost:4222';
/** Optional libSQL server: sqld, or a Turso database (`libsql://...`). Every test gets its own table. */
export const LIBSQL_URL = process.env.LIBSQL_URL ?? 'http://localhost:8081';
/** Where the shared SQLite test files go (every test gets its own file). */
export const SQLITE_DIR = process.env.SQLITE_DIR ?? tmpdir();

export interface ServerInfo {
  product: 'Redis' | 'Valkey';
  version: string;
  major: number;
  minor: number;
}

/** Server product and version at a Redis-protocol URL, or null if nothing answers. */
export async function probeRedis(url: string): Promise<ServerInfo | null> {
  const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
  redis.on('error', () => {});
  try {
    await redis.connect();
    const info = await redis.info('server');
    const valkey = /valkey_version:(\d+)\.(\d+)\.(\d+)/.exec(info);
    const match = valkey ?? /redis_version:(\d+)\.(\d+)\.(\d+)/.exec(info);
    if (!match) return null;
    return {
      product: valkey ? 'Valkey' : 'Redis',
      version: `${match[1]}.${match[2]}.${match[3]}`,
      major: Number(match[1]),
      minor: Number(match[2]),
    };
  } catch {
    return null;
  } finally {
    redis.disconnect();
  }
}

export function supportsIdmp(server: ServerInfo | null): boolean {
  return !!server && server.product === 'Redis' && (server.major > 8 || (server.major === 8 && server.minor >= 6));
}

export async function probePostgres(url: string): Promise<string | null> {
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 1_000 });
  pool.on('error', () => {});
  try {
    const { rows } = await pool.query('SHOW server_version');
    return String(rows[0]?.server_version ?? 'unknown').split(' ')[0]!;
  } catch {
    return null;
  } finally {
    await pool.end().catch(() => {});
  }
}

export async function probeSqlite(): Promise<string | null> {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    const version = String((db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v);
    db.close();
    return version;
  } catch {
    return null;
  }
}

/** The token stays in the environment (LIBSQL_AUTH_TOKEN), never in a spec, so child processes read it too. */
export function libsqlServer(url: string) {
  return createLibsqlClient({ url, authToken: process.env.LIBSQL_AUTH_TOKEN });
}

export async function probeLibsql(url: string): Promise<string | null> {
  const client = libsqlServer(url);
  try {
    const { rows } = await client.execute('SELECT sqlite_version() AS v');
    return String(rows[0]?.v ?? 'unknown');
  } catch {
    return null;
  } finally {
    client.close();
  }
}

export async function probeRabbit(url: string): Promise<string | null> {
  try {
    const amqp = await import('amqplib');
    const connection = await amqp.connect(url);
    const version = String(connection.connection.serverProperties.version);
    await connection.close();
    return version;
  } catch {
    return null;
  }
}

export async function probeNats(url: string): Promise<string | null> {
  try {
    const { connect } = await import('@nats-io/transport-node');
    const nc = await connect({ servers: url, timeout: 1_000 });
    const version = nc.info?.version ?? 'unknown';
    await nc.close();
    return version;
  } catch {
    return null;
  }
}
