/* Copyright (C) 2026-present Aristotelis — see repository license. */

// Builds anarchon and this app, runs the app for a few seconds in a real Nest container, and checks
// what its providers did. The app is compiled the way a Nest project is: legacy decorators and
// emitDecoratorMetadata.
//
//   node check.mjs                  check the app on the NestJS installed here
//   node check.mjs --nest 11        check it on another major version of NestJS
//   node check.mjs --run            run the app until Ctrl+C instead of checking it
//
// For another version, the source is copied into dist/nest-<version>, where that NestJS is
// installed on its own, so the same source is type-checked and run against it.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const app = import.meta.dirname;
const repository = resolve(app, '../..');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: 'inherit' });

const other = process.argv.includes('--nest') ? process.argv[process.argv.indexOf('--nest') + 1] : undefined;
const project = other ? join(app, 'dist', `nest-${other}`) : app;

run('pnpm', ['build'], repository);
if (other) {
  const { dependencies } = readJson(join(app, 'package.json'));
  rmSync(join(project, 'src'), { recursive: true, force: true });
  mkdirSync(project, { recursive: true });
  cpSync(join(app, 'src'), join(project, 'src'), { recursive: true });
  writeFileSync(
    join(project, 'package.json'),
    JSON.stringify(
      {
        name: `anarchon-example-nestjs-${other}`,
        private: true,
        type: 'commonjs',
        dependencies: {
          ...dependencies,
          '@nestjs/common': `^${other}.0.0`,
          '@nestjs/core': `^${other}.0.0`,
          anarchon: `link:${repository}`,
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(project, 'tsconfig.json'),
    JSON.stringify({
      extends: '../../tsconfig.json',
      compilerOptions: { rootDir: 'src', outDir: 'out', typeRoots: [join(app, 'node_modules/@types')] },
      include: ['src'],
    }),
  );
  run('pnpm', ['install', '--ignore-workspace', '--prefer-offline'], project);
}
run('pnpm', ['exec', 'tsc', '-p', join(project, 'tsconfig.json')], app);

const main = join(project, other ? 'out' : 'dist', 'main.js');
const nest = readJson(join(project, 'node_modules/@nestjs/core/package.json')).version;

if (process.argv.includes('--run')) {
  console.log(`NestJS ${nest}`);
  spawnSync(process.execPath, [main], { cwd: project, stdio: 'inherit' });
  process.exit(0);
}

const folder = mkdtempSync(join(tmpdir(), 'anarchon-nestjs-'));
try {
  const { status, stdout, stderr } = spawnSync(process.execPath, [main], {
    cwd: project,
    encoding: 'utf8',
    env: { ...process.env, SQLITE_FILE: join(folder, 'jobs.db'), EXIT_AFTER_MS: '5000' },
  });
  assert.equal(status, 0, `the app exited with ${status}:\n${stderr}`);

  const checks = [
    [
      'the jobs of the providers are on the scheduler when the app has started',
      stdout,
      /^jobs: nest-reports-sync, nest-audit, nest-invoices$/m,
    ],
    [
      '@Injectable() over @Scheduled(): the job runs, with its dependency injected',
      stdout,
      /^ran nest-reports-sync in ReportsService \(attempt 1\)$/m,
    ],
    [
      '@Scheduled() over @Injectable(): the job runs, with its dependency injected',
      stdout,
      /^ran nest-audit in AuditService \(attempt 1\)$/m,
    ],
    ['register(this) in onModuleInit: the job runs', stdout, /^ran nest-invoices in InvoicesService \(attempt 1\)$/m],
    [
      'a provider with neither is reported',
      stderr,
      /@Every "nest-forgotten" on ForgottenService\.run is not scheduled: with legacy decorators, add @Scheduled\(\)/,
    ],
    ['the app stops cleanly', stdout, /^stopped$/m],
  ];
  for (const [what, output, expected] of checks) {
    assert.match(output, expected, what);
    console.log(`ok  ${what}`);
  }
  assert.doesNotMatch(stdout, /never printed/, 'the job of the provider with neither must not run');
  console.log(`ok  the job of the provider with neither does not run\n\nNestJS ${nest}: all checks passed.\n`);
} finally {
  rmSync(folder, { recursive: true, force: true });
}
