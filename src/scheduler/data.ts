/* Copyright (C) 2026-present Aristotelis — see repository license. */

import type { JobContext, JobDataProvider } from '../types';

type Run = Omit<JobContext, 'data'>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** More specific data on top of more general data: two plain objects are merged, anything else replaces. */
function merge(general: unknown, specific: unknown): unknown {
  if (specific === undefined) return general;
  return isPlainObject(general) && isPlainObject(specific) ? { ...general, ...specific } : specific;
}

/**
 * The data of one run: every source, from the most general to the most specific, on top of the
 * one before. A source that is a function is called for its value, so it is read when the run starts.
 */
export async function resolveData(sources: readonly unknown[], run: Run): Promise<unknown> {
  let data: unknown;
  for (const source of sources) {
    data = merge(data, typeof source === 'function' ? await (source as JobDataProvider)(run) : source);
  }
  return data;
}

/** Two sources as one, the second on top of the first. */
export function layerData(general: unknown, specific: unknown): unknown {
  if (general === undefined) return specific;
  if (specific === undefined) return general;
  return (run: Run) => resolveData([general, specific], run);
}
