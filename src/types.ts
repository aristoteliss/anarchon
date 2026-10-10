import type { RedisInput } from './backends/redis/client';

/**
 * How the Redis/Valkey backend picks the single winner of each run:
 * - `lease` (default, Redis 5+, Valkey): one atomic script claims the run and gives the winner a lease it
 *   renews while the job runs. Adds: no overlapping runs, backup runners when the winner dies or
 *   freezes, catch-up of a run missed while every instance was down, and retries.
 * - `stream-id` (Redis 5+, Valkey): XADD with the run time as the entry ID; Redis refuses an ID that
 *   is not bigger than the last one, so only the first instance succeeds.
 * - `idmp` (Redis 8.6+ only): XADD with `IDMP <job> <run time>`; Redis keeps the first entry and
 *   ignores repeats.
 * - `script` (Redis 5+, Valkey): a small Lua script does the same as IDMP: it appends the run only if
 *   that run time isn't already in the stream.
 */
export type RedisStrategyName = 'lease' | 'stream-id' | 'idmp' | 'script';

/** @deprecated use RedisStrategyName */
export type ClaimStrategyName = RedisStrategyName;

/**
 * Where the scheduler writes its own messages. `console` fits, and so do pino and winston loggers.
 *
 * @example
 * ```ts
 * new Scheduler({ logger: pino(), log: true });
 * new Scheduler({ logger: { warn: (m) => myLog('warn', m), error: (m) => myLog('error', m) } });
 * ```
 */
export interface Logger {
  /** Used by `log: true` for run messages. Falls back to console.log when missing. */
  info?(message: string, ...meta: unknown[]): void;
  /** Failed and lost runs (with `log: true`), and problems while closing the backend. */
  warn(message: string, ...meta: unknown[]): void;
  /** 'error' events nobody listens for, and listeners that throw. */
  error(message: string, ...meta: unknown[]): void;
}

/**
 * What a job's handler receives.
 *
 * @example A job that is safe to run again: `slot` is the same on every instance and every attempt
 * ```ts
 * scheduler.every('invoice', '1h', async (ctx) => {
 *   await db.query('INSERT INTO invoice_runs (period) VALUES ($1) ON CONFLICT DO NOTHING', [ctx.slot]);
 *   await buildInvoices({ from: ctx.slot - 3_600_000, to: ctx.slot });
 * });
 * ```
 *
 * @example A long job that stops when asked, so another instance can continue it
 * ```ts
 * scheduler.every('export', '10m', async (ctx) => {
 *   if (ctx.attempt > 1) console.log(`continuing after ${ctx.reason}`); // 'takeover'
 *   for (const page of pages) {
 *     ctx.signal.throwIfAborted();
 *     await exportPage(page, { signal: ctx.signal }); // fetch, pg and many others accept a signal
 *   }
 * });
 * ```
 */
export interface JobContext {
  /** Job name. */
  name: string;
  /** Scheduled run time in ms since epoch. Same value on every instance. */
  slot: number;
  /** `slot` as a Date: when the run was due, not when it actually started (up to jitterMs later). */
  scheduledAt: Date;
  /** The instance running this job (you). */
  instanceId: string;
  /** true when started with `runNow()`. */
  manual: boolean;
  /**
   * Aborted when `stop()` is called, when the run times out, or (lease strategy) when this instance
   * lost the run to a backup because it stopped renewing its lease. Check it before side effects.
   *
   * If the handler throws after `stop()` aborted it (e.g. `ctx.signal.throwIfAborted()`), the run is
   * recorded as 'interrupted' and, with the lease strategy, handed to another instance right away.
   * If the handler returns normally, the run counts as finished.
   */
  signal: AbortSignal;
  /** 1 for the first try; 2, 3... when a backup took over after the previous runner died. */
  attempt: number;
  /** Why this run started. */
  reason: RunReason;
}

/**
 * Why a run started:
 * - `scheduled`: it was due.
 * - `manual`: `runNow()` was called.
 * - `catch-up`: it was due while every instance was down, and an instance that started within
 *   `catchUpMs` ran it (lease backends).
 * - `takeover`: its runner died, froze or was stopped, and a backup started the next attempt (lease backends).
 */
export type RunReason = 'scheduled' | 'manual' | 'catch-up' | 'takeover';

