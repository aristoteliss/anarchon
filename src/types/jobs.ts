/* Copyright (C) 2026-present Aristotelis — see repository license. */

/**
 * What a job's handler receives.
 *
 * @example A job that is safe to run again: `slot` is the same on every instance and every attempt
 * ```ts
 * scheduler.every('invoice', '1h', async (ctx) => {
 *   await db.query('INSERT INTO invoice_runs (period) VALUES ($1) ON CONFLICT DO NOTHING', [ctx.slot]);
 *   await buildInvoices({ from: ctx.slot - 3_600_000, to: ctx.slot });
 * });
 * ```
 *
 * @example A long job that stops when asked, so another instance can continue it
 * ```ts
 * scheduler.every('export', '10m', async (ctx) => {
 *   if (ctx.attempt > 1) console.log(`continuing after ${ctx.reason}`); // 'takeover'
 *   for (const page of pages) {
 *     ctx.signal.throwIfAborted();
 *     await exportPage(page, { signal: ctx.signal }); // fetch, pg and many others accept a signal
 *   }
 * });
 * ```
 */
export interface JobContext<Data = unknown> {
  /**
   * The job's name. Useful when one handler serves several jobs.
   *
   * @example
   * ```ts
   * const refresh: JobHandler = (ctx) => cache.refresh(ctx.name.replace('refresh-', ''));
   * scheduler.every('refresh-prices', '1m', refresh).every('refresh-rates', '5m', refresh);
   * ```
   */
  name: string;
  /**
   * When the run was due, in ms since epoch: the same value on every instance and every attempt.
   * Use it as the run's key for idempotent writes, or as the end of the period the run covers.
   *
   * @example
   * ```ts
   * scheduler.every('hourly-totals', '1h', (ctx) => totals.build({ from: ctx.slot - 3_600_000, to: ctx.slot }));
   * ```
   */
  slot: number;
  /** `slot` as a Date: when the run was due, not when it actually started (up to jitterMs later). */
  scheduledAt: Date;
  /**
   * The instance running this job (you): the scheduler's `instanceId`.
   *
   * @example
   * ```ts
   * scheduler.every('sync', '10s', (ctx) => log.info(`sync on ${ctx.instanceId}`));
   * ```
   */
  instanceId: string;
  /**
   * true when started with `runNow()`, for example to skip work that only scheduled runs do.
   *
   * @example
   * ```ts
   * scheduler.cron('digest', '0 8 * * *', async (ctx) => {
   *   const users = ctx.manual ? [await admin()] : await subscribers(); // a manual run is a preview
   *   await sendDigest(users);
   * });
   * ```
   */
  manual: boolean;
  /**
   * The data you gave for this run: the scheduler's `data`, then the job's, then the one passed
   * to `runNow()`, each on top of the one before. `undefined` when none was given. Name its type in
   * your handler: `async (ctx: JobContext<{ tenant: string }>) => ...`.
   *
   * @example
   * ```ts
   * const scheduler = new Scheduler({ backend, data: { db } });
   * scheduler.every('export', '1h', async (ctx: JobContext<{ db: Db; format: string }>) => {
   *   await ctx.data.db.export(ctx.data.format);
   * }, { data: { format: 'csv' } });
   * await scheduler.runNow('export', { format: 'json' }); // this run only
   * ```
   */
  data: Data;
  /**
   * Aborted when `stop()` is called, when the run times out, or (lease backends) when this
   * instance lost the run to a backup because it stopped renewing its lease. Check it before side
   * effects, and pass it to anything that accepts a signal.
   *
   * If the handler throws after `stop()` aborted it (e.g. `ctx.signal.throwIfAborted()`), the run is
   * recorded as 'interrupted' and, on a lease backend, handed to another instance right away.
   * If the handler returns normally, the run counts as finished.
   *
   * @example
   * ```ts
   * scheduler.every('crawl', '15m', async (ctx) => {
   *   for (const url of await queue.next(100)) {
   *     ctx.signal.throwIfAborted(); // stop between items, not in the middle of one
   *     await fetch(url, { signal: ctx.signal });
   *   }
   * }, { timeoutMs: 10 * 60_000 });
   * ```
   */
  signal: AbortSignal;
  /**
   * 1 for the first try; 2, 3... when a backup took over after the previous runner died (lease
   * backends). A later attempt may find part of the work done.
   *
   * @example
   * ```ts
   * scheduler.cron('charge', '0 6 * * *', async (ctx) => {
   *   const pending = ctx.attempt > 1 ? await charges.unpaid(ctx.slot) : await charges.all(ctx.slot);
   *   for (const charge of pending) await charge.pay();
   * });
   * ```
   */
  attempt: number;
  /**
   * Why this run started: 'scheduled', 'manual', 'catch-up' or 'takeover'.
   *
   * @example
   * ```ts
   * scheduler.cron('report', '0 6 * * *', (ctx) => {
   *   if (ctx.reason === 'catch-up') log.info(`report for ${ctx.scheduledAt.toISOString()} runs late, after a restart`);
   * });
   * ```
   */
  reason: RunReason;
}

