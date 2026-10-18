/* Copyright (C) 2026-present Aristotelis — see repository license. */

import type { RunReason } from './jobs';
import type { RunKey, RunRecord } from './runs';

/**
 * What a lease-capable backend answers when asked to claim a run. Exactly one instance gets 'won'
 * for each attempt of a run; what the scheduler does with each answer is in `LeaseRunner.run()`.
 * New kinds may be added in a minor release; a kind the scheduler doesn't know counts as 'done'.
 *
 * @example How a custom RunStore decides, in outline
 * ```ts
 * async claim(input: RunClaim): Promise<ClaimOutcome> {
 *   const run = await this.load(input.job, input.slot);
 *   if (!run) return input.mode === 'takeover' ? { kind: 'none' } : this.start(input, 1); // { kind: 'won', attempt: 1 }
 *   if (run.finished) return { kind: 'done' };
 *   if (run.leaseEnd > now) return { kind: 'running', attempt: run.attempt };
 *   return run.attempt < run.maxAttempts ? this.start(input, run.attempt + 1) : { kind: 'done' };
 * }
 * ```
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

/**
 * A claim on a lease backend: {@link ClaimInput} plus what the store needs to decide it on its own,
 * atomically: the lease to give, the overlap rule, the attempt limit and how late is too late.
 *
 * @example What the scheduler sends for a due run
 * ```ts
 * await runs.claim({
 *   job: 'report', slot: 1791633600000, token: randomUUID(), instanceId: 'api-1', historySize: 1000,
 *   mode: 'new', reason: 'scheduled', leaseMs: 30_000, overlap: 'skip', maxAttempts: 3, maxLateMs: 61_000, keepMs: 301_000,
 * });
 * ```
 */
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
 * when a lease runs out before the run is finished, a backup can claim the next attempt. A backend
 * that sets `runs` gets backups, no overlap, catch-up and retries, and the lease options.
 *
 * @example A custom backend with leases
 * ```ts
 * class MyBackend implements Backend {
 *   readonly runs: RunStore = new MyRunStore(this.db); // claim, heartbeat, finish, release, active
 *   // ...the rest of Backend
 * }
 * ```
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

/**
 * What a backend stores when an instance claims a run.
 *
 * @example A claim a custom backend receives
 * ```ts
 * { job: 'sync', slot: 1791633610000, token: '4f1c…', instanceId: 'api-2', historySize: 1000 }
 * ```
 */
export interface ClaimInput extends RunKey {
  /** Random value unique to this attempt: lets an instance recognize its own claim after a retry. */
  token: string;
  /** Who is claiming. Shown in history as the runner. */
  instanceId: string;
  /** About how many runs of the job to keep; the backend trims older ones on a claim. */
  historySize: number;
  /** Drop history entries older than this (ms). */
  historyTtlMs?: number;
}

/**
 * What the winner stores when a run ends. `history()` joins it with the claim into a RunRecord.
 *
 * @example
 * ```ts
 * { slot: 1791633610000, by: 'api-2', attempt: 1, status: 'failed', startedAt: 1791633610412,
 *   finishedAt: 1791633610615, durationMs: 203, error: 'Error: upstream timeout' }
 * ```
 */
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

/**
 * A job's settings that a backend may need to refuse it, passed to `checkJob()` when the job is
 * added: its name, how late its claims can come, and how much history it keeps.
 *
 * @example A backend that remembers runs for 5 minutes
 * ```ts
 * checkJob(job: JobLimits) {
 *   if (job.jitterMs + job.maxLateMs >= 300_000) throw new RangeError(`Job "${job.name}": claims can come too late for this store`);
 * }
 * ```
 */
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
  /**
   * Which backend and strategy, for logs and error messages: 'redis:lease', 'valkey:script',
   * 'postgres', 'sqlite', 'rabbitmq', 'nats'.
   *
   * @example
   * ```ts
   * log.info(`scheduler on ${scheduler.backend.name}`); // 'scheduler on postgres'
   * ```
   */
  readonly name: string;
  /**
   * How long the backend remembers that a run was claimed (ms). Infinity means forever.
   * jitterMs + maxLateMs of every job must be shorter than this, which the scheduler checks when a
   * job is added.
   *
   * @example
   * ```ts
   * new RedisBackend({ strategy: { name: 'script', windowMs: 600_000 } }).dedupeWindowMs; // 600000
   * new PostgresBackend().dedupeWindowMs;                                               // Infinity
   * ```
   */
  readonly dedupeWindowMs: number;
  /**
   * Throws if a job can't run safely on this backend (name, limits, options it can't honour).
   * Called when the job is added, so a bad job fails at once instead of at its first run.
   *
   * @example
   * ```ts
   * checkJob(job: JobLimits) {
   *   if (!/^[a-z0-9-]+$/.test(job.name)) throw new TypeError(`Job "${job.name}": lowercase names only on this backend`);
   * }
   * ```
   */
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
  recordManualRun(input: ClaimInput): Promise<number | undefined>;
  /** Stores how an attempt ended, and trims the job's history to historySize and historyTtlMs. */
  saveResult(job: string, result: StoredResult, historySize: number, historyTtlMs?: number): Promise<void>;
  /**
   * Latest runs of a job from all instances, newest first, at most `limit` attempts. What
   * `scheduler.history()` and `lastRun()` return.
   *
   * @example
   * ```ts
   * const [latest] = await backend.history('report', 1);
   * ```
   */
  history(job: string, limit: number): Promise<RunRecord[]>;
  /** Present when the backend supports leases (see RunStore). */
  readonly runs?: RunStore;
  /** Closes connections the backend opened itself. */
  close(): Promise<void>;
}
