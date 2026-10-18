/* Copyright (C) 2026-present Aristotelis — see repository license. */

// Which schedulers there are (the default one, the named ones, the ones that can be created from
// settings), and on which of them the jobs of each decorated object live.
import {
  type DeclaredJob,
  declaredJobs,
  forgetUnadded,
  markAdded,
  onObjectCreated,
  type RegisterOptions,
  takeUnaddedWarnings,
} from './decorators';
import type { Backend, SchedulerOptions } from './types';

/**
 * Settings a scheduler is created from when a decorated job needs it: the options of
 * `new Scheduler()`, with a backend that must be given, and whether to start it. Use them when the
 * decorated classes are created before your code would create the scheduler (a framework's
 * dependency injection), or to keep the setup of several schedulers in one place.
 *
 * @example The default scheduler, created when the first decorated object needs it
 * ```ts
 * Scheduler.configure({ backend: new PostgresBackend({ connection: process.env.DATABASE_URL }), timezone: 'Europe/Athens' });
 *
 * class Reports {
 *   @Cron('digest', '0 8 * * 1-5')
 *   digest() {}
 * }
 * new Reports();               // creates the default scheduler from the settings and adds 'digest'
 * await Scheduler.startAll();
 * ```
 *
 * @example One set of settings for every named scheduler, each with its own key prefix
 * ```ts
 * Scheduler.configure({
 *   backend: (name) => new RedisBackend({ redis: process.env.REDIS_URL, prefix: `cron:${name}:` }),
 *   autoStart: true,
 * });
 * // @Every('sync', '1m', { scheduler: 'billing' }) creates the 'billing' scheduler on keys 'cron:billing:...'
 * ```
 *
 * @example Settings of their own for one named scheduler
 * ```ts
 * Scheduler.configure('billing', { backend: new PostgresBackend({ connection: billingPool }), leaseMs: 10_000 });
 * ```
 */
export interface ConfigureOptions extends Omit<SchedulerOptions, 'backend' | 'name'> {
  /**
   * Where runs are claimed and recorded. A function is called with the scheduler's name
   * (`'default'` for the default one) and returns a backend for it: that lets one set of settings
   * serve several schedulers, each with its own table or key prefix. A backend object can serve
   * one scheduler only, so default settings with an object can't create named schedulers.
   *
   * @example
   * ```ts
   * Scheduler.configure({ backend: new SqliteBackend({ database: './jobs.db' }) });                     // one scheduler
   * Scheduler.configure({ backend: (name) => new PostgresBackend({ connection: pool, table: `jobs_${name}` }) }); // one table each
   * ```
   */
  backend: Backend | ((name: string) => Backend);
  /**
   * Start the scheduler as soon as it is created. A failure to start is reported as an `'error'`
   * event. Default false: you start it, with `Scheduler.get(name).start()` or `Scheduler.startAll()`.
   *
   * @example A worker whose jobs should run as soon as their classes are created
   * ```ts
   * Scheduler.configure({ backend, autoStart: true });
   * Scheduler.get().on('error', ({ error }) => log.error('scheduler', error));
   * ```
   */
  autoStart?: boolean;
}

/** What the registry uses of one scheduler. The Scheduler builds it in its constructor. */
export interface SchedulerHost {
  /** The Scheduler object, as the registry hands it out. */
  readonly scheduler: object;
  /** Its name, or undefined for an unnamed scheduler (which can be the default one). */
  readonly name: string | undefined;
  /** Adds one declared job under `name`, with the object's `register()` defaults under its own options. */
  add(job: DeclaredJob, name: string, defaults: NonNullable<RegisterOptions['defaults']>): void;
  /** Removes a job. false when there was none by that name. */
  remove(name: string): boolean;
  /** Whether a job by that name is on the scheduler. */
  has(name: string): boolean;
  /** Starts the scheduler without waiting, reporting a failure as an 'error' event (`autoStart`). */
  startInBackground(): void;
}