/**
 * The function a job runs. Sync or async. Returning (any value) means success; throwing means
 * failure, or 'interrupted' when `ctx.signal` was aborted by stop() or a takeover first.
 *
 * @example
 * ```ts
 * const sync: JobHandler = async (ctx) => {
 *   await syncCustomers({ signal: ctx.signal });
 * };
 * scheduler.every('sync', '10s', sync);
 * ```
 */
export type JobHandler = (ctx: JobContext) => unknown;

/**
 * Per-job settings, for `cron()`, `every()` and `at()`. Each one falls back to the scheduler's
 * option of the same name, then to the default given here.
 *
 * @example A heavy nightly job: at most 2 h, started at most twice, never two at once
 * ```ts
 * scheduler.cron('rebuild-index', '0 2 * * *', rebuild, {
 *   timeoutMs: 2 * 60 * 60_000,
 *   maxAttempts: 2,
 *   overlap: 'skip',
 * });
 * ```
 *
 * @example A cheap, frequent job where a missed run doesn't matter
 * ```ts
 * scheduler.every('refresh-cache', '5s', refresh, { jitterMs: 0, catchUpMs: 0, historySize: 50 });
 * ```
 *
 * @example A job that must run even if the instances were down when it was due (up to 6 h late)
 * ```ts
 * scheduler.cron('daily-report', '0 6 * * *', report, { catchUpMs: 6 * 60 * 60_000 });
 * ```
 */
export interface JobOptions {
  /**
   * Each instance waits a random 0..jitterMs before trying to claim a run, so a random instance
   * wins each time and the work is spread. 0 = no spreading: the instance with the fastest clock
   * and connection wins every time. Must be under half the time between runs.
   * Default: the scheduler's `jitterMs` (2000), or a quarter of the time between runs if smaller.
   *
   * @example
   * ```ts
   * scheduler.cron('nightly', '0 2 * * *', run, { jitterMs: 30_000 }); // starts between 02:00:00 and 02:00:30
   * scheduler.every('precise', '1m', run, { jitterMs: 0 });            // starts on the minute
   * ```
   */
  jitterMs?: number;
  /**
   * An instance that reaches a run later than this (ms after its scheduled time) skips it, with a
   * 'skip' event of reason 'late'. This is what stops a process that was frozen for minutes (a
   * suspended laptop, a long GC pause) from starting a stale run when it wakes up. Must be bigger
   * than jitterMs. Default: the scheduler's `maxLateMs` (60000).
   *
   * @example
   * ```ts
   * scheduler.every('quote-refresh', '30s', refresh, { maxLateMs: 10_000 });
   * ```
   */
  maxLateMs?: number;
  /**
   * About how many runs to keep in history for this job. Default: the scheduler's `historySize` (1000).
   *
   * @example
   * ```ts
   * scheduler.every('heartbeat', '5s', ping, { historySize: 100 });
   * ```
   */
  historySize?: number;
  /**
   * Also drop history older than this (ms), like SyncedCron's collectionTTL. Default: keep by count only.
   *
   * @example
   * ```ts
   * scheduler.cron('audit', '0 * * * *', audit, { historyTtlMs: 30 * 24 * 60 * 60_000 }); // 30 days
   * ```
   */
  historyTtlMs?: number;
  /**
   * Lease strategy: what to do when a run is due while the previous one is still running somewhere.
   * 'skip' (default) skips it, with a 'skip' event of reason 'overlap'; skipped runs are not queued.
   * 'allow' runs both.
   *
   * @example
   * ```ts
   * scheduler.every('export', '5m', exportAll);                          // never two exports at once
   * scheduler.every('sample', '5s', sample, { overlap: 'allow' });       // each run stands alone
   * ```
   */
  overlap?: 'skip' | 'allow';
  /**
   * Aborts ctx.signal and marks the run failed (error `TimeoutError`) after this many ms. The
   * handler itself is not killed: it should watch `ctx.signal`. Set it on jobs that can hang, since
   * with overlap 'skip' a hung run blocks every later run of the job. Default: no limit.
   *
   * @example
   * ```ts
   * scheduler.every('export', '5m', (ctx) => exportAll({ signal: ctx.signal }), { timeoutMs: 4 * 60_000 });
   * ```
   */
  timeoutMs?: number;
  /**
   * Lease strategy: how many times a run may be started when runners die (first try included).
   * 1 = never retried. A hand-over on stop() doesn't count. A run that fails by throwing is not
   * retried either: retries are for runners that died. 1 to 100. Default 3.
   *
   * @example
   * ```ts
   * scheduler.cron('charge-cards', '0 6 * * *', charge, { maxAttempts: 1 }); // never started twice
   * ```
   */
  maxAttempts?: number;
  /**
   * Lease strategy: on start, run the latest scheduled run if nobody ran it and it was due at most this
   * many ms ago (it was missed while every instance was down). Only the latest run is caught up,
   * not every missed one. 0 = never. Default 300000 (5 min).
   *
   * @example
   * ```ts
   * scheduler.cron('daily-report', '0 6 * * *', report, { catchUpMs: 6 * 60 * 60_000 }); // up to 6 h late
   * scheduler.every('refresh-cache', '5s', refresh, { catchUpMs: 0 });
   * ```
   */
  catchUpMs?: number;
}

