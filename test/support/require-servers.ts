/* Copyright (C) 2026-present Aristotelis — see repository license. */

/**
 * Vitest global setup. A server that doesn't answer only skips its tests, so a run meant to cover a
 * backend can pass without testing it. REQUIRE_SERVERS names the servers a run must have
 * (`REQUIRE_SERVERS=redis,postgres pnpm test`): the run fails before any test if one is missing.
 */
import {
  LIBSQL_URL,
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
  VALKEY_URL,
} from './servers';

const probes: Record<string, () => Promise<unknown>> = {
  redis: () => probeRedis(REDIS_URL),
  'redis-old': () => probeRedis(REDIS_OLD_URL),
  valkey: () => probeRedis(VALKEY_URL),
  postgres: () => probePostgres(POSTGRES_URL),
  sqlite: () => probeSqlite(),
  libsql: () => probeLibsql(LIBSQL_URL),
  rabbitmq: () => probeRabbit(RABBITMQ_URL),
  nats: () => probeNats(NATS_URL),
};

export default async function requireServers(): Promise<void> {
  const names = (process.env.REQUIRE_SERVERS ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const missing: string[] = [];
  for (const name of names) {
    const probe = probes[name];
    if (!probe) throw new Error(`REQUIRE_SERVERS: unknown server "${name}" (known: ${Object.keys(probes).join(', ')})`);
    if (!(await probe())) missing.push(name);
  }
  if (missing.length) throw new Error(`REQUIRE_SERVERS: no answer from ${missing.join(', ')}`);
}
