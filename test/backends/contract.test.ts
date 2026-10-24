/* Copyright (C) 2026-present Aristotelis — see repository license. */

/**
 * The contract every backend must meet, run against real servers through `backendContract()` from
 * `anarchon/testing`: one winner per run, retry-safe claims, and history that names the winner.
 */
import { Logger as GlideLogger } from '@valkey/valkey-glide';
import { describe, test } from 'vitest';

import { backendContract } from '../../src/testing';
import { availableSpecs, makeBackend } from '../support';

// GLIDE logs every server error (expected here: losers' XADDs are refused) to stdout.
GlideLogger.setLoggerConfig('off');

describe('every backend', async () => {
  for (const { label, spec, skip } of await availableSpecs()) {
    describe.skipIf(skip)(label, () => {
      const cases = backendContract((namespace) =>
        makeBackend({ ...spec, id: namespace }),
      );
      for (const { name, run } of cases) test(name, run);
    });
  }
});
