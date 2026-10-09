// Reads test-run.log, written by `pnpm test:all:full`.
//   node scripts/test-log.mjs review   summary and verdict
//   node scripts/test-log.mjs fails    failures and their stack traces only
import { existsSync, readFileSync, statSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';

const LOG = 'test-run.log';
const RULE = '='.repeat(80);
const green = (text) => `\x1b[32m${text}\x1b[0m`;
const red = (text) => `\x1b[31m${text}\x1b[0m`;

if (!existsSync(LOG)) {
  console.log(`No ${LOG} found. Run pnpm test:all:full first.`);
  process.exit(0);
}
const recorded = statSync(LOG).mtime.toLocaleString();
const lines = stripVTControlCharacters(readFileSync(LOG, 'utf8')).split('\n');

/** Counts from Vitest's "Test Files" or "Tests" line, e.g. "Tests  2 failed | 120 passed | 44 skipped (166)". */
function counts(label) {
  const line = lines.find((l) => new RegExp(`^\\s*${label}\\s+\\d`).test(l));
  if (!line) return null;
  const count = (word) => Number(line.match(new RegExp(`(\\d+) ${word}`))?.[1] ?? 0);
  return { failed: count('failed'), passed: count('passed'), skipped: count('skipped'), total: Number(line.match(/\((\d+)\)/)?.[1] ?? 0) };
}

function describe(c) {
  if (!c) return '-';
  const parts = [`${c.passed} passed`];
  if (c.failed) parts.unshift(`${c.failed} failed`);
  if (c.skipped) parts.push(`${c.skipped} skipped`);
  return `${parts.join(', ')} (${c.total})`;
}

const files = counts('Test Files');
const tests = counts('Tests');

if (process.argv[2] === 'fails') {
  if (tests && !tests.failed && !files?.failed) {
    console.log(`${green('✔ No failures found! All tests passed.')} (Recorded: ${recorded})`);
    process.exit(0);
  }
  console.log(`${red(`✖ Failures detected in test run (${recorded}):`)}\n`);
  // Vitest repeats every failure, with its stack trace, between this header and the totals.
  const start = lines.findIndex((l) => /Failed (Tests|Suites) \d/.test(l));
  if (start < 0) {
    for (const line of lines) if (/^\s*[×✕] /.test(line)) console.log(line);
  } else {
    const end = lines.findIndex((l, i) => i > start && /^\s*Test Files\s/.test(l));
    console.log(lines.slice(start, end < 0 ? undefined : end).join('\n'));
  }
  console.log('-'.repeat(80));
  process.exit(0);
}

const duration = lines.map((l) => l.match(/^\s*Duration\s+([0-9.]+[mµ]?s)/)?.[1]).findLast(Boolean) ?? '-';
const coverage =
  lines.map((l) => l.match(/Lines\s*:\s*([0-9.]+%)/)?.[1]).find(Boolean) ??
  lines
    .map((l) => l.match(/^All files\s*\|\s*[0-9.]+\s*\|\s*[0-9.]+\s*\|\s*[0-9.]+\s*\|\s*([0-9.]+)/)?.[1])
    .find(Boolean)
    ?.concat('%') ??
  '-';

console.log(`\n${RULE}`);
console.log(`${' '.repeat(31)}TEST RUN SUMMARY`);
console.log(`${' '.repeat(27)}Recorded: ${recorded}`);
console.log(RULE);
console.log(`${'Test files'.padEnd(14)}${describe(files)}`);
console.log(`${'Tests'.padEnd(14)}${describe(tests)}`);
console.log(`${'Duration'.padEnd(14)}${duration}`);
console.log(`${'Line cov'.padEnd(14)}${coverage}`);
console.log('-'.repeat(80));
if (!tests || tests.total === 0) console.log('\x1b[33m? No tests recorded in log.\x1b[0m');
else if (!tests.failed && !files?.failed) console.log(green(`✔ OVERALL VERDICT: ALL TESTS PASSED! (${describe(tests)})`));
else
  console.log(
    `${red(`✖ OVERALL VERDICT: ${tests.failed} TESTS FAILED`)}\n  Run "pnpm test:last:fails" to see failure details and stack traces.`,
  );
console.log(`${RULE}\n`);
