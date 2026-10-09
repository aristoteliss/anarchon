import type { RunReason, RunRecord, RunStatus, StoredResult } from './types';

/** What every backend stores when a run is claimed. */
export interface ClaimRecord {
  slot: number;
  by: string;
  at: number;
  manual: boolean;
  attempt?: number;
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

/**
 * Joins claims with results, newest first. A claim without a result is 'running', unless the
 * backend can tell it was interrupted (pendingStatus).
 */
export function mergeRuns(
  job: string,
  claims: ClaimRecord[],
  results: Iterable<StoredResult>,
  limit: number,
  pendingStatus: (claim: ClaimRecord & { attempt: number }) => RunStatus = () => 'running',
): RunRecord[] {
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
