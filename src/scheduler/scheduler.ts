/* Copyright (C) 2026-present Aristotelis — see repository license. */

import { EventEmitter } from 'node:events';
import { hostname } from 'node:os';

import type { RegisterOptions } from '../decorators';
import {
  type ConfigureOptions,
  configure,
  getScheduler,
  hostOf,
  knownSchedulers,
  registerOn,
  resetSchedulers,
  type SchedulerHost,
  schedulerCreated,
  schedulerStarting,
  schedulerStopped,
  setDefaultScheduler,
  setSchedulerFactory,
} from '../registry';
import { cronSchedule, everySchedule, onceSchedule, parseDuration, type Schedule } from '../schedule';
import type {
  AtJobOptions,
  Backend,
  CronJobOptions,
  EveryJobOptions,
  JobData,
  JobHandler,
  JobInfo,
  JobOptions,
  JobOptionsFor,
  LeaseSchedulerOptions,
  Logger,
  RunRecord,
  SchedulerErrorEvent,
  SchedulerEvents,
  SchedulerOptions,
} from '../types';
import { errorMessage, intInRange, nonNegativeInt, positiveInt } from '../util';
import { ClaimOnlyRunner } from './claim-only-runner';
import type { SchedulerCore } from './core';
import { layerData } from './data';
import { Executor } from './executor';
import { createJob, type Job, type JobDefaults, refuseWithoutLeases } from './job';
import { LeaseRunner } from './lease-runner';
import { logRuns } from './logging';
import { JobTimers } from './timers';

/**
 * Runs cron and interval jobs once per scheduled time across any number of instances. No leader and
 * no locks: each run is claimed with one atomic operation on the backend that only one instance can
 * win, and a random delay before claiming spreads the work.
 *
 * With a lease-capable backend (Redis/Valkey 'lease' strategy, Postgres, SQLite) a running job also
 * renews a lease. That gives: no overlapping runs, backup runners when the runner dies or freezes,
 * retries, and catch-up of a run that was due while every instance was down.
 *
 * This class is the public API and the lifecycle. The work is done by its parts, all in this folder:
 * `JobTimers` (when a run is due), `LeaseRunner` or `ClaimOnlyRunner` (claiming it), `Executor`
 * (running the handler and recording the result).
 *
 * @example The smallest setup: Redis on localhost, one job. Start the same code on every instance.
 * ```ts
 * import { Scheduler } from 'anarchon';
 *
 * const scheduler = new Scheduler({ backend: new RedisBackend({ redis: 'redis://localhost:6379' }) });
 * scheduler.every('sync', '10s', async () => {
 *   await syncCustomers();
 * });
 * await scheduler.start();
 * ```
 *
 * @example Postgres instead of Redis, several kinds of job, and a clean shutdown.
 * ```ts
 * import { PostgresBackend, Scheduler } from 'anarchon';
 *
 * const scheduler = new Scheduler({
 *   backend: new PostgresBackend({ connection: process.env.DATABASE_URL }),
 *   timezone: 'Europe/Athens',
 *   log: true,
 * });
 *
 * scheduler
 *   .every('sync', '10s', () => syncCustomers())
 *   .cron('digest', '0 8 * * 1-5', () => sendDigest()) // 08:00 Athens time, Monday to Friday
 *   .at('migration', '2026-12-01T03:00:00Z', () => migrate());
 *
 * await scheduler.start();
 * process.on('SIGTERM', async () => {
 *   await scheduler.stop(); // running jobs are handed to the other instances
 *   process.exit(0);
 * });
 * ```
 *
 * @example Reacting to what happens, and asking what happened.
 * ```ts
 * scheduler.on('failure', (run) => alert(`${run.job} failed: ${run.error}`));
 * scheduler.on('skip', (e) => console.log(`${e.job} skipped here: ${e.reason}`));
 *
 * const runs = await scheduler.history('sync', 10); // from every instance, newest first
 * const next = scheduler.nextRun('sync');
 * ```
 */
export class Scheduler<B extends Backend = Backend> {
  /**
   * This instance's name in history and events. Default `${hostname}:${pid}`.
   *
   * @example
   * ```ts
   * const scheduler = new Scheduler({ backend, instanceId: process.env.POD_NAME });
   * const mine = (await scheduler.history('sync', 50)).filter((run) => run.instanceId === scheduler.instanceId);
   * ```
   */
  readonly instanceId: string;
  /**
   * Where runs are claimed and recorded, as given to the constructor. `backend.name` tells which
   * one, e.g. 'redis:lease' or 'postgres'.
   *
   * @example
   * ```ts
   * log.info(`jobs run on ${scheduler.backend.name}`);
   * ```
   */
  readonly backend: B;
  /**
   * The name decorated jobs choose this scheduler by (`{ scheduler: 'billing' }`), if it has one.
   *
   * @example
   * ```ts
   * const billing = new Scheduler({ name: 'billing', backend });
   * Scheduler.get('billing') === billing; // true
   * ```
   */
  readonly name: string | undefined;

