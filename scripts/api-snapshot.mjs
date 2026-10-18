/* Copyright (C) 2026-present Aristotelis — see repository license. */

// The public API as the compiler emits it: every declaration file reachable from dist/index.d.ts,
// without comments. `--check` fails when it differs from api/anarchon.api.txt, so a change to the
// API is never accidental; `--update` writes the file after an intended change, and the diff of
// that file is what a reviewer reads. Run after `pnpm build`.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const snapshotPath = resolve(root, 'api/anarchon.api.txt');
const mode = process.argv[2];
if (mode !== '--check' && mode !== '--update') {
  console.error('usage: node scripts/api-snapshot.mjs --check | --update');
  process.exit(2);
}

/** Every .d.ts the entry point reaches through its imports and re-exports, in a stable order. */
function reachable(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const [, specifier] of source.matchAll(/\bfrom\s+'(\.[^']+)'/g)) {
      const base = resolve(dirname(file), specifier.replace(/\.js$/, ''));
      const target = [`${base}.d.ts`, resolve(base, 'index.d.ts')].find((path) => existsSync(path));
      if (target) queue.push(target);
    }
  }
  return [...seen].sort();
}

function strip(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
    .join('\n');
}

const entry = resolve(root, 'dist/index.d.ts');
if (!existsSync(entry)) {
  console.error('dist/index.d.ts is missing: run `pnpm build` first');
  process.exit(2);
}
const snapshot = `${reachable(entry)
  .map((file) => `// ${relative(resolve(root, 'dist'), file)}\n${strip(readFileSync(file, 'utf8'))}`)
  .join('\n\n')}\n`;

if (mode === '--update') {
  writeFileSync(snapshotPath, snapshot);
  console.log(`api: wrote ${relative(root, snapshotPath)}`);
} else if (!existsSync(snapshotPath) || readFileSync(snapshotPath, 'utf8') !== snapshot) {
  console.error(
    'api: the public API differs from api/anarchon.api.txt.\n' +
      'If the change is intended, run `pnpm api:update` and review the diff of that file: removing or ' +
      'changing anything users or backends rely on is a breaking change.',
  );
  process.exit(1);
} else {
  console.log('api: matches api/anarchon.api.txt');
}
