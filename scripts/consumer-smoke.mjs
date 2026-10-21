/* Copyright (C) 2026-present Aristotelis — see repository license. */

// Installs a packed anarchon tarball with npm into a fresh folder outside the checkout and runs
// one job through require() and through import, on the Node that runs this script. It needs no
// build tools, so CI runs it on every supported Node line, older than the one that builds.
// `pnpm test:release` is the full check of the tarball (files, types, exports, Bun).
//   node scripts/consumer-smoke.mjs <tarball>
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const tarball = process.argv[2];
if (!tarball)
  throw new Error('usage: node scripts/consumer-smoke.mjs <tarball>');

// A Node without the built-in node:sqlite gets better-sqlite3 12, the last line that supports Node 20.
const builtin = await import('node:sqlite').then(
  () => true,
  () => false,
);
const driver = builtin ? 'node:sqlite' : 'better-sqlite3@12';
const packages = [resolve(tarball), ...(builtin ? [] : [driver])];

const job = `
  const scheduler = new Scheduler({ backend: new SqliteBackend({ database: ':memory:' }), instanceId: 'smoke' });
  let ran = 0;
  scheduler.every('job', '1h', async (ctx) => { ctx.signal.throwIfAborted(); ran++; }, { catchUpMs: 0 });
  await scheduler.start();
  try {
    const record = await scheduler.runNow('job');
    if (record.status !== 'success' || ran !== 1) throw new Error('job did not run: ' + JSON.stringify(record));
  } finally {
    await scheduler.stop();
  }
`;

const consumer = mkdtempSync(resolve(tmpdir(), 'anarchon-smoke-'));
const run = (command, args) =>
  execFileSync(command, args, { cwd: consumer, stdio: 'inherit' });
try {
  writeFileSync(
    resolve(consumer, 'package.json'),
    JSON.stringify({
      name: 'anarchon-smoke-consumer',
      private: true,
      version: '1.0.0',
    }),
  );
  writeFileSync(
    resolve(consumer, 'run.cjs'),
    `const { Scheduler, SqliteBackend } = require('anarchon');
(async () => {${job}  console.log('require: ran one job');
})().catch((error) => { console.error(error); process.exit(1); });
`,
  );
  writeFileSync(
    resolve(consumer, 'run.mjs'),
    `import { Scheduler, SqliteBackend } from 'anarchon';
${job}console.log('import: ran one job');
`,
  );
  run('npm', ['install', '--no-audit', '--no-fund', ...packages]);
  run(process.execPath, ['run.cjs']);
  run(process.execPath, ['run.mjs']);
  console.log(
    `\nanarchon on Node ${process.version} with ${driver}: installs and runs a job.`,
  );
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
