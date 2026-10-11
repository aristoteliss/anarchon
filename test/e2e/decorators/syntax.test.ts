/* Copyright (C) 2026-present Aristotelis — see repository license. */

// Decorator syntax, compiled for real: instance.ts is type-checked with tsc and run with tsx, once
// with standard decorators and once with experimentalDecorators.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'vitest';

const run = promisify(execFile);
const ROOT = resolve(__dirname, '../../..');
const FIXTURE = resolve(__dirname, 'instance.ts');

const REPORTS = ['Reports-digest', 'sync', 'Reports-launch'];

// With standard decorators every object adds its jobs when it is created. Legacy decorators can't
// run code at that moment, so only a class marked with @Scheduled() does; the scheduler warns about
// the other one when it starts.
const TENANTS = ['a-tenant-sync', 'b-tenant-sync'];
const expected = {
  standard: { beforeStart: ['unmarked'], jobs: ['unmarked', ...REPORTS, ...TENANTS] },
  legacy: { beforeStart: [], jobs: [...REPORTS, ...TENANTS] },
};
const NOT_SCHEDULED = /@Every "unmarked" on Unmarked\.run is not scheduled: with legacy decorators, add @Scheduled\(\)/;

for (const style of ['standard', 'legacy'] as const) {
  const tsconfig = resolve(__dirname, `tsconfig.${style}.json`);

  test(`${style} decorators type-check`, async () => {
    await run('pnpm', ['exec', 'tsc', '-p', tsconfig], { cwd: ROOT });
  });

  test(`${style} decorators add the jobs of an object to the default scheduler, with no register()`, async () => {
    const { stdout, stderr } = await run(process.execPath, ['--import', 'tsx', FIXTURE], {
      cwd: ROOT,
      env: { ...process.env, TSX_TSCONFIG_PATH: tsconfig },
    });
    assert.deepEqual(JSON.parse(stdout.trim().split('\n').at(-1) ?? ''), {
      style,
      ...expected[style],
      status: 'success',
      ran: ['early:sync'],
      unmarked: true,
      tenantRuns: [0, 1],
      extra: ['extra-memory', ['extra-job'], 'success'],
    });
    if (style === 'legacy') assert.match(stderr, NOT_SCHEDULED);
    else assert.doesNotMatch(stderr, /"unmarked".* is not scheduled/);
    // Tenant objects are created after start(), so at that moment their class had none.
    assert.match(stderr, /@Every "tenant-sync" on .* is not scheduled/);
  });
}
