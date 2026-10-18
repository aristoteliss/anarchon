/* Copyright (C) 2026-present Aristotelis — see repository license. */

/**
 * The claim strategies of the key-value backends, by server: how the backend makes sure each run has
 * exactly one runner.
 * - `lease` (default; Redis 5+, Valkey): one atomic script claims the run and gives the winner a lease
 *   it renews while the job runs. Adds: no overlapping runs, backup runners when the winner dies or
 *   freezes, catch-up of a run missed while every instance was down, and retries.
 * - `stream-id` (Redis 5+, Valkey): XADD with the run time as the entry ID; the server refuses an ID
 *   that is not bigger than the last one, so only the first instance succeeds.
 * - `idmp` (Redis 8.6+ only): XADD with `IDMP <job> <run time>`; the server keeps the first entry and
 *   ignores repeats.
 * - `script` (Redis 5+, Valkey): a small Lua script does what IDMP does, on any version: it appends
 *   the run only if that run time isn't already in the stream.
 *
 * Only `lease` adds the extras; the other three only decide who runs each time. The database and
 * broker backends have no strategy to choose: PostgreSQL and SQLite always follow the `lease` rules,
 * and RabbitMQ and NATS always make a simple claim.
 *
 * @example Pick a strategy from configuration (ValkeyBackend refuses an unsupported one when created)
 * ```ts
 * const name = (process.env.CRON_STRATEGY ?? 'lease') as KeyValueStrategies['valkey'];
 * new ValkeyBackend({ valkey: process.env.VALKEY_URL, strategy: name });
 * ```
 */
export interface KeyValueStrategies {
  /**
   * The strategies of `RedisBackend`. 'idmp' needs Redis 8.6+; the others Redis 5+.
   *
   * @example
   * ```ts
   * new RedisBackend({ strategy: 'lease' }); // the default: backups, no overlap, catch-up, retries
   * new RedisBackend({ strategy: { name: 'idmp', durationSec: 900 } }); // Redis 8.6+, one winner per run
   * ```
   */
  redis: 'lease' | 'stream-id' | 'idmp' | 'script';
  /**
   * The strategies of `ValkeyBackend`: Valkey has no idempotent XADD, so no 'idmp'.
   *
   * @example
   * ```ts
   * new ValkeyBackend({ valkey: process.env.VALKEY_URL, strategy: { name: 'script', windowMs: 600_000 } });
   * ```
   */
  valkey: 'lease' | 'stream-id' | 'script';
}

/**
 * The name of a strategy one key-value server supports (see {@link KeyValueStrategies}).
 *
 * @example
 * ```ts
 * const name: KeyValueStrategyName<'valkey'> = 'idmp'; // type error: Valkey has no 'idmp'
 * ```
 */
export type KeyValueStrategyName<Server extends keyof KeyValueStrategies = 'redis'> = KeyValueStrategies[Server];

type StrategySettings<Name> = Name extends 'idmp' ? IdmpOptions : Name extends 'script' ? ScriptOptions : unknown;

/**
 * The `strategy` option of `RedisBackend` and `ValkeyBackend`: a strategy's name, or an object with
 * its name and the settings of that strategy only ('idmp' and 'script' have settings).
 *
 * @example
 * ```ts
 * const plain: KeyValueStrategy = 'stream-id';
 * const tuned: KeyValueStrategy = { name: 'script', windowMs: 10 * 60_000 };
 * const wrong: KeyValueStrategy = { name: 'lease', windowMs: 1 }; // type error: 'lease' has no windowMs
 * ```
 */
export type KeyValueStrategy<Name extends string = KeyValueStrategyName> = {
  [N in Name]: N | ({ name: N } & StrategySettings<N>);
}[Name];

/**
 * Where the scheduler writes its own messages. `console` fits, and so do pino and winston loggers.
 *
 * @example
 * ```ts
 * new Scheduler({ backend, logger: pino(), log: true });
 * new Scheduler({ backend, logger: winston.createLogger({ transports: [new winston.transports.Console()] }) });
 * new Scheduler({ backend, logger: { warn: (m) => myLog('warn', m), error: (m) => myLog('error', m) } });
 * ```
 *
 * @example A NestJS logger
 * ```ts
 * const nest = new Logger('anarchon');
 * new Scheduler({ backend, logger: { info: (m) => nest.log(m), warn: (m) => nest.warn(m), error: (m, e) => nest.error(m, e) } });
 * ```
 */
