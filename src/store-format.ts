/* Copyright (C) 2026-present Aristotelis — see repository license. */

import { coded } from './errors';

/**
 * The version of the data layout the Redis, Valkey and SQL backends write. It goes up only for a
 * change that an older version of anarchon can't read or would damage; added fields don't raise it,
 * since every version keeps the fields it doesn't know.
 */
export const STORE_FORMAT = 1;

/** Throws when the store holds data in a newer format than this version of anarchon reads. */
export function checkStoreFormat(found: unknown, where: string): void {
  const version = Number(found);

  if (Number.isInteger(version) && version > STORE_FORMAT) {
    throw coded(
      new Error(
        `${where} holds data in store format ${version}, newer than this version of anarchon reads (${STORE_FORMAT}). ` +
          'Run the same anarchon version on every instance.',
      ),
      'ANARCHON_STORE_FORMAT',
    );
  }
}
