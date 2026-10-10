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
  return value !== null && typeof value === 'object' && !Array.isArray(value) && 'key' in value && 'value' in value;
}

/** Turns `[k1, v1, k2, v2]`, `[[k, v], ...]`, `[{ key, value }, ...]`, a Map or an object into an object. */
export function toRecord(reply: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (Array.isArray(reply)) {
    if (reply.length > 0 && reply.every((item) => Array.isArray(item) && item.length === 2)) {
      for (const [k, v] of reply as Array<[unknown, unknown]>) out[toStr(k)] = v;
    } else if (reply.length > 0 && reply.every(isKeyValue)) {
      for (const { key, value } of reply as Array<{ key: unknown; value: unknown }>) out[toStr(key)] = value;
    } else {
      for (let i = 0; i + 1 < reply.length; i += 2) out[toStr(reply[i])] = reply[i + 1];
    }
    return out;
  }
  if (reply instanceof Map) {
    for (const [k, v] of reply) out[toStr(k)] = v;
    return out;
  }
  if (reply !== null && typeof reply === 'object') return reply as Record<string, unknown>;
  return out;
}

/** Parses an XRANGE / XREVRANGE reply. */
export function parseEntries(reply: unknown): StreamEntry[] {
  if (!Array.isArray(reply)) return [];
  const entries: StreamEntry[] = [];
  for (const item of reply) {
    let id: unknown;
    let rawFields: unknown;
    if (Array.isArray(item) && item.length >= 2) [id, rawFields] = item;
    else if (isKeyValue(item)) [id, rawFields] = [item.key, item.value];
    else continue;
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(toRecord(rawFields))) fields[k] = toStr(v);
    entries.push({ id: toStr(id), fields });
  }
  return entries;
}