export interface Logger {
  /**
   * Run messages of `log: true` (started, finished, skipped). Falls back to console.log when missing.
   *
   * @example
   * ```ts
   * // [anarchon] sync @ 2026-10-10T12:00:10.000Z: started on api-2 (attempt 1, scheduled)
   * ```
   */
  info?(message: string, ...meta: unknown[]): void;
  /**
   * Failed and lost runs (with `log: true`), and problems while closing the backend.
   *
   * @example
   * ```ts
   * // [anarchon] sync @ 2026-10-10T12:00:10.000Z: failed after 203 ms: Error: timeout
   * ```
   */
  warn(message: string, ...meta: unknown[]): void;
  /**
   * 'error' events nobody listens for, and listeners that throw. The error is the second argument.
   *
   * @example
   * ```ts
   * // logger.error('[anarchon] error in sync', new Error('connection refused'))
   * ```
   */
  error(message: string, ...meta: unknown[]): void;
}

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

/**
 * Settings of the Redis 'idmp' strategy (Redis 8.6+).
 *
 * @example A job with jitterMs 5 s and maxLateMs 10 min needs Redis to remember runs for longer than that
 * ```ts
 * new RedisBackend({ strategy: { name: 'idmp', durationSec: 900 } });
 * ```
 */
export interface IdmpOptions {
  /**
   * How long Redis remembers a run's ID (seconds, 1-86400). Must be longer than
   * jitterMs + maxLateMs + any clock difference between your instances. Default 300.
   *
   * @example
   * ```ts
   * new Scheduler({ backend: new RedisBackend({ strategy: { name: 'idmp', durationSec: 900 } }), maxLateMs: 600_000 });
   * ```
   */
  durationSec?: number;
  /**
   * How many run IDs Redis keeps per job (1-10000). Together with the time between runs it must
   * cover jitterMs + maxLateMs: a job every second with maxSize 50 is remembered for 50 s. Default 1000.
   *
   * @example
   * ```ts
   * new RedisBackend({ strategy: { name: 'idmp', maxSize: 5_000 } });
   * ```
   */
  maxSize?: number;
}

/**
 * Settings of the Redis/Valkey 'script' strategy.
 *
 * @example
 * ```ts
 * new RedisBackend({ strategy: { name: 'script', windowMs: 10 * 60_000 } });
 * ```
 */
export interface ScriptOptions {
  /**
   * How long a claimed run is remembered (ms). Must be longer than a job's jitterMs + maxLateMs, or
   * a late instance could run it again. Default 300000 (5 min).
   *
   * @example Instances that may reach a run up to 10 min late
   * ```ts
   * const backend = new RedisBackend({ strategy: { name: 'script', windowMs: 15 * 60_000 } });
   * new Scheduler({ backend, maxLateMs: 10 * 60_000 });
   * ```
   */
  windowMs?: number;
}

// ------------------------------------------------------------------ backend contract

/**
 * What a lease-capable backend answers when asked to claim a run. Exactly one instance gets 'won'
 * for each attempt of a run; what the scheduler does with each answer is in `LeaseRunner.run()`.
 *
 * @example How a custom RunStore decides, in outline
 * ```ts
 * async claim(input: RunClaim): Promise<ClaimOutcome> {
 *   const run = await this.load(input.job, input.slot);
 *   if (!run) return input.mode === 'takeover' ? { kind: 'none' } : this.start(input, 1); // { kind: 'won', attempt: 1 }
 *   if (run.finished) return { kind: 'done' };
 *   if (run.leaseEnd > now) return { kind: 'running', attempt: run.attempt };
 *   return run.attempt < run.maxAttempts ? this.start(input, run.attempt + 1) : { kind: 'done' };
 * }
 * ```
 */
export type ClaimOutcome =
  | { kind: 'won'; attempt: number }
  /** Someone alive is running it. */
  | { kind: 'running'; attempt: number }
  /** Finished, or given up after maxAttempts. */
  | { kind: 'done' }
  /** Another run of the same job is still running (overlap 'skip'). */
  | { kind: 'overlap'; slot: number }
  /** A takeover was asked for a run nobody ever claimed. */
  | { kind: 'none' }
  /** A new run was asked for more than maxLateMs after its slot, by the server's clock. */
  | { kind: 'late'; lateMs: number };

/**
 * A claim on a lease backend: {@link ClaimInput} plus what the store needs to decide it on its own,
 * atomically: the lease to give, the overlap rule, the attempt limit and how late is too late.
 *
 * @example What the scheduler sends for a due run
 * ```ts
 * await runs.claim({
 *   job: 'report', slot: 1791633600000, token: randomUUID(), instanceId: 'api-1', historySize: 1000,
 *   mode: 'new', reason: 'scheduled', leaseMs: 30_000, overlap: 'skip', maxAttempts: 3, maxLateMs: 61_000, keepMs: 301_000,
 * });
 * ```
 */
