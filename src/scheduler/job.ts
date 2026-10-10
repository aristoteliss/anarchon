import { randomUUID } from 'node:crypto';

import type { Schedule } from '../schedule';
import type { Backend, ClaimInput, JobHandler, JobOptions } from '../types';
import { intInRange, nonNegativeInt, positiveInt } from '../util';

/**
 * Lease strategy: slack for clock differences and network delays when the server checks how late a
 * claim is. Its only job is to stop claims that are far too late (delayed or queued during an outage).
 */
export const CLOCK_TOLERANCE_MS = 10_000;

/** A registered job: its settings after validation, and what this instance knows about it right now. */
export interface Job {
  readonly name: string;
  readonly schedule: Schedule;
  readonly handler: JobHandler;
  readonly jitterMs: number;
  readonly maxLateMs: number;
  readonly historySize: number;
  readonly historyTtlMs: number | undefined;
  readonly overlap: 'skip' | 'allow';
  readonly timeoutMs: number | undefined;
  readonly maxAttempts: number;
  readonly catchUpMs: number;
  /** Lease strategy: how long the server must remember a run, so a late claim can't run it twice. */
  readonly keepMs: number;
  timer: NodeJS.Timeout | undefined;
  nextSlot: number | null;
  runningHere: number;
  prepared: Promise<void> | undefined;
  removed: boolean;
}

/** The scheduler-wide defaults a job falls back to. */
export interface JobDefaults {
  jitterMs: number;
  maxLateMs: number;
  historySize: number;
  historyTtlMs?: number;
  timezone?: string;
}

/** Checks a job's name, handler and options against its schedule and the backend, and builds it. */
export function createJob(
  name: string,
  schedule: Schedule,
  handler: JobHandler,
  options: JobOptions,
  defaults: JobDefaults,
  backend: Backend,
): Job {
  if (typeof name !== 'string' || name.trim() === '') throw new TypeError('Job name must be a non-empty string');
  if (typeof handler !== 'function') throw new TypeError(`Job "${name}": handler must be a function`);

  const jitterMs =
    options.jitterMs !== undefined
      ? nonNegativeInt('jitterMs', options.jitterMs)
      : Math.min(defaults.jitterMs, Math.floor(schedule.minGapMs / 4));
  if (jitterMs * 2 >= schedule.minGapMs) {
    throw new RangeError(`Job "${name}": jitterMs (${jitterMs}) must be under half the time between runs (${schedule.minGapMs} ms)`);
  }
  const maxLateMs =
    options.maxLateMs !== undefined ? positiveInt('maxLateMs', options.maxLateMs) : Math.max(defaults.maxLateMs, jitterMs + 1_000);
  if (maxLateMs <= jitterMs) {
    throw new RangeError(`Job "${name}": maxLateMs (${maxLateMs}) must be bigger than jitterMs (${jitterMs})`);
  }
  if (jitterMs + maxLateMs >= backend.dedupeWindowMs) {
    throw new RangeError(
      `Job "${name}": jitterMs + maxLateMs (${jitterMs + maxLateMs} ms) must be shorter than how long ` +
        `${backend.name} remembers a run (${backend.dedupeWindowMs} ms), or a late instance could run it again`,
    );
  }
  const historySize = options.historySize !== undefined ? positiveInt('historySize', options.historySize) : defaults.historySize;
  const historyTtlMs = options.historyTtlMs !== undefined ? positiveInt('historyTtlMs', options.historyTtlMs) : defaults.historyTtlMs;
  if (options.overlap !== undefined && options.overlap !== 'skip' && options.overlap !== 'allow') {
    throw new TypeError(`Job "${name}": overlap must be "skip" or "allow"`);
  }
  const timeoutMs = options.timeoutMs !== undefined ? positiveInt('timeoutMs', options.timeoutMs) : undefined;
  const maxAttempts = intInRange('maxAttempts', options.maxAttempts ?? 3, 1, 100);
  const catchUpMs = nonNegativeInt('catchUpMs', options.catchUpMs ?? 300_000);
  backend.checkJob?.({ name, jitterMs, maxLateMs, minGapMs: schedule.minGapMs, historySize, historyTtlMs });

  return {
    name,
    schedule,
    handler,
    jitterMs,
    maxLateMs,
    historySize,
    historyTtlMs,
    overlap: options.overlap ?? 'skip',
    timeoutMs,
    maxAttempts,
    catchUpMs,
    // Covers the latest claim this job can make: a scheduled run up to maxLateMs late, or a
    // catch-up up to catchUpMs + jitterMs late.
    keepMs: Math.max(maxLateMs, catchUpMs + jitterMs) + CLOCK_TOLERANCE_MS,
    timer: undefined,
    nextSlot: null,
    runningHere: 0,
    prepared: undefined,
    removed: false,
  };
}

/** A random 0..jitterMs delay: which instance asks first, and so wins, differs from run to run. */
export function randomJitter(job: Job): number {
  return job.jitterMs > 0 ? Math.floor(Math.random() * (job.jitterMs + 1)) : 0;
}

/** What identifies one run of one job on this instance (in the maps of watched and local runs). */
export function runKey(job: Job, slot: number): string {
  return `${job.name}\u0000${slot}`;
}

/** What an instance sends to claim a run. The token is new for every attempt. */
export function claimInput(instanceId: string, job: Job, slot: number): ClaimInput {
  const input: ClaimInput = { job: job.name, slot, token: randomUUID(), instanceId, historySize: job.historySize };
  if (job.historyTtlMs !== undefined) input.historyTtlMs = job.historyTtlMs;
  return input;
}