/**
 * Why a run started:
 * - `scheduled`: it was due.
 * - `manual`: `runNow()` was called.
 * - `catch-up`: it was due while every instance was down, and an instance that started within
 *   `catchUpMs` ran it (lease backends).
 * - `takeover`: its runner died, froze or was stopped, and a backup started the next attempt (lease backends).
 *
 * New values may be added in a minor release: keep a default branch when you switch over them.
 *
 * @example
 * ```ts
 * scheduler.on('start', (e) => {
 *   if (e.reason === 'takeover' || e.reason === 'catch-up') alert(`${e.job} recovered (${e.reason}) on ${e.instanceId}`);
 * });
 * ```
 */
export type RunReason = 'scheduled' | 'manual' | 'catch-up' | 'takeover';

/**
 * The function a job runs. Sync or async. Returning (any value) means success; throwing means
 * failure, or 'interrupted' when `ctx.signal` was aborted by stop() or a takeover first.
 *
 * @example
 * ```ts
 * const sync: JobHandler = async (ctx) => {
 *   await syncCustomers({ signal: ctx.signal });
 * };
 * scheduler.every('sync', '10s', sync);
 * ```
 */
export type JobHandler<Data = unknown> = (ctx: JobContext<Data>) => unknown;

/**
 * Gives a run its data when the run starts, so the value can be read at that moment: a fresh
 * token, the permissions as they are now, a tenant's current settings. It may be async. If it
 * throws, the run fails with that error, like a handler that throws.
 *
 * @example
 * ```ts
 * const freshToken: JobDataProvider = async (run) => ({ token: await auth.tokenFor(run.name) });
 * scheduler.every('pull-orders', '5m', (ctx: JobContext<{ token: string }>) => pull(ctx.data.token), { data: freshToken });
 * ```
 */
export type JobDataProvider = (run: Omit<JobContext, 'data'>) => unknown;

/**
 * Data for a job's runs, handed to the handler as `ctx.data`: a value, or a function that
 * returns it when a run starts. A function is always called; to pass a function as the data, put
 * it in an object.
 *
 * @example
 * ```ts
 * scheduler.every('a', '1h', run, { data: { tenant: 'acme' } });            // a value
 * scheduler.every('b', '1h', run, { data: () => ({ now: settings.get() }) }); // read at each run
 * scheduler.every('c', '1h', run, { data: { notify: sendMail } });          // a function, inside an object
 * ```
 */
export type JobData = object | string | number | boolean | null | JobDataProvider;

/**
 * The job options that need a backend with leases: Redis or Valkey with the 'lease' strategy,
 * PostgreSQL or SQLite. On another backend, `scheduler.every()`, `cron()` and `at()` don't offer
 * them, and a job that sets them anyway (from a decorator or JavaScript) is refused when added.
 *
 * @example
 * ```ts
 * const scheduler = new Scheduler({ backend: new PostgresBackend({ connection: process.env.DATABASE_URL }) });
 * scheduler.cron('charge-cards', '0 6 * * *', charge, { maxAttempts: 1, catchUpMs: 0 }); // never twice, never late
 * scheduler.every('sample', '5s', sample, { overlap: 'allow' });                       // runs may overlap
 * ```
 */
