/* Copyright (C) 2026-present Aristotelis — see repository license. */

import assert from 'node:assert/strict';
import { test } from 'vitest';

import { buildHistory, type ClaimRecord, type StoredResult } from '../../src';

const T = 1_791_633_600_000;

test('buildHistory joins each claim with its result, newest first, one record per attempt', () => {
  const claims: ClaimRecord[] = [
    { slot: T, by: 'api-1', at: T + 10, manual: false, attempt: 1, reason: 'scheduled' },
    { slot: T, by: 'api-2', at: T + 40_000, manual: false, attempt: 2, reason: 'takeover' },
    { slot: T + 60_000, by: 'api-3', at: T + 60_010, manual: true },
  ];
  const results: StoredResult[] = [
    { slot: T, by: 'api-2', attempt: 2, status: 'success', startedAt: T + 40_001, finishedAt: T + 41_001, durationMs: 1_000 },
  ];
  const runs = buildHistory({ job: 'report', claims, results, limit: 10 });
  assert.deepEqual(
    runs.map((r) => [r.instanceId, r.attempt, r.status, r.manual, r.reason]),
    [
      ['api-3', 1, 'running', true, undefined],
      ['api-2', 2, 'success', false, 'takeover'],
      ['api-1', 1, 'running', false, 'scheduled'],
    ],
  );
  assert.equal(runs[1]?.durationMs, 1_000);
  assert.deepEqual(runs[1]?.scheduledAt, new Date(T));
});

test('buildHistory keeps the newest `limit` records, and a backend can say what an unfinished attempt is', () => {
  const claims: ClaimRecord[] = [1, 2, 3].map((n) => ({ slot: T + n * 60_000, by: 'api-1', at: T + n * 60_000, manual: false }));
  const runs = buildHistory({ job: 'sync', claims, results: [], limit: 2, pendingStatus: () => 'interrupted' });
  assert.deepEqual(
    runs.map((r) => [r.slot, r.status]),
    [
      [T + 180_000, 'interrupted'],
      [T + 120_000, 'interrupted'],
    ],
  );
});
