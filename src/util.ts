/* Copyright (C) 2026-present Aristotelis — see repository license. */

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function describeError(value: unknown): string {
  const text = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
  return text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text;
}

export function positiveInt(label: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive whole number (got ${value})`);
  return value;
}

export function nonNegativeInt(label: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${label} must be a whole number >= 0 (got ${value})`);
  return value;
}

export function intInRange(label: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} must be a whole number from ${min} to ${max} (got ${value})`);
  }
  return value;
}

/** Job names used in queue names and NATS subjects must stay simple. */
export function assertSimpleName(backend: string, name: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new TypeError(`Job "${name}": with ${backend}, job names may only contain letters, digits, "_" and "-"`);
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