export interface RunClaim extends ClaimInput {
  /** 'new': a run that is due. 'takeover': a run whose runner stopped renewing its lease. */
  mode: 'new' | 'takeover';
  /** Stored with the attempt and shown in history. */
  reason: RunReason;
  /** The lease given to the winner: it ends this long after the claim, on the server's clock. */
  leaseMs: number;
  /** 'skip': answer 'overlap' when an earlier run of the job has a live lease. 'allow': ignore other runs. */
  overlap: 'skip' | 'allow';
  /** Stored with the run on its first claim; later attempts are checked against the stored value. */
  maxAttempts: number;
  /**
   * Refuse to start a new run more than this many ms after its slot, by the server's clock (0 or
   * missing: no limit). Stops claims that were delayed or queued (e.g. during an outage) from
   * starting a stale run.
   */
  maxLateMs?: number;
  /**
   * Never forget a run younger than this (ms, server clock), even beyond historySize. Must cover
   * maxLateMs of every claim, so a run that is forgotten can never be claimed again.
   */
  keepMs?: number;
}

/**
 * Optional backend capability: runs with leases. The winner renews its lease while the job runs;
 * when a lease runs out before the run is finished, a backup can claim the next attempt. A backend
 * that sets `runs` gets backups, no overlap, catch-up and retries, and the lease options.
 *
 * @example A custom backend with leases
 * ```ts
 * class MyBackend implements Backend {
 *   readonly runs: RunStore = new MyRunStore(this.db); // claim, heartbeat, finish, release, active
 *   // ...the rest of Backend
 * }
 * ```
 */
export interface RunStore {
  /** Decides one claim atomically. Exactly one caller gets 'won' for each attempt of a run. */
  claim(input: RunClaim): Promise<ClaimOutcome>;
  /** Renews the lease. false: the run is no longer ours (a backup took it over). */
  heartbeat(job: string, slot: number, token: string, leaseMs: number): Promise<boolean>;
  /** Marks the run finished. false: the run is no longer ours. */
  finish(job: string, slot: number, token: string, status: 'success' | 'failed' | 'interrupted'): Promise<boolean>;
  /**
   * Gives an unfinished run up so a backup can take it over now (graceful shutdown). This doesn't
   * count against maxAttempts. false: the run is no longer ours.
   */
  release(job: string, slot: number, token: string): Promise<boolean>;
  /** Runs of this job not finished yet, and whether their lease is still alive. */
  active(job: string): Promise<Array<{ slot: number; attempt: number; alive: boolean }>>;
}

/**
 * What a backend stores when an instance claims a run.
 *
 * @example A claim a custom backend receives
 * ```ts
 * { job: 'sync', slot: 1791633610000, token: '4f1c…', instanceId: 'api-2', historySize: 1000 }
 * ```
 */
export interface ClaimInput extends RunKey {
  /** Random value unique to this attempt: lets an instance recognize its own claim after a retry. */
  token: string;
  /** Who is claiming. Shown in history as the runner. */
  instanceId: string;
  /** About how many runs of the job to keep; the backend trims older ones on a claim. */
  historySize: number;
  /** Drop history entries older than this (ms). */
  historyTtlMs?: number;
}

/**
 * What the winner stores when a run ends. `history()` joins it with the claim into a RunRecord.
 *
 * @example
 * ```ts
 * { slot: 1791633610000, by: 'api-2', attempt: 1, status: 'failed', startedAt: 1791633610412,
 *   finishedAt: 1791633610615, durationMs: 203, error: 'Error: upstream timeout' }
 * ```
 */
export interface StoredResult {
  /** The run's scheduled time (ms). */
  slot: number;
  /** The instance that ran this attempt. */
  by: string;
  /** Which attempt this result belongs to. Missing means 1. */
  attempt?: number;
  /** How the attempt ended. ('running' is never stored: it is a claim without a result.) */
  status: 'success' | 'failed' | 'interrupted';
  /** When the handler was called (ms since epoch, the instance's clock). */
  startedAt: number;
  /** When the handler ended (ms since epoch, the instance's clock). */
  finishedAt: number;
  /** finishedAt - startedAt. */
  durationMs: number;
  /** What the handler threw, as `Name: message`, cut at 2000 characters. */
  error?: string;
}

/**
 * A job's settings that a backend may need to refuse it, passed to `checkJob()` when the job is
 * added: its name, how late its claims can come, and how much history it keeps.
 *
 * @example A backend that remembers runs for 5 minutes
 * ```ts
 * checkJob(job: JobLimits) {
 *   if (job.jitterMs + job.maxLateMs >= 300_000) throw new RangeError(`Job "${job.name}": claims can come too late for this store`);
 * }
 * ```
 */
export interface JobLimits {
  /** The job's name, for error messages and for backends that restrict names. */
  name: string;
  /** The job's jitter after defaults were applied. */
  jitterMs: number;
  /** The job's lateness limit after defaults were applied. With jitterMs: the latest a claim is sent. */
  maxLateMs: number;
  /** Smallest gap between two runs of the job (ms). */
  minGapMs: number;
  /** How many runs the job keeps: a limit on memory for backends that find claimed runs in history. */
  historySize: number;
  /** How long the job keeps history, if limited. */
  historyTtlMs?: number;
}

