import type { Backend, SchedulerEvents } from '../types';
import type { Job } from './job';

/**
 * What the parts of the scheduler (timers, runners, executor) share. The Scheduler owns the state
 * and hands this view of it to each part, so no part reaches into another.
 */
export interface SchedulerCore {
  readonly instanceId: string;
  readonly backend: Backend;
  readonly leaseMs: number;
  readonly heartbeatMs: number;
  readonly unrefTimers: boolean;
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
  emit<E extends keyof SchedulerEvents>(event: E, payload: SchedulerEvents[E]): void;
}