  private readonly defaults: JobDefaults;
  private readonly logger: Logger;
  private readonly registry = new Map<string, Job>();
  private readonly emitter = new EventEmitter();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly host: SchedulerHost;
  private dataSource: unknown;

  private readonly timers: JobTimers;
  private readonly executor: Executor;
  private readonly claimOnly: ClaimOnlyRunner;
  /** Present when the backend has leases. */
  private readonly leases: LeaseRunner | undefined;

  private state: 'idle' | 'starting' | 'running' | 'stopping' = 'idle';
  private abort = new AbortController();
  private ready: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;

  /**
   * Creates a scheduler. Nothing connects and nothing runs until {@link Scheduler.start | start()}.
   *
   * @throws TypeError when no backend is given: no store is assumed.
   * @throws RangeError when a number is out of range, or `heartbeatMs` is not under half of `leaseMs`.
   *
   * @example Redis or Valkey
   * ```ts
   * new Scheduler({ backend: new RedisBackend({ redis: process.env.REDIS_URL }) }); // the 'lease' strategy
   * new Scheduler({ backend: new RedisBackend({ redis: 'redis://cache.internal:6379', prefix: 'billing:cron:' }) });
   * new Scheduler({ backend: new RedisBackend({ redis: myIoredisClient }) }); // your client; never closed by stop()
   * ```
   *
   * @example Another backend
   * ```ts
   * new Scheduler({ backend: new PostgresBackend({ connection: pool }) });
   * new Scheduler({ backend: new SqliteBackend({ database: './jobs.db' }) });
   * ```
   *
   * @example Faster failover: a dead runner is replaced after about 10 s instead of 30 s
   * ```ts
   * new Scheduler({ backend, leaseMs: 10_000, heartbeatMs: 2_000 });
   * ```
   */
  constructor(options: SchedulerOptions<B>) {
    // Also for callers without types, who can leave the options out altogether.
    if (!options?.backend) {
      throw new TypeError('A scheduler needs a backend, e.g. backend: new RedisBackend({ redis: url }). No store is assumed');
    }
    if (options.name !== undefined && (typeof options.name !== 'string' || options.name === '')) {
      throw new TypeError('name must be a non-empty string');
    }
    this.name = options.name;
    this.dataSource = options.data;
    this.instanceId = options.instanceId ?? `${hostname()}:${process.pid}`;
    if (typeof this.instanceId !== 'string' || this.instanceId === '') throw new TypeError('instanceId must be a non-empty string');
    this.backend = options.backend;
    refuseWithoutLeases(this.backend, options, ['leaseMs', 'heartbeatMs']);
    const lease = options as LeaseSchedulerOptions;
    this.defaults = {
      jitterMs: nonNegativeInt('jitterMs', options.jitterMs ?? 2_000),
      maxLateMs: positiveInt('maxLateMs', options.maxLateMs ?? 60_000),
      historySize: positiveInt('historySize', options.historySize ?? 1_000),
      timezone: options.timezone,
    };
    if (options.historyTtlMs !== undefined) this.defaults.historyTtlMs = positiveInt('historyTtlMs', options.historyTtlMs);
    const leaseMs = positiveInt('leaseMs', lease.leaseMs ?? 30_000);
    const heartbeatMs = positiveInt('heartbeatMs', lease.heartbeatMs ?? Math.min(5_000, Math.floor(leaseMs / 6)));
    if (heartbeatMs * 2 >= leaseMs) {
      throw new RangeError(`heartbeatMs (${heartbeatMs}) must be under half of leaseMs (${leaseMs}), so a lease is renewed at least twice`);
    }
    this.logger = options.logger ?? console;

    const core: SchedulerCore = {
      instanceId: this.instanceId,
      backend: this.backend,
      leaseMs,
      heartbeatMs,
      unrefTimers: options.unrefTimers ?? false,
      isRunning: () => this.state === 'running',
      isIdle: () => this.state === 'idle',
      schedulerData: () => this.dataSource,
      stopSignal: () => this.abort.signal,
      ensureReady: () => this.ensureReady(),
      prepare: (job) => this.prepare(job),
      track: (promise) => this.track(promise),
      emit: (event, payload) => this.emit(event, payload),
    };
    this.executor = new Executor(core);
    this.claimOnly = new ClaimOnlyRunner(core, this.executor);
    this.leases = this.backend.runs ? new LeaseRunner(core, this.executor, this.backend.runs) : undefined;
    this.timers = new JobTimers(core, (job, slot) => void this.track(this.fire(job, slot)));
    if (options.log) logRuns((event, listener) => this.on(event, listener), this.logger);
    this.host = {
      scheduler: this,
      name: this.name,
      add: (job, name, { timezone, ...defaults }) => {
        // The object's data and the job's are two layers, not one replacing the other.
        const data = layerData(defaults.data, job.options.data) as JobData | undefined;
        const options = { ...defaults, ...job.options, ...(data === undefined ? {} : { data }) };
        if (job.type === 'cron') {
          this.cron(name, job.expression, job.handler, { ...(timezone === undefined ? {} : { timezone }), ...options });
        } else if (job.type === 'every') {
          this.every(name, job.interval, job.handler, options);
        } else {
          // register() defaults cover every job of the object; a one-off job has nothing to overlap.
          const { overlap, ...once } = defaults;
          this.at(name, job.when, job.handler, { ...once, ...job.options, ...(data === undefined ? {} : { data }) });
        }
      },
      remove: (name) => this.remove(name),
      has: (name) => this.registry.has(name),
      // Not at once: a scheduler is created while an object's jobs are being added, and starting
      // must see them added. The object is created synchronously, so the next microtask is after it.
      startInBackground: () => queueMicrotask(() => void this.start().catch((error: unknown) => this.emit('error', { error }))),
    };
    schedulerCreated(this.host);
  }

