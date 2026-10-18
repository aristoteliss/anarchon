/* Copyright (C) 2026-present Aristotelis — see repository license. */

/**
 * What kind of problem an error from anarchon is. The code is stable across releases; the message
 * may be reworded, so check the code rather than the text. The error keeps its class (`TypeError`,
 * `RangeError` or `Error`), so `instanceof` checks keep working. New codes may be added.
 *
 * - `ANARCHON_INVALID_ARGUMENT`: a value or argument that can't be used (a number out of range, an
 *   invalid cron expression, a missing backend)
 * - `ANARCHON_UNKNOWN_OPTION`: an option the object doesn't have, often a misspelling
 * - `ANARCHON_UNSUPPORTED`: a valid option the backend or strategy can't honour
 * - `ANARCHON_UNSAFE_JOB`: job settings that could let a late instance run a job twice
 * - `ANARCHON_SERVER`: the server is too old, or lacks a feature the backend needs
 * - `ANARCHON_MISSING_DRIVER`: the driver package for a backend isn't installed
 * - `ANARCHON_STATE`: a call the scheduler's state doesn't allow (runNow() before start())
 * - `ANARCHON_JOB_EXISTS`, `ANARCHON_UNKNOWN_JOB`: a job name that is taken, or not registered
 * - `ANARCHON_SCHEDULER_EXISTS`, `ANARCHON_NO_SCHEDULER`: a scheduler name that is taken, or that
 *   names no scheduler and no settings
 * - `ANARCHON_STORE`: the store refused a write
 * - `ANARCHON_STORE_FORMAT`: the store holds data a newer version of anarchon wrote
 * - `ANARCHON_INTERNAL`: a bug in anarchon; please report it
 *
 * @example
 * ```ts
 * try {
 *   scheduler.every(name, interval, handler, options);
 * } catch (error) {
 *   if (isAnarchonError(error, 'ANARCHON_UNKNOWN_OPTION')) return badRequest(error.message);
 *   throw error;
 * }
 * ```
 */
export type ErrorCode =
  | 'ANARCHON_INVALID_ARGUMENT'
  | 'ANARCHON_UNKNOWN_OPTION'
  | 'ANARCHON_UNSUPPORTED'
  | 'ANARCHON_UNSAFE_JOB'
  | 'ANARCHON_SERVER'
  | 'ANARCHON_MISSING_DRIVER'
  | 'ANARCHON_STATE'
  | 'ANARCHON_JOB_EXISTS'
  | 'ANARCHON_UNKNOWN_JOB'
  | 'ANARCHON_SCHEDULER_EXISTS'
  | 'ANARCHON_NO_SCHEDULER'
  | 'ANARCHON_STORE'
  | 'ANARCHON_STORE_FORMAT'
  | 'ANARCHON_INTERNAL';

/** Gives an error its code; returns the same error, to be thrown. */
export function coded<E extends Error>(error: E, code: ErrorCode): E & { readonly code: ErrorCode } {
  return Object.assign(error, { code });
}

/**
 * Whether an error came from anarchon, optionally with a given code. Narrows the error so its
 * `code` can be read.
 *
 * @example
 * ```ts
 * scheduler.on('error', ({ error }) => {
 *   if (isAnarchonError(error, 'ANARCHON_STORE')) metrics.increment('scheduler.store_refused');
 * });
 * if (isAnarchonError(error)) log.warn(`${error.code}: ${error.message}`);
 * ```
 */
export function isAnarchonError(error: unknown, code?: ErrorCode): error is Error & { readonly code: ErrorCode } {
  if (!(error instanceof Error)) return false;
  const actual = (error as { code?: unknown }).code;
  return typeof actual === 'string' && actual.startsWith('ANARCHON_') && (code === undefined || actual === code);
}
