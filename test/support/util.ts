/* Copyright (C) 2026-present Aristotelis — see repository license. */

import { randomBytes } from 'node:crypto';

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Unique per test, so tests never share keys, tables, queues or subjects. */
export function uniqueId(label: string): string {
  return `${label}${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
}
