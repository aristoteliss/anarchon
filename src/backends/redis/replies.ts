/* Copyright (C) 2026-present Aristotelis — see repository license. */

import { parseJson, toResult } from '../../history';
import type { StoredResult } from '../../types';

/**
 * Reads Redis/Valkey replies the same way whatever the client or protocol:
 * RESP2 flat arrays, RESP3 objects/Maps, or Valkey GLIDE's `{ key, value }` records.
 */

export interface StreamEntry {
  /** The entry ID, e.g. '1791633610000-0'. */
  id: string;
  /** The entry's field-value pairs as an object. */
  fields: Record<string, string>;
}

export function toStr(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return String(value);
}

function isKeyValue(value: unknown): value is { key: unknown; value: unknown } {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'key' in value &&
    'value' in value
  );
}

/** Turns `[k1, v1, k2, v2]`, `[[k, v], ...]`, `[{ key, value }, ...]`, a Map or an object into an object. */
export function toRecord(reply: unknown): Record<string, unknown> {
  if (Array.isArray(reply)) return fromPairs(toPairs(reply));
  if (reply instanceof Map) return fromPairs(reply);
  if (reply !== null && typeof reply === 'object') {
    return reply as Record<string, unknown>;
  }
  return {};
}

/** The key-value pairs of an array reply, in any of the three layouts clients return. */
function toPairs(reply: unknown[]): Iterable<[unknown, unknown]> {
  const isPairList =
    reply.length > 0 &&
    reply.every((item) => Array.isArray(item) && item.length === 2);
  if (isPairList) return reply as Array<[unknown, unknown]>;

  if (reply.length > 0 && reply.every(isKeyValue)) {
    return reply.map(({ key, value }) => [key, value] as [unknown, unknown]);
  }

  const pairs: Array<[unknown, unknown]> = [];
  for (let i = 0; i + 1 < reply.length; i += 2) {
    const key = reply[i];
    const value = reply[i + 1];
    pairs.push([key, value]);
  }
  return pairs;
}

/** An object of the pairs, each key read as a string. */
function fromPairs(
  pairs: Iterable<[unknown, unknown]>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of pairs) {
    out[toStr(key)] = value;
  }
  return out;
}

/** Parses an XRANGE / XREVRANGE reply. */
export function parseEntries(reply: unknown): StreamEntry[] {
  if (!Array.isArray(reply)) return [];
  return reply.flatMap((item) => toEntry(item) ?? []);
}

/** One entry, as `[id, fields]` or `{ key, value }`; undefined for any other shape. */
function toEntry(item: unknown): StreamEntry | undefined {
  if (Array.isArray(item) && item.length >= 2) {
    const [id, fields] = item;
    return { id: toStr(id), fields: toFields(fields) };
  }
  if (isKeyValue(item)) {
    return { id: toStr(item.key), fields: toFields(item.value) };
  }
  return undefined;
}

/** An entry's field-value pairs, each value read as a string. */
function toFields(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(toRecord(raw))) {
    out[name] = toStr(value);
  }
  return out;
}

/** The results in a ZRANGEBYSCORE reply; members that don't parse are left out. */
export function toResults(members: unknown): StoredResult[] {
  if (!Array.isArray(members)) return [];
  return members.flatMap((member) => {
    const raw = parseJson(toStr(member));
    return toResult(raw) ?? [];
  });
}
