/* Copyright (C) 2026-present Aristotelis — see repository license. */

/** The backends the tests run on: one spec per backend, server and strategy, with a reason to skip the ones that are missing. */
import { join } from 'node:path';

import { createClient as createLibsqlClient } from '@libsql/client';
import BetterSqlite3 from 'better-sqlite3';

import {
  type Backend,
  type KeyValueStrategyName,
  NatsBackend,
  PostgresBackend,
  RabbitMQBackend,
  RedisBackend,
  SqliteBackend,
  ValkeyBackend,
} from '../../src';
import {
  LIBSQL_URL,
  libsqlServer,
  NATS_URL,
  POSTGRES_URL,
  probeLibsql,
  probeNats,
  probePostgres,
  probeRabbit,
  probeRedis,
  probeSqlite,
  RABBITMQ_URL,
  REDIS_OLD_URL,
  REDIS_URL,
  SQLITE_DIR,
  supportsIdmp,
  VALKEY_URL,
} from './servers';

/** Everything needed to build the same backend in several processes. */
export interface Spec {
  /** Default 'redis'. */
  kind?: 'redis' | 'valkey' | 'postgres' | 'sqlite' | 'rabbitmq' | 'nats';
  url: string;
  /** Redis / Valkey only. */
  strategy?: KeyValueStrategyName;
  /** SQLite driver: the built-in node:sqlite (default), better-sqlite3, the libSQL client on a file, or on a libSQL server (url). */
  driver?: 'node:sqlite' | 'better-sqlite3' | 'libsql' | 'libsql-server';
  /** Unique per test so tests never share keys, tables, queues or subjects. */
  id: string;
}

export function makeBackend(spec: Spec): Backend {
  switch (spec.kind ?? 'redis') {
    case 'redis':
      return new RedisBackend({
        redis: spec.url,
        strategy: spec.strategy,
        prefix: `test:${spec.id}:`,
      });
    case 'valkey':
      return new ValkeyBackend({
        valkey: spec.url,
        strategy: spec.strategy as KeyValueStrategyName<'valkey'>,
        prefix: `test:${spec.id}:`,
      });
    case 'postgres':
      return new PostgresBackend({
        connection: spec.url,
        table: `t_${spec.id}`,
      });
    case 'sqlite': {
      const table = `t_${spec.id}`;
      if (spec.driver === 'libsql-server')
        return new SqliteBackend({ database: libsqlServer(spec.url), table });
      const file = join(spec.url, `anarchon-${spec.id}.db`);
      if (spec.driver === 'better-sqlite3') {
        const db = new BetterSqlite3(file);
        db.pragma('journal_mode = WAL');
        return new SqliteBackend({ database: db, table });
      }
      if (spec.driver === 'libsql')
        return new SqliteBackend({
          database: createLibsqlClient({ url: `file:${file}` }),
          table,
        });
      return new SqliteBackend({ database: file, table });
    }
    case 'rabbitmq':
      return new RabbitMQBackend({ url: spec.url, prefix: `${spec.id}.` });
    case 'nats':
      return new NatsBackend({
        servers: spec.url,
        prefix: `${spec.id}.`,
        stream: spec.id.toUpperCase(),
      });
  }
}

export type SpecEntry = {
  label: string;
  spec: Omit<Spec, 'id'>;
  skip?: string;
};

/** Every Redis / Valkey server × strategy to test, with the server version, or a reason to skip. */
export async function redisSpecs(): Promise<SpecEntry[]> {
  const servers = await Promise.all(
    [
      [REDIS_URL, 'Redis', 'redis'],
      [REDIS_OLD_URL, 'older Redis', 'redis'],
      [VALKEY_URL, 'Valkey', 'valkey'],
    ].map(async ([url, fallback, kind]) => ({
      url: url!,
      fallback: fallback!,
      kind: kind as 'redis' | 'valkey',
      server: await probeRedis(url!),
    })),
  );
  const specs: SpecEntry[] = [];
  for (const { url, fallback, kind, server } of servers) {
    for (const strategy of ['lease', 'stream-id', 'idmp', 'script'] as const) {
      const label = `${server ? `${server.product} ${server.version}` : fallback} · ${strategy}`;
      if (!server)
        specs.push({
          label,
          spec: { kind, url, strategy },
          skip: `nothing at ${url}`,
        });
      else if (strategy === 'idmp' && !supportsIdmp(server))
        continue; // covered by the "refuses" test
      else specs.push({ label, spec: { kind, url, strategy } });
    }
  }
  return specs;
}

/** Postgres, SQLite (every driver) and a libSQL server: the other backends with leases. */
export async function sqlSpecs(): Promise<SpecEntry[]> {
  const [postgres, sqlite, libsql] = await Promise.all([
    probePostgres(POSTGRES_URL),
    probeSqlite(),
    probeLibsql(LIBSQL_URL),
  ]);
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
      ...(driver === 'node:sqlite' && !sqlite
        ? { skip: 'this Node has no node:sqlite' }
        : {}),
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
  const [rabbit, nats] = await Promise.all([
    probeRabbit(RABBITMQ_URL),
    probeNats(NATS_URL),
  ]);
  return [
    {
      label: `RabbitMQ ${rabbit ?? ''}`.trim(),
      spec: { kind: 'rabbitmq', url: RABBITMQ_URL },
      ...(rabbit ? {} : { skip: `nothing at ${RABBITMQ_URL}` }),
    },
    {
      label: `NATS ${nats ?? ''}`.trim(),
      spec: { kind: 'nats', url: NATS_URL },
      ...(nats ? {} : { skip: `nothing at ${NATS_URL}` }),
    },
  ];
}

/** Every backend to test. */
export async function availableSpecs(): Promise<SpecEntry[]> {
  return [
    ...(await redisSpecs()),
    ...(await sqlSpecs()),
    ...(await queueSpecs()),
  ];
}

/** The backends with leases: Redis 'lease' on each server, Postgres and SQLite. */
export async function leaseSpecs(): Promise<SpecEntry[]> {
  return [
    ...(await redisSpecs()).filter((s) => s.spec.strategy === 'lease'),
    ...(await sqlSpecs()),
  ];
}
