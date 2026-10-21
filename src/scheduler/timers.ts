/* Copyright (C) 2026-present Aristotelis — see repository license. */

import type { SchedulerCore } from './core';
import { type Job, randomJitter } from './job';

/** Long waits are split so the clock is re-checked at least once a minute. */
const MAX_TIMER_MS = 60_000;

/** Decides when a job's next run is due on this instance, and calls back when it is. */
export class JobTimers {
  constructor(
    private readonly core: SchedulerCore,
    private readonly onDue: (job: Job, slot: number) => void,
  ) {}

  /** Schedules the job's next run on this instance: run time + a random 0..jitterMs delay. */
  arm(job: Job): void {
    if (!this.core.isRunning() || job.removed) return;
    const slot = job.schedule.next(Date.now());
    job.nextSlot = slot;
    if (slot === null) return;
    this.sleepUntil(job, slot + randomJitter(job), () => this.onDue(job, slot));
  }

  /** Cancels the job's pending timer, if any (stop() and remove()). */
  disarm(job: Job): void {
    if (job.timer) clearTimeout(job.timer);
    job.timer = undefined;
  }

  private sleepUntil(job: Job, at: number, then: () => void): void {
    const remaining = at - Date.now();
    const wait = Math.max(0, Math.min(remaining, MAX_TIMER_MS));

    job.timer = setTimeout(() => {
      job.timer = undefined;
      if (!this.core.isRunning() || job.removed) return;
      if (Date.now() < at) this.sleepUntil(job, at, then);
      else then();
    }, wait);

    if (this.core.unrefTimers) job.timer.unref();
  }
}