/**
 * Options of `cron()`.
 *
 * @example
 * ```ts
 * scheduler.cron('open-market', '30 9 * * 1-5', open, { timezone: 'America/New_York' });
 * ```
 */
export interface CronJobOptions extends JobOptions {
  /**
   * IANA time zone for this cron expression, e.g. 'Europe/Athens'. Defaults to the scheduler's
   * `timezone`, then to the server's local zone. Daylight-saving changes are followed: '0 8 * * *'
   * stays 08:00 local time all year.
   *
   * @example
   * ```ts
   * scheduler.cron('open-market', '30 9 * * 1-5', open, { timezone: 'America/New_York' });
   * scheduler.cron('utc-midnight', '0 0 * * *', rollOver, { timezone: 'UTC' });
   * ```
   */
  timezone?: string;
}

/**
 * Options of `every()`.
 *
 * @example Two hourly jobs that should not start together
 * ```ts
 * scheduler.every('a', '1h', runA);                              // 00:00, 01:00, ...
 * scheduler.every('b', '1h', runB, { offsetMs: 30 * 60_000 });   // 00:30, 01:30, ...
 * ```
 */
export interface EveryJobOptions extends JobOptions {
  /**
   * Shifts the interval grid (ms). With 0, runs fall on multiples of the interval since 1970 UTC:
   * `'10s'` runs at :00, :10, :20; `'1h'` on the hour. Must be the same on every instance.
   *
   * @example
   * ```ts
   * scheduler.every('invoices', '1h', build, { offsetMs: 30 * 60_000 }); // 00:30, 01:30, ...
   * scheduler.every('daily', '1d', run, { offsetMs: 3 * 60 * 60_000 });  // 03:00 UTC every day
   * ```
   */
  offsetMs?: number;
}

/**
 * Settings of the Redis 'idmp' strategy (Redis 8.6+).
 *
 * @example A job with jitterMs 5 s and maxLateMs 10 min needs Redis to remember runs for longer than that
 * ```ts
 * new Scheduler({ redis, strategy: 'idmp', idmp: { durationSec: 900 } });
 * ```
 */
export interface IdmpOptions {
  /**
   * How long Redis remembers a run's ID (seconds, 1-86400). Must be longer than
   * jitterMs + maxLateMs + any clock difference between your instances. Default 300.
   *
   * @example
   * ```ts
   * new Scheduler({ redis, strategy: 'idmp', maxLateMs: 600_000, idmp: { durationSec: 900 } });
   * ```
   */
  durationSec?: number;
  /**
   * How many run IDs Redis keeps per job (1-10000). Together with the time between runs it must
   * cover jitterMs + maxLateMs: a job every second with maxSize 50 is remembered for 50 s. Default 1000.
   *
   * @example
   * ```ts
   * new Scheduler({ redis, strategy: 'idmp', idmp: { maxSize: 5_000 } });
   * ```
   */
  maxSize?: number;
}

// ------------------------------------------------------------------ backend contract

/**
 * What a lease-capable backend answers when asked to claim a run. Exactly one instance gets 'won'
 * for each attempt of a run; what the scheduler does with each answer is in `LeaseRunner.run()`.
 */
