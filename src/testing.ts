/* Copyright (C) 2026-present Aristotelis — see repository license. */

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { coded } from './errors';
import type { Backend, ClaimInput } from './types';

/**
 * One check of the backend contract, for any test runner: `run()` resolves when the backend
 * passes it, and rejects with an `ANARCHON_CONTRACT` error that says what was expected when it
 * doesn't.
 *
 * @example
 * ```ts
 * for (const { name, run } of backendContract(create)) test(name, run);
 * ```
 */
export interface ContractCase {
  /** What the check proves, as a sentence: use it as the test's title. */
  name: string;
  run: () => Promise<void>;
}

/**
 * Creates a backend for one instance. Backends created with the same `namespace` share one store,
 * as instances of one service do; different namespaces must not see each other's jobs. The
 * namespace has only letters and digits, so it fits a key prefix, a table name or a queue name.
 * Each case uses a new namespace, creates its backends and closes them.
 *
 * @example
 * ```ts
 * const create: BackendFactory = (namespace) => new MyBackend({ url: process.env.STORE_URL, prefix: `${namespace}:` });
 * ```
 */
export type BackendFactory = (namespace: string) => Backend | Promise<Backend>;

/** Instances that race for each run in the race check. */
const RACERS = 3;
/** Runs the instances race for. */
const RACE_RUNS = 40;
const HISTORY_SIZE = 1_000;
/** Claims go to slots this far ahead, so no check depends on the time it runs. */
const AHEAD_MS = 60_000;

/**
 * The checks every backend must pass, as runner-agnostic cases: several instances racing for the
 * same runs get exactly one winner each; a claim sent again with the same token still wins, and
 * another instance's claim loses; history joins claims and results, newest first. They run
 * against your real store: run them where calls really overlap (a connection pool, several
 * clients), not against a mock.
 *
 * Covers the {@link Backend} methods every backend has. A lease backend's `RunStore` (takeover,
 * heartbeats, hand-over) needs tests of its own.
 *
 * @param create Makes one instance's backend; see {@link BackendFactory}.
 * @returns The cases, in a stable order. Each one resolves, or rejects with an `ANARCHON_CONTRACT`
 *   error naming what the backend did wrong.
 *
 * @example Vitest
 * ```ts
 * import { backendContract } from 'anarchon/testing';
 * import { test } from 'vitest';
 *
 * for (const { name, run } of backendContract((namespace) => new MyBackend({ prefix: `${namespace}:` }))) {
 *   test(name, run, 30_000);
 * }
 * ```
 *
 * @example node:test
 * ```ts
 * import { test } from 'node:test';
 * import { backendContract } from 'anarchon/testing';
 *
 * for (const { name, run } of backendContract(createBackend)) test(name, run);
 * ```
 */
export function backendContract(create: BackendFactory): ContractCase[] {
  return [
    {
      name: `${RACERS} instances race for ${RACE_RUNS} runs: exactly one winner each`,
      run: () => withBackends(create, RACERS, race),
    },
    {
      name: 'the same claim sent twice is still a win; another instance loses',
      run: () => withBackends(create, 1, ([backend]) => resend(backend)),
    },
    {
      name: 'history joins claims and results, newest first',
      run: () => withBackends(create, 1, ([backend]) => joinHistory(backend)),
    },
  ];
}

/** Creates `count` backends on a new namespace, sets them up, runs `check`, and closes them. */
async function withBackends(
  create: BackendFactory,
  count: number,
  check: (backends: Backend[]) => Promise<void>,
): Promise<void> {
  const namespace = `c${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const backends = await Promise.all(
    Array.from({ length: count }, () => create(namespace)),
  );

  try {
    await Promise.all(backends.map((backend) => backend.init()));
    await Promise.all(
      backends.map((backend) => backend.prepareJob('job', HISTORY_SIZE)),
    );
    await check(backends);
  } finally {
    await Promise.all(backends.map((backend) => backend.close()));
  }
}

async function race(backends: Backend[]): Promise<void> {
  const first = futureSlot();

  for (let run = 0; run < RACE_RUNS; run++) {
    const slot = first + run * 1_000;
    const wins = await Promise.all(
      backends.map((backend, n) => backend.claim(claim(slot, `i${n}`))),
    );
    const winners = wins.filter(Boolean).length;
    expect(winners, 1, `run ${run}: winners of one claim race`);
  }
}

async function resend(backend: Backend | undefined): Promise<void> {
  if (!backend) return;
  const slot = futureSlot();
  const mine = claim(slot, 'A');

  expect(await backend.claim(mine), true, 'a first claim');
  expect(await backend.claim(mine), true, 'the same claim sent again');
  expect(await backend.claim(claim(slot, 'B')), false, "another's claim");
}

async function joinHistory(backend: Backend | undefined): Promise<void> {
  if (!backend) return;
  const first = futureSlot();
  const second = first + 1_000;

  for (const [slot, by] of [
    [first, 'A'],
    [second, 'B'],
  ] as const) {
    const input = claim(slot, by);
    expect(await backend.claim(input), true, `the claim of ${by}`);
    await backend.recordClaim?.(input);
  }
  const result = { slot: first, by: 'A', status: 'failed' as const };
  const times = { startedAt: first, finishedAt: first + 5, durationMs: 5 };
  await backend.saveResult(
    'job',
    { ...result, ...times, error: 'Error: boom' },
    HISTORY_SIZE,
  );

  const records = await backend.history('job', 10);
  const seen = records.map((r) => [r.slot, r.instanceId, r.status, r.error]);
  const expected = [
    [second, 'B', 'running', undefined],
    [first, 'A', 'failed', 'Error: boom'],
  ];
  expect(seen, expected, 'history (slot, instanceId, status, error)');
  expect(await backend.history('never-ran', 10), [], 'history of no runs');
}

function claim(slot: number, instanceId: string): ClaimInput {
  return {
    job: 'job',
    slot,
    token: randomUUID(),
    instanceId,
    historySize: HISTORY_SIZE,
  };
}

/** A whole second, AHEAD_MS from now. */
function futureSlot(): number {
  return Math.ceil((Date.now() + AHEAD_MS) / 1_000) * 1_000;
}

function expect(actual: unknown, expected: unknown, what: string): void {
  if (isDeepStrictEqual(actual, expected)) return;
  throw coded(
    new Error(
      `Backend contract: ${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    ),
    'ANARCHON_CONTRACT',
  );
}
