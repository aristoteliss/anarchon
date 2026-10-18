/* Copyright (C) 2026-present Aristotelis — see repository license. */

/**
 * Vitest global setup. A server that doesn't answer only skips its tests, so a run meant to cover a
 * backend can pass without testing it. REQUIRE_SERVERS names the servers a run must have
 * (`REQUIRE_SERVERS=redis,postgres pnpm test`): the run fails before any test if one is missing.
 * Each is given WAIT_MS to answer, since servers that were just started may still be booting.
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

const WAIT_MS = 30_000;

/** Probes until the server answers or WAIT_MS has passed. */
async function answers(probe: () => Promise<unknown>): Promise<boolean> {
  for (const deadline = Date.now() + WAIT_MS; ; ) {
    if (await probe()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

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
    if (!(await answers(probe))) missing.push(name);
  }
  if (missing.length) throw new Error(`REQUIRE_SERVERS: no answer from ${missing.join(', ')}`);
}
