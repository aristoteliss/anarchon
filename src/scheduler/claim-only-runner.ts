/* Copyright (C) 2026-present Aristotelis — see repository license. */

import type { RunRecord } from '../types';
import type { SchedulerCore } from './core';
import type { Executor } from './executor';
import { claimInput, type Job } from './job';

/**
 * Runs for backends without leases (Redis 'stream-id', 'idmp', 'script', RabbitMQ, NATS): one
 * atomic claim per run, and the instance that wins runs the job. No backups and no retries.
 */
export class ClaimOnlyRunner {
  constructor(
    private readonly core: SchedulerCore,
    private readonly executor: Executor,
  ) {}

  /** A scheduled run is due: claim it, and run it if this instance won. Never rejects. */
  async run(job: Job, slot: number): Promise<void> {
    const { core } = this;
    const input = claimInput(core.instanceId, job, slot);
    let won: boolean;
    try {
      await core.ensureReady();
      await core.prepare(job);
      won = await core.backend.claim(input);
    } catch (error) {
      core.emit('error', { error, job: job.name, slot });
      return;
    }
    if (!won) {
      core.emit('skip', { job: job.name, slot, scheduledAt: new Date(slot), instanceId: core.instanceId, reason: 'taken' });
      return;
    }
    if (core.backend.recordClaim) {
      // The run is ours either way; a failed history write must not cancel it.
      await core.backend.recordClaim(input).catch((error: unknown) => core.emit('error', { error, job: job.name, slot }));
    }
    await this.executor.execute(job, slot, this.executor.newRun(1, 'scheduled'));
  }

  /** runNow(): recorded in history, not deduplicated. */
  async runManual(job: Job, data?: unknown): Promise<RunRecord> {
    const { core } = this;
    const requested = Date.now();
    const slot = (await core.backend.recordManualRun(claimInput(core.instanceId, job, requested))) ?? requested;
    return core.track(this.executor.execute(job, slot, { ...this.executor.newRun(1, 'manual'), data }));
  }
}
