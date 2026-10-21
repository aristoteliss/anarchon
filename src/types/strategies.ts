/* Copyright (C) 2026-present Aristotelis — see repository license. */

/**
 * The claim strategies of the key-value backends, by server: how the backend makes sure each run has
 * exactly one runner.
 * - `lease` (default; Redis 5+, Valkey): one atomic script claims the run and gives the winner a lease
 *   it renews while the job runs. Adds: no overlapping runs, backup runners when the winner dies or
 *   freezes, catch-up of a run missed while every instance was down, and retries.
 * - `stream-id` (Redis 5+, Valkey): XADD with the run time as the entry ID; the server refuses an ID
 *   that is not bigger than the last one, so only the first instance succeeds.
 * - `idmp` (Redis 8.6+ only): XADD with `IDMP <job> <run time>`; the server keeps the first entry and
 *   ignores repeats.
 * - `script` (Redis 5+, Valkey): a small Lua script does what IDMP does, on any version: it appends
 *   the run only if that run time isn't already in the stream.
 *
 * Only `lease` adds the extras; the other three only decide who runs each time. The database and
 * broker backends have no strategy to choose: PostgreSQL and SQLite always follow the `lease` rules,
 * and RabbitMQ and NATS always make a simple claim.
 *
 * @example Pick a strategy from configuration (ValkeyBackend refuses an unsupported one when created)
 * ```ts
 * const name = (process.env.CRON_STRATEGY ?? 'lease') as KeyValueStrategies['valkey'];
 * new ValkeyBackend({ valkey: process.env.VALKEY_URL, strategy: name });
 * ```
 */
export interface KeyValueStrategies {
  /**
   * The strategies of `RedisBackend`. 'idmp' needs Redis 8.6+; the others Redis 5+.
   *
   * @example
   * ```ts
   * new RedisBackend({ strategy: 'lease' }); // the default: backups, no overlap, catch-up, retries
   * new RedisBackend({ strategy: { name: 'idmp', durationSec: 900 } }); // Redis 8.6+, one winner per run
   * ```
   */
  redis: 'lease' | 'stream-id' | 'idmp' | 'script';
  /**
   * The strategies of `ValkeyBackend`: Valkey has no idempotent XADD, so no 'idmp'.
   *
   * @example
   * ```ts
   * new ValkeyBackend({ valkey: process.env.VALKEY_URL, strategy: { name: 'script', windowMs: 600_000 } });
   * ```
   */
  valkey: 'lease' | 'stream-id' | 'script';
}

/**
 * The name of a strategy one key-value server supports (see {@link KeyValueStrategies}).
 *
 * @example
 * ```ts
 * const name: KeyValueStrategyName<'valkey'> = 'idmp'; // type error: Valkey has no 'idmp'
 * ```
 */
export type KeyValueStrategyName<
  Server extends keyof KeyValueStrategies = 'redis',
> = KeyValueStrategies[Server];

type StrategySettings<Name> = Name extends 'idmp'
  ? IdmpOptions
  : Name extends 'script'
    ? ScriptOptions
    : unknown;

/**
 * The `strategy` option of `RedisBackend` and `ValkeyBackend`: a strategy's name, or an object with
 * its name and the settings of that strategy only ('idmp' and 'script' have settings).
 *
 * @example
 * ```ts
 * const plain: KeyValueStrategy = 'stream-id';
 * const tuned: KeyValueStrategy = { name: 'script', windowMs: 10 * 60_000 };
 * const wrong: KeyValueStrategy = { name: 'lease', windowMs: 1 }; // type error: 'lease' has no windowMs
 * ```
 */
export type KeyValueStrategy<Name extends string = KeyValueStrategyName> = {
  [N in Name]: N | ({ name: N } & StrategySettings<N>);
}[Name];

/**
 * Settings of the Redis 'idmp' strategy (Redis 8.6+).
 *
 * @example A job with jitterMs 5 s and maxLateMs 10 min needs Redis to remember runs for longer than that
 * ```ts
 * new RedisBackend({ strategy: { name: 'idmp', durationSec: 900 } });
 * ```
 */
export interface IdmpOptions {
  /**
   * How long Redis remembers a run's ID (seconds, 1-86400). Must be longer than
   * jitterMs + maxLateMs + any clock difference between your instances. Default 300.
   *
   * @example
   * ```ts
   * new Scheduler({ backend: new RedisBackend({ strategy: { name: 'idmp', durationSec: 900 } }), maxLateMs: 600_000 });
   * ```
   */
  durationSec?: number;
  /**
   * How many run IDs Redis keeps per job (1-10000). Together with the time between runs it must
   * cover jitterMs + maxLateMs: a job every second with maxSize 50 is remembered for 50 s. Default 1000.
   *
   * @example
   * ```ts
   * new RedisBackend({ strategy: { name: 'idmp', maxSize: 5_000 } });
   * ```
   */
  maxSize?: number;
}

/**
 * Settings of the Redis/Valkey 'script' strategy.
 *
 * @example
 * ```ts
 * new RedisBackend({ strategy: { name: 'script', windowMs: 10 * 60_000 } });
 * ```
 */
export interface ScriptOptions {
  /**
   * How long a claimed run is remembered (ms). Must be longer than a job's jitterMs + maxLateMs, or
   * a late instance could run it again. Default 300000 (5 min).
   *
   * @example Instances that may reach a run up to 10 min late
   * ```ts
   * const backend = new RedisBackend({ strategy: { name: 'script', windowMs: 15 * 60_000 } });
   * new Scheduler({ backend, maxLateMs: 10 * 60_000 });
   * ```
   */
  windowMs?: number;
}