interface Placement {
  jobs: Array<{ host: SchedulerHost; name: string }>;
  options: RegisterOptions;
  /** The scheduler the object was registered on by hand, which then holds all its jobs. */
  forced: SchedulerHost | undefined;
}

const DEFAULT_NAME = 'default';

const hosts = new WeakMap<object, SchedulerHost>();
const named = new Map<string, SchedulerHost>();
/** Settings by scheduler name; the default scheduler's are under `undefined`. */
const settings = new Map<string | undefined, ConfigureOptions>();
const placements = new WeakMap<object, Placement>();
/** Class to the newest object of it that couldn't add its jobs yet: a scheduler it needs doesn't exist. */
const waiting = new Map<unknown, object>();
let defaultScheduler: SchedulerHost | undefined;
let factory: ((options: SchedulerOptions) => object) | undefined;

/**
 * How a scheduler is created from settings. Set by the scheduler module, which the registry can't import.
 *
 * @example
 * ```ts
 * setSchedulerFactory((options) => new Scheduler(options)); // once, in scheduler.ts
 * ```
 */
export function setSchedulerFactory(create: (options: SchedulerOptions) => object): void {
  factory = create;
}

/** A scheduler's own settings, else the default settings when their backend is a function. */
function settingsFor(name: string | undefined): ConfigureOptions | undefined {
  const own = settings.get(name);
  if (own || name === undefined) return own;
  const shared = settings.get(undefined);
  if (!shared || typeof shared.backend === 'function') return shared;
  throw new Error(
    `Scheduler "${name}" has no settings of its own, and the default settings hold a backend object, which two schedulers can't share. ` +
      `Call Scheduler.configure("${name}", { ... }), or give the default settings a function: backend: (name) => ...`,
  );
}

/** Creates a scheduler from settings, and starts it in the background with `autoStart`. */
function create(name: string | undefined, { autoStart, backend, ...options }: ConfigureOptions): SchedulerHost {
  if (!factory) throw new Error('No scheduler can be created yet');
  const built = typeof backend === 'function' ? backend(name ?? DEFAULT_NAME) : backend;
  const host = hosts.get(factory({ ...options, backend: built, ...(name === undefined ? {} : { name }) }));
  if (!host) throw new Error('The scheduler that was created is not known to the registry');
  if (autoStart) host.startInBackground();
  return host;
}

/** The scheduler a job goes to: an existing one, or one created from settings. Undefined when there is neither. */
function resolve(reference: string | object | undefined): SchedulerHost | undefined {
  if (typeof reference === 'object') {
    const host = hosts.get(reference);
    if (!host) throw new TypeError('scheduler must be the name of a scheduler, or a Scheduler');
    return host;
  }
  const existing = reference === undefined ? defaultScheduler : named.get(reference);
  if (existing) return existing;
  const from = settingsFor(reference);
  return from ? create(reference, from) : undefined;
}

/**
 * Puts the jobs of an object on their schedulers, in place of where they were. All of them or
 * none: when one is refused, the object's jobs are left as they were.
 *
 * @param forced The scheduler that takes every job, whatever scheduler each job names.
 * @returns false when a scheduler one of the jobs names doesn't exist and can't be created yet.
 */
function place(target: object, options: RegisterOptions, forced: SchedulerHost | undefined): boolean {
  const declared = declaredJobs(target);
  if (declared.length === 0) {
    throw new TypeError('register() needs an object whose class has methods decorated with @Cron, @Every or @At');
  }
  const plan: Array<{ host: SchedulerHost; job: DeclaredJob; name: string }> = [];
  for (const job of declared) {
    const host = forced ?? resolve(job.scheduler);
    if (!host) return false;
    plan.push({ host, job, name: (options.prefix ?? '') + job.name });
  }

  const previous = placements.get(target);
  for (const { host, name } of previous?.jobs ?? []) host.remove(name);
  const added: Placement['jobs'] = [];
  try {
    for (const { host, job, name } of plan) {
      host.add(job, name, options.defaults ?? {});
      added.push({ host, name });
    }
  } catch (error) {
    for (const { host, name } of added) host.remove(name);
    placements.delete(target);
    if (previous) {
      try {
        place(target, previous.options, previous.forced);
      } catch {
        // The jobs that were there can't be put back; the error that caused this is the one to report.
      }
    }
    throw error;
  }
  placements.set(target, { jobs: added, options, forced });
  for (const [key, waited] of waiting) if (waited === target) waiting.delete(key);
  markAdded(target);
  return true;
}

