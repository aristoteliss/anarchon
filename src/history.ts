/* Copyright (C) 2026-present Aristotelis — see repository license. */

import type { RunReason, RunRecord, RunStatus, StoredResult } from './types';

/**
 * What a backend stores when a run is claimed, in the shape {@link buildHistory} reads.
 *
 * @example A claim as a custom backend keeps it, from the ClaimInput it was given
 * ```ts
 * const claim: ClaimRecord = { slot: input.slot, by: input.instanceId, at: Date.now(), manual: false };
 * ```
 */
export interface ClaimRecord {
  /** Scheduled time of the run (ms). */
  slot: number;
  /** The instance that claimed it. */
  by: string;
  /** When it was claimed (ms): the record's startedAt until a result says otherwise. */
  at: number;
  /** true for a runNow() run. */
  manual: boolean;
  /** Lease strategy: which attempt this claim is. Missing means 1. */
  attempt?: number;
  /** Lease strategy: why the attempt started. */
  reason?: RunReason;
}

/** The claim record queue backends (RabbitMQ, NATS) append to a job's history. */
export function claimPayload(input: { slot: number; instanceId: string; token: string }, manual: boolean) {
  return { type: 'claim' as const, slot: input.slot, by: input.instanceId, token: input.token, at: Date.now(), manual };
}

/** Reads a claim from any object with slot / by / at / manual fields (strings or numbers). */
export function toClaim(raw: Record<string, unknown>): ClaimRecord | null {
  const slot = Number(raw.slot);
  const by = raw.by;
  if (!Number.isFinite(slot) || typeof by !== 'string' || by === '') return null;
  const at = Number(raw.at);
  return { slot, by, at: Number.isFinite(at) ? at : slot, manual: raw.manual === true || raw.manual === '1' || raw.manual === 1 };
}

export function toResult(raw: unknown): StoredResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.slot !== 'number' || typeof r.by !== 'string') return null;
  if (r.status !== 'success' && r.status !== 'failed' && r.status !== 'interrupted') return null;
  const result: StoredResult = {
    slot: r.slot,
    by: r.by,
    attempt: typeof r.attempt === 'number' ? r.attempt : 1,
    status: r.status,
    startedAt: Number(r.startedAt),
    finishedAt: Number(r.finishedAt),
    durationMs: Number(r.durationMs),
  };
  if (typeof r.error === 'string') result.error = r.error;
  return result;
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** What {@link buildHistory} joins into a job's history. */
export interface HistoryInput {
  /** The job's name. */
  job: string;
  /** The job's claims, in any order. */
  claims: ReadonlyArray<ClaimRecord>;
  /** The results the winners saved, in any order. A result belongs to the claim of the same slot, instance and attempt. */
  results: Iterable<StoredResult>;
  /** How many records to return, newest first. */
  limit: number;
  /**
   * The status of a claim without a result. Default 'running'. A backend that knows the attempt
   * ended without a result (its lease ran out) answers 'interrupted'.
   */
  pendingStatus?: (claim: ClaimRecord & { attempt: number }) => RunStatus;
}

/**
 * Joins a job's claims with their results into the records `history()` returns: newest first, one
 * per attempt, at most `limit`. For a custom backend: store claims and results as they come, and
 * build its `history()` with this, so its records match those of the built-in backends.
 *
 * @example The history() of a custom backend
 * ```ts
 * async history(job: string, limit: number): Promise<RunRecord[]> {
 *   const claims = await this.db.claimsOf(job);   // ClaimRecord[]
 *   const results = await this.db.resultsOf(job); // StoredResult[]
 *   return buildHistory({ job, claims, results, limit });
 * }
 * ```
 */
export function buildHistory({ job, claims, results, limit, pendingStatus = () => 'running' }: HistoryInput): RunRecord[] {
  const byKey = new Map<string, StoredResult>();
  for (const result of results) byKey.set(`${result.slot}|${result.by}|${result.attempt ?? 1}`, result);
  return [...claims]
    .map((claim) => ({ ...claim, attempt: claim.attempt ?? 1 }))
    .sort((a, b) => b.slot - a.slot || b.attempt - a.attempt || b.at - a.at)
    .slice(0, limit)
    .map((claim) => {
      const result = byKey.get(`${claim.slot}|${claim.by}|${claim.attempt}`);
      const record: RunRecord = {
        job,
        slot: claim.slot,
        scheduledAt: new Date(claim.slot),
        instanceId: claim.by,
        manual: claim.manual,
        attempt: claim.attempt,
        status: result ? result.status : pendingStatus(claim),
        startedAt: new Date(result?.startedAt ?? claim.at),
      };
      if (claim.reason) record.reason = claim.reason;
      if (result) {
        record.finishedAt = new Date(result.finishedAt);
        record.durationMs = result.durationMs;
        if (result.error !== undefined) record.error = result.error;
      }
      return record;
    });
}
