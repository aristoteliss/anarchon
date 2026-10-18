/* Copyright (C) 2026-present Aristotelis — see repository license. */

import type { Backend } from './backend';
import type { AtJobOptions, JobData, JobOptions, LeaseJobOptions } from './jobs';

/**
 * Where the scheduler writes its own messages. `console` fits, and so do pino and winston loggers.
 *
 * @example
 * ```ts
 * new Scheduler({ backend, logger: pino(), log: true });
 * new Scheduler({ backend, logger: winston.createLogger({ transports: [new winston.transports.Console()] }) });
 * new Scheduler({ backend, logger: { warn: (m) => myLog('warn', m), error: (m) => myLog('error', m) } });
 * ```
 *
 * @example A NestJS logger
 * ```ts
 * const nest = new Logger('anarchon');
 * new Scheduler({ backend, logger: { info: (m) => nest.log(m), warn: (m) => nest.warn(m), error: (m, e) => nest.error(m, e) } });
 * ```
 */
export interface Logger {
  /**
   * Run messages of `log: true` (started, finished, skipped). Falls back to console.log when missing.
   *
   * @example
   * ```ts
   * // [anarchon] sync @ 2026-10-10T12:00:10.000Z: started on api-2 (attempt 1, scheduled)
   * ```
   */
  info?(message: string, ...meta: unknown[]): void;
  /**
   * Failed and lost runs (with `log: true`), and problems while closing the backend.
   *
   * @example
   * ```ts
   * // [anarchon] sync @ 2026-10-10T12:00:10.000Z: failed after 203 ms: Error: timeout
   * ```
   */
  warn(message: string, ...meta: unknown[]): void;
  /**
   * 'error' events nobody listens for, and listeners that throw. The error is the second argument.
   *
   * @example
   * ```ts
   * // logger.error('[anarchon] error in sync', new Error('connection refused'))
   * ```
   */
  error(message: string, ...meta: unknown[]): void;
}

interface CommonSchedulerOptions<B extends Backend> {
  /**
   * A name for this scheduler, unique in the process. Jobs declared with decorators choose a
   * scheduler by it: `@Cron('close', '0 6 1 * *', { scheduler: 'billing' })`. A scheduler without a
   * name can be the default one, which takes the decorated jobs that name none.
   *
   * @example
   * ```ts
   * new Scheduler({ name: 'billing', backend: new PostgresBackend({ connection: pool }) });
   * ```
   */
  name?: string;
  /**
   * Data for the runs of every job of this scheduler, handed to each handler as `ctx.data`: a
   * value, or a function called when a run starts. A job's own `data` goes on top of it, and
   * `setData()` replaces it while the scheduler runs.
   *
   * @example
   * ```ts
   * new Scheduler({ backend, data: { tenant: 'acme', db } });
   * new Scheduler({ backend, data: async (run) => ({ permissions: await permissionsFor(run.name) }) });
   * ```
   */
  data?: JobData;
  /**
   * Where runs are claimed and recorded. stop() closes it, which closes only the connections the
   * backend opened itself, never a client you passed to it.
   *
   * @example
   * ```ts
   * new Scheduler({ backend: new RedisBackend({ redis: process.env.REDIS_URL }) });
   * new Scheduler({ backend: new RedisBackend({ redis: process.env.REDIS_URL, prefix: 'billing:cron:' }) });
   * new Scheduler({ backend: new PostgresBackend({ connection: process.env.DATABASE_URL }) });
   * new Scheduler({ backend: new SqliteBackend({ database: './jobs.db' }) });
   * ```
   */
  backend: B;
  /**
   * Name of this instance in history and events. Must differ between instances, or history can't
   * tell them apart. Default `${hostname}:${pid}`; a pod name or host name reads better.
   *
   * @example
   * ```ts
   * new Scheduler({ backend, instanceId: process.env.POD_NAME }); // 'billing-7d9f8c-x2x4q'
   * new Scheduler({ backend, instanceId: `api-${process.env.PORT}` });
   * ```
   */
  instanceId?: string;
  /**
   * Default jitter for all jobs (ms): each instance waits a random 0..jitterMs after a run is due
   * before claiming it, which spreads the work. Default 2000, lowered automatically to a quarter of
   * the interval for short intervals. A job's own `jitterMs` overrides it.
   *
   * @example
   * ```ts
   * new Scheduler({ backend, jitterMs: 500 }); // runs start within half a second of their time
   * new Scheduler({ backend, jitterMs: 0 });   // on the dot; the fastest instance always wins
   * ```
   */
  jitterMs?: number;
  /**
   * Default maxLateMs for all jobs: an instance that reaches a run later than this skips it, so a
   * process that was frozen doesn't start stale runs when it wakes. Default 60000.
   *
   * @example
   * ```ts
   * new Scheduler({ backend, maxLateMs: 10_000 }); // a run that can't start within 10 s is dropped
   * ```
   */
  maxLateMs?: number;
  /**
   * Default history size per job: about how many runs `history()` can return. Default 1000.
   *
   * @example
   * ```ts
   * new Scheduler({ backend, historySize: 200 });
   * ```
   */
  historySize?: number;
  /**
   * Default history age limit per job (ms): records older than this are dropped as well.
   * Default: none (keep by count only).
   *
   * @example
   * ```ts
   * new Scheduler({ backend, historyTtlMs: 7 * 24 * 60 * 60_000 }); // one week
   * ```
   */
  historyTtlMs?: number;
  /**
   * Log every start, success, failure, interruption, skip and lost run through `logger`, one line
   * each (like SyncedCron's `log`). Default false.
   *
   * @example
   * ```ts
   * new Scheduler({ backend, log: true });
   * // [anarchon] sync @ 2026-10-10T12:00:10.000Z: started on api-2 (attempt 1, scheduled)
   * // [anarchon] sync @ 2026-10-10T12:00:10.000Z: finished in 203 ms
   * ```
   */
  log?: boolean;
  /**
   * Default IANA time zone for cron jobs, e.g. 'Europe/Athens' or 'UTC'. Set it: the default is the
   * server's local time zone, which can differ between machines. `every()` ignores it (UTC grid).
   *
   * @example
   * ```ts
   * const scheduler = new Scheduler({ backend, timezone: 'Europe/Athens' });
   * scheduler.cron('digest', '0 8 * * *', sendDigest); // 08:00 in Athens, summer and winter
   * ```
   */
  timezone?: string;
  /**
   * Where to log 'error' events nobody listens for, and the run messages of `log: true`.
   * Needs `warn` and `error`; `info` is optional. Default `console`.
   *
   * @example
   * ```ts
   * new Scheduler({ backend, logger: pino() });
   * new Scheduler({ backend, logger: { warn: (m) => log('warn', m), error: (m) => log('error', m) } });
   * ```
   */
  logger?: Logger;
  /**
   * If true, the scheduler's timers don't keep the process alive: it exits when nothing else is
   * pending. For scripts and tests. Default false.
   *
   * @example
   * ```ts
   * new Scheduler({ backend, unrefTimers: true });
   * ```
   */
  unrefTimers?: boolean;
}

