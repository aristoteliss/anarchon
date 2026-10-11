/* Copyright (C) 2026-present Aristotelis — see repository license. */

import type { JobContext, RunReason, RunRecord, StoredResult } from '../types';
import { describeError } from '../util';
import type { SchedulerCore } from './core';
import { resolveData } from './data';
import type { Job } from './job';

/** How one execution is tracked while it runs. */
export interface Execution {
  /** 1 for the first try; 2+ when this execution is a backup's takeover. */
  attempt: number;
  /** Why this execution started. Passed to the handler as ctx.reason. */
  reason: RunReason;
  /** Its abort() is ctx.signal's. */
  controller: AbortController;
  /** The data given to runNow() for this one run. */
  data?: unknown;
  /** Why ctx.signal was aborted, if it was (the first reason wins). */
  abortedBy?: 'stop' | 'lost' | 'timeout';
  /** Cleans up when the run ends (removes its stop listener). */
  dispose: () => void;
  /** Lease strategy: marks the run ended in the backend, before the result is stored. */
  finish?: (status: 'success' | 'failed' | 'interrupted') => Promise<void>;
  /** Lease strategy: gives an interrupted run to a backup now. true if it was handed over. */
  release?: () => Promise<boolean>;
}

export function abortError(message: string, name = 'AbortError'): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/**
 * Runs one job that this instance already owns: calls the handler, applies the timeout, decides how
 * the run ended, stores the result and emits the events. Claiming the run is the runners' part.
 */
export class Executor {
  constructor(private readonly core: SchedulerCore) {}

  /** A new execution. Its signal aborts when the scheduler stops; the listener goes when the run ends. */
  newRun(attempt: number, reason: RunReason): Execution {
    const parent = this.core.stopSignal();
    const run: Execution = { attempt, reason, controller: new AbortController(), dispose: () => {} };
    const onStop = () => this.abortRun(run, 'stop', abortError('The scheduler is stopping'));
    if (parent.aborted) {
      onStop();
    } else {
      parent.addEventListener('abort', onStop, { once: true });
      run.dispose = () => parent.removeEventListener('abort', onStop);
    }
    return run;
  }

  /** Aborts the run's signal and remembers why. Later calls do nothing, so the first reason wins. */
  abortRun(run: Execution, by: 'stop' | 'lost' | 'timeout', reason: Error): void {
    if (run.controller.signal.aborted) return;
    run.abortedBy = by;
    run.controller.abort(reason);
  }

  /**
   * Runs the handler to its end and returns the run's record. Never rejects: a throwing handler becomes
   * a 'failed' or 'interrupted' record.
   */
  async execute(job: Job, slot: number, run: Execution): Promise<RunRecord> {
    const { core } = this;
    const scheduledAt = new Date(slot);
    const startedAt = Date.now();
    const manual = run.reason === 'manual';
    job.runningHere++;
    core.emit('start', { job: job.name, slot, scheduledAt, instanceId: core.instanceId, manual, attempt: run.attempt, reason: run.reason });

    const failure = await this.callHandler(job, slot, scheduledAt, run);

    // A job that throws after stop() or a takeover aborted it didn't fail: it was interrupted.
    const interrupted = failure !== undefined && (run.abortedBy === 'stop' || run.abortedBy === 'lost');
    const status = interrupted ? 'interrupted' : failure ? 'failed' : 'success';
    // After stop() has returned, nothing is written any more (the lease runs out on its own).
    const stopped = core.isIdle();
    let handedOver = false;
    if (!stopped) {
      // Stopped mid-run: give the run to another instance now. Manual runs are never retried.
      if (interrupted && run.abortedBy === 'stop' && run.release && !manual) handedOver = await run.release();
      else await run.finish?.(status);
    }
    const finishedAt = Date.now();
    const result: StoredResult = {
      slot,
      by: core.instanceId,
      attempt: run.attempt,
      status,
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
    };
    if (failure) result.error = describeError(failure.cause);

    if (!stopped) {
      try {
        await core.ensureReady();
        await core.backend.saveResult(job.name, result, job.historySize, job.historyTtlMs);
      } catch (error) {
        core.emit('error', { error, job: job.name, slot });
      }
    }

    const record: RunRecord = {
      job: job.name,
      slot,
      scheduledAt,
      instanceId: core.instanceId,
      manual,
      attempt: run.attempt,
      reason: run.reason,
      status,
      startedAt: new Date(startedAt),
      finishedAt: new Date(finishedAt),
      durationMs: result.durationMs,
    };
    if (result.error !== undefined) record.error = result.error;
    if (interrupted && failure) core.emit('interrupted', { ...record, cause: failure.cause, handedOver });
    else if (failure) core.emit('failure', { ...record, cause: failure.cause });
    else core.emit('success', record);
    return record;
  }

  /** Calls the job's handler, with its timeout. Returns what it threw, or undefined if it returned. */
  private async callHandler(job: Job, slot: number, scheduledAt: Date, run: Execution): Promise<{ cause: unknown } | undefined> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const info: Omit<JobContext, 'data'> = {
        name: job.name,
        slot,
        scheduledAt,
        instanceId: this.core.instanceId,
        manual: run.reason === 'manual',
        signal: run.controller.signal,
        attempt: run.attempt,
        reason: run.reason,
      };
      // Inside the run, so a data function that throws or is slow fails or times out the run.
      const work = Promise.resolve().then(async () =>
        job.handler({ ...info, data: await resolveData([this.core.schedulerData(), job.data, run.data], info) }),
      );
      if (job.timeoutMs === undefined) {
        await work;
      } else {
        work.catch(() => {}); // it may fail after the timeout; that is already reported
        await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              const error = abortError(`Timed out after ${job.timeoutMs} ms`, 'TimeoutError');
              this.abortRun(run, 'timeout', error);
              reject(error);
            }, job.timeoutMs);
          }),
        ]);
      }
      return undefined;
    } catch (cause) {
      return { cause };
    } finally {
      clearTimeout(timer);
      run.dispose();
      job.runningHere--;
    }
  }
}