/** Retries the objects that waited for a scheduler, once one may exist. */
function placeWaiting(): void {
  for (const target of [...waiting.values()]) place(target, {}, undefined);
}

onObjectCreated((target) => {
  if (placements.has(target)) return;
  try {
    if (!place(target, {}, undefined)) waiting.set(target.constructor, target);
  } catch (error) {
    // The usual cause is a second object of one class, which register() with a prefix solves.
    if (!(error instanceof Error) || !/is already registered$/.test(error.message)) throw error;
    throw new Error(
      `${error.message}. To use several objects of one class, register each of them with a prefix of its own: scheduler.register(object, { prefix })`,
      { cause: error },
    );
  }
});

/**
 * `scheduler.register(target, options)`: every job of the object goes on that scheduler. Registering
 * again without options keeps the jobs as they are; with options, it replaces them.
 *
 * @example
 * ```ts
 * scheduler.register(new TenantJobs('acme'), { prefix: 'acme:', defaults: { data: { tenant: 'acme' } } });
 * // registerOn(host of scheduler, object, { prefix: 'acme:', ... }): adds 'acme:sync', 'acme:report', ...
 * ```
 */
export function registerOn(host: SchedulerHost, target: object, options: RegisterOptions): void {
  if (options.prefix !== undefined && typeof options.prefix !== 'string') throw new TypeError('register(): prefix must be a string');
  if (options.defaults !== undefined && (typeof options.defaults !== 'object' || options.defaults === null)) {
    throw new TypeError('register(): defaults must be an object of job options');
  }
  const placed = placements.get(target);
  const here = placed?.jobs.every((job) => job.host === host) ? placed : undefined;
  const asked = options.prefix !== undefined || options.defaults !== undefined;
  if (here && !asked && here.jobs.every(({ name }) => host.has(name))) return;
  place(target, here && !asked ? here.options : options, host);
}

/**
 * A scheduler was created: it takes its name, or the role of default scheduler if nobody has it. Adds no jobs.
 *
 * @example
 * ```ts
 * new Scheduler({ name: 'billing', backend }); // schedulerCreated(host): 'billing' is taken
 * new Scheduler({ name: 'billing', backend }); // throws: A scheduler named "billing" already exists
 * ```
 */
export function schedulerCreated(host: SchedulerHost): void {
  if (host.name !== undefined) {
    if (named.has(host.name)) throw new Error(`A scheduler named "${host.name}" already exists`);
    named.set(host.name, host);
  } else {
    defaultScheduler ??= host;
  }
  hosts.set(host.scheduler, host);
}

/**
 * A scheduler is starting: it takes back its name or the default role if it gave it up when it
 * stopped, and the objects that were waiting for a scheduler add their jobs.
 *
 * @returns one warning for each declared job that still no object has added.
 *
 * @example
 * ```ts
 * await scheduler.start(); // schedulerStarting(host); each warning is logged:
 * // [anarchon] @Every "sync" on Reports.sync is not scheduled: with legacy decorators, add @Scheduled() ...
 * ```
 */
export function schedulerStarting(host: SchedulerHost): string[] {
  if (host.name === undefined) {
    defaultScheduler ??= host;
    if (defaultScheduler !== host) return [];
  } else {
    const holder = named.get(host.name);
    if (holder && holder !== host) throw new Error(`A scheduler named "${host.name}" already exists`);
    named.set(host.name, host);
  }
  placeWaiting();
  return takeUnaddedWarnings();
}