export type ClaimOutcome =
  | { kind: 'won'; attempt: number }
  /** Someone alive is running it. */
  | { kind: 'running'; attempt: number }
  /** Finished, or given up after maxAttempts. */
  | { kind: 'done' }
  /** Another run of the same job is still running (overlap 'skip'). */
  | { kind: 'overlap'; slot: number }
  /** A takeover was asked for a run nobody ever claimed. */
  | { kind: 'none' }
  /** A new run was asked for more than maxLateMs after its slot, by the server's clock. */
  | { kind: 'late'; lateMs: number };

export interface RunClaim extends ClaimInput {
  /** 'new': a run that is due. 'takeover': a run whose runner stopped renewing its lease. */
  mode: 'new' | 'takeover';
  /** Stored with the attempt and shown in history. */
  reason: RunReason;
  /** The lease given to the winner: it ends this long after the claim, on the server's clock. */
  leaseMs: number;
  /** 'skip': answer 'overlap' when an earlier run of the job has a live lease. 'allow': ignore other runs. */
  overlap: 'skip' | 'allow';
  /** Stored with the run on its first claim; later attempts are checked against the stored value. */
  maxAttempts: number;
  /**
   * Refuse to start a new run more than this many ms after its slot, by the server's clock (0 or
   * missing: no limit). Stops claims that were delayed or queued (e.g. during an outage) from
   * starting a stale run.
   */
  maxLateMs?: number;
  /**
   * Never forget a run younger than this (ms, server clock), even beyond historySize. Must cover
   * maxLateMs of every claim, so a run that is forgotten can never be claimed again.
   */
  keepMs?: number;
}

/**
 * Optional backend capability: runs with leases. The winner renews its lease while the job runs;
 * when a lease runs out before the run is finished, a backup can claim the next attempt.
 */
export interface RunStore {
  /** Decides one claim atomically. Exactly one caller gets 'won' for each attempt of a run. */
  claim(input: RunClaim): Promise<ClaimOutcome>;
  /** Renews the lease. false: the run is no longer ours (a backup took it over). */
  heartbeat(job: string, slot: number, token: string, leaseMs: number): Promise<boolean>;
  /** Marks the run finished. false: the run is no longer ours. */
  finish(job: string, slot: number, token: string, status: 'success' | 'failed' | 'interrupted'): Promise<boolean>;
  /**
   * Gives an unfinished run up so a backup can take it over now (graceful shutdown). This doesn't
   * count against maxAttempts. false: the run is no longer ours.
   */
  release(job: string, slot: number, token: string): Promise<boolean>;
  /** Runs of this job not finished yet, and whether their lease is still alive. */
  active(job: string): Promise<Array<{ slot: number; attempt: number; alive: boolean }>>;
}

/** What a backend stores when an instance claims a run. */
export interface ClaimInput {
  /** The job's name. With `slot`, the identity of the run. */
  job: string;
  /** Scheduled run time (ms). */
  slot: number;
  /** Random value unique to this attempt: lets an instance recognize its own claim after a retry. */
  token: string;
  /** Who is claiming. Shown in history as the runner. */
  instanceId: string;
  /** About how many runs of the job to keep; the backend trims older ones on a claim. */
  historySize: number;
  /** Drop history entries older than this (ms). */
  historyTtlMs?: number;
}

/** What the winner stores when a run ends. */
export interface StoredResult {
  /** The run's scheduled time (ms). */
  slot: number;
  /** The instance that ran this attempt. */
  by: string;
  /** Which attempt this result belongs to. Missing means 1. */
  attempt?: number;
  /** How the attempt ended. ('running' is never stored: it is a claim without a result.) */
  status: 'success' | 'failed' | 'interrupted';
  /** When the handler was called (ms since epoch, the instance's clock). */
  startedAt: number;
  /** When the handler ended (ms since epoch, the instance's clock). */
  finishedAt: number;
  /** finishedAt - startedAt. */
  durationMs: number;
  /** What the handler threw, as `Name: message`, cut at 2000 characters. */
  error?: string;
}

export interface JobLimits {
  /** The job's name, for error messages and for backends that restrict names. */
  name: string;
  /** The job's jitter after defaults were applied. */
  jitterMs: number;
  /** The job's lateness limit after defaults were applied. With jitterMs: the latest a claim is sent. */
  maxLateMs: number;
  /** Smallest gap between two runs of the job (ms). */
  minGapMs: number;
  /** How many runs the job keeps: a limit on memory for backends that find claimed runs in history. */
  historySize: number;
  /** How long the job keeps history, if limited. */
  historyTtlMs?: number;
}