  /**
   * Stores the settings a scheduler is created from when a decorated job needs it. With this, a
   * class with `@Cron`, `@Every` or `@At` is all the code a job takes: no scheduler is created by
   * hand.
   *
   * Without a name, these are the settings of the default scheduler. With a name, of the scheduler
   * that jobs choose with `{ scheduler: name }`. A named scheduler that has no settings of its own
   * is created from the default ones when their `backend` is a function of the name.
   *
   * @param options The options of `new Scheduler()`, plus `autoStart`. `backend` must be given: no
   *   backend is assumed.
   * @throws TypeError when no backend is given.
   * @throws Error when that scheduler already exists, or when an object that was waiting for it
   *   can't add its jobs.
   *
   * @example The least there is to write
   * ```ts
   * Scheduler.configure({ backend: new RedisBackend({ redis: process.env.REDIS_URL }), autoStart: true });
   *
   * class Reports {
   *   @Cron('weekday-digest', '0 8 * * 1-5')
   *   async digest() {}
   * }
   * new Reports(); // the default scheduler is created, started, and has the job
   * ```
   *
   * @example Several schedulers, started by you
   * ```ts
   * Scheduler.configure({ backend: (name) => new PostgresBackend({ connection: pool, table: `cron_${name}` }) });
   * Scheduler.configure('billing', { backend: new RedisBackend({ redis: process.env.BILLING_REDIS_URL }), leaseMs: 10_000 });
   *
   * class Jobs {
   *   @Cron('job-1', '*\/10 * * * * *') // the default scheduler
   *   one() {}
   *   @Cron('job-2', '*\/10 * * * * *', { scheduler: 'billing' })
   *   two() {}
   *   @Every('job-3', '5s', { scheduler: 'reports' }) // created from the default settings, table cron_reports
   *   three() {}
   * }
   * new Jobs();
   * await Scheduler.startAll();
   * ```
   */
  static configure(options: ConfigureOptions): void;
  /**
   * Settings for the scheduler with this name only. They win over the default settings for it.
   *
   * @example
   * ```ts
   * Scheduler.configure('billing', { backend: new PostgresBackend({ connection: billingPool }), leaseMs: 10_000 });
   * ```
   */
  static configure(name: string, options: ConfigureOptions): void;
  static configure(first: string | ConfigureOptions, second?: ConfigureOptions): void {
    if (typeof first === 'string' || second !== undefined) configure(first as string, second as ConfigureOptions);
    else configure(undefined, first);
  }

  /**
   * The default scheduler, or the one with that name. It is created from the settings given to
   * {@link Scheduler.configure} if it doesn't exist yet.
   *
   * @throws Error when it doesn't exist and has no settings.
   *
   * @example
   * ```ts
   * await Scheduler.get().start();
   * console.table(Scheduler.get('billing').jobs());
   * ```
   */
  static get(name?: string): Scheduler {
    return getScheduler(name) as Scheduler;
  }