/**
 * Where runs are claimed and recorded. Every backend gives the same guarantee: for one slot,
 * `claim()` returns true for exactly one instance.
 *
 * The built-in backends get that from one atomic operation of their store; each class explains its
 * own: {@link RedisBackend} (a script or XADD), {@link PostgresBackend} and {@link SqliteBackend}
 * (one transaction on the run's row), {@link RabbitMQBackend} (a queue of length 1 with publisher
 * confirms), {@link NatsBackend} (JetStream message de-duplication).
 *
 * @example The idea, as a backend for tests: one process, so a Map is atomic enough
 * ```ts
 * class MemoryBackend implements Backend {
 *   readonly name = 'memory';
 *   readonly dedupeWindowMs = Infinity;
 *   private claims = new Map<string, ClaimInput>();
 *   private results: StoredResult[] = [];
 *   async init() {}
 *   async prepareJob() {}
 *   async claim(input: ClaimInput) {
 *     const key = `${input.job}:${input.slot}`;
 *     const first = this.claims.get(key) ?? input; // whoever asked first holds the run
 *     this.claims.set(key, first);
 *     return first.token === input.token;
 *   }
 *   async recordManualRun(input: ClaimInput) {
 *     this.claims.set(`${input.job}:${input.slot}:manual`, input);
 *   }
 *   async saveResult(_job: string, result: StoredResult) {
 *     this.results.push(result);
 *   }
 *   async history() {
 *     return [];
 *   }
 *   async close() {}
 * }
 * new Scheduler({ backend: new MemoryBackend() });
 * ```
 */
export interface Backend {
  /**
   * Which backend and strategy, for logs and error messages: 'redis:lease', 'valkey:script',
   * 'postgres', 'sqlite', 'rabbitmq', 'nats'.
   *
   * @example
   * ```ts
   * log.info(`scheduler on ${scheduler.backend.name}`); // 'scheduler on postgres'
   * ```
   */
  readonly name: string;
  /**
   * How long the backend remembers that a run was claimed (ms). Infinity means forever.
   * jitterMs + maxLateMs of every job must be shorter than this, which the scheduler checks when a
   * job is added.
   *
   * @example
   * ```ts
   * new RedisBackend({ strategy: { name: 'script', windowMs: 600_000 } }).dedupeWindowMs; // 600000
   * new PostgresBackend().dedupeWindowMs;                                               // Infinity
   * ```
   */
  readonly dedupeWindowMs: number;
  /**
   * Throws if a job can't run safely on this backend (name, limits, options it can't honour).
   * Called when the job is added, so a bad job fails at once instead of at its first run.
   *
   * @example
   * ```ts
   * checkJob(job: JobLimits) {
   *   if (!/^[a-z0-9-]+$/.test(job.name)) throw new TypeError(`Job "${job.name}": lowercase names only on this backend`);
   * }
   * ```
   */
  checkJob?(job: JobLimits): void;
  /** Connects and checks the server. Called by start() and before reads. */
  init(): Promise<void>;
  /** One-time setup for a job (streams, queues). */
  prepareJob(job: string, historySize: number): Promise<void>;
  /** True for exactly one instance per slot. Safe to repeat with the same token. */
  claim(input: ClaimInput): Promise<boolean>;
  /** Called after a won claim, for backends whose claim isn't already a history record. */
  recordClaim?(input: ClaimInput): Promise<void>;
  /** Records a manual run (runNow), not deduplicated. May return the slot it actually used. */
  recordManualRun(input: ClaimInput): Promise<number | undefined>;
  /** Stores how an attempt ended, and trims the job's history to historySize and historyTtlMs. */
  saveResult(job: string, result: StoredResult, historySize: number, historyTtlMs?: number): Promise<void>;
  /**
   * Latest runs of a job from all instances, newest first, at most `limit` attempts. What
   * `scheduler.history()` and `lastRun()` return.
   *
   * @example
   * ```ts
   * const [latest] = await backend.history('report', 1);
   * ```
   */
  history(job: string, limit: number): Promise<RunRecord[]>;
  /** Present when the backend supports leases (see RunStore). */
  readonly runs?: RunStore;
  /** Closes connections the backend opened itself. */
  close(): Promise<void>;
}

// ------------------------------------------------------------------ scheduler