/**
 * Where runs are claimed and recorded. Every backend gives the same guarantee: for one slot,
 * `claim()` returns true for exactly one instance.
 *
 * The built-in backends get that from one atomic operation of their store; each class explains its
 * own: {@link RedisBackend} (a script or XADD), {@link PostgresBackend} and {@link SqliteBackend}
 * (one transaction on the run's row), {@link RabbitMQBackend} (a queue of length 1 with publisher
 * confirms), {@link NatsBackend} (JetStream message de-duplication).
 *
 * @example The idea, as a backend for tests: one process, so a Map is atomic enough
 * ```ts
 * class MemoryBackend implements Backend {
 *   readonly name = 'memory';
 *   readonly dedupeWindowMs = Infinity;
 *   private claims = new Map<string, ClaimInput>();
 *   private results: StoredResult[] = [];
 *   async init() {}
 *   async prepareJob() {}
 *   async claim(input: ClaimInput) {
 *     const key = `${input.job}:${input.slot}`;
 *     const first = this.claims.get(key) ?? input; // whoever asked first holds the run
 *     this.claims.set(key, first);
 *     return first.token === input.token;
 *   }
 *   async recordManualRun(input: ClaimInput) {
 *     this.claims.set(`${input.job}:${input.slot}:manual`, input);
 *   }
 *   async saveResult(_job: string, result: StoredResult) {
 *     this.results.push(result);
 *   }
 *   async history() {
 *     return [];
 *   }
 *   async close() {}
 * }
 * new Scheduler({ backend: new MemoryBackend() });
 * ```
 */
export interface Backend {
  /** e.g. 'redis:lease', 'redis:stream-id'. */
  readonly name: string;
  /**
   * How long the backend remembers that a run was claimed (ms). Infinity means forever.
   * jitterMs + maxLateMs of every job must be shorter than this.
   */
  readonly dedupeWindowMs: number;
  /** Throws if a job can't run safely on this backend (name, limits). */
  checkJob?(job: JobLimits): void;
  /** Connects and checks the server. Called by start() and before reads. */
  init(): Promise<void>;
  /** One-time setup for a job (streams, queues). */
  prepareJob(job: string, historySize: number): Promise<void>;
  /** True for exactly one instance per slot. Safe to repeat with the same token. */
  claim(input: ClaimInput): Promise<boolean>;
  /** Called after a won claim, for backends whose claim isn't already a history record. */
  recordClaim?(input: ClaimInput): Promise<void>;
  /** Records a manual run (runNow), not deduplicated. May return the slot it actually used. */
  recordManualRun(input: ClaimInput): Promise<number | void>;
  /** Stores how an attempt ended, and trims the job's history to historySize and historyTtlMs. */
  saveResult(job: string, result: StoredResult, historySize: number, historyTtlMs?: number): Promise<void>;
  /** Latest runs of a job from all instances, newest first. */
  history(job: string, limit: number): Promise<RunRecord[]>;
  /** Present when the backend supports leases (see RunStore). */
  readonly runs?: RunStore;
  /** Closes connections the backend opened itself. */
  close(): Promise<void>;
}

// ------------------------------------------------------------------ scheduler

/**
 * Options of `new Scheduler()`. All optional: `new Scheduler()` uses Redis on localhost:6379.
 *
 * Pass either `backend`, or the Redis shortcuts (`redis`, `strategy`, `prefix`, `idmp`), not both.
 * Give every instance of a service the same options, apart from `instanceId`.
 *
 * @example Production-style setup on Redis
 * ```ts
 * new Scheduler({
 *   redis: process.env.REDIS_URL,
 *   prefix: 'billing:cron:',        // this service's own keys
 *   instanceId: process.env.POD_NAME, // readable names in history
 *   timezone: 'Europe/Athens',       // for cron expressions
 *   logger: pino(),
 *   log: true,
 * });
 * ```
 *
 * @example Quick failover for short jobs, slow and steady for long ones
 * ```ts
 * new Scheduler({ redis, leaseMs: 6_000, heartbeatMs: 1_000 });   // a dead runner is replaced within ~8 s
 * new Scheduler({ redis, leaseMs: 120_000 });                    // tolerates 2 min of lost network
 * ```
 *
 * @example In tests and scripts: don't let the scheduler keep the process alive
 * ```ts
 * new Scheduler({ backend: new SqliteBackend({ database: ':memory:' }), unrefTimers: true });
 * ```
 */