  /**
   * The default scheduler and every scheduler that has a name.
   *
   * @example A health check across all schedulers
   * ```ts
   * const jobs = Scheduler.all().flatMap((s) => s.jobs().map((job) => ({ scheduler: s.name ?? 'default', ...job })));
   * ```
   */
  static all(): Scheduler[] {
    return knownSchedulers() as Scheduler[];
  }

  /**
   * Starts the default scheduler and every scheduler that has a name.
   *
   * @throws when one of them can't start; the others are started all the same.
   *
   * @example
   * ```ts
   * Scheduler.configure({ backend: (name) => new PostgresBackend({ connection: pool, table: `cron_${name}` }) });
   * new ReportJobs(); // decorated; creates the schedulers its jobs name
   * await Scheduler.startAll();
   * ```
   */
  static async startAll(): Promise<void> {
    const results = await Promise.allSettled(Scheduler.all().map((scheduler) => scheduler.start()));
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
  }

  /**
   * Stops the default scheduler and every scheduler that has a name. Same options as `stop()`.
   *
   * @example On shutdown
   * ```ts
   * process.on('SIGTERM', async () => {
   *   await Scheduler.stopAll({ timeoutMs: 20_000 }); // running jobs get 20 s, then are handed over
   *   process.exit(0);
   * });
   * ```
   */
  static async stopAll(options: { timeoutMs?: number } = {}): Promise<void> {
    await Promise.all(Scheduler.all().map((scheduler) => scheduler.stop(options)));
  }

  /**
   * Forgets the default scheduler, the names, the settings given to {@link Scheduler.configure} and
   * the objects waiting for a scheduler. It stops nothing. Meant for tests, between cases.
   *
   * @example
   * ```ts
   * afterEach(async () => {
   *   await Scheduler.stopAll();
   *   Scheduler.reset();
   * });
   * ```
   */
  static reset(): void {
    resetSchedulers();
  }

  /**
   * Chooses the scheduler that receives the jobs of decorated objects (`@Cron`, `@Every`, `@At`).
   * Without this call it is the first scheduler created; when that one is stopped, the next one
   * created or started takes its place.
   *
   * An object created while there is a default scheduler adds its jobs at once. One created earlier
   * waits (the newest object of each class), and its jobs are added when the default scheduler
   * starts, or here.
   *
   * @param scheduler `undefined` goes back to the initial state: the next scheduler created or started
   *   becomes the default, and objects that were waiting are forgotten. Useful between tests.
   * @throws when the jobs of a waiting object can't be added.
   *
   * @example Two schedulers, with the decorated jobs on the second
   * ```ts
   * const cache = new Scheduler({ backend: new RedisBackend({ redis: cacheUrl }) });
   * const billing = new Scheduler({ backend: new PostgresBackend({ connection: pool }) });
   * Scheduler.setDefault(billing);
   * ```
   */
  static setDefault(scheduler: Scheduler | undefined): void {
    setDefaultScheduler(scheduler ? hostOf(scheduler) : undefined);
  }

  // ---------------------------------------------------------------- jobs

  /**
   * Adds a cron job. The expression has 5 fields (minute hour day month weekday), or 6 with seconds
   * first. Times are in `options.timezone`, else the scheduler's `timezone`, else the server's zone.
   *
   * Register the same jobs, with the same names and schedules, on every instance.
   *
   * @param name Unique per scheduler. It is also the job's name in the backend, so keep it stable.
   * @throws Error when the expression is invalid or the name is already registered.
   *
   * @example
   * ```ts
   * scheduler.cron('digest', '0 8 * * 1-5', sendDigest); // 08:00, Monday to Friday
   * scheduler.cron('cleanup', '30 3 * * *', cleanUp, { timezone: 'Europe/Athens' }); // 03:30 Athens time
   * scheduler.cron('poll', '*\/15 * * * * *', poll); // every 15 seconds (6 fields)
   * scheduler.cron('report', '0 0 1 * *', buildReport, { timeoutMs: 30 * 60_000 }); // monthly, at most 30 min
   * ```
   */
  cron<Data = unknown>(name: string, expression: string, handler: JobHandler<Data>, options: JobOptionsFor<B, CronJobOptions> = {}): this {
    let schedule: Schedule;
    try {
      schedule = cronSchedule(expression, options.timezone ?? this.defaults.timezone);
    } catch (error) {
      throw new Error(`Job "${name}": invalid cron "${expression}": ${errorMessage(error)}`);
    }
    return this.add(name, schedule, handler, options);
  }

