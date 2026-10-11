/* Copyright (C) 2026-present Aristotelis — see repository license. */

import { parseDuration } from './schedule';
import type { Scheduler } from './scheduler/scheduler';
import type { CronJobOptions, EveryJobOptions, JobHandler, JobOptions } from './types';

/** Which scheduler a job declared with a decorator goes to. */
export interface JobPlacement {
  /**
   * The scheduler this job is added to: its name, or the scheduler itself. Default: the default
   * scheduler. A named scheduler that doesn't exist yet is created from its settings (see
   * `Scheduler.configure()`); jobs that give the same name share one scheduler.
   */
  scheduler?: string | Scheduler;
}

/** A job's options, plus what a decorator adds: the job's name and the scheduler it goes to. */
export type DecoratedJobOptions<Options> = Options &
  JobPlacement & {
    /**
     * The job's name. Default `Class-method`, which every backend accepts. Set it so that renaming
     * the class or the method, or minifying the code, can't change it: the name is the job's identity
     * in the backend and must be the same on every instance.
     */
    name?: string;
  };

type Declaration = { name?: string; scheduler?: string | object } & (
  | { type: 'cron'; expression: string; options: CronJobOptions }
  | { type: 'every'; interval: number | string; options: EveryJobOptions }
  | { type: 'at'; when: Date | number | string; options: JobOptions }
);

/** A job declared on a method, bound to one object. */
export type DeclaredJob = Declaration & { name: string; handler: JobHandler };

/**
 * A method decorator that works with both decorator styles: standard decorators (TypeScript 5+, no
 * compiler flag) and legacy ones (`experimentalDecorators`, the style NestJS and Angular use).
 */
export interface JobDecorator {
  <Data>(method: JobHandler<Data>, context: ClassMethodDecoratorContext): void;
  <Method extends JobHandler<never>>(target: object, propertyKey: string | symbol, descriptor: TypedPropertyDescriptor<Method>): void;
}

type AnyClass = abstract new (...args: never[]) => object;

/** A class decorator that works with both decorator styles. */
export interface ScheduledDecorator {
  <Class extends AnyClass>(target: Class, context: ClassDecoratorContext<Class>): void;
  <Class extends AnyClass>(target: Class): Class;
}

/** Options of `scheduler.register()`: they apply to the jobs of the one object being registered. */
export interface RegisterOptions {
  /**
   * Put in front of the name of every job of this object. With a prefix of its own, each object of
   * one class has its own jobs: `tenant-a:sync` and `tenant-b:sync`.
   */
  prefix?: string;
  /**
   * Job options for every job of this object. An option a job sets in its decorator wins, and the
   * scheduler's settings apply to what neither sets. `timezone` is used by cron jobs only.
   */
  defaults?: JobOptions & Pick<CronJobOptions, 'timezone'>;
}

const declarations = new WeakMap<object, Declaration[]>();
/** Method to the jobs declared on it that no object has added to a scheduler, for the warning a starting scheduler gives. */
const unadded = new Map<object, Array<{ label: string; legacy: boolean; scheduled: boolean }>>();
let objectCreated: (target: object) => void = () => {};

/** Sets what happens when an object of a decorated class is created. The scheduler registry sets it. */
export function onObjectCreated(handler: (target: object) => void): void {
  objectCreated = handler;
}

/** The methods an object of a class has, from its prototype up: an overriding method hides the one it overrides. */
function* methodsFrom(prototype: object | null): Generator<[string | symbol, (...args: never[]) => unknown]> {
  const seen = new Set<string | symbol>();
  for (let proto = prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const key of Reflect.ownKeys(proto)) {
      if (seen.has(key)) continue;
      seen.add(key);
      const method: unknown = Object.getOwnPropertyDescriptor(proto, key)?.value;
      if (typeof method === 'function') yield [key, method as (...args: never[]) => unknown];
    }
  }
}

/** The jobs declared with decorators on an object's class and the classes it extends. */
export function declaredJobs(target: object): DeclaredJob[] {
  const jobs: DeclaredJob[] = [];
  const className = target.constructor?.name;
  for (const [key, method] of methodsFrom(Object.getPrototypeOf(target))) {
    for (const declaration of declarations.get(method) ?? []) {
      jobs.push({
        ...declaration,
        name: declaration.name ?? (className ? `${className}-${String(key)}` : String(key)),
        handler: (ctx) => (method as JobHandler).call(target, ctx),
      });
    }
  }
  return jobs;
}

/** An object added its jobs: they are no longer reported as declared but never added. */
export function markAdded(target: object): void {
  for (const [, method] of methodsFrom(Object.getPrototypeOf(target))) unadded.delete(method);
}