export interface SchedulerOptions {
  /**
   * Where runs are claimed and recorded. Use it for every store but Redis, or for Redis settings the
   * shortcuts below don't cover. Default: a RedisBackend built from `redis`, `strategy`, `prefix`
   * and `idmp`. Passing `backend` together with any of those four throws.
   *
   * @example
   * ```ts
   * new Scheduler({ backend: new PostgresBackend({ connection: process.env.DATABASE_URL }) });
   * new Scheduler({ backend: new SqliteBackend({ database: './jobs.db' }) });
   * new Scheduler({ backend: new RedisBackend({ strategy: 'script', scriptWindowMs: 600_000 }) });
   * ```
   */
  backend?: Backend;
  /**
   * Shortcut for the default Redis/Valkey backend: where the server is. A URL, `{ host, port, ... }`,
   * or a client your app already has (never closed by stop()). Default localhost:6379.
   *
   * @example
   * ```ts
   * new Scheduler({ redis: 'redis://cache.internal:6379' });
   * new Scheduler({ redis: 'rediss://user:secret@host:6380/2' }); // TLS, credentials, database 2
   * new Scheduler({ redis: { host: 'localhost', port: 6390 } });   // Valkey
   * new Scheduler({ redis: new Redis(process.env.REDIS_URL) });    // your ioredis client
   * ```
   */
  redis?: RedisInput;
  /**
   * Shortcut for the default Redis/Valkey backend: how the single runner of each run is picked.
   * Default 'lease', the only one with backups, no overlapping runs, retries and catch-up.
   *
   * @example
   * ```ts
   * new Scheduler({ redis, strategy: 'stream-id' }); // one winner per run, nothing more
   * ```
   */
  strategy?: RedisStrategyName;
  /**
   * Shortcut for the default Redis/Valkey backend: prefix of every key. Default 'cron:'. Instances
   * that share jobs must use the same prefix; services that share a Redis must use different ones.
   *
   * @example
   * ```ts
   * new Scheduler({ redis, prefix: 'billing:cron:' });
   * new Scheduler({ redis, prefix: `${process.env.APP_ENV}:billing:cron:` }); // staging and production apart
   * ```
   */
  prefix?: string;
  /**
   * Shortcut for the default Redis backend: settings for the 'idmp' strategy (Redis 8.6+).
   *
   * @example
   * ```ts
   * new Scheduler({ redis, strategy: 'idmp', idmp: { durationSec: 900, maxSize: 5_000 } });
   * ```
   */
  idmp?: IdmpOptions;
  /**
   * Name of this instance in history and events. Must differ between instances, or history can't
   * tell them apart. Default `${hostname}:${pid}`; a pod name or host name reads better.
   *
   * @example
   * ```ts
   * new Scheduler({ redis, instanceId: process.env.POD_NAME }); // 'billing-7d9f8c-x2x4q'
   * new Scheduler({ redis, instanceId: `api-${process.env.PORT}` });
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
   * new Scheduler({ redis, jitterMs: 500 }); // runs start within half a second of their time
   * new Scheduler({ redis, jitterMs: 0 });   // on the dot; the fastest instance always wins
   * ```
   */
  jitterMs?: number;
  /**
   * Default maxLateMs for all jobs: an instance that reaches a run later than this skips it, so a
   * process that was frozen doesn't start stale runs when it wakes. Default 60000.
   *
   * @example
   * ```ts
   * new Scheduler({ redis, maxLateMs: 10_000 }); // a run that can't start within 10 s is dropped
   * ```
   */
  maxLateMs?: number;
  /**
   * Default history size per job: about how many runs `history()` can return. Default 1000.
   *
   * @example
   * ```ts
   * new Scheduler({ redis, historySize: 200 });
   * ```
   */
  historySize?: number;
  /**
   * Default history age limit per job (ms): records older than this are dropped as well.
   * Default: none (keep by count only).
   *
   * @example
   * ```ts
   * new Scheduler({ redis, historyTtlMs: 7 * 24 * 60 * 60_000 }); // one week
   * ```
   */
  historyTtlMs?: number;
  /**
   * Log every start, success, failure, interruption, skip and lost run through `logger`, one line
   * each (like SyncedCron's `log`). Default false.
   *
   * @example
   * ```ts
   * new Scheduler({ redis, log: true });
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
   * const scheduler = new Scheduler({ redis, timezone: 'Europe/Athens' });
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
   * new Scheduler({ redis, logger: pino() });
   * new Scheduler({ redis, logger: { warn: (m) => log('warn', m), error: (m) => log('error', m) } });
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
  /**
   * Lease strategy: a running job's lease lasts this long and is renewed every heartbeatMs. A runner
   * that stops renewing (crash, freeze, lost network) loses the run to a backup about leaseMs later
   * (at most leaseMs + 2 × heartbeatMs). Default 30000.
   *
   * Shorter means faster takeover; longer tolerates longer pauses of a healthy runner.
   *
   * @example
   * ```ts
   * new Scheduler({ redis, leaseMs: 10_000 });  // a dead runner is replaced within about 13 s
   * new Scheduler({ redis, leaseMs: 120_000 }); // survives two minutes without the store
   * ```
   */
  leaseMs?: number;
  /**
   * Lease strategy: how often a running job renews its lease, and how often backups check on it
   * (every 1 to 2 heartbeats). Must be under half of leaseMs. Default 5000, or leaseMs / 6 if smaller.
   *
   * @example
   * ```ts
   * new Scheduler({ redis, leaseMs: 6_000, heartbeatMs: 1_000 });
   * ```
   */
  heartbeatMs?: number;
}

