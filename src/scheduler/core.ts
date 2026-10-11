/* Copyright (C) 2026-present Aristotelis — see repository license. */

import type { Backend, SchedulerEvents } from '../types';
import type { Job } from './job';

/**
 * What the parts of the scheduler (timers, runners, executor) share. The Scheduler owns the state
 * and hands this view of it to each part, so no part reaches into another.
 */
export interface SchedulerCore {
  /** This instance's name: the `by` of its claims, and `instanceId` in events and history. */
  readonly instanceId: string;
  /** Where runs are claimed and recorded. */
  readonly backend: Backend;
  /** Lease strategy: how long a lease lasts without a heartbeat. */
  readonly leaseMs: number;
  /** Lease strategy: how often a runner renews its lease; backups check every 1 to 2 of these. */
  readonly heartbeatMs: number;
  /** true: the scheduler's timers are unref()'d, so they don't keep the process alive. */
  readonly unrefTimers: boolean;
  /** The scheduler's `data` as it is now: a value, or a function to call when a run starts. */
  schedulerData(): unknown;
  /** Between start() and stop(). Timers and background checks do nothing outside it. */
  isRunning(): boolean;
  /** stop() has returned (or start() was never called): nothing is written to the backend any more. */
  isIdle(): boolean;
  /** Aborts when stop() is called. A new one is made by every start(). */
  stopSignal(): AbortSignal;
  /** Connects the backend once; later calls wait for the same connection. */
  ensureReady(): Promise<void>;
  /** The backend's one-time setup for a job. */
  prepare(job: Job): Promise<void>;
  /** Registers work that stop() must wait for. */
  track<T>(promise: Promise<T>): Promise<T>;
  /**
   * Emits to the user's listeners. Never throws: a listener that throws is logged, and an 'error'
   * nobody listens for goes to the logger.
   */
  emit<E extends keyof SchedulerEvents>(event: E, payload: SchedulerEvents[E]): void;
}
