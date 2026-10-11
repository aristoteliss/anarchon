/* Copyright (C) 2026-present Aristotelis — see repository license. */

import type { Logger, SchedulerEvents } from '../types';

type Subscribe = <E extends keyof SchedulerEvents>(event: E, listener: (payload: SchedulerEvents[E]) => void) => unknown;

/** `log: true`: one line per start, success, failure, interruption, skip and lost run. */
export function logRuns(on: Subscribe, logger: Logger): void {
  const info = (message: string) => (logger.info ? logger.info(message) : console.log(message));
  const at = (slot: number) => new Date(slot).toISOString();
  on('start', (e) => info(`[anarchon] ${e.job} @ ${at(e.slot)}: started on ${e.instanceId} (attempt ${e.attempt}, ${e.reason})`));
  on('success', (r) => info(`[anarchon] ${r.job} @ ${at(r.slot)}: finished in ${r.durationMs} ms`));
  on('failure', (r) => logger.warn(`[anarchon] ${r.job} @ ${at(r.slot)}: failed after ${r.durationMs} ms: ${r.error}`));
  on('interrupted', (r) =>
    info(
      `[anarchon] ${r.job} @ ${at(r.slot)}: interrupted after ${r.durationMs} ms${r.handedOver ? ', handed over to another instance' : ''}`,
    ),
  );
  on('skip', (e) => info(`[anarchon] ${e.job} @ ${at(e.slot)}: skipped (${e.reason})`));
  on('lost', (e) => logger.warn(`[anarchon] ${e.job} @ ${at(e.slot)}: attempt ${e.attempt} was taken over by a backup`));
}