export interface LeaseJobOptions {
  /**
   * What to do when a run is due while the previous one is still running somewhere.
   * 'skip' (default) skips it, with a 'skip' event of reason 'overlap'; skipped runs are not queued.
   * 'allow' runs both.
   *
   * @example
   * ```ts
   * scheduler.every('export', '5m', exportAll);                          // never two exports at once
   * scheduler.every('sample', '5s', sample, { overlap: 'allow' });       // each run stands alone
   * ```
   */
  overlap?: 'skip' | 'allow';
  /**
   * How many times a run may be started when runners die (first try included).
   * 1 = never retried. A hand-over on stop() doesn't count. A run that fails by throwing is not
   * retried either: retries are for runners that died. 1 to 100. Default 3.
   *
   * @example
   * ```ts
   * scheduler.cron('charge-cards', '0 6 * * *', charge, { maxAttempts: 1 }); // never started twice
   * ```
   */
  maxAttempts?: number;
  /**
   * On start, run the latest scheduled run if nobody ran it and it was due at most this
   * many ms ago (it was missed while every instance was down). Only the latest run is caught up,
   * not every missed one. 0 = never. Default 300000 (5 min).
   *
   * @example
   * ```ts
   * scheduler.cron('daily-report', '0 6 * * *', report, { catchUpMs: 6 * 60 * 60_000 }); // up to 6 h late
   * scheduler.every('refresh-cache', '5s', refresh, { catchUpMs: 0 });
   * ```
   */
  catchUpMs?: number;
}

/**
 * Per-job settings, for `cron()`, `every()` and `at()`. Each one falls back to the scheduler's
 * option of the same name, then to the default given here.
 *
 * @example A heavy nightly job: at most 2 h, started at most twice, never two at once
 * ```ts
 * scheduler.cron('rebuild-index', '0 2 * * *', rebuild, {
 *   timeoutMs: 2 * 60 * 60_000,
 *   maxAttempts: 2,
 *   overlap: 'skip',
 * });
 * ```
 *
 * @example A cheap, frequent job where a missed run doesn't matter
 * ```ts
 * scheduler.every('refresh-cache', '5s', refresh, { jitterMs: 0, catchUpMs: 0, historySize: 50 });
 * ```
 *
 * @example A job that must run even if the instances were down when it was due (up to 6 h late)
 * ```ts
 * scheduler.cron('daily-report', '0 6 * * *', report, { catchUpMs: 6 * 60 * 60_000 });
 * ```
 */