/** One warning for each declared job that no object has added to a scheduler. Each is given once. */
export function takeUnaddedWarnings(): string[] {
  const warnings = [...unadded.values()]
    .flat()
    .map(({ label, legacy, scheduled }) =>
      legacy && !scheduled
        ? `${label} is not scheduled: with legacy decorators, add @Scheduled() to the class or call scheduler.register(object)`
        : `${label} is not scheduled: no object of its class has been created`,
    );
  unadded.clear();
  return warnings;
}

/** Forgets which declared jobs were never added, without reporting them. */
export function forgetUnadded(): void {
  unadded.clear();
}

function declare(decorator: string, declaration: Declaration): JobDecorator {
  return (first: object, second: ClassMethodDecoratorContext | string | symbol, descriptor?: PropertyDescriptor): void => {
    const standard = typeof second === 'object';
    const method: unknown = standard ? first : descriptor?.value;
    // Jobs are found on the prototype of an object, which static and #private methods are not on.
    const onPrototype = standard ? second.kind === 'method' && !second.static && !second.private : typeof first !== 'function';
    if (typeof method !== 'function' || !onPrototype) {
      throw new TypeError(`@${decorator} can only decorate a public instance method`);
    }
    // Decorators are applied bottom-up; adding at the front keeps the order they are written in.
    declarations.set(method, [declaration, ...(declarations.get(method) ?? [])]);
    const schedule =
      declaration.type === 'cron' ? declaration.expression : declaration.type === 'every' ? declaration.interval : declaration.when;
    const job = declaration.name ? `@${decorator} "${declaration.name}"` : `@${decorator}(${JSON.stringify(schedule)})`;
    const where = standard ? `the method "${String(second.name)}"` : `${first.constructor?.name || 'a class'}.${String(second)}`;
    unadded.set(method, [...(unadded.get(method) ?? []), { label: `${job} on ${where}`, legacy: !standard, scheduled: false }]);
    // Standard decorators can run code when an object is created. Legacy ones can't: @Scheduled() does it for them.
    if (standard) {
      second.addInitializer(function (this: unknown) {
        if (typeof this === 'object' && this !== null) objectCreated(this);
      });
    }
  };
}

interface ScheduleKind {
  decorator: string;
  /** Whether an argument can be the schedule at all; a plain options object can't. */
  isValue(arg: unknown): boolean;
  /** Whether a value reads as a schedule of this kind. Only used to recognize two arguments given in the wrong order. */
  looksValid(value: unknown): boolean;
  /** The right way to write the two-argument form. */
  usage: string;
}

interface Parsed<Value, Options> {
  name?: string;
  scheduler?: string | object;
  value: Value;
  options: Options;
}

/** Splits `(name, value, options)` from `(value, options)`, and takes the decorator's own options out of the job's. */
function parse<Value, Options>(kind: ScheduleKind, args: unknown[]): Parsed<Value, Options> {
  const [first, second, third] = args;
  const nameFirst = kind.isValue(second);
  // The name and the schedule can both be strings, so swapping them, or passing something else as the
  // second string, would otherwise surface later as an invalid schedule of a job with a strange name.
  if (nameFirst && (typeof first !== 'string' || (!kind.looksValid(second) && kind.looksValid(first)))) {
    throw new TypeError(`@${kind.decorator}(${JSON.stringify(first)}, ${JSON.stringify(second)}): ${kind.usage}`);
  }
  const { name, scheduler, ...options } = ((nameFirst ? third : second) ?? {}) as DecoratedJobOptions<Options>;
  if (scheduler !== undefined && (typeof scheduler === 'string' ? scheduler === '' : typeof scheduler !== 'object' || scheduler === null)) {
    throw new TypeError(`@${kind.decorator}: scheduler must be the name of a scheduler, or a Scheduler`);
  }
  return {
    name: nameFirst ? (first as string) : name,
    scheduler,
    value: (nameFirst ? second : first) as Value,
    options: options as Options,
  };
}

const isTextOrNumber = (arg: unknown): boolean => typeof arg === 'string' || typeof arg === 'number';

function isDuration(value: unknown): boolean {
  if (!isTextOrNumber(value)) return false;
  try {
    parseDuration(value as number | string);
    return true;
  } catch {
    return false;
  }
}

const CRON: ScheduleKind = {
  decorator: 'Cron',
  isValue: (arg) => typeof arg === 'string',
  // 5 to 7 fields, or a nickname such as @daily.
  looksValid: (value) => typeof value === 'string' && /^\s*(@\w+|\S+(\s+\S+){4,6})\s*$/.test(value),
  usage:
    "with two strings, the first is the job's name and the second the cron expression: @Cron(name, expression). " +
    'A time zone goes in the options: @Cron(expression, { timezone })',
};

