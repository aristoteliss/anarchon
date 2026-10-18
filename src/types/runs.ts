/* Copyright (C) 2026-present Aristotelis — see repository license. */

import type { RunReason } from './jobs';

/**
 * Which run something is about: a job and one of its scheduled times. Every run event, history
 * record and claim carries it.
 *
 * @example Tell runs apart in logs and metrics
 * ```ts
 * const runId = ({ job, slot }: RunKey) => `${job}@${new Date(slot).toISOString()}`;
 * scheduler.on('start', (e) => log.info(`started ${runId(e)}`));
 * scheduler.on('skip', (e) => metrics.increment('skipped', { run: runId(e), reason: e.reason }));
 * ```
 */
export interface RunKey {
  /** The job's name, as given to `every()`, `cron()`, `at()` or a decorator. */
  job: string;
  /**
   * When the run was due (ms since epoch). Every instance computes the same value, so `job` and
   * `slot` together name one run across the cluster. For a runNow() run: when it was asked for.
   */
  slot: number;
}

/**
 * What every run event and history record says besides {@link RunKey}: when the run was due, and
 * which instance it is about.
 *
 * @example One log format for every kind of run event
 * ```ts
 * const line = (e: RunEvent) => `${e.job} due ${e.scheduledAt.toISOString()} on ${e.instanceId}`;
 * scheduler.on('start', (e) => log.info(line(e)));
 * scheduler.on('skip', (e) => log.debug(`${line(e)}: ${e.reason}`));
 * scheduler.on('lost', (e) => log.warn(`${line(e)}: taken over by a backup`));
 * ```
 */
export interface RunEvent extends RunKey {
  /** `slot` as a Date. */
  scheduledAt: Date;
  /**
   * The instance: the one the event happened on, or in history the one that ran the attempt. Set
   * it with the scheduler's `instanceId` option (a pod or host name reads well).
   */
  instanceId: string;
}

/**
 * How an attempt stands. 'running': in progress, or its runner died on a backend without leases.
 * 'success': the handler returned. 'failed': it threw or timed out. 'interrupted': it didn't
 * finish; its runner died or froze, lost the run to a backup, or was stopped with `stop()`.
 * New values may be added in a minor release: keep a default branch when you switch over them.
 *
 * @example
 * ```ts
 * const runs = await scheduler.history('nightly-export', 20);
 * const failures = runs.filter((run) => run.status === 'failed' || run.status === 'interrupted');
 * ```
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
 *
 * @example Alert when the latest run of a job is too old or failed
 * ```ts
 * const last = await scheduler.lastRun('sync-customers');
 * if (!last || Date.now() - last.scheduledAt.getTime() > 30 * 60_000) alert('sync-customers has not run for 30 min');
 * else if (last.status === 'failed') alert(`sync-customers failed on ${last.instanceId}: ${last.error}`);
 * ```
 */
