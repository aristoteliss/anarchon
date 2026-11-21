/* Copyright (C) 2026-present Aristotelis — see repository license. */

/**
 * anarchon in a CommonJS app on NATS: the app loads the client with require() and gives its own
 * connection to anarchon. consumer.cjs runs in its own Node process, on anarchon built with tsc,
 * so require() and import() resolve the NATS packages as they do in a real app.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'vitest';

import { NATS_URL, probeNats } from '../../support';

const run = promisify(execFile);
const ROOT = resolve(__dirname, '../../..');
const CONSUMER = resolve(__dirname, 'consumer.cjs');
// In node_modules, so the build finds the dependencies of the repository and git ignores it.
const BUILD = resolve(ROOT, 'node_modules/.cache/anarchon-commonjs');

test('a CommonJS app gives its NATS connection to anarchon, and both strategies meet the contract', async (t) => {
  if (!(await probeNats(NATS_URL))) return t.skip(`nothing at ${NATS_URL}`);
  rmSync(BUILD, { recursive: true, force: true });
  await run(
    'pnpm',
    [
      'exec',
      'tsc',
      '-p',
      'tsconfig.json',
      '--outDir',
      BUILD,
      '--declaration',
      'false',
      '--declarationMap',
      'false',
      '--sourceMap',
      'false',
    ],
    { cwd: ROOT },
  );

  const { stdout } = await run(process.execPath, [CONSUMER, BUILD, NATS_URL], {
    cwd: ROOT,
    timeout: 120_000,
  });
  const report = JSON.parse(stdout.trim().split('\n').at(-1) ?? '');

  assert.deepEqual(report.failures, []);
  assert.ok(report.contract['msg-id'] > 0);
  assert.ok(report.contract.lease > 0);
  for (const strategy of ['msg-id', 'lease']) {
    assert.deepEqual(report.jobs[strategy], {
      status: 'success',
      ran: 1,
      history: 1,
    });
  }
  // The connection belongs to the app: stop() and close() leave it open.
  assert.equal(report.connectionOpen, true);
}, 180_000);