/**
 * interrupted: the attempt didn't finish. Its runner died or froze, lost the run to a backup, or
 * was stopped with `stop()`.
 */
export type RunStatus = 'running' | 'success' | 'failed' | 'interrupted';

/**
 * One attempt of one run of a job: who ran it, when, and how it ended. Returned by `history()`,
 * `lastRun()` and `runNow()`, and the payload of the 'success' event.
 *
 * @example What `history()` returns for a run that was taken over (newest first)
 * ```ts
 * [
 *   { job: 'report', slot: 1791633600000, instanceId: 'api-2', attempt: 2, reason: 'takeover',
 *     status: 'success', startedAt: 2026-10-10T12:00:34Z, finishedAt: 2026-10-10T12:01:14Z, durationMs: 40012 },
 *   { job: 'report', slot: 1791633600000, instanceId: 'api-1', attempt: 1, reason: 'scheduled',
 *     status: 'interrupted', startedAt: 2026-10-10T12:00:01Z },
 * ]
 * ```
 */
export interface RunRecord {
  /** The job's name. */
  job: string;
  /** Scheduled run time (ms since epoch). */
  slot: number;
  /** `slot` as a Date: when the run was due. */
  scheduledAt: Date;
  /** The instance that ran it. */
  instanceId: string;
  /** true when started with runNow(). */
  manual: boolean;
  /** 1 for the first try, 2+ when a backup took over. Each attempt is its own record. */
  attempt: number;
  /** Why this attempt started. Missing on backends that don't record it. */
  reason?: RunReason;
  /**
   * 'running': in progress. 'interrupted': its runner stopped before finishing (lease strategy;
   * other strategies keep showing 'running').
   */
  status: RunStatus;
  /** When the instance claimed and started the run. */
  startedAt: Date;
  /** When the attempt ended. Missing while it runs, and for an attempt whose runner died. */
  finishedAt?: Date;
  /** finishedAt - startedAt. Missing with finishedAt. */
  durationMs?: number;
  /** Error message when status is 'failed'. */
  error?: string;
}

/** A registered job, as `jobs()` reports it. */
export interface JobInfo {
  /** The job's name. */
  name: string;
  /** Which method registered it: cron(), every() or at() ('once'). */
  type: 'cron' | 'every' | 'once';
  /** The schedule in words, e.g. 'every 10s' or 'cron "0 8 * * 1-5" (Europe/Athens)'. */
  schedule: string;
  /** Next scheduled run, or null if there are no more. */
  nextRunAt: Date | null;
  /** How many runs of this job this instance is executing right now. */
  runningHere: number;
}