export interface RunRecord extends RunEvent {
  /** true when started with runNow(). */
  manual: boolean;
  /** 1 for the first try, 2+ when a backup took over. Each attempt is its own record. */
  attempt: number;
  /** Why this attempt started. Missing on backends that don't record it (RabbitMQ, NATS). */
  reason?: RunReason;
  /**
   * 'running': in progress. 'interrupted': its runner stopped before finishing (lease backends;
   * the others keep showing 'running').
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

/**
 * A registered job, as `jobs()` reports it.
 *
 * @example A health endpoint that lists the jobs and when they run next
 * ```ts
 * app.get('/health/jobs', (_req, res) => {
 *   res.json(scheduler.jobs().map((job) => ({ name: job.name, schedule: job.schedule, next: job.nextRunAt })));
 * });
 * ```
 */
export interface JobInfo {
  /** The job's name. */
  name: string;
  /** Which method registered it: cron(), every() or at() ('once'). New values may be added in a minor release: keep a default branch when you switch over them. */
  type: 'cron' | 'every' | 'once';
  /** The schedule in words, e.g. 'every 10s' or 'cron "0 8 * * 1-5" (Europe/Athens)'. */
  schedule: string;
  /** Next scheduled run, or null if there are no more (a one-off job that already ran). */
  nextRunAt: Date | null;
  /** How many runs of this job this instance is executing right now (more than 1 only with overlap 'allow' or runNow()). */
  runningHere: number;
}

/**
 * Payload of 'start': this instance won a run and is about to call the handler.
 *
 * @example Count runs per instance, and notice takeovers
 * ```ts
 * scheduler.on('start', (e) => {
 *   metrics.increment('job.start', { job: e.job, instance: e.instanceId, reason: e.reason });
 *   if (e.reason === 'takeover') log.warn(`${e.job}: attempt ${e.attempt} taken over by ${e.instanceId}`);
 * });
 * ```
 */
export interface RunStartEvent extends RunEvent {
  /** true when started with runNow(). */
  manual: boolean;
  /** 1, or 2+ when this instance is taking the run over. */
  attempt: number;
  /** Why the run starts here. */
  reason: RunReason;
}

/**
 * Payload of 'lost': this instance stopped owning a run it was executing, because a backup took it
 * over (this instance missed its heartbeats: a long pause, or the store was unreachable).
 * `ctx.signal` of that run was aborted. Only on backends with leases.
 *
 * @example
 * ```ts
 * scheduler.on('lost', (e) => {
 *   log.warn(`${e.job} @ ${e.scheduledAt.toISOString()}: attempt ${e.attempt} on ${e.instanceId} was taken over`);
 * });
 * ```
 */
export interface LostEvent extends RunEvent {
  /** The attempt this instance was running. The backup runs attempt + 1. */
  attempt: number;
}

/**
 * Payload of 'failure': the handler threw, or `timeoutMs` passed. `error` is the message, `cause`
 * the thrown value.
 *
 * @example Page on failures, but not on errors the job expects
 * ```ts
 * scheduler.on('failure', (run) => {
 *   if (run.cause instanceof RateLimitError) return;
 *   pager.notify(`${run.job} failed on ${run.instanceId} after ${run.durationMs} ms: ${run.error}`);
 * });
 * ```
 */
export interface RunFailureEvent extends RunRecord {
  /** The value the job threw: an Error, or anything else a handler can throw. */
  cause: unknown;
}

/**
 * Payload of 'interrupted': a run ended without finishing because `stop()` or a backup's takeover
 * aborted ctx.signal and the job then threw. Not a job failure.
 *
 * @example
 * ```ts
 * scheduler.on('interrupted', (run) => {
 *   log.info(`${run.job}: stopped on ${run.instanceId}${run.handedOver ? ', another instance finishes it' : ''}`);
 * });
 * ```
 */
export interface RunInterruptedEvent extends RunRecord {
  /** The value the job threw. */
  cause: unknown;
  /** The run was given to another instance to finish (graceful shutdown on a lease backend). */
  handedOver: boolean;
}

/**
 * Payload of 'skip': a run was due and this instance did not run it. With several instances this is
 * the normal case: for every run, all instances but one emit 'skip' with reason 'taken'.
 *
 * @example Only the reasons worth a look
 * ```ts
 * scheduler.on('skip', (e) => {
 *   if (e.reason === 'late') log.warn(`${e.job}: reached ${e.lateMs} ms late, skipped (process frozen?)`);
 *   if (e.reason === 'overlap') log.info(`${e.job}: the previous run is still going, skipped`);
 * });
 * ```
 */
export interface SkipEvent extends RunEvent {
  /**
   * 'taken': another instance won this run. 'late': this instance got there after maxLateMs.
   * 'overlap': the previous run of this job is still running (overlap 'skip'). New values may be added in a minor release: keep a default branch when you switch over them.
   */
  reason: 'taken' | 'late' | 'overlap';
  /** With reason 'late': how long after the slot the run was reached. */
  lateMs?: number;
}

/**
 * Payload of 'error': a backend or setup problem, not a job failure (those are 'failure'). Without
 * an 'error' listener these are written to the logger instead. `job` and `slot` are set when the
 * problem belongs to one run.
 *
 * @example
 * ```ts
 * scheduler.on('error', ({ error, job, slot }) => {
 *   log.error(job ? `${job} @ ${slot}: store problem` : 'scheduler problem', error);
 * });
 * ```
 */
export interface SchedulerErrorEvent extends Partial<RunKey> {
  /** What went wrong: a connection error, a refused write, a listener that threw. */
  error: unknown;
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