  /**
   * Adds an interval job. The interval is a number of ms, or a string such as `'10s'`, `'35m'` or
   * `'1h30m'`; the minimum is 1 s.
   *
   * Runs fall on a fixed UTC grid (multiples of the interval since 1970), not "interval after
   * start": every instance computes the same run times, and a restart doesn't shift them. For times
   * on the wall clock of a time zone, use {@link Scheduler.cron | cron()}.
   *
   * @throws RangeError when the interval is under 1 s.
   *
   * @example
   * ```ts
   * scheduler.every('sync', '10s', syncCustomers);
   * scheduler.every('backup', '1h30m', backup);
   * scheduler.every('heartbeat', 5_000, ping);
   * scheduler.every('hourly-at-quarter-past', '1h', run, { offsetMs: 15 * 60_000 }); // 00:15, 01:15, ...
   * ```
   *
   * @example A long job that can be stopped and taken over
   * ```ts
   * scheduler.every('export', '5m', async (ctx) => {
   *   for (const batch of batches) {
   *     ctx.signal.throwIfAborted(); // stop(), timeout, or a backup took over
   *     await exportBatch(batch);
   *   }
   * }, { timeoutMs: 4 * 60_000 });
   * ```
   */
  every<Data = unknown>(
    name: string,
    interval: number | string,
    handler: JobHandler<Data>,
    options: JobOptionsFor<B, EveryJobOptions> = {},
  ): this {
    const ms = parseDuration(interval);
    if (ms < 1_000) throw new RangeError(`Job "${name}": the interval must be at least 1s (got ${ms} ms)`);
    return this.add(name, everySchedule(ms, options.offsetMs ?? 0), handler, options);
  }

  /**
   * Adds a one-off job: it runs once, at `when`, on one instance (like SyncedCron's one-off jobs).
   * `when` is a Date, ms since epoch, or an ISO date string.
   *
   * @throws RangeError when `when` is not a valid date.
   * @throws TypeError when `overlap` is given: a one-off job has no previous run.
   *
   * @example
   * ```ts
   * scheduler.at('launch', '2026-12-01T09:00:00Z', announce);
   * scheduler.at('reminder', new Date(Date.now() + 60 * 60_000), remind); // in one hour
   * ```
   */
  at<Data = unknown>(
    name: string,
    when: Date | number | string,
    handler: JobHandler<Data>,
    options: JobOptionsFor<B, AtJobOptions> = {},
  ): this {
    if ((options as JobOptions).overlap !== undefined) throw new TypeError(`Job "${name}": a one-off job takes no overlap`);
    const time = when instanceof Date ? when.getTime() : typeof when === 'number' ? when : Date.parse(when);
    if (!Number.isFinite(time)) throw new RangeError(`Job "${name}": invalid date ${String(when)}`);
    return this.add(name, onceSchedule(time), handler, options);
  }

  /**
   * Adds the jobs declared with `@Cron`, `@Every` and `@At` on an object's class to this scheduler.
   * Each job calls its method on that object, so the method can use the object's fields. A job is
   * named `Class-method` unless the decorator gives a name. Nothing is added when one of the jobs is
   * invalid.
   *
   * A decorated object adds its jobs to their schedulers when it is created, so you call this only
   * to decide something for one object: a prefix for its job names, job options for all its jobs, or
   * this scheduler for all of them. It is also how an object is added with legacy decorators on a
   * class without `@Scheduled()`.
   *
   * Every job of the object goes on this scheduler, whatever scheduler a decorator names, and is
   * taken off the scheduler that had it. Registering the object again with options replaces its
   * jobs, and without options changes nothing.
   *
   * @param options `prefix` goes in front of every job name, so that several objects of one class
   *   can each have their own jobs. `defaults` are job options for every job of the object; an
   *   option set in a decorator wins.
   * @throws TypeError when the object's class has no decorated methods.
   * @throws Error when a job is invalid or its name is already registered; the object's jobs are
   *   then left as they were.
   *
   * @example
   * ```ts
   * class Reports {
   *   constructor(private readonly mailer: Mailer) {}
   *
   *   @Cron('0 8 * * 1-5', { timezone: 'Europe/Athens' })
   *   async digest(ctx: JobContext) {
   *     await this.mailer.send(await buildDigest(ctx.scheduledAt));
   *   }
   *
   *   @Every('sync-customers', '10s', { timeoutMs: 8_000 })
   *   async sync() {}
   * }
   *
   * billing.register(new Reports(mailer)); // adds 'Reports-digest' and 'sync-customers' to `billing`
   * ```
   *
   * @example One object per tenant, each with its own jobs and time zone
   * ```ts
   * for (const tenant of tenants) {
   *   scheduler.register(new Reports(tenant.mailer), {
   *     prefix: `${tenant.id}:`, // 'acme:Reports-digest', 'acme:sync-customers'
   *     defaults: { timezone: tenant.timezone, timeoutMs: 60_000 },
   *   });
   * }
   * ```
   */
  register(target: object, options: RegisterOptions = {}): this {
    registerOn(this.host, target, options);
    return this;
  }