/**
 * The scheduler options that need a backend with leases: Redis or Valkey with the 'lease' strategy,
 * PostgreSQL or SQLite. `new Scheduler()` doesn't offer them with another backend, and refuses them
 * when they are set anyway.
 *
 * @example
 * ```ts
 * new Scheduler({ backend: new SqliteBackend({ database: './jobs.db' }), leaseMs: 10_000, heartbeatMs: 2_000 });
 * new Scheduler({ backend: new NatsBackend(), leaseMs: 10_000 }); // type error: NATS has no leases
 * ```
 */
export interface LeaseSchedulerOptions {
  /**
   * A running job's lease lasts this long and is renewed every heartbeatMs. A runner
   * that stops renewing (crash, freeze, lost network) loses the run to a backup about leaseMs later
   * (at most leaseMs + 2 × heartbeatMs). Default 30000.
   *
   * Shorter means faster takeover; longer tolerates longer pauses of a healthy runner.
   *
   * @example
   * ```ts
   * new Scheduler({ backend, leaseMs: 10_000 });  // a dead runner is replaced within about 13 s
   * new Scheduler({ backend, leaseMs: 120_000 }); // survives two minutes without the store
   * ```
   */
  leaseMs?: number;
  /**
   * How often a running job renews its lease, and how often backups check on it
   * (every 1 to 2 heartbeats). Must be under half of leaseMs. Default 5000, or leaseMs / 6 if smaller.
   *
   * @example
   * ```ts
   * new Scheduler({ backend, leaseMs: 6_000, heartbeatMs: 1_000 });
   * ```
   */
  heartbeatMs?: number;
}

/**
 * True when backend type B has no leases (no `runs`): RabbitMQ, NATS, and Redis or Valkey with a
 * strategy other than 'lease'. A backend typed only as `Backend` may have them.
 */
type HasNoLeases<B> = 'runs' extends keyof B ? (B[keyof B & 'runs'] extends undefined ? true : false) : true;

/**
 * Options of `new Scheduler()`. `backend` is required: no store is assumed.
 * Give every instance of a service the same options, apart from `instanceId`.
 *
 * @example Production-style setup on Redis
 * ```ts
 * new Scheduler({
 *   backend: new RedisBackend({ redis: process.env.REDIS_URL, prefix: 'billing:cron:' }), // this service's own keys
 *   instanceId: process.env.POD_NAME, // readable names in history
 *   timezone: 'Europe/Athens',       // for cron expressions
 *   logger: pino(),
 *   log: true,
 * });
 * ```
 *
 * @example Quick failover for short jobs, slow and steady for long ones
 * ```ts
 * new Scheduler({ backend, leaseMs: 6_000, heartbeatMs: 1_000 });   // a dead runner is replaced within ~8 s
 * new Scheduler({ backend, leaseMs: 120_000 });                    // tolerates 2 min of lost network
 * ```
 *
 * @example In tests and scripts: don't let the scheduler keep the process alive
 * ```ts
 * new Scheduler({ backend: new SqliteBackend({ database: ':memory:' }), unrefTimers: true });
 * ```
 */
export type SchedulerOptions<B extends Backend = Backend> = CommonSchedulerOptions<B> &
  (HasNoLeases<B> extends true ? unknown : LeaseSchedulerOptions);

/**
 * The options a job takes on a scheduler with backend B: `Options` without {@link LeaseJobOptions}
 * when B has no leases.
 *
 * @example
 * ```ts
 * type OnRabbit = JobOptionsFor<RabbitMQBackend>; // no overlap, maxAttempts or catchUpMs
 * ```
 */
export type JobOptionsFor<B, Options extends AtJobOptions = JobOptions> =
  HasNoLeases<B> extends true ? Omit<Options, keyof LeaseJobOptions> : Options;
