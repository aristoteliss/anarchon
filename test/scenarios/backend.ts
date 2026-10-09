/** The backend a scenario runs on: a Redis strategy ('lease', 'stream-id'...), 'postgres', 'sqlite' or 'libsql' (a server). */
import { type Backend, RedisBackend } from '../../src';
import { LIBSQL_URL, makeBackend, POSTGRES_URL, SQLITE_DIR } from '../helpers';

export function scenarioBackend(cfg: { strategy: string; redisUrl: string; prefix: string }): Backend {
  const id = cfg.prefix.replace(/[^A-Za-z0-9_]/g, '_');
  if (cfg.strategy === 'postgres') return makeBackend({ kind: 'postgres', url: POSTGRES_URL, id });
  if (cfg.strategy === 'sqlite') return makeBackend({ kind: 'sqlite', url: SQLITE_DIR, id });
  if (cfg.strategy === 'libsql') return makeBackend({ kind: 'sqlite', url: LIBSQL_URL, driver: 'libsql-server', id });
  return new RedisBackend({ redis: cfg.redisUrl, strategy: cfg.strategy as never, prefix: cfg.prefix });
}
