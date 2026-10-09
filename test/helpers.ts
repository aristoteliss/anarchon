import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient as createLibsqlClient } from '@libsql/client';
import BetterSqlite3 from 'better-sqlite3';
import { Redis } from 'ioredis';
import { Pool } from 'pg';

import { type Backend, NatsBackend, PostgresBackend, RabbitMQBackend, RedisBackend, type RedisStrategyName, SqliteBackend } from '../src';

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

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function uniqueId(label: string): string {
  return `${label}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** Everything needed to build the same backend in several processes. */
export interface Spec {
  /** Default 'redis'. */
  kind?: 'redis' | 'postgres' | 'sqlite' | 'rabbitmq' | 'nats';
  url: string;
  /** Redis / Valkey only. */
  strategy?: RedisStrategyName;
  /** SQLite driver: the built-in node:sqlite (default), better-sqlite3, the libSQL client on a file, or on a libSQL server (url). */
  driver?: 'node:sqlite' | 'better-sqlite3' | 'libsql' | 'libsql-server';
  /** Unique per test so tests never share keys, tables, queues or subjects. */
  id: string;
}

export function makeBackend(spec: Spec): Backend {
  switch (spec.kind ?? 'redis') {
    case 'redis':
      return new RedisBackend({ redis: spec.url, strategy: spec.strategy, prefix: `test:${spec.id}:` });
    case 'postgres':
      return new PostgresBackend({ connection: spec.url, table: `t_${spec.id}` });
    case 'sqlite': {
      const table = `t_${spec.id}`;
      if (spec.driver === 'libsql-server') return new SqliteBackend({ database: libsqlServer(spec.url), table });
      const file = join(spec.url, `anarchon-${spec.id}.db`);
      if (spec.driver === 'better-sqlite3') {
        const db = new BetterSqlite3(file);
        db.pragma('journal_mode = WAL');
        return new SqliteBackend({ database: db, table });
      }
      if (spec.driver === 'libsql') return new SqliteBackend({ database: createLibsqlClient({ url: `file:${file}` }), table });
      return new SqliteBackend({ database: file, table });
    }
    case 'rabbitmq':
      return new RabbitMQBackend({ url: spec.url, prefix: `${spec.id}.` });
    case 'nats':
      return new NatsBackend({ servers: spec.url, prefix: `${spec.id}.`, stream: spec.id.toUpperCase() });
  }
}

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
function libsqlServer(url: string) {
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

export type SpecEntry = { label: string; spec: Omit<Spec, 'id'>; skip?: string };

/** Every Redis / Valkey server × strategy to test, with the server version, or a reason to skip. */
export async function redisSpecs(): Promise<SpecEntry[]> {
  const servers = await Promise.all(
    [
      [REDIS_URL, 'Redis'],
      [REDIS_OLD_URL, 'older Redis'],
      [VALKEY_URL, 'Valkey'],
    ].map(async ([url, fallback]) => ({ url: url!, fallback: fallback!, server: await probeRedis(url!) })),
  );
  const specs: SpecEntry[] = [];
  for (const { url, fallback, server } of servers) {
    for (const strategy of ['lease', 'stream-id', 'idmp', 'script'] as const) {
      const label = `${server ? `${server.product} ${server.version}` : fallback} · ${strategy}`;
      if (!server) specs.push({ label, spec: { url, strategy }, skip: `nothing at ${url}` });
      else if (strategy === 'idmp' && !supportsIdmp(server))
        continue; // covered by the "refuses" test
      else specs.push({ label, spec: { url, strategy } });
    }
  }
  return specs;
}

/** Postgres, SQLite (every driver) and a libSQL server: the other backends with leases. */
export async function sqlSpecs(): Promise<SpecEntry[]> {
  const [postgres, sqlite, libsql] = await Promise.all([probePostgres(POSTGRES_URL), probeSqlite(), probeLibsql(LIBSQL_URL)]);
  const specs: SpecEntry[] = [
    {
      label: `PostgreSQL ${postgres ?? ''}`.trim(),
      spec: { kind: 'postgres', url: POSTGRES_URL },
      ...(postgres ? {} : { skip: `nothing at ${POSTGRES_URL}` }),
    },
  ];
  for (const driver of ['node:sqlite', 'better-sqlite3', 'libsql'] as const) {
    specs.push({
      label: `SQLite ${sqlite ?? ''} (${driver})`.replace('  ', ' '),
      spec: { kind: 'sqlite', url: SQLITE_DIR, driver },
      ...(driver === 'node:sqlite' && !sqlite ? { skip: 'this Node has no node:sqlite' } : {}),
    });
  }
  specs.push({
    label: `libSQL server ${libsql ?? ''}`.trim(),
    spec: { kind: 'sqlite', url: LIBSQL_URL, driver: 'libsql-server' },
    ...(libsql ? {} : { skip: `nothing at ${LIBSQL_URL}` }),
  });
  return specs;
}

/** RabbitMQ and NATS: simple claim only. */
export async function queueSpecs(): Promise<SpecEntry[]> {
  const [rabbit, nats] = await Promise.all([probeRabbit(RABBITMQ_URL), probeNats(NATS_URL)]);
  return [
    {
      label: `RabbitMQ ${rabbit ?? ''}`.trim(),
      spec: { kind: 'rabbitmq', url: RABBITMQ_URL },
      ...(rabbit ? {} : { skip: `nothing at ${RABBITMQ_URL}` }),
    },
    { label: `NATS ${nats ?? ''}`.trim(), spec: { kind: 'nats', url: NATS_URL }, ...(nats ? {} : { skip: `nothing at ${NATS_URL}` }) },
  ];
}

/** Every backend to test. */
export async function availableSpecs(): Promise<SpecEntry[]> {
  return [...(await redisSpecs()), ...(await sqlSpecs()), ...(await queueSpecs())];
}

/** The backends with leases: Redis 'lease' on each server, Postgres and SQLite. */
export async function leaseSpecs(): Promise<SpecEntry[]> {
  return [...(await redisSpecs()).filter((s) => s.spec.strategy === 'lease'), ...(await sqlSpecs())];
}
