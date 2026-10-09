/** The backend a scenario runs on: a Redis strategy ('lease', 'stream-id'...), 'postgres' or 'sqlite'. */
import { RedisBackend, type Backend } from '../../src';
import { makeBackend, POSTGRES_URL, SQLITE_DIR } from '../helpers';

export function scenarioBackend(cfg: { strategy: string; redisUrl: string; prefix: string }): Backend {
  const id = cfg.prefix.replace(/[^A-Za-z0-9_]/g, '_');
  if (cfg.strategy === 'postgres') return makeBackend({ kind: 'postgres', url: POSTGRES_URL, id });
  if (cfg.strategy === 'sqlite') return makeBackend({ kind: 'sqlite', url: SQLITE_DIR, id });
  return new RedisBackend({ redis: cfg.redisUrl, strategy: cfg.strategy as never, prefix: cfg.prefix });
}
