/* Copyright (C) 2026-present Aristotelis — see repository license. */

import { Cron } from 'croner';
import { coded } from './errors';

/**
 * A schedule turns "now" into the next run time. Every instance computes the same run times
 * from the same schedule, so a run time ("slot") identifies one run across the whole cluster.
 */
export interface Schedule {
  /** Which method made it: cron(), every() or at(). */
  readonly type: 'cron' | 'every' | 'once';
  /** For people: 'every 10s', 'cron "0 8 * * 1-5" (Europe/Athens)'. Shown by jobs(). */
  readonly description: string;
  /** Smallest gap between two runs, in ms (Infinity if it can't be known). */
  readonly minGapMs: number;
  /** First run time strictly after `after` (ms since epoch), or null if there are no more runs. */
  next(after: number): number | null;
  /** Latest run time at or before `atOrBefore`, or null if there is none. */
  prev(atOrBefore: number): number | null;
}

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Accepts milliseconds (`10000`) or a duration string: `'10s'`, `'10m'`, `'35m'`, `'1h30m'`, `'2d'`, `'500ms'`.
 *
 * @throws RangeError for a string it can't read, or a number that isn't a positive whole number of ms.
 *
 * @example Durations from configuration
 * ```ts
 * parseDuration('1h30m');                                // 5400000
 * const timeoutMs = parseDuration(process.env.JOB_TIMEOUT ?? '5m');
 * scheduler.every('export', '1h', exportAll, { timeoutMs });
 * ```
 */
export function parseDuration(value: number | string): number {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value <= 0) {
      throw coded(
        new RangeError(
          `Invalid duration: ${value} (use a positive whole number of ms)`,
        ),
        'ANARCHON_INVALID_ARGUMENT',
      );
    }
    return value;
  }

  const text = value.trim().toLowerCase();
  if (/^\d+$/.test(text)) return parseDuration(Number(text));

  const tokens = text.split(/(ms|s|m|h|d)/);
  if (
    tokens.length < 3 ||
    tokens.length % 2 === 0 ||
    tokens[tokens.length - 1] !== ''
  ) {
    throw coded(
      new RangeError(
        `Invalid duration: "${value}" (examples: "10s", "35m", "1h30m")`,
      ),
      'ANARCHON_INVALID_ARGUMENT',
    );
  }

  const total = sumTokens(value, tokens);
  return parseDuration(Math.round(total));
}

/**
 * The ms of the amount and unit pairs that a duration string splits into. `value` is the string
 * as given, for the error message.
 */
function sumTokens(value: string, tokens: string[]): number {
  let total = 0;
  for (let i = 0; i < tokens.length - 1; i += 2) {
    const amount = (tokens[i] ?? '').trim();
    const unit = tokens[i + 1] ?? '';
    const ms = UNIT_MS[unit];
    if (!/^\d+(?:\.\d+)?$/.test(amount) || ms === undefined) {
      throw coded(
        new RangeError(
          `Invalid duration: "${value}" (examples: "10s", "35m", "1h30m")`,
        ),
        'ANARCHON_INVALID_ARGUMENT',
      );
    }
    total += Number(amount) * ms;
  }

  return total;
}

/**
 * Writes milliseconds the way `parseDuration()` reads them, largest units first.
 *
 * @example
 * ```ts
 * formatDuration(5_400_000); // '1h30m'
 * formatDuration(90_500);    // '1m30s500ms'
 * log.info(`next run in ${formatDuration(scheduler.nextRun('sync')!.getTime() - Date.now())}`);
 * ```
 */
export function formatDuration(ms: number): string {
  const parts: string[] = [];
  let rest = ms;

  for (const [unit, size] of [
    ['d', 86_400_000],
    ['h', 3_600_000],
    ['m', 60_000],
    ['s', 1_000],
  ] as const) {
    if (rest >= size) {
      parts.push(`${Math.floor(rest / size)}${unit}`);
      rest %= size;
    }
  }

  if (rest > 0 || parts.length === 0) parts.push(`${rest}ms`);
  return parts.join('');
}

/**
 * Runs every `intervalMs`, on a grid counted from 1970-01-01 UTC (plus an optional offset).
 * All instances share the grid, so they agree on run times no matter when each one started.
 */
export function everySchedule(intervalMs: number, offsetMs = 0): Schedule {
  if (!Number.isInteger(offsetMs)) {
    throw coded(
      new RangeError(`offsetMs must be a whole number of ms (got ${offsetMs})`),
      'ANARCHON_INVALID_ARGUMENT',
    );
  }

  const offset = ((offsetMs % intervalMs) + intervalMs) % intervalMs;

  return {
    type: 'every',
    description: `every ${formatDuration(intervalMs)}${offset ? ` (offset ${formatDuration(offset)})` : ''}`,
    minGapMs: intervalMs,
    next(after) {
      return (
        (Math.floor((after - offset) / intervalMs) + 1) * intervalMs + offset
      );
    },
    prev(atOrBefore) {
      return (
        Math.floor((atOrBefore - offset) / intervalMs) * intervalMs + offset
      );
    },
  };
}

/** Runs once, at `at` (ms since epoch). */
export function onceSchedule(at: number): Schedule {
  if (!Number.isFinite(at)) {
    throw coded(
      new RangeError('Invalid date for a one-off job'),
      'ANARCHON_INVALID_ARGUMENT',
    );
  }

  return {
    type: 'once',
    description: `once at ${new Date(at).toISOString()}`,
    minGapMs: Infinity,
    next(after) {
      return at > after ? at : null;
    },
    prev(atOrBefore) {
      return at <= atOrBefore ? at : null;
    },
  };
}

/** Standard cron syntax; a 6th leading field adds seconds (`'*\/10 * * * * *'`). */
export function cronSchedule(expression: string, timezone?: string): Schedule {
  const zone = timezone ? { timezone } : {};
  const cron = new Cron(expression, zone);
  const runs = cron.nextRuns(64, new Date());
  if (runs.length === 0) {
    throw coded(
      new RangeError(
        `Cron expression "${expression}" never runs in the future`,
      ),
      'ANARCHON_INVALID_ARGUMENT',
    );
  }

  let minGapMs = Infinity;
  let previous: number | undefined;
  for (const run of runs) {
    const time = run.getTime();
    if (previous !== undefined) minGapMs = Math.min(minGapMs, time - previous);
    previous = time;
  }

  return {
    type: 'cron',
    description: `cron "${expression}"${timezone ? ` (${timezone})` : ''}`,
    minGapMs,
    next(after) {
      return cron.nextRun(new Date(after))?.getTime() ?? null;
    },
    prev(atOrBefore) {
      // croner works in whole seconds and returns runs strictly before the time it is given.
      const [previous] = cron.previousRuns(
        1,
        new Date(Math.floor(atOrBefore / 1_000) * 1_000 + 1_000),
      );
      return previous ? previous.getTime() : null;
    },
  };
}