export interface JobOptions extends LeaseJobOptions {
  /**
   * Each instance waits a random 0..jitterMs before trying to claim a run, so a random instance
   * wins each time and the work is spread. 0 = no spreading: the instance with the fastest clock
   * and connection wins every time. Must be under half the time between runs.
   * Default: the scheduler's `jitterMs` (2000), or a quarter of the time between runs if smaller.
   *
   * @example
   * ```ts
   * scheduler.cron('nightly', '0 2 * * *', run, { jitterMs: 30_000 }); // starts between 02:00:00 and 02:00:30
   * scheduler.every('precise', '1m', run, { jitterMs: 0 });            // starts on the minute
   * ```
   */
  jitterMs?: number;
  /**
   * An instance that reaches a run later than this (ms after its scheduled time) skips it, with a
   * 'skip' event of reason 'late'. This is what stops a process that was frozen for minutes (a
   * suspended laptop, a long GC pause) from starting a stale run when it wakes up. Must be bigger
   * than jitterMs. Default: the scheduler's `maxLateMs` (60000).
   *
   * @example
   * ```ts
   * scheduler.every('quote-refresh', '30s', refresh, { maxLateMs: 10_000 });
   * ```
   */
  maxLateMs?: number;
  /**
   * About how many runs to keep in history for this job. Default: the scheduler's `historySize` (1000).
   *
   * @example
   * ```ts
   * scheduler.every('heartbeat', '5s', ping, { historySize: 100 });
   * ```
   */
  historySize?: number;
  /**
   * Also drop history older than this (ms), like SyncedCron's collectionTTL. Default: keep by count only.
   *
   * @example
   * ```ts
   * scheduler.cron('audit', '0 * * * *', audit, { historyTtlMs: 30 * 24 * 60 * 60_000 }); // 30 days
   * ```
   */
  historyTtlMs?: number;
  /**
   * Data for this job's runs, handed to the handler as `ctx.data`: what the job needs and can't
   * take from its surroundings, such as the permission it runs with or the user it runs for. It
   * goes on top of the scheduler's `data`: two plain objects are merged, with this job's keys
   * winning, and any other value replaces the scheduler's.
   *
   * @example
   * ```ts
   * scheduler.every('export', '1h', exportData, { data: { permission: 'reports:export' } });
   * scheduler.every('sync', '5m', sync, { data: async () => ({ token: await freshToken() }) }); // read at each run
   * ```
   */
  data?: JobData;
  /**
   * Aborts ctx.signal and marks the run failed (error `TimeoutError`) after this many ms. The
   * handler itself is not killed: it should watch `ctx.signal`. Set it on jobs that can hang, since
   * with overlap 'skip' a hung run blocks every later run of the job. Default: no limit.
   *
   * @example
   * ```ts
   * scheduler.every('export', '5m', (ctx) => exportAll({ signal: ctx.signal }), { timeoutMs: 4 * 60_000 });
   * ```
   */
  timeoutMs?: number;
}

/**
 * Options of `cron()`.
 *
 * @example
 * ```ts
 * scheduler.cron('open-market', '30 9 * * 1-5', open, { timezone: 'America/New_York' });
 * ```
 */
export interface CronJobOptions extends JobOptions {
  /**
   * IANA time zone for this cron expression, e.g. 'Europe/Athens'. Defaults to the scheduler's
   * `timezone`, then to the server's local zone. Daylight-saving changes are followed: '0 8 * * *'
   * stays 08:00 local time all year.
   *
   * @example
   * ```ts
   * scheduler.cron('open-market', '30 9 * * 1-5', open, { timezone: 'America/New_York' });
   * scheduler.cron('utc-midnight', '0 0 * * *', rollOver, { timezone: 'UTC' });
   * ```
   */
  timezone?: string;
}

/**
 * Options of `every()`.
 *
 * @example Two hourly jobs that should not start together
 * ```ts
 * scheduler.every('a', '1h', runA);                              // 00:00, 01:00, ...
 * scheduler.every('b', '1h', runB, { offsetMs: 30 * 60_000 });   // 00:30, 01:30, ...
 * ```
 */
export interface EveryJobOptions extends JobOptions {
  /**
   * Shifts the interval grid (ms). With 0, runs fall on multiples of the interval since 1970 UTC:
   * `'10s'` runs at :00, :10, :20; `'1h'` on the hour. Must be the same on every instance.
   *
   * @example
   * ```ts
   * scheduler.every('invoices', '1h', build, { offsetMs: 30 * 60_000 }); // 00:30, 01:30, ...
   * scheduler.every('daily', '1d', run, { offsetMs: 3 * 60 * 60_000 });  // 03:00 UTC every day
   * ```
   */
  offsetMs?: number;
}

/**
 * Options of `at()`: a one-off job has no previous run to overlap, so no `overlap`.
 *
 * @example
 * ```ts
 * scheduler.at('migrate-2026-12', '2026-12-01T03:00:00Z', migrate, { timeoutMs: 60 * 60_000, maxAttempts: 1 });
 * ```
 */
export type AtJobOptions = Omit<JobOptions, 'overlap'>;