/** Payload of 'start': this instance won a run and is about to call the handler. */
export interface RunStartEvent {
  /** The job's name. */
  job: string;
  /** The run's scheduled time (ms since epoch). */
  slot: number;
  /** `slot` as a Date. */
  scheduledAt: Date;
  /** This instance. */
  instanceId: string;
  /** true when started with runNow(). */
  manual: boolean;
  /** 1, or 2+ when this instance is taking the run over. */
  attempt: number;
  /** Why the run starts here. */
  reason: RunReason;
}

/** This instance stopped owning a run it was executing (a backup took over); ctx.signal was aborted. */
export interface LostEvent {
  /** The job's name. */
  job: string;
  /** The run that was taken over (ms since epoch). */
  slot: number;
  /** The attempt this instance was running. The backup runs attempt + 1. */
  attempt: number;
  /** This instance. */
  instanceId: string;
}

/** Payload of 'failure': the handler threw (or timed out). `error` is the message, `cause` the thrown value. */
export interface RunFailureEvent extends RunRecord {
  /** The value the job threw. */
  cause: unknown;
}

/**
 * A run ended without finishing because `stop()` or a backup's takeover aborted ctx.signal and the
 * job then threw. Not a job failure.
 */
export interface RunInterruptedEvent extends RunRecord {
  /** The value the job threw. */
  cause: unknown;
  /** Lease strategy: the run was given to another instance to finish (graceful shutdown). */
  handedOver: boolean;
}

/**
 * Payload of 'skip': a run was due and this instance did not run it. With several instances this is
 * the normal case: for every run, all instances but one emit 'skip' with reason 'taken'.
 */
export interface SkipEvent {
  /** The job's name. */
  job: string;
  /** The run this instance did not run (ms since epoch). */
  slot: number;
  /** `slot` as a Date. */
  scheduledAt: Date;
  /** This instance. */
  instanceId: string;
  /**
   * 'taken': another instance won this run. 'late': this instance got there after maxLateMs.
   * 'overlap': the previous run of this job is still running (overlap 'skip').
   */
  reason: 'taken' | 'late' | 'overlap';
  /** With reason 'late': how long after the slot the run was reached. */
  lateMs?: number;
}

/** Payload of 'error'. Without an 'error' listener these are written to the logger instead. */
export interface SchedulerErrorEvent {
  /** Backend or setup problem (not a job failure; those come as 'failure'). */
  error: unknown;
  /** The job the problem belongs to, when it belongs to one. */
  job?: string;
  /** The run the problem belongs to, when it belongs to one. */
  slot?: number;
}

/**
 * Every event of `scheduler.on()` and its payload. Events describe what happened on this instance
 * only; `history()` is the view across all instances.
 *
 * | event | when |
 * | --- | --- |
 * | `start` | this instance won a run and starts the handler |
 * | `success` | the handler returned |
 * | `failure` | the handler threw, or `timeoutMs` passed |
 * | `interrupted` | stop() or a takeover aborted `ctx.signal`, and the handler then threw |
 * | `skip` | a run was due and this instance didn't run it: 'taken', 'late' or 'overlap' |
 * | `lost` | a backup took over a run this instance was executing (it stopped renewing its lease) |
 * | `error` | a backend or setup problem; job failures are 'failure' |
 *
 * @example
 * ```ts
 * scheduler.on('failure', (run) => {
 *   if (run.cause instanceof RateLimitError) return; // the thrown value itself
 *   pager.notify(`${run.job} @ ${run.scheduledAt.toISOString()} failed on ${run.instanceId}: ${run.error}`);
 * });
 * ```
 */
export interface SchedulerEvents {
  /** This instance won a run and is about to call the handler. */
  start: RunStartEvent;
  /** The handler returned. */
  success: RunRecord;
  /** The handler threw, or timeoutMs passed. */
  failure: RunFailureEvent;
  /** stop() or a takeover aborted ctx.signal, and the handler then threw. */
  interrupted: RunInterruptedEvent;
  /** A run was due and this instance did not run it. */
  skip: SkipEvent;
  /** A backup took over a run this instance was executing. */
  lost: LostEvent;
  /** A backend or setup problem. Never a job failure. */
  error: SchedulerErrorEvent;
}
