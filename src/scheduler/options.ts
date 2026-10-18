/* Copyright (C) 2026-present Aristotelis — see repository license. */

import { hostname } from 'node:os';

import { coded } from '../errors';
import { LEASE_SCHEDULER_OPTIONS, SCHEDULER_OPTIONS } from '../option-keys';
import type { Backend, JobData, LeaseSchedulerOptions, Logger, SchedulerOptions } from '../types';
import { nonNegativeInt, positiveInt, refuseUnknown } from '../util';
import { type JobDefaults, refuseWithoutLeases } from './job';

/** The options of `new Scheduler()`, checked and with their defaults applied. */
export interface SchedulerSettings<B extends Backend> {
  name: string | undefined;
  backend: B;
  instanceId: string;
  data: JobData | undefined;
  defaults: JobDefaults;
  leaseMs: number;
  heartbeatMs: number;
  logger: Logger;
  log: boolean;
  unrefTimers: boolean;
}

/** Checks the options of `new Scheduler()` and applies their defaults. Throws on the first problem. */
export function readOptions<B extends Backend>(options: SchedulerOptions<B>): SchedulerSettings<B> {
  // Also for callers without types, who can leave the options out altogether.
  if (!options?.backend) {
    throw coded(
      new TypeError('A scheduler needs a backend, e.g. backend: new RedisBackend({ redis: url }). No store is assumed'),
      'ANARCHON_INVALID_ARGUMENT',
    );
  }
  refuseUnknown('new Scheduler()', options, SCHEDULER_OPTIONS);
  if (options.name !== undefined && (typeof options.name !== 'string' || options.name === '')) {
    throw coded(new TypeError('name must be a non-empty string'), 'ANARCHON_INVALID_ARGUMENT');
  }
  const instanceId = options.instanceId ?? `${hostname()}:${process.pid}`;
  if (typeof instanceId !== 'string' || instanceId === '') {
    throw coded(new TypeError('instanceId must be a non-empty string'), 'ANARCHON_INVALID_ARGUMENT');
  }
  refuseWithoutLeases(options.backend, options, LEASE_SCHEDULER_OPTIONS);
  const defaults: JobDefaults = {
    jitterMs: nonNegativeInt('jitterMs', options.jitterMs ?? 2_000),
    maxLateMs: positiveInt('maxLateMs', options.maxLateMs ?? 60_000),
    historySize: positiveInt('historySize', options.historySize ?? 1_000),
    timezone: options.timezone,
  };
  if (options.historyTtlMs !== undefined) defaults.historyTtlMs = positiveInt('historyTtlMs', options.historyTtlMs);
  const lease = options as LeaseSchedulerOptions;
  const leaseMs = positiveInt('leaseMs', lease.leaseMs ?? 30_000);
  const heartbeatMs = positiveInt('heartbeatMs', lease.heartbeatMs ?? Math.min(5_000, Math.floor(leaseMs / 6)));
  if (heartbeatMs * 2 >= leaseMs) {
    throw coded(
      new RangeError(`heartbeatMs (${heartbeatMs}) must be under half of leaseMs (${leaseMs}), so a lease is renewed at least twice`),
      'ANARCHON_INVALID_ARGUMENT',
    );
  }
  return {
    name: options.name,
    backend: options.backend,
    instanceId,
    data: options.data,
    defaults,
    leaseMs,
    heartbeatMs,
    logger: options.logger ?? console,
    log: options.log ?? false,
    unrefTimers: options.unrefTimers ?? false,
  };
}
