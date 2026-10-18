/* Copyright (C) 2026-present Aristotelis — see repository license. */

import { coded } from './errors';

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function describeError(value: unknown): string {
  const text = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
  return text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text;
}

export function positiveInt(label: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0)
    throw coded(new RangeError(`${label} must be a positive whole number (got ${value})`), 'ANARCHON_INVALID_ARGUMENT');
  return value;
}

export function nonNegativeInt(label: string, value: number): number {
  if (!Number.isInteger(value) || value < 0)
    throw coded(new RangeError(`${label} must be a whole number >= 0 (got ${value})`), 'ANARCHON_INVALID_ARGUMENT');
  return value;
}

export function intInRange(label: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw coded(new RangeError(`${label} must be a whole number from ${min} to ${max} (got ${value})`), 'ANARCHON_INVALID_ARGUMENT');
  }
  return value;
}

/**
 * Throws on a key of `options` that isn't in `known`, naming the known key it was probably meant to
 * be: options are never silently ignored, including options that come from configuration or
 * JavaScript, which the compiler doesn't check.
 *
 * @param aliases Names users mix up with a known key, e.g. `{ redis: 'valkey' }`.
 * @param hint Appended to the message, e.g. where a setting this object doesn't take goes instead.
 */
export function refuseUnknown(
  label: string,
  options: object | null | undefined,
  known: ReadonlyArray<string>,
  aliases: Readonly<Record<string, string>> = {},
  hint = '',
): void {
  if (options === null || typeof options !== 'object') return;
  const key = Object.keys(options).find((k) => !known.includes(k));
  if (key === undefined) return;
  const meant = aliases[key] ?? closest(key, known);
  throw coded(
    new TypeError(`${label}: unknown option "${key}"${meant ? ` (did you mean "${meant}"?)` : ''}${hint}`),
    'ANARCHON_UNKNOWN_OPTION',
  );
}

/** The known name a misspelled one most likely stands for: same letters in another case, a prefix of it, or a near spelling. */
function closest(key: string, known: ReadonlyArray<string>): string | undefined {
  const lower = key.toLowerCase();
  const prefixed = known.find((k) => k.toLowerCase() === lower || k.toLowerCase().startsWith(lower) || lower.startsWith(k.toLowerCase()));
  if (prefixed) return prefixed;
  let best: { name: string; distance: number } | undefined;
  for (const name of known) {
    const distance = editDistance(lower, name.toLowerCase());
    if (distance <= Math.max(2, Math.floor(key.length / 3)) && (!best || distance < best.distance)) best = { name, distance };
  }
  return best?.name;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** Refuses historyTtlMs on a backend that trims history by count only. */
export function refuseHistoryTtl(backend: string, job: { name: string; historyTtlMs?: number | undefined }): void {
  if (job.historyTtlMs !== undefined) {
    throw coded(
      new TypeError(`Job "${job.name}": historyTtlMs is not supported by ${backend}, which keeps history by count (historySize) only`),
      'ANARCHON_UNSUPPORTED',
    );
  }
}

/** Job names used in queue names and NATS subjects must stay simple. */
export function assertSimpleName(backend: string, name: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw coded(
      new TypeError(`Job "${name}": with ${backend}, job names may only contain letters, digits, "_" and "-"`),
      'ANARCHON_UNSUPPORTED',
    );
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Parses a server version like "3.12.1" or "redis_version:8.6.3" into [major, minor]. */
export function versionAtLeast(version: string, major: number, minor: number): boolean {
  const match = /(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const [maj, min] = [Number(match[1]), Number(match[2])];
  return maj > major || (maj === major && min >= minor);
}
