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
  warn(message: string, ...meta: unknown[]): void;
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
   * @example `jitterMs: 5_000` on an hourly job: it starts between hh:00:00 and hh:00:05.
   */
  jitterMs?: number;
  /**
   * An instance that reaches a run later than this (ms after its scheduled time) skips it, with a
   * 'skip' event of reason 'late'. This is what stops a process that was frozen for minutes (a
   * suspended laptop, a long GC pause) from starting a stale run when it wakes up.
   * Default: the scheduler's `maxLateMs` (60000).
   */
  maxLateMs?: number;
  /** About how many runs to keep in history for this job. Default: the scheduler's `historySize` (1000). */
  historySize?: number;
  /** Also drop history older than this (ms), like SyncedCron's collectionTTL. Default: keep by count only. */
  historyTtlMs?: number;
  /**
   * Lease strategy: what to do when a run is due while the previous one is still running somewhere.
   * 'skip' (default) skips it; 'allow' runs both.
   */
  overlap?: 'skip' | 'allow';
  /**
   * Aborts ctx.signal and marks the run failed (error `TimeoutError`) after this many ms. The
   * handler itself is not killed: it should watch `ctx.signal`. Set it on jobs that can hang, since
   * with overlap 'skip' a hung run blocks every later run of the job. Default: no limit.
   */
  timeoutMs?: number;
  /**
   * Lease strategy: how many times a run may be started when runners die (first try included).
   * 1 = never retried. A hand-over on stop() doesn't count. A run that fails by throwing is not
   * retried either: retries are for runners that died. Default 3.
   */
  maxAttempts?: number;
  /**
   * Lease strategy: on start, run the latest scheduled run if nobody ran it and it was due at most this
   * many ms ago (it was missed while every instance was down). 0 = never. Default 300000 (5 min).
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
  /** IANA time zone for this cron expression, e.g. 'Europe/Athens'. Defaults to the scheduler's. */
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
   */
  durationSec?: number;
  /** How many run IDs Redis keeps per job (1-10000). Default 1000. */
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
  reason: RunReason;
  leaseMs: number;
  overlap: 'skip' | 'allow';
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
  job: string;
  /** Scheduled run time (ms). */
  slot: number;
  /** Random value unique to this attempt: lets an instance recognize its own claim after a retry. */
  token: string;
  instanceId: string;
  historySize: number;
  /** Drop history entries older than this (ms). */
  historyTtlMs?: number;
}

/** What the winner stores when a run ends. */
export interface StoredResult {
  slot: number;
  by: string;
  attempt?: number;
  status: 'success' | 'failed' | 'interrupted';
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  error?: string;
}

export interface JobLimits {
  name: string;
  jitterMs: number;
  maxLateMs: number;
  /** Smallest gap between two runs of the job (ms). */
  minGapMs: number;
  historySize: number;
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
   * Where runs are claimed and recorded. Default: a RedisBackend built from `redis`, `strategy`,
   * `prefix` and `idmp`. Other backends can implement the Backend interface.
   */
  backend?: Backend;
  /** Shortcut for the default Redis/Valkey backend: connection or client. Default localhost:6379. */
  redis?: RedisInput;
  /** Shortcut for the default Redis/Valkey backend. Default 'lease'. */
  strategy?: RedisStrategyName;
  /** Shortcut for the default Redis/Valkey backend: key prefix. Default 'cron:'. */
  prefix?: string;
  /** Shortcut for the default Redis backend: settings for the 'idmp' strategy. */
  idmp?: IdmpOptions;
  /**
   * Name of this instance in history and events. Must differ between instances, or history can't
   * tell them apart. Default `${hostname}:${pid}`; a pod name or host name reads better.
   */
  instanceId?: string;
  /** Default jitter for all jobs (ms). Default 2000, lowered automatically for short intervals. */
  jitterMs?: number;
  /** Default maxLateMs for all jobs. Default 60000. */
  maxLateMs?: number;
  /** Default history size per job. Default 1000. */
  historySize?: number;
  /** Default history age limit per job (ms). Default: none (keep by count only). */
  historyTtlMs?: number;
  /** Log every start, success, failure, skip and lost run through `logger` (like SyncedCron's `log`). Default false. */
  log?: boolean;
  /**
   * Default IANA time zone for cron jobs, e.g. 'Europe/Athens' or 'UTC'. Set it: the default is the
   * server's local time zone, which can differ between machines. `every()` ignores it (UTC grid).
   */
  timezone?: string;
  /** Where to log 'error' events nobody listens for, and the run messages of `log: true`. Default `console`. */
  logger?: Logger;
  /** If true, the scheduler's timers don't keep the process alive. Default false. */
  unrefTimers?: boolean;
  /**
   * Lease strategy: a running job's lease lasts this long and is renewed every heartbeatMs. A runner
   * that stops renewing (crash, freeze, lost network) loses the run to a backup about leaseMs later
   * (at most leaseMs + 2 × heartbeatMs). Default 30000.
   */
  leaseMs?: number;
  /**
   * Lease strategy: how often a running job renews its lease, and how often backups check on it
   * (every 1 to 2 heartbeats). Default 5000, or leaseMs / 6 if smaller.
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
  job: string;
  /** Scheduled run time (ms since epoch). */
  slot: number;
  scheduledAt: Date;
  /** The instance that ran it. */
  instanceId: string;
  manual: boolean;
  /** 1 for the first try, 2+ when a backup took over. Each attempt is its own record. */
  attempt: number;
  reason?: RunReason;
  /**
   * 'running': in progress. 'interrupted': its runner stopped before finishing (lease strategy;
   * other strategies keep showing 'running').
   */
  status: RunStatus;
  /** When the instance claimed and started the run. */
  startedAt: Date;
  finishedAt?: Date;
  durationMs?: number;
  /** Error message when status is 'failed'. */
  error?: string;
}

/** A registered job, as `jobs()` reports it. */
export interface JobInfo {
  name: string;
  type: 'cron' | 'every' | 'once';
  schedule: string;
  /** Next scheduled run, or null if there are no more. */
  nextRunAt: Date | null;
  /** How many runs of this job this instance is executing right now. */
  runningHere: number;
}

/** Payload of 'start': this instance won a run and is about to call the handler. */
export interface RunStartEvent {
  job: string;
  slot: number;
  scheduledAt: Date;
  instanceId: string;
  manual: boolean;
  attempt: number;
  reason: RunReason;
}

/** This instance stopped owning a run it was executing (a backup took over); ctx.signal was aborted. */
export interface LostEvent {
  job: string;
  slot: number;
  attempt: number;
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
  job: string;
  slot: number;
  scheduledAt: Date;
  instanceId: string;
  /**
   * 'taken': another instance won this run. 'late': this instance got there after maxLateMs.
   * 'overlap': the previous run of this job is still running (overlap 'skip').
   */
  reason: 'taken' | 'late' | 'overlap';
  lateMs?: number;
}

/** Payload of 'error'. Without an 'error' listener these are written to the logger instead. */
export interface SchedulerErrorEvent {
  /** Backend or setup problem (not a job failure; those come as 'failure'). */
  error: unknown;
  job?: string;
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
  start: RunStartEvent;
  success: RunRecord;
  failure: RunFailureEvent;
  interrupted: RunInterruptedEvent;
  skip: SkipEvent;
  lost: LostEvent;
  error: SchedulerErrorEvent;
}
