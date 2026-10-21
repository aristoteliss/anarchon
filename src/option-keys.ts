/* Copyright (C) 2026-present Aristotelis — see repository license. */

import type { RegisterOptions } from './decorators';
import type { ConfigureOptions } from './registry';
import type {
  AtJobOptions,
  CronJobOptions,
  EveryJobOptions,
  IdmpOptions,
  JobOptions,
  KeyValueStrategyName,
  LeaseJobOptions,
  LeaseSchedulerOptions,
  SchedulerOptions,
  ScriptOptions,
} from './types';

/**
 * The keys of an options type, for checks at runtime. The argument names every key of T once:
 * a key T doesn't have, or one of T's keys left out, is a type error, so the list can't drift
 * from the type when an option is added.
 */
export function keysOf<T>(
  all: Record<keyof T, true>,
): ReadonlyArray<keyof T & string> {
  return Object.keys(all) as Array<keyof T & string>;
}

/** Job options only a backend with leases can honour. */
export const LEASE_JOB_OPTIONS = keysOf<LeaseJobOptions>({
  overlap: true,
  maxAttempts: true,
  catchUpMs: true,
  yieldAfterFailure: true,
});

/** Scheduler options only a backend with leases can honour. */
export const LEASE_SCHEDULER_OPTIONS = keysOf<LeaseSchedulerOptions>({
  leaseMs: true,
  heartbeatMs: true,
});

/** The settings each Redis/Valkey strategy takes besides its name. Every strategy must be listed. */
export const STRATEGY_SETTINGS: Readonly<
  Record<KeyValueStrategyName, ReadonlyArray<string>>
> = {
  lease: [],
  'stream-id': [],
  idmp: keysOf<IdmpOptions>({ durationSec: true, maxSize: true }),
  script: keysOf<ScriptOptions>({ windowMs: true }),
};

const job: Record<keyof JobOptions, true> = {
  jitterMs: true,
  maxLateMs: true,
  historySize: true,
  historyTtlMs: true,
  data: true,
  timeoutMs: true,
  overlap: true,
  maxAttempts: true,
  catchUpMs: true,
  yieldAfterFailure: true,
};

/** Options of `every()`, `cron()` and `at()`. */
export const EVERY_JOB_OPTIONS = keysOf<EveryJobOptions>({
  ...job,
  offsetMs: true,
});
export const CRON_JOB_OPTIONS = keysOf<CronJobOptions>({
  ...job,
  timezone: true,
});
export const AT_JOB_OPTIONS = keysOf<AtJobOptions>(
  (({ overlap, ...rest }) => rest)(job),
);

const scheduler: Record<keyof SchedulerOptions, true> = {
  name: true,
  data: true,
  backend: true,
  instanceId: true,
  jitterMs: true,
  maxLateMs: true,
  historySize: true,
  historyTtlMs: true,
  log: true,
  timezone: true,
  logger: true,
  unrefTimers: true,
  leaseMs: true,
  heartbeatMs: true,
};

/** Options of `new Scheduler()`, and of `Scheduler.configure()`. */
export const SCHEDULER_OPTIONS = keysOf<SchedulerOptions>(scheduler);
export const CONFIGURE_OPTIONS = keysOf<ConfigureOptions>(
  (({ name, ...rest }) => ({ ...rest, autoStart: true }))(scheduler),
);

/** Options of `register()`, and the job options its `defaults` may hold. */
export const REGISTER_OPTIONS = keysOf<RegisterOptions>({
  prefix: true,
  defaults: true,
});
export const REGISTER_DEFAULTS = keysOf<
  NonNullable<RegisterOptions['defaults']>
>({ ...job, timezone: true });
