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
  /** The stopSignal of the lifecycle that created this run. */
  parent: AbortSignal;
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
  newRun(
    attempt: number,
    reason: RunReason,
    parent = this.core.stopSignal(),
  ): Execution {
    const run: Execution = {
      attempt,
      reason,
      parent,
      controller: new AbortController(),
      dispose: () => {},
    };

    const onStop = () =>
      this.abortRun(run, 'stop', abortError('The scheduler is stopping'));
    if (parent.aborted) {
      onStop();
    } else {
      parent.addEventListener('abort', onStop, { once: true });
      run.dispose = () => parent.removeEventListener('abort', onStop);
    }

    return run;
  }

  /** Aborts the run's signal and remembers why. Later calls do nothing, so the first reason wins. */
  abortRun(
    run: Execution,
    by: 'stop' | 'lost' | 'timeout',
    reason: Error,
  ): void {
    if (run.controller.signal.aborted) return;
    run.abortedBy = by;
    run.controller.abort(reason);
  }

  /**
   * Runs the handler to its end and returns the run's record. Never rejects: a throwing handler becomes
   * a 'failed' or 'interrupted' record.
   */
  async execute(
    job: Job,
    slot: number,
    run: Execution,
    claimed = true,
  ): Promise<RunRecord> {
    const { core } = this;
    const scheduledAt = new Date(slot);
    const startedAt = Date.now();
    const started = !run.controller.signal.aborted;
    const failure = started
      ? await this.start(job, slot, scheduledAt, run)
      : { cause: run.controller.signal.reason };
    const status = statusOf(run, failure);

    // After stop() has returned, nothing is written any more (the lease runs out on its own).
    const stopped =
      !claimed || core.isIdle() || run.parent !== core.stopSignal();
    const handedOver = stopped ? false : await end(run, status);

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

    if (!stopped) await this.save(job, result);

    const record = this.toRecord(job, scheduledAt, run, result);
    if (started) this.report(record, failure, handedOver);
    return record;
  }

  /** Counts the run as running here, emits 'start' and calls the handler. Returns what it threw. */
  private async start(
    job: Job,
    slot: number,
    scheduledAt: Date,
    run: Execution,
  ): Promise<Failure | undefined> {
    const { core } = this;
    job.runningHere++;
    core.emit('start', {
      job: job.name,
      slot,
      scheduledAt,
      instanceId: core.instanceId,
      manual: run.reason === 'manual',
      attempt: run.attempt,
      reason: run.reason,
    });

    return this.callHandler(job, slot, scheduledAt, run);
  }

  /** Stores the result. A store that fails is reported as an 'error' event. */
  private async save(job: Job, result: StoredResult): Promise<void> {
    try {
      await this.core.ensureReady();

      await this.core.backend.saveResult(
        job.name,
        result,
        job.historySize,
        job.historyTtlMs,
      );
    } catch (error) {
      this.core.emit('error', { error, job: job.name, slot: result.slot });
    }
  }

  private toRecord(
    job: Job,
    scheduledAt: Date,
    run: Execution,
    result: StoredResult,
  ): RunRecord {
    const record: RunRecord = {
      job: job.name,
      slot: result.slot,
      scheduledAt,
      instanceId: this.core.instanceId,
      manual: run.reason === 'manual',
      attempt: run.attempt,
      reason: run.reason,
      status: result.status,
      startedAt: new Date(result.startedAt),
      finishedAt: new Date(result.finishedAt),
      durationMs: result.durationMs,
    };

    if (result.error !== undefined) record.error = result.error;
    return record;
  }

  /** Emits how the run ended. */
  private report(
    record: RunRecord,
    failure: Failure | undefined,
    handedOver: boolean,
  ): void {
    if (!failure) this.core.emit('success', record);
    else if (record.status === 'interrupted') {
      this.core.emit('interrupted', {
        ...record,
        cause: failure.cause,
        handedOver,
      });
    } else this.core.emit('failure', { ...record, cause: failure.cause });
  }

  /** Calls the job's handler, with its timeout. Returns what it threw, or undefined if it returned. */
  private async callHandler(
    job: Job,
    slot: number,
    scheduledAt: Date,
    run: Execution,
  ): Promise<Failure | undefined> {
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
      const work = Promise.resolve().then(async () => {
        const data = await resolveData(
          [this.core.schedulerData(), job.data, run.data],
          info,
        );
        return job.handler({ ...info, data });
      });

      await this.within(work, job.timeoutMs, run);
      return undefined;
    } catch (cause) {
      return { cause };
    } finally {
      run.dispose();
      job.runningHere--;
    }
  }

  /** Waits for the handler; when timeoutMs passes first, aborts the run and throws a TimeoutError. */
  private async within(
    work: Promise<unknown>,
    timeoutMs: number | undefined,
    run: Execution,
  ): Promise<void> {
    if (timeoutMs === undefined) {
      await work;
      return;
    }

    work.catch(() => {}); // it may fail after the timeout; that is already reported
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = abortError(
          `Timed out after ${timeoutMs} ms`,
          'TimeoutError',
        );
        this.abortRun(run, 'timeout', error);
        reject(error);
      }, timeoutMs);
    });

    try {
      await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** What a handler threw. */
interface Failure {
  cause: unknown;
}

/** A job that throws after stop() or a takeover aborted it didn't fail: it was interrupted. */
function statusOf(
  run: Execution,
  failure: Failure | undefined,
): StoredResult['status'] {
  if (!failure) return 'success';
  const interrupted = run.abortedBy === 'stop' || run.abortedBy === 'lost';
  return interrupted ? 'interrupted' : 'failed';
}

/** Marks the run ended in the store, or hands an interrupted run to a backup. True if it was handed over. */
async function end(
  run: Execution,
  status: StoredResult['status'],
): Promise<boolean> {
  // Stopped mid-run: give the run to another instance now. Manual runs are never retried.
  const handOver =
    status === 'interrupted' &&
    run.abortedBy === 'stop' &&
    run.reason !== 'manual';
  if (handOver && run.release) return run.release();
  await run.finish?.(status);
  return false;
}
