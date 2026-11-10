/* Copyright (C) 2026-present Aristotelis — see repository license. */

import { coded } from '../errors';
import type { ClaimInput, RunStore } from '../types';

/**
 * A value made on first use and shared by every later call, such as a connection. A failed attempt
 * is forgotten, so the next call tries again.
 */
export class Lazy<T> {
  private pending: Promise<T> | undefined;

  /**
   * @param make Makes the value. It is given `forget`, to call when the value stops being usable
   *   (a connection that closed): the next get() then makes a new one. `forget` returns false, and
   *   changes nothing, when a newer value has already taken this one's place.
   */
  constructor(private readonly make: (forget: () => boolean) => Promise<T>) {}

  get(): Promise<T> {
    if (this.pending) return this.pending;

    const forget = () => {
      if (this.pending !== pending) return false;
      this.pending = undefined;
      return true;
    };
    const pending: Promise<T> = this.make(forget).catch((error: unknown) => {
      forget();
      throw error;
    });
    this.pending = pending;
    return pending;
  }

  /** Forgets the value, so the next get() makes a new one. Returns what was held, to be closed. */
  reset(): Promise<T> | undefined {
    const pending = this.pending;
    this.pending = undefined;
    return pending;
  }
}

/** Closes a connection the backend opened itself. One that was passed in, or never opened, is left alone. */
export async function closeIfOwned(
  connection:
    | Promise<{ client: { close?(): Promise<void> }; owned: boolean }>
    | undefined,
): Promise<void> {
  try {
    const opened = await connection;
    if (opened?.owned) await opened.client.close?.();
  } catch {
    // never connected
  }
}

/** Refuses historyTtlMs on a backend that trims history by count only. */
export function refuseHistoryTtl(
  backend: string,
  job: { name: string; historyTtlMs?: number | undefined },
): void {
  if (job.historyTtlMs !== undefined) {
    throw coded(
      new TypeError(
        `Job "${job.name}": historyTtlMs is not supported by ${backend}, which keeps history by count (historySize) only`,
      ),
      'ANARCHON_UNSUPPORTED',
    );
  }
}

/** Job names used in queue names and NATS subjects must stay simple. */
export function assertSimpleName(backend: string, name: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw coded(
      new TypeError(
        `Job "${name}": with ${backend}, job names may only contain letters, digits, "_" and "-"`,
      ),
      'ANARCHON_UNSUPPORTED',
    );
  }
}

/** Parses a server version like "3.12.1" or "redis_version:8.6.3" into [major, minor]. */
export function versionAtLeast(
  version: string,
  major: number,
  minor: number,
): boolean {
  for (const token of version.split(/[^0-9.]+/)) {
    const [first, second] = token.split('.');
    if (first && second) {
      const [maj, min] = [Number(first), Number(second)];
      return maj > major || (maj === major && min >= minor);
    }
  }
  return false;
}

/**
 * The two `Backend` methods a lease store answers without the scheduler's lease handling
 * (`claim()` and `recordManualRun()`): a run of its own with a long lease, no backups, and free to
 * overlap. The scheduler never calls them on a lease backend; it claims through `runs`.
 */
const WITHOUT_LEASES = {
  mode: 'new',
  leaseMs: 86_400_000,
  overlap: 'allow',
  maxAttempts: 1,
} as const;

/** `Backend.claim()` on a lease store: true for exactly one instance per slot. */
export async function claimWithoutLeases(
  runs: RunStore,
  input: ClaimInput,
): Promise<boolean> {
  const outcome = await runs.claim({
    ...input,
    ...WITHOUT_LEASES,
    reason: 'scheduled',
  });
  return outcome.kind === 'won';
}

/**
 * Claims a runNow() run on a lease store, at the first free millisecond from its slot, and returns
 * that slot. The run is never retried and may overlap other runs of its job.
 *
 * @param lease The lease the scheduler gives the run. Without it (`Backend.recordManualRun()`,
 *   which the scheduler never calls on a lease backend): a long lease that nobody renews.
 */
export async function claimManualSlot(
  runs: RunStore,
  input: ClaimInput,
  lease: { leaseMs: number; keepMs?: number } = WITHOUT_LEASES,
): Promise<number> {
  for (let slot = input.slot; slot < input.slot + 10; slot++) {
    const outcome = await runs.claim({
      ...input,
      ...WITHOUT_LEASES,
      ...lease,
      slot,
      reason: 'manual',
    });
    if (outcome.kind === 'won') return slot;
  }

  throw coded(
    new Error(`Could not start a manual run of "${input.job}"`),
    'ANARCHON_STORE',
  );
}