interface CommonSchedulerOptions<B extends Backend> {
  /**
   * A name for this scheduler, unique in the process. Jobs declared with decorators choose a
   * scheduler by it: `@Cron('close', '0 6 1 * *', { scheduler: 'billing' })`. A scheduler without a
   * name can be the default one, which takes the decorated jobs that name none.
   *
   * @example
   * ```ts
   * new Scheduler({ name: 'billing', backend: new PostgresBackend({ connection: pool }) });
   * ```
   */
  name?: string;
  /**
   * Data for the runs of every job of this scheduler, handed to each handler as `ctx.data`: a
   * value, or a function called when a run starts. A job's own `data` goes on top of it, and
   * `setData()` replaces it while the scheduler runs.
   *
   * @example
   * ```ts
   * new Scheduler({ backend, data: { tenant: 'acme', db } });
   * new Scheduler({ backend, data: async (run) => ({ permissions: await permissionsFor(run.name) }) });
   * ```
   */
  data?: JobData;
  /**
   * Where runs are claimed and recorded. stop() closes it, which closes only the connections the
   * backend opened itself, never a client you passed to it.
   *
   * @example
   * ```ts
   * new Scheduler({ backend: new RedisBackend({ redis: process.env.REDIS_URL }) });
   * new Scheduler({ backend: new RedisBackend({ redis: process.env.REDIS_URL, prefix: 'billing:cron:' }) });
   * new Scheduler({ backend: new PostgresBackend({ connection: process.env.DATABASE_URL }) });
   * new Scheduler({ backend: new SqliteBackend({ database: './jobs.db' }) });
   * ```
   */
  backend: B;
  /**
   * Name of this instance in history and events. Must differ between instances, or history can't
   * tell them apart. Default `${hostname}:${pid}`; a pod name or host name reads better.
   *
   * @example
   * ```ts
   * new Scheduler({ backend, instanceId: process.env.POD_NAME }); // 'billing-7d9f8c-x2x4q'
   * new Scheduler({ backend, instanceId: `api-${process.env.PORT}` });
   * ```
   */
  instanceId?: string;
  /**
   * Default jitter for all jobs (ms): each instance waits a random 0..jitterMs after a run is due
   * before claiming it, which spreads the work. Default 2000, lowered automatically to a quarter of
   * the interval for short intervals. A job's own `jitterMs` overrides it.
   *
   * @example
   * ```ts
   * new Scheduler({ backend, jitterMs: 500 }); // runs start within half a second of their time
   * new Scheduler({ backend, jitterMs: 0 });   // on the dot; the fastest instance always wins
   * ```
   */
  jitterMs?: number;
  /**
   * Default maxLateMs for all jobs: an instance that reaches a run later than this skips it, so a
   * process that was frozen doesn't start stale runs when it wakes. Default 60000.
   *
   * @example
   * ```ts
   * new Scheduler({ backend, maxLateMs: 10_000 }); // a run that can't start within 10 s is dropped
   * ```
   */
  maxLateMs?: number;
  /**
   * Default history size per job: about how many runs `history()` can return. Default 1000.
   *
   * @example
   * ```ts
   * new Scheduler({ backend, historySize: 200 });
   * ```
   */
  historySize?: number;
  /**
   * Default history age limit per job (ms): records older than this are dropped as well.
   * Default: none (keep by count only).
   *
   * @example
   * ```ts
   * new Scheduler({ backend, historyTtlMs: 7 * 24 * 60 * 60_000 }); // one week
   * ```
   */
  historyTtlMs?: number;
  /**
   * Log every start, success, failure, interruption, skip and lost run through `logger`, one line
   * each (like SyncedCron's `log`). Default false.
   *
   * @example
   * ```ts
   * new Scheduler({ backend, log: true });
   * // [anarchon] sync @ 2026-10-10T12:00:10.000Z: started on api-2 (attempt 1, scheduled)
   * // [anarchon] sync @ 2026-10-10T12:00:10.000Z: finished in 203 ms
   * ```
   */
  log?: boolean;
  /**
   * Default IANA time zone for cron jobs, e.g. 'Europe/Athens' or 'UTC'. Set it: the default is the
   * server's local time zone, which can differ between machines. `every()` ignores it (UTC grid).
   *
   * @example
   * ```ts
   * const scheduler = new Scheduler({ backend, timezone: 'Europe/Athens' });
   * scheduler.cron('digest', '0 8 * * *', sendDigest); // 08:00 in Athens, summer and winter
   * ```
   */
  timezone?: string;
  /**
   * Where to log 'error' events nobody listens for, and the run messages of `log: true`.
   * Needs `warn` and `error`; `info` is optional. Default `console`.
   *
   * @example
   * ```ts
   * new Scheduler({ backend, logger: pino() });
   * new Scheduler({ backend, logger: { warn: (m) => log('warn', m), error: (m) => log('error', m) } });
   * ```
   */
  logger?: Logger;
  /**
   * If true, the scheduler's timers don't keep the process alive: it exits when nothing else is
   * pending. For scripts and tests. Default false.
   *
   * @example
   * ```ts
   * new Scheduler({ backend, unrefTimers: true });
   * ```
   */
  unrefTimers?: boolean;
}

