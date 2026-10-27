/* Copyright (C) 2026-present Aristotelis — see repository license. */

import type { ClaimInput, RunRecord } from '../types';
import type { SchedulerCore } from './core';
import type { Executor } from './executor';
import { claimInput, type Job } from './job';

/**
 * Runs for backends without leases (Redis 'stream-id', 'idmp', 'script', RabbitMQ, NATS 'msg-id'): one
 * atomic claim per run, and the instance that wins runs the job. No backups and no retries.
 */
export class ClaimOnlyRunner {
  constructor(
    private readonly core: SchedulerCore,
    private readonly executor: Executor,
  ) {}

  /** A scheduled run is due: claim it, and run it if this instance won. Never rejects. */
  async run(
    job: Job,
    slot: number,
    signal = this.core.stopSignal(),
  ): Promise<void> {
    const { core } = this;
    const input = claimInput(core.instanceId, job, slot);
    const won = await this.claim(job, input, signal);
    if (won === undefined) return;

    if (!won) {
      if (!signal.aborted) this.emitTaken(job, slot);
      return;
    }

    if (core.backend.recordClaim) {
      // The run is ours either way; a failed history write must not cancel it.
      await core.backend
        .recordClaim(input)
        .catch((error: unknown) =>
          core.emit('error', { error, job: job.name, slot }),
        );
    }

    // Won after stop() began: execute() records it as interrupted without starting the handler.
    await this.executor.execute(
      job,
      slot,
      this.executor.newRun(1, 'scheduled', signal),
    );
  }

  /**
   * Sends the claim. Undefined when the scheduler stopped first, or when the claim failed: the
   * failure is reported as an 'error' event.
   */
  private async claim(
    job: Job,
    input: ClaimInput,
    signal: AbortSignal,
  ): Promise<boolean | undefined> {
    const { core } = this;
    try {
      await core.ensureReady();
      await core.prepare(job);
      if (signal.aborted) return undefined;

      return await core.backend.claim(input);
    } catch (error) {
      if (!signal.aborted) {
        core.emit('error', { error, job: job.name, slot: input.slot });
      }
      return undefined;
    }
  }

  /** Emits 'skip' for a run another instance won. */
  private emitTaken(job: Job, slot: number): void {
    this.core.emit('skip', {
      job: job.name,
      slot,
      scheduledAt: new Date(slot),
      instanceId: this.core.instanceId,
      reason: 'taken',
    });
  }

  /** runNow(): recorded in history, not deduplicated. */
  async runManual(
    job: Job,
    data?: unknown,
    signal = this.core.stopSignal(),
  ): Promise<RunRecord> {
    const { core } = this;
    const requested = Date.now();
    if (signal.aborted) {
      return this.executor.execute(
        job,
        requested,
        { ...this.executor.newRun(1, 'manual', signal), data },
        false,
      );
    }

    const input = claimInput(core.instanceId, job, requested);
    const recorded = await core.backend.recordManualRun(input);
    const slot = recorded ?? requested;

    return this.executor.execute(job, slot, {
      ...this.executor.newRun(1, 'manual', signal),
      data,
    });
  }
}
