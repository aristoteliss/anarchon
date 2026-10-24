/* Copyright (C) 2026-present Aristotelis — see repository license. */

/** backendContract() from anarchon/testing fails a backend that breaks the contract. */
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { type Backend, isAnarchonError } from '../../src';
import { backendContract } from '../../src/testing';

/** Every claim wins, and nothing is remembered: breaks every check. */
function careless(): Backend {
  return {
    name: 'careless',
    dedupeWindowMs: Number.POSITIVE_INFINITY,
    init: async () => {},
    prepareJob: async () => {},
    claim: async () => true,
    recordManualRun: async () => undefined,
    saveResult: async () => {},
    history: async () => [],
    close: async () => {},
  };
}

test('every contract check fails a backend whose claims always win', async () => {
  const cases = backendContract(careless);

  assert.equal(cases.length, 3);
  for (const { name, run } of cases) {
    await assert.rejects(
      run(),
      (error) => isAnarchonError(error, 'ANARCHON_CONTRACT'),
      name,
    );
  }
});

test('a namespace is letters and digits, and new for each check', async () => {
  const namespaces: string[] = [];
  const record = (namespace: string) => {
    namespaces.push(namespace);
    return careless();
  };

  for (const { run } of backendContract(record)) {
    await run().catch(() => {});
  }

  assert.ok(
    namespaces.every((namespace) => /^[a-z][a-z0-9]+$/.test(namespace)),
  );
  assert.equal(new Set(namespaces).size, 3, JSON.stringify(namespaces));
});