  /**
   * Stops scheduling a job on this instance. Other instances keep running it, its history is kept,
   * and a run already in progress here finishes.
   *
   * @returns false when no job has that name.
   *
   * @example Replacing a job's schedule at run time
   * ```ts
   * scheduler.remove('sync');
   * scheduler.every('sync', '30s', syncCustomers);
   * ```
   */
  remove(name: string): boolean {
    const job = this.registry.get(name);
    if (!job) return false;
    job.removed = true;
    this.timers.disarm(job);
    this.leases?.stopWatching(name);
    this.registry.delete(name);
    return true;
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Connects to the backend and starts scheduling. Jobs can be added before or after. Calling it
   * again while running does nothing.
   *
   * With leases, starting also picks up what was left behind: an unfinished run whose runner died
   * is taken over, and the latest run is caught up if it was due (at most `catchUpMs` ago) while
   * every instance was down.
   *
   * @throws when the backend can't be reached or is too old; the scheduler stays stopped.
   * @throws when this is the default scheduler and a decorated object that was waiting for one can't
   *   add its jobs; the scheduler stays stopped.
   *
   * @example
   * ```ts
   * try {
   *   await scheduler.start();
   * } catch (error) {
   *   console.error('scheduler could not start', error);
   *   process.exit(1);
   * }
   * ```
   */
  async start(): Promise<void> {
    if (this.state === 'running') return;
    for (const warning of schedulerStarting(this.host)) this.logger.warn(`[anarchon] ${warning}`);
    if (this.state !== 'idle') throw new Error(`Cannot start while ${this.state}`);
    this.state = 'starting';
    try {
      await this.ensureReady();
      await Promise.all([...this.registry.values()].map((job) => this.prepare(job)));
    } catch (error) {
      this.state = 'idle';
      await this.closeBackend();
      throw error;
    }
    if ((this.state as string) !== 'starting') return; // stop() was called meanwhile
    this.abort = new AbortController();
    this.state = 'running';
    for (const job of this.registry.values()) this.schedule(job);
  }

  /**
   * Stops scheduling, aborts `ctx.signal`, waits up to `timeoutMs` (default 30 s) for running jobs
   * to finish, then closes the connections the backend opened. Clients you passed in stay open.
   *
   * Lease strategy: a job that throws once its signal is aborted (e.g. `ctx.signal.throwIfAborted()`)
   * is handed to another instance right away. A job still running when the timeout passes stops
   * renewing its lease, so a backup takes it over when the lease runs out.
   *
   * @example On shutdown
   * ```ts
   * process.on('SIGTERM', async () => {
   *   await scheduler.stop({ timeoutMs: 10_000 });
   *   process.exit(0);
   * });
   * ```
   */
  stop(options: { timeoutMs?: number } = {}): Promise<void> {
    schedulerStopped(this.host);
    this.stopping ??= this.doStop(options.timeoutMs ?? 30_000).finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }

  /**
   * Runs a job now, on this instance, whatever its schedule. The run is not deduplicated (calling
   * it on two instances runs it twice), may overlap a scheduled run, and is recorded in history
   * with `manual: true`. Resolves with the run's record when the job has finished.
   *
   * @throws Error when the job is not registered here, or the scheduler is not started.
   *
   * @example Behind an admin endpoint
   * ```ts
   * app.post('/jobs/:name/run', async (req, res) => {
   *   const run = await scheduler.runNow(req.params.name);
   *   res.json({ status: run.status, ms: run.durationMs, error: run.error });
   * });
   * ```
   */
  async runNow(name: string, options: { data?: JobData } = {}): Promise<RunRecord> {
    const job = this.getJob(name);
    if (this.state !== 'running') throw new Error('Call start() before runNow()');
    await this.prepare(job);
    return this.leases ? this.leases.runManual(job, options.data) : this.claimOnly.runManual(job, options.data);
  }

  /**
   * Replaces the scheduler's `data`: what is handed to every handler as `ctx.data`, under
   * each job's own. Runs that start after the call get the new one; runs in progress keep theirs.
   *
   * @param data A value, or a function called when a run starts. `undefined` removes it.
   *
   * @example
   * ```ts
   * scheduler.setData({ tenant: 'acme', features: await loadFeatures() });
   * events.on('features-changed', (features) => scheduler.setData({ tenant: 'acme', features }));
   * ```
   */
  setData(data: JobData | undefined): this {
    this.dataSource = data;
    return this;
  }

  // ---------------------------------------------------------------- read API

  /**
   * The latest runs of a job across all instances, newest first: who ran it, when it started, when
   * it finished and how it ended. One record per attempt, so a run that was taken over shows twice.
   * Works for any job name, even one not registered here, and before start().
   *
   * @param limit 1 to 10000. Default 20.
   *
   * @example
   * ```ts
   * for (const run of await scheduler.history('sync', 5)) {
   *   console.log(run.scheduledAt, run.instanceId, run.attempt, run.status, run.durationMs);
   * }
   * // 2026-10-10T12:00:10Z api-2 1 success 212
   * // 2026-10-10T12:00:00Z api-1 2 success 4010    <- a backup finished it
   * // 2026-10-10T12:00:00Z api-3 1 interrupted     <- its first runner died
   * ```
   *
   * @example A read-only process, such as a dashboard: no jobs, only history
   * ```ts
   * const reader = new Scheduler({ backend });
   * const failed = (await reader.history('digest', 100)).filter((run) => run.status === 'failed');
   * ```
   */
  async history(name: string, limit = 20): Promise<RunRecord[]> {
    intInRange('limit', limit, 1, 10_000);
    await this.ensureReady();
    return this.backend.history(name, limit);
  }

  /**
   * The most recent run of a job on any instance, or null if it never ran.
   *
   * @example A health check: has "sync" succeeded in the last minute?
   * ```ts
   * const last = await scheduler.lastRun('sync');
   * const healthy = last?.status === 'success' && Date.now() - last.startedAt.getTime() < 60_000;
   * ```
   */
  async lastRun(name: string): Promise<RunRecord | null> {
    const [last] = await this.history(name, 1);
    return last ?? null;
  }

  /**
   * When a registered job is next due, or null if it has no more runs (a one-off job in the past).
   * The run starts up to `jitterMs` later, on whichever instance claims it.
   *
   * @throws Error when the job is not registered here.
   *
   * @example
   * ```ts
   * scheduler.cron('digest', '0 8 * * 1-5', sendDigest, { timezone: 'Europe/Athens' });
   * scheduler.nextRun('digest'); // the next weekday at 08:00 Athens time, as a Date
   * ```
   */
  nextRun(name: string): Date | null {
    return this.nextRunOf(this.getJob(name));
  }

  /**
   * The jobs registered on this instance, with their schedule, next run, and how many runs of each
   * are executing here right now.
   *
   * @example
   * ```ts
   * console.table(scheduler.jobs());
   * // name     type    schedule                             nextRunAt             runningHere
   * // sync     every   every 10s                            2026-10-10T12:00:10Z  0
   * // digest   cron    cron "0 8 * * 1-5" (Europe/Athens)   2026-10-12T05:00:00Z  0
   * ```
   */
  jobs(): JobInfo[] {
    return [...this.registry.values()].map((job) => ({
      name: job.name,
      type: job.schedule.type,
      schedule: job.schedule.description,
      nextRunAt: this.nextRunOf(job),
      runningHere: job.runningHere,
    }));
  }

  // ---------------------------------------------------------------- events

  /**
   * Listens for what happens on this instance. See {@link SchedulerEvents} for every event and its
   * payload. A listener that throws is logged and doesn't affect the run.
   *
   * @example
   * ```ts
   * scheduler.on('start', (e) => metrics.increment('job.start', { job: e.job }));
   * scheduler.on('success', (run) => metrics.timing('job.ms', run.durationMs, { job: run.job }));
   * scheduler.on('failure', (run) => logger.error({ job: run.job, cause: run.cause }, 'job failed'));
   * scheduler.on('interrupted', (run) => logger.info(`${run.job} stopped mid-run, handed over: ${run.handedOver}`));
   * scheduler.on('skip', (e) => logger.debug(`${e.job}: ${e.reason}`)); // 'taken' on every instance but one
   * scheduler.on('lost', (e) => logger.warn(`${e.job}: a backup took over attempt ${e.attempt}`));
   * scheduler.on('error', (e) => logger.error(e.error, 'backend problem')); // without a listener: logged
   * ```
   */
  on<E extends keyof SchedulerEvents>(event: E, listener: (payload: SchedulerEvents[E]) => void): this {
    this.emitter.on(event, listener);
    return this;
  }

  /**
   * Like {@link Scheduler.on | on()}, for the next occurrence only.
   *
   * @example Wait for the first run after a deploy
   * ```ts
   * const first = new Promise<RunRecord>((resolve) => scheduler.once('success', resolve));
   * await scheduler.start();
   * log.info(`first run: ${(await first).job}`);
   * ```
   */
  once<E extends keyof SchedulerEvents>(event: E, listener: (payload: SchedulerEvents[E]) => void): this {
    this.emitter.once(event, listener);
    return this;
  }

  /**
   * Removes a listener added with {@link Scheduler.on | on()} or {@link Scheduler.once | once()}.
   * Pass the same function that was added.
   *
   * @example
   * ```ts
   * const onFailure = (run: RunFailureEvent) => pager.notify(run.error);
   * scheduler.on('failure', onFailure);
   * scheduler.off('failure', onFailure); // e.g. during maintenance
   * ```
   */
  off<E extends keyof SchedulerEvents>(event: E, listener: (payload: SchedulerEvents[E]) => void): this {
    this.emitter.off(event, listener);
    return this;
  }

  // ---------------------------------------------------------------- scheduling

  private add(name: string, schedule: Schedule, handler: JobHandler<never>, options: JobOptions): this {
    if (this.registry.has(name)) throw new Error(`Job "${name}" is already registered`);
    const job = createJob(name, schedule, handler, options, this.defaults, this.backend);
    this.registry.set(name, job);
    if (this.state === 'running') this.schedule(job);
    return this;
  }

  /** Sets the job's timer and, with leases, picks up what other instances left behind. */
  private schedule(job: Job): void {
    this.timers.arm(job);
    if (this.leases) void this.track(this.leases.recover(job));
  }

  /** A scheduled run is due. Never rejects: problems are reported as events. */
  private async fire(job: Job, slot: number): Promise<void> {
    this.timers.arm(job); // schedule the next run first, so a long job doesn't delay it

    const lateMs = Date.now() - slot;
    if (lateMs > job.maxLateMs) {
      this.emit('skip', { job: job.name, slot, scheduledAt: new Date(slot), instanceId: this.instanceId, reason: 'late', lateMs });
      return;
    }
    return this.leases ? this.leases.run(job, slot, 'scheduled') : this.claimOnly.run(job, slot);
  }

  // ---------------------------------------------------------------- plumbing

  private async doStop(timeoutMs: number): Promise<void> {
    if (this.state === 'running' || this.state === 'starting') {
      this.state = 'stopping';
      for (const job of this.registry.values()) this.timers.disarm(job);
      this.leases?.stopWatching();
      this.abort.abort();
      await this.waitForRuns(timeoutMs);
      this.leases?.stopRenewing();
    }
    this.state = 'idle';
    await this.closeBackend();
  }

  private async waitForRuns(timeoutMs: number): Promise<void> {
    if (this.inflight.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    await Promise.race([Promise.allSettled([...this.inflight]), timeout]);
    clearTimeout(timer);
  }

  private ensureReady(): Promise<void> {
    this.ready ??= this.backend.init().catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  private prepare(job: Job): Promise<void> {
    job.prepared ??= this.backend.prepareJob(job.name, job.historySize).catch((error: unknown) => {
      job.prepared = undefined;
      throw error;
    });
    return job.prepared;
  }

  private async closeBackend(): Promise<void> {
    this.ready = undefined;
    for (const job of this.registry.values()) job.prepared = undefined;
    try {
      await this.backend.close();
    } catch (error) {
      this.logger.warn(`[anarchon] closing ${this.backend.name} failed: ${errorMessage(error)}`);
    }
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.inflight.add(promise);
    const remove = () => {
      this.inflight.delete(promise);
    };
    promise.then(remove, remove);
    return promise;
  }

  private emit<E extends keyof SchedulerEvents>(event: E, payload: SchedulerEvents[E]): void {
    if (event === 'error' && this.emitter.listenerCount('error') === 0) {
      const { error, job } = payload as SchedulerErrorEvent;
      this.logger.error(`[anarchon]${job ? ` job "${job}":` : ''} ${errorMessage(error)}`);
      return;
    }
    try {
      this.emitter.emit(event, payload);
    } catch (error) {
      this.logger.error(`[anarchon] a "${event}" listener threw: ${errorMessage(error)}`);
    }
  }

  private getJob(name: string): Job {
    const job = this.registry.get(name);
    if (!job) throw new Error(`Unknown job "${name}"`);
    return job;
  }

  private nextRunOf(job: Job): Date | null {
    const slot = this.state === 'running' ? job.nextSlot : job.schedule.next(Date.now());
    return slot === null ? null : new Date(slot);
  }
}

setSchedulerFactory((options) => new Scheduler(options));
