/* Copyright (C) 2026-present Aristotelis — see repository license. */

import { randomInt, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { coded } from '../errors';

import type {
  ClaimInput,
  ClaimOutcome,
  RunReason,
  RunRecord,
  RunStore,
  SkipEvent,
} from '../types';
import { sleep } from '../util';
import type { SchedulerCore } from './core';
import { abortError, type Execution, type Executor } from './executor';
import {
  CLOCK_TOLERANCE_MS,
  claimInput,
  type Job,
  randomJitter,
  runKey,
} from './job';

/**
 * Runs for backends with leases (Redis 'lease', Postgres, SQLite). The winner of a run renews a
 * lease while the job runs; every other instance becomes its backup and takes the run over when the
 * lease runs out. Also: no overlapping runs, catch-up on start, and hand-over on stop().
 */
export class LeaseRunner {
  /** Runs another instance is executing, that this instance is ready to take over. */
  private readonly watchers = new Map<string, NodeJS.Timeout>();
  /**
   * Leased runs this instance is executing right now (never watched: we know they are alive), with a
   * function that stops renewing the lease.
   */
  private readonly localRuns = new Map<string, () => void>();

  constructor(
    private readonly core: SchedulerCore,
    private readonly executor: Executor,
    private readonly runs: RunStore,
  ) {}

  /**
   * Called on start and when a job is added: picks up what other instances left behind.
   * - unfinished runs whose runner died (e.g. every instance restarted mid-run): take them over
   * - unfinished runs that are still alive: watch them, to back them up
   * - the latest run, if it was due while every instance was down: run it now (catch-up)
   */
  async recover(job: Job): Promise<void> {
    const { core } = this;
    const signal = core.stopSignal();

    try {
      await core.ensureReady();
      const latest = job.schedule.prev(Date.now());
      const active = await this.runs.active(job.name);
      for (const run of active) {
        if (signal.aborted || !core.isRunning() || job.removed) return;
        if (run.alive) this.watch(job, run.slot);
        // Retry a dead run only while it is still the latest run of the job; an older one is
        // superseded (it is marked interrupted when the next run starts).
        else if (latest === null || run.slot >= latest) {
          void core.track(this.run(job, run.slot, 'takeover', signal));
        }
      }
    } catch (error) {
      if (!signal.aborted) core.emit('error', { error, job: job.name });
    }

    if (job.catchUpMs === 0) return;
    const now = Date.now();
    const previous = job.schedule.prev(now);
    if (previous === null || now - previous > job.catchUpMs) return;

    await sleep(randomJitter(job)); // spread which instance catches up
    if (!signal.aborted && core.isRunning() && !job.removed) {
      await this.run(job, previous, 'catch-up', signal);
    }
  }

  /** Claims a run (or the next attempt of a dead one) and runs it if this instance wins. Never rejects. */
  async run(
    job: Job,
    slot: number,
    reason: RunReason,
    signal = this.core.stopSignal(),
  ): Promise<void> {
    const { core } = this;
    if (reason === 'scheduled') await this.yieldIfFailed(job, slot, signal);
    const input = claimInput(core.instanceId, job, slot);
    const outcome = await this.claim(job, input, reason, signal);
    if (!outcome) return;

    if (signal.aborted) {
      if (
        outcome.kind === 'won' &&
        !core.isIdle() &&
        signal === core.stopSignal()
      ) {
        await this.runs.release(job.name, slot, input.token).catch(() => {});
      }
      return;
    }

    if (outcome.kind !== 'won') return this.follow(job, slot, reason, outcome);

    this.unwatch(job, slot);
    const startedAs = outcome.attempt > 1 ? 'takeover' : reason;
    await this.executeLeased({
      job,
      slot,
      token: input.token,
      attempt: outcome.attempt,
      reason: startedAs,
      signal,
    });
  }

  /** With yieldAfterFailure, after a run failed here: waits so that healthy instances claim this run first. */
  private async yieldIfFailed(
    job: Job,
    slot: number,
    signal: AbortSignal,
  ): Promise<void> {
    const waitMs = yieldMs(job, slot, this.core.heartbeatMs, Date.now());
    if (waitMs === 0) return;

    try {
      await delay(waitMs, undefined, { signal, ref: !this.core.unrefTimers });
    } catch {
      // stop() aborted the wait: claim() sees the aborted signal and claims nothing.
    }
  }

  /**
   * Sends the claim. Undefined when the scheduler stopped first, or when the claim failed: the
   * failure is reported as an 'error' event, and a failed takeover is tried again later.
   */
  private async claim(
    job: Job,
    input: ClaimInput,
    reason: RunReason,
    signal: AbortSignal,
  ): Promise<ClaimOutcome | undefined> {
    const { core } = this;
    const mode = reason === 'takeover' ? 'takeover' : 'new';
    const lateMs =
      reason === 'catch-up' ? job.catchUpMs + job.jitterMs : job.maxLateMs;

    try {
      await core.ensureReady();
      if (signal.aborted) return undefined;

      return await this.runs.claim({
        ...input,
        mode,
        reason,
        leaseMs: core.leaseMs,
        overlap: job.overlap,
        maxAttempts: job.maxAttempts,
        // Checked again on the server's clock, in case this claim was delayed on its way
        maxLateMs: lateMs + CLOCK_TOLERANCE_MS,
        keepMs: job.keepMs,
      });
    } catch (error) {
      if (!signal.aborted) {
        core.emit('error', { error, job: job.name, slot: input.slot });
        if (reason === 'takeover') this.watch(job, input.slot); // try again later
      }
      return undefined;
    }
  }

  /** Reports a claim this instance lost as a skip, and backs up the run that someone else holds. */
  private follow(
    job: Job,
    slot: number,
    reason: RunReason,
    outcome: Exclude<ClaimOutcome, { kind: 'won' }>,
  ): void {
    // background checks don't report skips
    const quiet = reason === 'takeover' || reason === 'catch-up';
    const skip = (why: SkipEvent['reason'], lateMs?: number) => {
      if (!quiet) this.emitSkip(job, slot, why, lateMs);
    };

    switch (outcome.kind) {
      case 'running': // someone alive runs it: be its backup
        skip('taken');
        this.watch(job, slot);
        return;
      case 'overlap': // the previous run is still going: skip this one, back that one up
        skip('overlap');
        this.watch(job, outcome.slot);
        // Another instance may still start this run once the previous one ends: be its backup then.
        this.watch(job, slot);
        return;
      case 'late':
        skip('late', outcome.lateMs);
        return;
      case 'none':
        // Skipped here as an overlap, and not started by anyone yet: keep checking.
        if (couldStillStart(job, slot, Date.now())) this.watch(job, slot);
        return;
      default: // done, given up, or never claimed
        this.unwatch(job, slot);
        skip('taken');
    }
  }

  /** Emits 'skip' for a run this instance does not execute. */
  private emitSkip(
    job: Job,
    slot: number,
    why: SkipEvent['reason'],
    lateMs?: number,
  ): void {
    const event: SkipEvent = {
      job: job.name,
      slot,
      scheduledAt: new Date(slot),
      instanceId: this.core.instanceId,
      reason: why,
    };
    if (lateMs !== undefined) event.lateMs = lateMs;

    this.core.emit('skip', event);
  }

  /** runNow(): a run of its own, never retried by a backup and allowed to overlap. */
  async runManual(
    job: Job,
    data?: unknown,
    signal = this.core.stopSignal(),
  ): Promise<RunRecord> {
    const token = randomUUID();

    for (let slot = Date.now(), tries = 0; tries < 10; slot++, tries++) {
      if (signal.aborted) {
        return this.executor.execute(
          job,
          slot,
          { ...this.executor.newRun(1, 'manual', signal), data },
          false,
        );
      }

      const outcome = await this.claimManual(job, slot, token);
      if (outcome.kind === 'won') {
        return this.executeLeased({
          job,
          slot,
          token,
          attempt: 1,
          reason: 'manual',
          data,
          signal,
        });
      }
    }

    throw coded(
      new Error(`Could not start a manual run of "${job.name}"`),
      'ANARCHON_STORE',
    );
  }

  /** Claims one slot for runNow(): a new run with its own token, allowed to overlap, never retried. */
  private claimManual(
    job: Job,
    slot: number,
    token: string,
  ): Promise<ClaimOutcome> {
    const input = claimInput(this.core.instanceId, job, slot);

    return this.runs.claim({
      ...input,
      token,
      mode: 'new',
      reason: 'manual',
      leaseMs: this.core.leaseMs,
      overlap: 'allow',
      maxAttempts: 1,
      keepMs: job.keepMs,
    });
  }

  /** Stops backing up every run, or the runs of one job. */
  stopWatching(jobName?: string): void {
    for (const [key, timer] of this.watchers) {
      if (jobName !== undefined && !key.startsWith(`${jobName}\u0000`)) {
        continue;
      }
      clearTimeout(timer);
      this.watchers.delete(key);
    }
  }

  /** Runs still going here are left to their lease: it runs out, and a backup takes them over. */
  stopRenewing(): void {
    for (const stop of this.localRuns.values()) {
      stop();
    }
  }

  /**
   * Checks a run another instance is executing every 1 to 2 heartbeats, until it ends or dies. So a
   * crashed run is taken over soon after its lease runs out, and a released one within 2 heartbeats.
   */
  private watch(job: Job, slot: number): void {
    const { core } = this;
    const key = runKey(job, slot);
    const watched = this.watchers.has(key) || this.localRuns.has(key);
    if (watched || !core.isRunning() || job.removed) return;

    // At a random moment, so backups don't all try at once.
    const delay =
      core.heartbeatMs +
      (core.heartbeatMs > 0 ? randomInt(core.heartbeatMs) : 0);
    const timer = setTimeout(() => {
      this.watchers.delete(key);
      if (core.isRunning() && !job.removed) {
        void core.track(this.run(job, slot, 'takeover'));
      }
    }, delay);

    if (core.unrefTimers) timer.unref();
    this.watchers.set(key, timer);
  }

  private unwatch(job: Job, slot: number): void {
    const key = runKey(job, slot);
    const timer = this.watchers.get(key);
    if (timer) clearTimeout(timer);
    this.watchers.delete(key);
  }

  /** Runs a job this instance claimed, renewing its lease until it ends. */
  private async executeLeased(leased: LeasedRun): Promise<RunRecord> {
    const { job, slot, attempt, reason, data, signal } = leased;
    const run = this.executor.newRun(attempt, reason, signal);
    run.data = data;

    const key = runKey(job, slot);
    const lease = new HeldLease(this.core, this.runs, leased, () =>
      this.loseRun(run, leased),
    );
    this.localRuns.set(key, () => lease.stop());
    run.finish = (status) => lease.finish(status);
    run.release = () => lease.release();

    try {
      const record = await this.executor.execute(job, slot, run);
      if (reason !== 'manual') job.failedHere = record.status === 'failed';
      return record;
    } finally {
      lease.stop();
      this.localRuns.delete(key);
    }
  }

  /** Aborts a run whose lease another instance holds now, and emits 'lost'. */
  private loseRun(run: Execution, { job, slot, attempt }: LeasedRun): void {
    const reason = abortError('This run was taken over by another instance');
    this.executor.abortRun(run, 'lost', reason);

    this.core.emit('lost', {
      job: job.name,
      slot,
      scheduledAt: new Date(slot),
      attempt,
      instanceId: this.core.instanceId,
    });
  }
}

/** A run this instance claimed and now executes. */
interface LeasedRun {
  job: Job;
  slot: number;
  /** The token of the winning claim; the store checks it on every heartbeat, finish and release. */
  token: string;
  attempt: number;
  reason: RunReason;
  /** The data given to runNow() for this one run. */
  data?: unknown;
  signal: AbortSignal;
}

/**
 * The lease of one run this instance executes, renewed every heartbeat until the run's end is
 * stored or the run is released. Calls onLost once when the store says another instance has it.
 */
class HeldLease {
  private lost = false;
  private ending = false;
  private readonly heartbeat: NodeJS.Timeout;

  constructor(
    private readonly core: SchedulerCore,
    private readonly runs: RunStore,
    private readonly leased: LeasedRun,
    private readonly onLost: () => void,
  ) {
    this.heartbeat = setInterval(() => this.renew(), core.heartbeatMs);
    if (core.unrefTimers) this.heartbeat.unref();
  }

  stop(): void {
    clearInterval(this.heartbeat);
  }

  /** Stores how the run ended. */
  async finish(status: 'success' | 'failed' | 'interrupted'): Promise<void> {
    const { core, runs } = this;
    const { job, slot, token, signal } = this.leased;
    this.ending = true;

    // Keep renewing the lease until the end is stored, also while stop() waits: if Redis is
    // briefly unreachable here, a backup must not re-run a job that already completed.
    for (
      let delay = 200;
      !this.lost && !core.isIdle() && signal === core.stopSignal();
      delay = Math.min(delay * 2, core.heartbeatMs)
    ) {
      try {
        const stored = await runs.finish(job.name, slot, token, status);
        if (!stored) this.markLost();
        break;
      } catch (error) {
        core.emit('error', { error, job: job.name, slot });
        await sleep(delay);
      }
    }

    this.stop();
  }

  /** Hands the run to a backup now. True if the store released it. */
  async release(): Promise<boolean> {
    const { job, slot, token } = this.leased;
    this.ending = true;
    this.stop();
    if (this.lost) return false;

    try {
      return await this.runs.release(job.name, slot, token);
    } catch (error) {
      this.core.emit('error', { error, job: job.name, slot });
      return false; // the lease runs out on its own, then a backup takes over
    }
  }

  private renew(): void {
    const { job, slot, token } = this.leased;

    this.runs.heartbeat(job.name, slot, token, this.core.leaseMs).then(
      (ok) => {
        // Once finish() or release() is sent, a refused heartbeat is expected; both check the token themselves.
        if (!ok && !this.ending) this.markLost();
      },
      (error: unknown) =>
        this.core.emit('error', { error, job: job.name, slot }),
    );
  }

  private markLost(): void {
    if (this.lost) return;
    this.lost = true;
    this.onLost();
  }
}

/**
 * How long to wait before claiming a scheduled run: 0, unless yieldAfterFailure is on and the last
 * run here failed. Healthy instances claim by slot + jitterMs; the wait ends jitterMs + heartbeatMs
 * after the slot, capped at maxLateMs so the claim is never refused as late.
 */
function yieldMs(
  job: Job,
  slot: number,
  heartbeatMs: number,
  now: number,
): number {
  if (!job.yieldAfterFailure || !job.failedHere) return 0;
  const end = slot + Math.min(job.jitterMs + heartbeatMs, job.maxLateMs);
  return Math.max(0, end - now);
}

/** A run skipped as an overlap can still be started by another instance while it is the job's latest run and not too late. */
function couldStillStart(job: Job, slot: number, now: number): boolean {
  const latest = job.schedule.prev(now);
  const isLatest = latest === null || slot >= latest;
  return isLatest && now - slot <= job.maxLateMs + CLOCK_TOLERANCE_MS;
}
