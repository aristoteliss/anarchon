/* Copyright (C) 2026-present Aristotelis — see repository license. */

// Packs anarchon, installs the tarball into a fresh consumer outside the checkout, and checks
// that it is complete, type-checks, runs a job through require(), import and Bun, and passes the
// backend contract of anarchon/testing on SQLite.
// Run through `pnpm test:release`, which rebuilds dist first.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, stdio: 'inherit' });
const manifest = readJson(resolve(root, 'package.json'));
// tar from a fixed system directory, not looked up on PATH.
const TAR = ['/usr/bin/tar', '/bin/tar'].find((path) => existsSync(path));
const ROOT_FILES = [
  'package.json',
  'README.md',
  'LICENSE',
  'COMMERCIAL_LICENSE.txt',
];

// What the built dist exports at runtime; the installed tarball must export the same names.
const exported = (namespace) =>
  Object.keys(namespace)
    .filter((key) => !['default', '__esModule', 'module.exports'].includes(key))
    .sort()
    .join();
const expected = exported(
  createRequire(import.meta.url)(resolve(root, 'dist/index.js')),
);

// Outside the checkout: ancestor node_modules must not satisfy undeclared dependencies.
const temporary = mkdtempSync(resolve(tmpdir(), 'anarchon-release-'));
try {
  const packed = resolve(temporary, 'packed');
  const consumer = resolve(temporary, 'consumer');
  mkdirSync(packed);
  mkdirSync(resolve(consumer, 'src'), { recursive: true });

  run('pnpm', ['pack', '--pack-destination', packed], root);
  const [tarball] = readdirSync(packed).filter((name) => name.endsWith('.tgz'));
  if (!tarball) throw new Error('pnpm pack produced no tarball');

  if (!TAR) throw new Error('tar is not in /usr/bin or /bin');
  const entries = execFileSync(TAR, ['-tf', resolve(packed, tarball)], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .map((entry) => entry.replace(/^package\//, ''));
  const ENTRY_FILES = [
    'dist/index.js',
    'dist/index.d.ts',
    'dist/testing.js',
    'dist/testing.d.ts',
  ];
  for (const file of [...ROOT_FILES, ...ENTRY_FILES]) {
    if (!entries.includes(file)) throw new Error(`${tarball}: missing ${file}`);
  }
  const stray = entries.filter(
    (entry) => !ROOT_FILES.includes(entry) && !entry.startsWith('dist/'),
  );
  if (stray.length)
    throw new Error(`${tarball}: unexpected files ${stray.join(', ')}`);
  if (entries.some((entry) => /\.(spec|test)\.[cm]?[jt]s$/.test(entry)))
    throw new Error(`${tarball}: contains tests`);
  console.log(
    `${tarball}: ${entries.length} files, all under dist/ or expected at the root`,
  );

  writeFileSync(
    resolve(consumer, 'package.json'),
    JSON.stringify(
      {
        name: 'anarchon-packed-consumer',
        private: true,
        version: '1.0.0',
        dependencies: { anarchon: `file:../packed/${tarball}` },
        devDependencies: {
          '@types/node': readJson(
            resolve(root, 'node_modules/@types/node/package.json'),
          ).version,
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    resolve(consumer, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'es2022',
        module: 'nodenext',
        moduleResolution: 'nodenext',
        lib: ['es2022'],
        types: ['node'],
        strict: true,
        skipLibCheck: false,
        rootDir: 'src',
        outDir: 'dist',
      },
      include: ['src'],
    }),
  );
  // A real job end to end, on an in-memory SQLite database: no server needed.
  writeFileSync(
    resolve(consumer, 'src/run-job.ts'),
    `import { type JobContext, parseDuration, Scheduler, type SchedulerOptions, SqliteBackend } from 'anarchon';

async function main(): Promise<void> {
  const options: SchedulerOptions = { backend: new SqliteBackend({ database: ':memory:' }), instanceId: 'release-check' };
  const scheduler = new Scheduler(options);
  let ran = 0;
  scheduler.every('job', parseDuration('1h'), async (ctx: JobContext) => {
    ctx.signal.throwIfAborted();
    ran++;
  });
  await scheduler.start();
  try {
    const record = await scheduler.runNow('job');
    if (record.status !== 'success' || ran !== 1) throw new Error(\`job did not run: \${JSON.stringify(record)}\`);
  } finally {
    await scheduler.stop();
  }
  console.log('require: ran one job on SQLite');
}

void main();
`,
  );
  // The subpath export resolves, type-checks and runs; SQLite on a file, shared by the instances.
  writeFileSync(
    resolve(consumer, 'src/contract.ts'),
    `import { join } from 'node:path';
import { SqliteBackend } from 'anarchon';
import { backendContract } from 'anarchon/testing';

async function main(): Promise<void> {
  const database = join(__dirname, '..', 'contract.db');
  const cases = backendContract((namespace) => new SqliteBackend({ database, table: namespace }));
  for (const { run } of cases) await run();
  console.log(\`anarchon/testing: SQLite passes \${cases.length} contract checks\`);
}

void main();
`,
  );
  writeFileSync(
    resolve(consumer, 'src/load.mts'),
    `import { createRequire } from 'node:module';
import * as imported from 'anarchon';

const names = (namespace: object) =>
  Object.keys(namespace)
    .filter((key) => !['default', '__esModule', 'module.exports'].includes(key))
    .sort()
    .join();
const required = names(createRequire(import.meta.url)('anarchon'));
if (names(imported) !== required) throw new Error('import and require() export different names');
if (required !== ${JSON.stringify(expected)}) throw new Error(\`the tarball exports \${required}\`);
console.log(\`import: the same \${required.split(',').length} exports as require() and dist\`);
`,
  );

  run('pnpm', ['install', '--prefer-offline'], consumer);
  run(
    resolve(root, 'node_modules/.bin/tsc'),
    ['-p', 'tsconfig.json'],
    consumer,
  );
  run(process.execPath, ['dist/run-job.js'], consumer);
  run(process.execPath, ['dist/contract.js'], consumer);
  run(process.execPath, ['dist/load.mjs'], consumer);
  try {
    execFileSync('bun', ['--version'], { stdio: 'ignore' });
    run('bun', ['dist/load.mjs'], consumer);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    console.log('bun: not installed, skipped');
  }
  console.log(
    `\n${manifest.name}@${manifest.version}: the packed tarball is complete and loads.`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