/**
 * The scheduler options that need a backend with leases: Redis or Valkey with the 'lease' strategy,
 * PostgreSQL or SQLite. `new Scheduler()` doesn't offer them with another backend, and refuses them
 * when they are set anyway.
 *
 * @example
 * ```ts
 * new Scheduler({ backend: new SqliteBackend({ database: './jobs.db' }), leaseMs: 10_000, heartbeatMs: 2_000 });
 * new Scheduler({ backend: new NatsBackend(), leaseMs: 10_000 }); // type error: NATS has no leases
 * ```
 */
export interface LeaseSchedulerOptions {
  /**
   * A running job's lease lasts this long and is renewed every heartbeatMs. A runner
   * that stops renewing (crash, freeze, lost network) loses the run to a backup about leaseMs later
   * (at most leaseMs + 2 × heartbeatMs). Default 30000.
   *
   * Shorter means faster takeover; longer tolerates longer pauses of a healthy runner.
   *
   * @example
   * ```ts
   * new Scheduler({ backend, leaseMs: 10_000 });  // a dead runner is replaced within about 13 s
   * new Scheduler({ backend, leaseMs: 120_000 }); // survives two minutes without the store
   * ```
   */
  leaseMs?: number;
  /**
   * How often a running job renews its lease, and how often backups check on it
   * (every 1 to 2 heartbeats). Must be under half of leaseMs. Default 5000, or leaseMs / 6 if smaller.
   *
   * @example
   * ```ts
   * new Scheduler({ backend, leaseMs: 6_000, heartbeatMs: 1_000 });
   * ```
   */
  heartbeatMs?: number;
}

/**
 * True when backend type B has no leases (no `runs`): RabbitMQ, NATS, and Redis or Valkey with a
 * strategy other than 'lease'. A backend typed only as `Backend` may have them.
 */
type HasNoLeases<B> = 'runs' extends keyof B ? (B[keyof B & 'runs'] extends undefined ? true : false) : true;

/**
 * Options of `new Scheduler()`. `backend` is required: no store is assumed.
 * Give every instance of a service the same options, apart from `instanceId`.
 *
 * @example Production-style setup on Redis
 * ```ts
 * new Scheduler({
 *   backend: new RedisBackend({ redis: process.env.REDIS_URL, prefix: 'billing:cron:' }), // this service's own keys
 *   instanceId: process.env.POD_NAME, // readable names in history
 *   timezone: 'Europe/Athens',       // for cron expressions
 *   logger: pino(),
 *   log: true,
 * });
 * ```
 *
 * @example Quick failover for short jobs, slow and steady for long ones
 * ```ts
 * new Scheduler({ backend, leaseMs: 6_000, heartbeatMs: 1_000 });   // a dead runner is replaced within ~8 s
 * new Scheduler({ backend, leaseMs: 120_000 });                    // tolerates 2 min of lost network
 * ```
 *
 * @example In tests and scripts: don't let the scheduler keep the process alive
 * ```ts
 * new Scheduler({ backend: new SqliteBackend({ database: ':memory:' }), unrefTimers: true });
 * ```
 */
export type SchedulerOptions<B extends Backend = Backend> = CommonSchedulerOptions<B> &
  (HasNoLeases<B> extends true ? unknown : LeaseSchedulerOptions);

/**
 * The options a job takes on a scheduler with backend B: `Options` without {@link LeaseJobOptions}
 * when B has no leases.
 *
 * @example
 * ```ts
 * type OnRabbit = JobOptionsFor<RabbitMQBackend>; // no overlap, maxAttempts or catchUpMs
 * ```
 */
export type JobOptionsFor<B, Options extends AtJobOptions = JobOptions> =
  HasNoLeases<B> extends true ? Omit<Options, keyof LeaseJobOptions> : Options;

/**
 * Which run something is about: a job and one of its scheduled times. Every run event, history
 * record and claim carries it.
 *
 * @example Tell runs apart in logs and metrics
 * ```ts
 * const runId = ({ job, slot }: RunKey) => `${job}@${new Date(slot).toISOString()}`;
 * scheduler.on('start', (e) => log.info(`started ${runId(e)}`));
 * scheduler.on('skip', (e) => metrics.increment('skipped', { run: runId(e), reason: e.reason }));
 * ```
 */
export interface RunKey {
  /** The job's name, as given to `every()`, `cron()`, `at()` or a decorator. */
  job: string;
  /**
   * When the run was due (ms since epoch). Every instance computes the same value, so `job` and
   * `slot` together name one run across the cluster. For a runNow() run: when it was asked for.
   */
  slot: number;
}

/**
 * What every run event and history record says besides {@link RunKey}: when the run was due, and
 * which instance it is about.
 *
 * @example One log format for every kind of run event
 * ```ts
 * const line = (e: RunEvent) => `${e.job} due ${e.scheduledAt.toISOString()} on ${e.instanceId}`;
 * scheduler.on('start', (e) => log.info(line(e)));
 * scheduler.on('skip', (e) => log.debug(`${line(e)}: ${e.reason}`));
 * scheduler.on('lost', (e) => log.warn(`${line(e)}: taken over by a backup`));
 * ```
 */
