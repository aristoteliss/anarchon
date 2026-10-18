/* Copyright (C) 2026-present Aristotelis — see repository license. */

import { randomInt, randomUUID } from 'node:crypto';
import { coded } from '../errors';

import { LEASE_JOB_OPTIONS } from '../option-keys';
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
  /** Unique per scheduler, and the job's identity in the backend: the same on every instance. */
  readonly name: string;
  /** Turns "now" into the next and previous run time. Every instance gets the same answers from it. */
  readonly schedule: Schedule;
  /** The user's function. Called by the Executor on the instance that wins a run. */
  readonly handler: JobHandler;
  /** The job's `data` option: a value, or a function to call when a run starts. */
  readonly data: unknown;
  /** This instance waits a random 0..jitterMs after a slot before claiming it. Always under half the time between runs. */
  readonly jitterMs: number;
  /** A run reached later than this after its slot is skipped as 'late'. Always bigger than jitterMs. */
  readonly maxLateMs: number;
  /** About how many runs of this job the backend keeps. */
  readonly historySize: number;
  /** Also drop history older than this (ms). undefined: keep by count only. */
  readonly historyTtlMs: number | undefined;
  /** Lease strategy: 'skip' refuses a new run while an earlier one holds a live lease; 'allow' runs both. */
  readonly overlap: 'skip' | 'allow';
  /** The handler's time limit. undefined: none. */
  readonly timeoutMs: number | undefined;
  /** Lease strategy: how many times one run may be started when runners die (1 to 100). */
  readonly maxAttempts: number;
  /** Lease strategy: on start, the latest slot is run if nobody ran it and it was due at most this long ago. 0: never. */
  readonly catchUpMs: number;
  /** Lease strategy: how long the server must remember a run, so a late claim can't run it twice. */
  readonly keepMs: number;
  /** The pending timer for nextSlot on this instance, if any. Cleared by disarm(). */
  timer: NodeJS.Timeout | undefined;
  /** The slot the timer is waiting for; null when the schedule has no more runs. What nextRun() reports while running. */
  nextSlot: number | null;
  /** How many runs of this job are executing on this instance right now (more than 1 only with overlap 'allow' or runNow()). */
  runningHere: number;
  /** The backend's one-time setup for this job, started once and shared; reset when the backend is closed. */
  prepared: Promise<void> | undefined;
  /** Set by remove(). Timers and backup checks that fire afterwards see it and do nothing. */
  removed: boolean;
}

/** The scheduler-wide defaults a job falls back to. */
export interface JobDefaults {
  /** Used when a job sets no jitterMs, capped at a quarter of the time between its runs. */
  jitterMs: number;
  /** Used when a job sets no maxLateMs, raised to at least jitterMs + 1 s. */
  maxLateMs: number;
  /** Used when a job sets no historySize. */
  historySize: number;
  /** Used when a job sets no historyTtlMs. Missing: history is kept by count only. */
  historyTtlMs?: number;
  /** IANA time zone for cron jobs that set none. Missing: the server's local zone. */
  timezone?: string;
}

/** Throws when a backend without leases is given options only leases can honour. */
export function refuseWithoutLeases(backend: Backend, options: object, keys: readonly string[], label = ''): void {
  if (backend.runs) return;
  const key = keys.find((k) => (options as Record<string, unknown>)[k] !== undefined);
  if (key) {
    throw coded(
      new TypeError(
        `${label}${key} needs a backend with leases (Redis or Valkey with the "lease" strategy, PostgreSQL, SQLite); ${backend.name} has none`,
      ),
      'ANARCHON_UNSUPPORTED',
    );
  }
}

/** Checks a job's name, handler and options against its schedule and the backend, and builds it. */
export function createJob(
  name: string,
  schedule: Schedule,
  handler: JobHandler<never>,
  options: JobOptions,
  defaults: JobDefaults,
  backend: Backend,
): Job {
  if (typeof name !== 'string' || name.trim() === '')
    throw coded(new TypeError('Job name must be a non-empty string'), 'ANARCHON_INVALID_ARGUMENT');
  if (typeof handler !== 'function') throw coded(new TypeError(`Job "${name}": handler must be a function`), 'ANARCHON_INVALID_ARGUMENT');
  refuseWithoutLeases(backend, options, LEASE_JOB_OPTIONS, `Job "${name}": `);

  const jitterMs =
    options.jitterMs !== undefined
      ? nonNegativeInt('jitterMs', options.jitterMs)
      : Math.min(defaults.jitterMs, Math.floor(schedule.minGapMs / 4));
  if (jitterMs * 2 >= schedule.minGapMs) {
    throw coded(
      new RangeError(`Job "${name}": jitterMs (${jitterMs}) must be under half the time between runs (${schedule.minGapMs} ms)`),
      'ANARCHON_INVALID_ARGUMENT',
    );
  }
  const maxLateMs =
    options.maxLateMs !== undefined ? positiveInt('maxLateMs', options.maxLateMs) : Math.max(defaults.maxLateMs, jitterMs + 1_000);
  if (maxLateMs <= jitterMs) {
    throw coded(
      new RangeError(`Job "${name}": maxLateMs (${maxLateMs}) must be bigger than jitterMs (${jitterMs})`),
      'ANARCHON_INVALID_ARGUMENT',
    );
  }
  if (jitterMs + maxLateMs >= backend.dedupeWindowMs) {
    throw coded(
      new RangeError(
        `Job "${name}": jitterMs + maxLateMs (${jitterMs + maxLateMs} ms) must be shorter than how long ` +
          `${backend.name} remembers a run (${backend.dedupeWindowMs} ms), or a late instance could run it again`,
      ),
      'ANARCHON_UNSAFE_JOB',
    );
  }
  const historySize = options.historySize !== undefined ? positiveInt('historySize', options.historySize) : defaults.historySize;
  const historyTtlMs = options.historyTtlMs !== undefined ? positiveInt('historyTtlMs', options.historyTtlMs) : defaults.historyTtlMs;
  if (options.overlap !== undefined && options.overlap !== 'skip' && options.overlap !== 'allow') {
    throw coded(new TypeError(`Job "${name}": overlap must be "skip" or "allow"`), 'ANARCHON_INVALID_ARGUMENT');
  }
  const timeoutMs = options.timeoutMs !== undefined ? positiveInt('timeoutMs', options.timeoutMs) : undefined;
  const maxAttempts = intInRange('maxAttempts', options.maxAttempts ?? 3, 1, 100);
  const catchUpMs = nonNegativeInt('catchUpMs', options.catchUpMs ?? 300_000);
  backend.checkJob?.({ name, jitterMs, maxLateMs, minGapMs: schedule.minGapMs, historySize, historyTtlMs });

  return {
    name,
    schedule,
    handler: handler as JobHandler,
    data: options.data,
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
  return job.jitterMs > 0 ? randomInt(job.jitterMs + 1) : 0;
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