/**
 * A scheduler was stopped: it gives up its name or the default role until it is started again, so
 * a new scheduler can take them (a test, or a restart within one process).
 *
 * @example
 * ```ts
 * await old.stop();                                  // schedulerStopped(host)
 * const next = new Scheduler({ name: 'billing', backend }); // allowed: 'billing' is free
 * ```
 */
export function schedulerStopped(host: SchedulerHost): void {
  if (defaultScheduler === host) defaultScheduler = undefined;
  if (host.name !== undefined && named.get(host.name) === host) named.delete(host.name);
}

/**
 * Chooses the default scheduler. `undefined`: no default scheduler, and no object waiting for one.
 *
 * @example
 * ```ts
 * Scheduler.setDefault(main); // setDefaultScheduler(host of main): undecorated-scheduler jobs go to main
 * ```
 */
export function setDefaultScheduler(host: SchedulerHost | undefined): void {
  defaultScheduler = host;
  if (host) {
    placeWaiting();
  } else {
    waiting.clear();
    forgetUnadded();
  }
}

/**
 * Stores the settings a scheduler is created from, and lets the objects that waited for it add their
 * jobs. Throws when that scheduler already exists: settings only apply to one not created yet.
 *
 * @example
 * ```ts
 * Scheduler.configure('billing', { backend }); // configure('billing', { backend })
 * Scheduler.configure({ backend });            // configure(undefined, ...): the default scheduler
 * ```
 */
export function configure(name: string | undefined, options: ConfigureOptions): void {
  if (name !== undefined && (typeof name !== 'string' || name === ''))
    throw new TypeError('Scheduler.configure(): name must be a non-empty string');
  if (typeof options !== 'object' || options === null || !options.backend) {
    throw new TypeError('Scheduler.configure() needs a backend, e.g. backend: new RedisBackend({ redis: url })');
  }
  if (name === undefined ? defaultScheduler : named.get(name)) {
    throw new Error(
      `${name === undefined ? 'The default scheduler' : `The scheduler "${name}"`} already exists: configure it before it is created`,
    );
  }
  settings.set(name, options);
  placeWaiting();
}

/**
 * The default scheduler or a named one, created from its settings if it doesn't exist. Throws when
 * there is neither a scheduler nor settings to create it from.
 *
 * @example
 * ```ts
 * Scheduler.get();          // getScheduler(undefined): the default scheduler
 * Scheduler.get('billing'); // getScheduler('billing')
 * ```
 */
export function getScheduler(name: string | undefined): object {
  const host = resolve(name);
  if (host) return host.scheduler;
  throw new Error(
    name === undefined
      ? 'There is no default scheduler: create one with new Scheduler(...), or give its settings to Scheduler.configure({ ... })'
      : `There is no scheduler named "${name}": create it with new Scheduler({ name: "${name}", ... }), or give its settings to Scheduler.configure("${name}", { ... })`,
  );
}

/**
 * The default scheduler and the named ones, each once.
 *
 * @example
 * ```ts
 * await Scheduler.startAll(); // starts every scheduler knownSchedulers() returns
 * ```
 */
export function knownSchedulers(): object[] {
  return [...new Set([...(defaultScheduler ? [defaultScheduler] : []), ...named.values()])].map((host) => host.scheduler);
}

/**
 * Back to the initial state: no default scheduler, no names, no settings, nothing waiting. Stops nothing.
 *
 * @example Between tests
 * ```ts
 * afterEach(async () => {
 *   await Scheduler.stopAll();
 *   Scheduler.reset(); // resetSchedulers()
 * });
 * ```
 */
export function resetSchedulers(): void {
  defaultScheduler = undefined;
  named.clear();
  settings.clear();
  waiting.clear();
  forgetUnadded();
}

/**
 * The scheduler module's handle for a scheduler object.
 *
 * @example
 * ```ts
 * const host = hostOf(scheduler); // undefined for an object that is not a Scheduler
 * ```
 */
export function hostOf(scheduler: object): SchedulerHost | undefined {
  return hosts.get(scheduler);
}