export interface RunEvent extends RunKey {
  /** `slot` as a Date. */
  scheduledAt: Date;
  /**
   * The instance: the one the event happened on, or in history the one that ran the attempt. Set
   * it with the scheduler's `instanceId` option (a pod or host name reads well).
   */
  instanceId: string;
}

/**
 * How an attempt stands. 'running': in progress, or its runner died on a backend without leases.
 * 'success': the handler returned. 'failed': it threw or timed out. 'interrupted': it didn't
 * finish; its runner died or froze, lost the run to a backup, or was stopped with `stop()`.
 *
 * @example
 * ```ts
 * const runs = await scheduler.history('nightly-export', 20);
 * const failures = runs.filter((run) => run.status === 'failed' || run.status === 'interrupted');
 * ```
 */
export type RunStatus = 'running' | 'success' | 'failed' | 'interrupted';

/**
 * One attempt of one run of a job: who ran it, when, and how it ended. Returned by `history()`,
 * `lastRun()` and `runNow()`, and the payload of the 'success' event.
 *
 * @example What `history()` returns for a run that was taken over (newest first)
 * ```ts
 * [
 *   { job: 'report', slot: 1791633600000, instanceId: 'api-2', attempt: 2, reason: 'takeover',
 *     status: 'success', startedAt: 2026-10-10T12:00:34Z, finishedAt: 2026-10-10T12:01:14Z, durationMs: 40012 },
 *   { job: 'report', slot: 1791633600000, instanceId: 'api-1', attempt: 1, reason: 'scheduled',
 *     status: 'interrupted', startedAt: 2026-10-10T12:00:01Z },
 * ]
 * ```
 *
 * @example Alert when the latest run of a job is too old or failed
 * ```ts
 * const last = await scheduler.lastRun('sync-customers');
 * if (!last || Date.now() - last.scheduledAt.getTime() > 30 * 60_000) alert('sync-customers has not run for 30 min');
 * else if (last.status === 'failed') alert(`sync-customers failed on ${last.instanceId}: ${last.error}`);
 * ```
 */
export interface RunRecord extends RunEvent {
  /** true when started with runNow(). */
  manual: boolean;
  /** 1 for the first try, 2+ when a backup took over. Each attempt is its own record. */
  attempt: number;
  /** Why this attempt started. Missing on backends that don't record it (RabbitMQ, NATS). */
  reason?: RunReason;
  /**
   * 'running': in progress. 'interrupted': its runner stopped before finishing (lease backends;
   * the others keep showing 'running').
   */
  status: RunStatus;
  /** When the instance claimed and started the run. */
  startedAt: Date;
  /** When the attempt ended. Missing while it runs, and for an attempt whose runner died. */
  finishedAt?: Date;
  /** finishedAt - startedAt. Missing with finishedAt. */
  durationMs?: number;
  /** Error message when status is 'failed'. */
  error?: string;
}

/**
 * A registered job, as `jobs()` reports it.
 *
 * @example A health endpoint that lists the jobs and when they run next
 * ```ts
 * app.get('/health/jobs', (_req, res) => {
 *   res.json(scheduler.jobs().map((job) => ({ name: job.name, schedule: job.schedule, next: job.nextRunAt })));
 * });
 * ```
 */
export interface JobInfo {
  /** The job's name. */
  name: string;
  /** Which method registered it: cron(), every() or at() ('once'). */
  type: 'cron' | 'every' | 'once';
  /** The schedule in words, e.g. 'every 10s' or 'cron "0 8 * * 1-5" (Europe/Athens)'. */
  schedule: string;
  /** Next scheduled run, or null if there are no more (a one-off job that already ran). */
  nextRunAt: Date | null;
  /** How many runs of this job this instance is executing right now (more than 1 only with overlap 'allow' or runNow()). */
  runningHere: number;
}

/**
 * Payload of 'start': this instance won a run and is about to call the handler.
 *
 * @example Count runs per instance, and notice takeovers
 * ```ts
 * scheduler.on('start', (e) => {
 *   metrics.increment('job.start', { job: e.job, instance: e.instanceId, reason: e.reason });
 *   if (e.reason === 'takeover') log.warn(`${e.job}: attempt ${e.attempt} taken over by ${e.instanceId}`);
 * });
 * ```
 */
export interface RunStartEvent extends RunEvent {
  /** true when started with runNow(). */
  manual: boolean;
  /** 1, or 2+ when this instance is taking the run over. */
  attempt: number;
  /** Why the run starts here. */
  reason: RunReason;
}

