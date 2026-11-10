/* Copyright (C) 2026-present Aristotelis — see repository license. */

import type { ClaimOutcome, RunClaim, RunStatus } from '../types';

/**
 * The lease rules every lease store follows, as pure functions on what the store read: the SQL and
 * NATS stores decide with them. The Redis CLAIM script (redis/lease.ts) holds the same rules in
 * Lua, in the same order: change both together.
 */

/** What a lease store holds about one run. */
export interface LeaseState {
  /** The current attempt. */
  attempt: number;
  /** The attempt limit the run started with. Missing: the claim's own. */
  maxAttempts?: number | undefined;
  /** Hand-overs on stop(): they don't count against the limit. */
  released?: number | undefined;
  /** The current attempt's token. */
  token: string;
  /** 'running', or how the run ended. */
  status: string;
  /** Lease end on the store's clock (ms); 0 once released or finished. */
  leaseUntil: number;
}

/** One run's state as the Redis and NATS stores write it, as JSON with short names. */
export interface StoredRun {
  /** Current attempt. */
  a: number;
  /** The attempt limit the run started with. */
  m?: number;
  /** Hand-overs on stop(): they don't count against the limit. */
  r?: number;
  /** The current attempt's token. */
  t: string;
  /** Status. */
  s: 'running' | 'success' | 'failed' | 'interrupted';
  /** The instance running the current attempt. */
  i: string;
  /** Lease end on the server's clock (ms); 0 once released or finished. */
  l: number;
}

export function leaseStateOf(run: StoredRun): LeaseState {
  return {
    attempt: run.a,
    maxAttempts: run.m,
    released: run.r,
    token: run.t,
    status: run.s,
    leaseUntil: run.l,
  };
}

/** What a claim does with the run it asks for, decided on the store's clock. */
export type ClaimDecision =
  /** Answer without writing. */
  | { kind: 'answer'; outcome: ClaimOutcome }
  /** The run has used up its attempts: end it. */
  | { kind: 'give-up' }
  /** The runner stopped renewing its lease: it died, froze, or handed the run over. */
  | { kind: 'take-over'; attempt: number; maxAttempts: number }
  /** Nobody has claimed this run: start it, unless {@link refuseLate} or an overlap forbids. */
  | { kind: 'start' };

/** The lease state machine: what a claim does, given the run's state (undefined: never claimed). */
export function decideClaim(
  run: LeaseState | undefined,
  input: RunClaim,
  now: number,
): ClaimDecision {
  if (!run) {
    return input.mode === 'takeover'
      ? { kind: 'answer', outcome: { kind: 'none' } }
      : { kind: 'start' };
  }

  // Our own claim, sent again.
  if (run.token === input.token && run.status === 'running') {
    return { kind: 'answer', outcome: { kind: 'won', attempt: run.attempt } };
  }
  if (run.status !== 'running') {
    return { kind: 'answer', outcome: { kind: 'done' } };
  }
  if (run.leaseUntil >= now) {
    return {
      kind: 'answer',
      outcome: { kind: 'running', attempt: run.attempt },
    };
  }

  // A run keeps the attempt limit it started with (manual runs: 1); hand-overs don't count.
  const maxAttempts = run.maxAttempts ?? input.maxAttempts;
  if (run.attempt - (run.released ?? 0) >= maxAttempts) {
    return { kind: 'give-up' };
  }
  return { kind: 'take-over', attempt: run.attempt + 1, maxAttempts };
}

/**
 * Refuses a new run whose claim arrives too late (delayed, or queued while the server was
 * unreachable): it must not start a stale run, or one so old that it may have been trimmed already.
 */
export function refuseLate(
  { slot, maxLateMs }: RunClaim,
  now: number,
): ClaimOutcome | undefined {
  const lateMs = now - slot;
  return maxLateMs && lateMs > maxLateMs ? { kind: 'late', lateMs } : undefined;
}

/**
 * The status of an attempt that has no result. 'running' only while it is the run's current attempt
 * with a live lease; an attempt whose runner stopped before finishing is 'interrupted'.
 */
export function pendingStatus(
  run: Pick<LeaseState, 'attempt' | 'status' | 'leaseUntil'> | null | undefined,
  attempt: number | undefined,
  now: number,
): RunStatus {
  if (!run || run.attempt !== attempt) return 'interrupted';
  if (run.status === 'running') {
    return run.leaseUntil >= now ? 'running' : 'interrupted';
  }
  return run.status === 'success' || run.status === 'failed'
    ? run.status
    : 'interrupted';
}