const EVERY: ScheduleKind = {
  decorator: 'Every',
  isValue: isTextOrNumber,
  looksValid: isDuration,
  usage: "the job's name, a string, comes first and the interval second: @Every(name, interval)",
};

const AT: ScheduleKind = {
  decorator: 'At',
  isValue: (arg) => isTextOrNumber(arg) || arg instanceof Date,
  looksValid: (value) =>
    Number.isFinite(
      value instanceof Date ? value.getTime() : typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN,
    ),
  usage: "the job's name, a string, comes first and the time second: @At(name, when)",
};

/**
 * Declares a cron job on a method. Same arguments as `scheduler.cron()` without the handler; the
 * name can be left out, or given in the options.
 *
 * The job is added to a scheduler when an object of the class is created: the default scheduler, or
 * the one named in the `scheduler` option. With legacy decorators the class also needs `@Scheduled()`.
 *
 * @example
 * ```ts
 * class Reports {
 *   @Cron('weekday-digest', '0 8 * * 1-5', { timezone: 'Europe/Athens' })
 *   async digest(ctx: JobContext) {}
 *
 *   @Cron('30 3 * * *') // named 'Reports-cleanup'
 *   async cleanup() {}
 *
 *   @Cron('month-end', '0 6 1 * *', { scheduler: 'billing' }) // on the scheduler named 'billing'
 *   async close() {}
 * }
 * ```
 */
export function Cron(expression: string, options?: DecoratedJobOptions<CronJobOptions>): JobDecorator;
export function Cron(name: string, expression: string, options?: CronJobOptions & JobPlacement): JobDecorator;
export function Cron(...args: unknown[]): JobDecorator {
  const { name, scheduler, value, options } = parse<string, CronJobOptions>(CRON, args);
  return declare('Cron', { type: 'cron', expression: value, options, name, scheduler });
}

/**
 * Declares an interval job on a method. Same arguments as `scheduler.every()` without the handler;
 * the name can be left out, or given in the options.
 *
 * @example
 * ```ts
 * class Customers {
 *   @Every('sync-customers', '10s', { timeoutMs: 8_000 })
 *   async sync(ctx: JobContext) {}
 *
 *   @Every('1h', { name: 'prune-customers' })
 *   async prune() {}
 * }
 * ```
 */
export function Every(interval: number | string, options?: DecoratedJobOptions<EveryJobOptions>): JobDecorator;
export function Every(name: string, interval: number | string, options?: EveryJobOptions & JobPlacement): JobDecorator;
export function Every(...args: unknown[]): JobDecorator {
  const { name, scheduler, value, options } = parse<number | string, EveryJobOptions>(EVERY, args);
  return declare('Every', { type: 'every', interval: value, options, name, scheduler });
}

/**
 * Declares a one-off job on a method. Same arguments as `scheduler.at()` without the handler; the
 * name can be left out, or given in the options. `when` is an absolute time, so every instance
 * agrees on it; a delay counted from the start of each process would give each instance its own run.
 *
 * @example
 * ```ts
 * class Launch {
 *   @At('announce-launch', '2026-12-01T09:00:00Z')
 *   async announce() {}
 * }
 * ```
 */
export function At(when: Date | number | string, options?: DecoratedJobOptions<JobOptions>): JobDecorator;
export function At(name: string, when: Date | number | string, options?: JobOptions & JobPlacement): JobDecorator;
export function At(...args: unknown[]): JobDecorator {
  const { name, scheduler, value, options } = parse<Date | number | string, JobOptions>(AT, args);
  return declare('At', { type: 'at', when: value, options, name, scheduler });
}

/**
 * Makes the objects of a class add their jobs to their schedulers when they are created. Needed
 * with legacy decorators (`experimentalDecorators`) only: standard decorators do this by
 * themselves, and there `@Scheduled()` changes nothing.
 *
 * @example
 * ```ts
 * @Scheduled()
 * class Reports {
 *   @Every('10s')
 *   async sync() {}
 * }
 * ```
 */
export function Scheduled(): ScheduledDecorator {
  return ((target: new (...args: unknown[]) => object, context?: ClassDecoratorContext) => {
    if (context) return undefined;
    const Wrapped = class extends target {
      constructor(...args: unknown[]) {
        super(...args);
        objectCreated(this);
      }
    };
    // Same name as the class it wraps, so the default job names don't change.
    Object.defineProperty(Wrapped, 'name', { value: target.name });
    for (const [, method] of methodsFrom(target.prototype)) for (const job of unadded.get(method) ?? []) job.scheduled = true;
    return Wrapped;
  }) as ScheduledDecorator;
}