/**
 * Payload of 'lost': this instance stopped owning a run it was executing, because a backup took it
 * over (this instance missed its heartbeats: a long pause, or the store was unreachable).
 * `ctx.signal` of that run was aborted. Only on backends with leases.
 *
 * @example
 * ```ts
 * scheduler.on('lost', (e) => {
 *   log.warn(`${e.job} @ ${e.scheduledAt.toISOString()}: attempt ${e.attempt} on ${e.instanceId} was taken over`);
 * });
 * ```
 */
export interface LostEvent extends RunEvent {
  /** The attempt this instance was running. The backup runs attempt + 1. */
  attempt: number;
}

/**
 * Payload of 'failure': the handler threw, or `timeoutMs` passed. `error` is the message, `cause`
 * the thrown value.
 *
 * @example Page on failures, but not on errors the job expects
 * ```ts
 * scheduler.on('failure', (run) => {
 *   if (run.cause instanceof RateLimitError) return;
 *   pager.notify(`${run.job} failed on ${run.instanceId} after ${run.durationMs} ms: ${run.error}`);
 * });
 * ```
 */
export interface RunFailureEvent extends RunRecord {
  /** The value the job threw: an Error, or anything else a handler can throw. */
  cause: unknown;
}

/**
 * Payload of 'interrupted': a run ended without finishing because `stop()` or a backup's takeover
 * aborted ctx.signal and the job then threw. Not a job failure.
 *
 * @example
 * ```ts
 * scheduler.on('interrupted', (run) => {
 *   log.info(`${run.job}: stopped on ${run.instanceId}${run.handedOver ? ', another instance finishes it' : ''}`);
 * });
 * ```
 */
export interface RunInterruptedEvent extends RunRecord {
  /** The value the job threw. */
  cause: unknown;
  /** The run was given to another instance to finish (graceful shutdown on a lease backend). */
  handedOver: boolean;
}

/**
 * Payload of 'skip': a run was due and this instance did not run it. With several instances this is
 * the normal case: for every run, all instances but one emit 'skip' with reason 'taken'.
 *
 * @example Only the reasons worth a look
 * ```ts
 * scheduler.on('skip', (e) => {
 *   if (e.reason === 'late') log.warn(`${e.job}: reached ${e.lateMs} ms late, skipped (process frozen?)`);
 *   if (e.reason === 'overlap') log.info(`${e.job}: the previous run is still going, skipped`);
 * });
 * ```
 */
export interface SkipEvent extends RunEvent {
  /**
   * 'taken': another instance won this run. 'late': this instance got there after maxLateMs.
   * 'overlap': the previous run of this job is still running (overlap 'skip').
   */
  reason: 'taken' | 'late' | 'overlap';
  /** With reason 'late': how long after the slot the run was reached. */
  lateMs?: number;
}

/**
 * Payload of 'error': a backend or setup problem, not a job failure (those are 'failure'). Without
 * an 'error' listener these are written to the logger instead. `job` and `slot` are set when the
 * problem belongs to one run.
 *
 * @example
 * ```ts
 * scheduler.on('error', ({ error, job, slot }) => {
 *   log.error(job ? `${job} @ ${slot}: store problem` : 'scheduler problem', error);
 * });
 * ```
 */
export interface SchedulerErrorEvent extends Partial<RunKey> {
  /** What went wrong: a connection error, a refused write, a listener that threw. */
  error: unknown;
}

/**
 * Every event of `scheduler.on()` and its payload. Events describe what happened on this instance
 * only; `history()` is the view across all instances.
 *
 * | event | when |
 * | --- | --- |
 * | `start` | this instance won a run and starts the handler |
 * | `success` | the handler returned |
 * | `failure` | the handler threw, or `timeoutMs` passed |
 * | `interrupted` | stop() or a takeover aborted `ctx.signal`, and the handler then threw |
 * | `skip` | a run was due and this instance didn't run it: 'taken', 'late' or 'overlap' |
 * | `lost` | a backup took over a run this instance was executing (it stopped renewing its lease) |
 * | `error` | a backend or setup problem; job failures are 'failure' |
 *
 * @example
 * ```ts
 * scheduler.on('failure', (run) => {
 *   if (run.cause instanceof RateLimitError) return; // the thrown value itself
 *   pager.notify(`${run.job} @ ${run.scheduledAt.toISOString()} failed on ${run.instanceId}: ${run.error}`);
 * });
 * ```
 */
export interface SchedulerEvents {
  /** This instance won a run and is about to call the handler. */
  start: RunStartEvent;
  /** The handler returned. */
  success: RunRecord;
  /** The handler threw, or timeoutMs passed. */
  failure: RunFailureEvent;
  /** stop() or a takeover aborted ctx.signal, and the handler then threw. */
  interrupted: RunInterruptedEvent;
  /** A run was due and this instance did not run it. */
  skip: SkipEvent;
  /** A backup took over a run this instance was executing. */
  lost: LostEvent;
  /** A backend or setup problem. Never a job failure. */
  error: SchedulerErrorEvent;
}
