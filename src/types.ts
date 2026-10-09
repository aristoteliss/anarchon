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

export interface Logger {
  /** Used by `log: true` for run messages. Falls back to console.log when missing. */
  info?(message: string, ...meta: unknown[]): void;
  warn(message: string, ...meta: unknown[]): void;
  error(message: string, ...meta: unknown[]): void;
}

export interface JobContext {
  /** Job name. */
  name: string;
  /** Scheduled run time in ms since epoch. Same value on every instance. */
  slot: number;
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

/** scheduled: on time. catch-up: missed while every instance was down. takeover: a backup re-running a run whose runner died. */
export type RunReason = 'scheduled' | 'manual' | 'catch-up' | 'takeover';

export type JobHandler = (ctx: JobContext) => unknown;

export interface JobOptions {
  /**
   * Each instance waits a random 0..jitterMs before trying to claim a run, so a random instance
   * wins each time and the work is spread. 0 = no spreading. Must be under half the time between runs.
   */
  jitterMs?: number;
  /** An instance that reaches a run later than this (ms after its scheduled time) skips it. */
  maxLateMs?: number;
  /** About how many runs to keep in history for this job. */
  historySize?: number;
  /** Also drop history older than this (ms), like SyncedCron's collectionTTL. Default: keep by count only. */
  historyTtlMs?: number;
  /**
   * Lease strategy: what to do when a run is due while the previous one is still running somewhere.
   * 'skip' (default) skips it; 'allow' runs both.
   */
  overlap?: 'skip' | 'allow';
  /** Aborts ctx.signal and marks the run failed after this many ms. Default: no limit. */
  timeoutMs?: number;
  /** Lease strategy: how many times a run may be started when runners die (first try included). Default 3. */
  maxAttempts?: number;
  /**
   * Lease strategy: on start, run the latest scheduled run if nobody ran it and it was due at most this
   * many ms ago (it was missed while every instance was down). 0 = never. Default 300000 (5 min).
   */
  catchUpMs?: number;
}

export interface CronJobOptions extends JobOptions {
  /** IANA time zone for this cron expression, e.g. 'Europe/Athens'. Defaults to the scheduler's. */
  timezone?: string;
}

export interface EveryJobOptions extends JobOptions {
  /** Shifts the interval grid. With 0, runs fall on multiples of the interval since 1970 UTC. */
  offsetMs?: number;
}

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

/** What a lease-capable backend answers when asked to claim a run. */
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
  /** Name of this instance in history. Default `${hostname}:${pid}`. */
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
  /** Default time zone for cron jobs. Default: the server's local time zone. */
  timezone?: string;
  /** Where to log errors nobody listens for. Default `console`. */
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

/** One run of a job: who ran it, when, and how it ended. */
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

export interface JobInfo {
  name: string;
  type: 'cron' | 'every' | 'once';
  schedule: string;
  /** Next scheduled run, or null if there are no more. */
  nextRunAt: Date | null;
  /** How many runs of this job this instance is executing right now. */
  runningHere: number;
}

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

export interface SchedulerErrorEvent {
  /** Backend or setup problem (not a job failure; those come as 'failure'). */
  error: unknown;
  job?: string;
  slot?: number;
}

export interface SchedulerEvents {
  start: RunStartEvent;
  success: RunRecord;
  failure: RunFailureEvent;
  interrupted: RunInterruptedEvent;
  skip: SkipEvent;
  lost: LostEvent;
  error: SchedulerErrorEvent;
}
