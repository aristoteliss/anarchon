/* Copyright (C) 2026-present Aristotelis — see repository license. */

/** The job is due every 2 s, at :00, :02, :04, ... */
export const EVERY_2_SECONDS = '*/2 * * * * *';
export const INTERVAL_MS = 2_000;
export const JOB_MS = 500;
/** The same lease on both libraries: it runs out 2 s after its holder stops renewing it. */
export const LEASE_MS = 2_000;

/** The test Redis of `pnpm test:servers`. */
export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6381';

/** `anarchon-yield`: anarchon with `yieldAfterFailure: true`. */
export type Library = 'anarchon' | 'anarchon-yield' | 'nestjs-locks';

/**
 * - `healthy`: every run succeeds.
 * - `fails`: every run throws, as on a pod whose database connection broke.
 * - `hangs`: no run ever ends, as on a pod stuck on a query without a timeout.
 */
export type Behaviour = 'healthy' | 'fails' | 'hangs';

/** What an instance reports to compare.ts over IPC. `slot` is the time the run was due. */
export type InstanceEvent =
  | { type: 'ready'; instance: string }
  | { type: 'start' | 'success' | 'failure'; instance: string; slot: number };

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
