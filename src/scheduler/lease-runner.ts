/* Copyright (C) 2026-present Aristotelis — see repository license. */

import { randomUUID } from 'node:crypto';

import type { ClaimOutcome, RunReason, RunRecord, RunStore, SkipEvent } from '../types';
import { sleep } from '../util';
import type { SchedulerCore } from './core';
import { abortError, type Executor } from './executor';
import { CLOCK_TOLERANCE_MS, claimInput, type Job, randomJitter, runKey } from './job';

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
    try {
      await core.ensureReady();
      const latest = job.schedule.prev(Date.now());
      for (const run of await this.runs.active(job.name)) {
        if (!core.isRunning() || job.removed) return;
        if (run.alive) this.watch(job, run.slot);
        // Retry a dead run only while it is still the latest run of the job; an older one is
        // superseded (it is marked interrupted when the next run starts).
        else if (latest === null || run.slot >= latest) void core.track(this.run(job, run.slot, 'takeover'));
      }
    } catch (error) {
      core.emit('error', { error, job: job.name });
    }
    if (job.catchUpMs === 0) return;
    const now = Date.now();
    const previous = job.schedule.prev(now);
    if (previous === null || now - previous > job.catchUpMs) return;
    await sleep(randomJitter(job)); // spread which instance catches up
    if (core.isRunning() && !job.removed) await this.run(job, previous, 'catch-up');
  }

  /** Claims a run (or the next attempt of a dead one) and runs it if this instance wins. Never rejects. */
  async run(job: Job, slot: number, reason: RunReason): Promise<void> {
    const { core } = this;
    const input = claimInput(core.instanceId, job, slot);
    let outcome: ClaimOutcome;
    try {
      await core.ensureReady();
      outcome = await this.runs.claim({
        ...input,
        mode: reason === 'takeover' ? 'takeover' : 'new',
        reason,
        leaseMs: core.leaseMs,
        overlap: job.overlap,
        maxAttempts: job.maxAttempts,
        // Checked again on the server's clock, in case this claim was delayed on its way
        maxLateMs: (reason === 'catch-up' ? job.catchUpMs + job.jitterMs : job.maxLateMs) + CLOCK_TOLERANCE_MS,
        keepMs: job.keepMs,
      });
    } catch (error) {
      core.emit('error', { error, job: job.name, slot });
      if (reason === 'takeover') this.watch(job, slot); // try again later
      return;
    }
    const skip = (why: SkipEvent['reason'], lateMs?: number) => {
      if (reason === 'takeover' || reason === 'catch-up') return; // background checks don't report skips
      const event: SkipEvent = { job: job.name, slot, scheduledAt: new Date(slot), instanceId: core.instanceId, reason: why };
      if (lateMs !== undefined) event.lateMs = lateMs;
      core.emit('skip', event);
    };
    switch (outcome.kind) {
      case 'won':
        this.unwatch(job, slot);
        await this.executeLeased(job, slot, input.token, outcome.attempt, outcome.attempt > 1 ? 'takeover' : reason);
        return;
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
      case 'none': {
        // Skipped here as an overlap, and not started by anyone yet. Keep checking while another
        // instance could still start it: it is the job's latest run and not too late.
        const now = Date.now();
        const latest = job.schedule.prev(now);
        if ((latest === null || slot >= latest) && now - slot <= job.maxLateMs + CLOCK_TOLERANCE_MS) this.watch(job, slot);
        return;
      }
      default: // done, given up, or never claimed
        this.unwatch(job, slot);
        skip('taken');
    }
  }

  /** runNow(): a run of its own, never retried by a backup and allowed to overlap. */
  async runManual(job: Job, data?: unknown): Promise<RunRecord> {
    const { core } = this;
    const token = randomUUID();
    for (let slot = Date.now(), tries = 0; tries < 10; slot++, tries++) {
      const outcome = await this.runs.claim({
        ...claimInput(core.instanceId, job, slot),
        token,
        mode: 'new',
        reason: 'manual',
        leaseMs: core.leaseMs,
        overlap: 'allow',
        maxAttempts: 1,
        keepMs: job.keepMs,
      });
      if (outcome.kind === 'won') return core.track(this.executeLeased(job, slot, token, 1, 'manual', data));
    }
    throw new Error(`Could not start a manual run of "${job.name}"`);
  }

  /** Stops backing up every run, or the runs of one job. */
  stopWatching(jobName?: string): void {
    for (const [key, timer] of this.watchers) {
      if (jobName !== undefined && !key.startsWith(`${jobName}\u0000`)) continue;
      clearTimeout(timer);
      this.watchers.delete(key);
    }
  }

  /** Runs still going here are left to their lease: it runs out, and a backup takes them over. */
  stopRenewing(): void {
    for (const stop of this.localRuns.values()) stop();
  }

  /**
   * Checks a run another instance is executing every 1 to 2 heartbeats, until it ends or dies. So a
   * crashed run is taken over soon after its lease runs out, and a released one within 2 heartbeats.
   */
  private watch(job: Job, slot: number): void {
    const { core } = this;
    const key = runKey(job, slot);
    if (this.watchers.has(key) || this.localRuns.has(key) || !core.isRunning() || job.removed) return;
    // At a random moment, so backups don't all try at once.
    const delay = Math.floor(core.heartbeatMs * (1 + Math.random()));
    const timer = setTimeout(() => {
      this.watchers.delete(key);
      if (core.isRunning() && !job.removed) void core.track(this.run(job, slot, 'takeover'));
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
  private async executeLeased(
    job: Job,
    slot: number,
    token: string,
    attempt: number,
    reason: RunReason,
    data?: unknown,
  ): Promise<RunRecord> {
    const { core, runs } = this;
    const run = this.executor.newRun(attempt, reason);
    run.data = data;
    const key = runKey(job, slot);
    let lost = false;
    let ending = false;
    const markLost = () => {
      if (lost) return;
      lost = true;
      this.executor.abortRun(run, 'lost', abortError('This run was taken over by another instance'));
      core.emit('lost', { job: job.name, slot, scheduledAt: new Date(slot), attempt, instanceId: core.instanceId });
    };
    const heartbeat = setInterval(() => {
      runs.heartbeat(job.name, slot, token, core.leaseMs).then(
        (ok) => {
          // Once finish() or release() is sent, a refused heartbeat is expected; both check the token themselves.
          if (!ok && !ending) markLost();
        },
        (error: unknown) => core.emit('error', { error, job: job.name, slot }),
      );
    }, core.heartbeatMs);
    if (core.unrefTimers) heartbeat.unref();
    this.localRuns.set(key, () => clearInterval(heartbeat));

    run.finish = async (status) => {
      ending = true;
      // Keep renewing the lease until the end is stored, also while stop() waits: if Redis is
      // briefly unreachable here, a backup must not re-run a job that already completed.
      for (let delay = 200; !lost && !core.isIdle(); delay = Math.min(delay * 2, core.heartbeatMs)) {
        try {
          if (!(await runs.finish(job.name, slot, token, status))) markLost();
          break;
        } catch (error) {
          core.emit('error', { error, job: job.name, slot });
          await sleep(delay);
        }
      }
      clearInterval(heartbeat);
    };
    run.release = async () => {
      ending = true;
      clearInterval(heartbeat);
      if (lost) return false;
      try {
        return await runs.release(job.name, slot, token);
      } catch (error) {
        core.emit('error', { error, job: job.name, slot });
        return false; // the lease runs out on its own, then a backup takes over
      }
    };
    try {
      return await this.executor.execute(job, slot, run);
    } finally {
      clearInterval(heartbeat);
      this.localRuns.delete(key);
    }
  }
}
