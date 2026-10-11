---
title: Decorators
description: "@Every, @Cron, @At and @Scheduled, with Scheduler.configure(), get(), register() and the rest: signatures, examples and what to watch for."
---

```ts
import { At, Cron, Every, Scheduled, Scheduler } from 'anarchon';
```

The decorators declare jobs on the methods of a class. An object of the class adds those jobs to their schedulers when it is created. Guide: [Decorators](../../guides/decorators/).

## Method decorators

All three have two forms: with the job's name first, or without it. They only record the schedule; the job is validated when it is added to a scheduler.

### `@Every`

```ts
Every(name: string, interval: number | string, options?: EveryJobOptions & { scheduler? }): JobDecorator
Every(interval: number | string, options?: EveryJobOptions & { name?, scheduler? }): JobDecorator
```

Declares an interval job, as [`every()`](../scheduler/#everyname-interval-handler-options) does. The interval is milliseconds or a duration string; the shortest is 1 second.

```ts
class Customers {
  @Every('sync-customers', '10s', { timeoutMs: 8_000 })
  async sync(ctx: JobContext) {}

  @Every('1h', { name: 'prune-customers', overlap: 'allow' })
  async prune() {}

  @Every(60_000) // named 'Customers-report'
  async report() {}
}
```

### `@Cron`

```ts
Cron(name: string, expression: string, options?: CronJobOptions & { scheduler? }): JobDecorator
Cron(expression: string, options?: CronJobOptions & { name?, scheduler? }): JobDecorator
```

Declares a cron job, as [`cron()`](../scheduler/#cronname-expression-handler-options) does. The expression has 5 fields, or 6 with seconds first.

```ts
class Reports {
  @Cron('weekday-digest', '0 8 * * 1-5', { timezone: 'Europe/Athens' })
  async digest(ctx: JobContext) {}

  @Cron('month-end', '0 6 1 * *', { scheduler: 'billing', timeoutMs: 30 * 60_000 })
  async close() {}
}
```

:::caution[Two strings mean a name and an expression]
With two strings, the first is the job's name and the second the expression. The time zone goes in the options: `@Cron('0 8 * * *', { timezone: 'Europe/Athens' })`. Writing `@Cron('0 8 * * *', 'Europe/Athens')` throws `TypeError` when the class is defined, and the message gives the right form.
:::

### `@At`

```ts
At(name: string, when: Date | number | string, options?: JobOptions & { scheduler? }): JobDecorator
At(when: Date | number | string, options?: JobOptions & { name?, scheduler? }): JobDecorator
```

Declares a one-off job, as [`at()`](../scheduler/#atname-when-handler-options) does. `when` is a `Date`, ms since 1970, or an ISO string.

```ts
class Launch {
  @At('announce-launch', '2026-12-01T09:00:00Z')
  async announce() {}

  @At(new Date(Date.UTC(2027, 0, 1)), { name: 'new-year', catchUpMs: 60 * 60_000 })
  async newYear() {}
}
```

:::caution[An absolute time, not a delay]
Every instance must compute the same time. `@At(Date.now() + 5_000)` is a different moment in each process, so each instance runs the job. There is no `@Timeout` for this reason.
:::

### What the three have in common

| | |
| --- | --- |
| Where | Public instance methods. On a `static` or `#private` method they throw `TypeError` when the class is defined |
| Name | First argument, or `name` in the options, or `Class-method` when neither is given |
| Options | The [job options](../options/#job-options) of the matching method, [`data`](../../guides/run-data/) included |
| `scheduler` | The scheduler the job goes to: a name, or a `Scheduler`. Default: the default scheduler |
| The method | Receives the [`JobContext`](../types/#jobcontext), and runs with `this` set to the object |
| Several on one method | Allowed. Each needs its own name |
| Inheritance | A subclass inherits them. An overriding method replaces them |

The form with the name first is chosen when the second argument is a string or a number (for `@At`, also a `Date`).

Because the name and the schedule can both be strings, two arguments in the wrong order are refused when the class is defined: the decorator throws `TypeError` if the first argument reads as a schedule and the second doesn't.

```ts
@Every('1h', 'sync')                 // TypeError: ... the job's name, a string, comes first and the interval second: @Every(name, interval)
@Cron('0 8 * * *', 'Europe/Athens')  // TypeError: ... A time zone goes in the options: @Cron(expression, { timezone })
@At('2026-12-01T09:00:00Z', 'launch') // TypeError: ... @At(name, when)
```

## `@Scheduled()`

```ts
Scheduled(): ScheduledDecorator
```

A class decorator for projects compiled with legacy decorators (`"experimentalDecorators": true`). It makes the objects of the class add their jobs when they are created, which legacy method decorators can't do on their own.

```ts
@Scheduled()
class Reports {
  @Every('sync-customers', '10s')
  async sync() {}
}

new Reports(); // adds 'sync-customers'
```

| Decorator style | What `@Scheduled()` does |
| --- | --- |
| Standard | Nothing. Objects already add their jobs by themselves |
| Legacy | Replaces the class with a subclass of the same name that adds the jobs at the end of the constructor |

:::caution[Legacy decorators without `@Scheduled()`]
With legacy decorators, a class that has neither `@Scheduled()` nor a `register()` call adds no jobs. A starting scheduler [warns about it](#jobs-that-were-never-added).
:::

## Schedulers for decorated jobs

### `Scheduler.configure(options)`

```ts
static configure(options: ConfigureOptions): void
static configure(name: string, options: ConfigureOptions): void
```

Stores the settings a scheduler is created from when a decorated job needs it. Without a name they are the default scheduler's; with a name, those of the scheduler that jobs choose with `{ scheduler: name }`. It creates nothing by itself.

`ConfigureOptions` is the [scheduler options](../options/#scheduler-options), with two differences:

| Option | Type | Meaning |
| --- | --- | --- |
| `backend` | `Backend`, or `(name: string) => Backend` | Required unless `redis` is given. A function is called with the scheduler's name (`'default'` for the default one), so one set of settings serves several schedulers |
| `autoStart` | `boolean`, default `false` | Start the scheduler when it is created. A failure to start is an `'error'` event |

```ts
Scheduler.configure({ redis: process.env.REDIS_URL, autoStart: true });

Scheduler.configure({ backend: (name) => new PostgresBackend({ connection: pool, table: `cron_${name}` }) });
Scheduler.configure('billing', { redis: process.env.BILLING_REDIS_URL, leaseMs: 10_000 });
```

A named scheduler without settings of its own is created from the default ones:

| Default settings | A scheduler named `reports` gets |
| --- | --- |
| `backend` is a function | `backend('reports')` |
| `redis` | The same connection settings, with the key prefix `<prefix>reports:` (`cron:reports:` by default) |
| `backend` is an object | Nothing: creating it throws, because two schedulers can't share one backend object |

**Throws** `TypeError` when neither `backend` nor `redis` is given; `Error` when that scheduler already exists, or when an object that was waiting for it can't add its jobs.

### `Scheduler.get(name?)`

```ts
static get(name?: string): Scheduler
```

The default scheduler, or the one with that name. It is created from its settings if it doesn't exist yet.

```ts
await Scheduler.get().start();
console.table(Scheduler.get('billing').jobs());
```

**Throws** `Error` when it doesn't exist and has no settings.

### `Scheduler.all()`, `startAll()`, `stopAll()`

```ts
static all(): Scheduler[]
static startAll(): Promise<void>
static stopAll(options?: { timeoutMs?: number }): Promise<void>
```

`all()` is the default scheduler and every scheduler that has a name. `startAll()` and `stopAll()` start and stop them. `startAll()` starts every one even if one fails, then rejects with the first failure.

```ts
new Jobs();
await Scheduler.startAll();
process.on('SIGTERM', () => Scheduler.stopAll().then(() => process.exit(0)));
```

A scheduler created without a name that isn't the default is not in `all()`: start and stop it yourself.

### `Scheduler.setDefault(scheduler)`

```ts
static setDefault(scheduler: Scheduler | undefined): void
```

Chooses the default scheduler: the one that takes the decorated jobs that name none.

- Without this call, it is the first scheduler created without a `name`, or the one created from the default settings.
- When the default scheduler is stopped, the next unnamed scheduler created or started becomes the default.
- Objects that were waiting for a default scheduler add their jobs to the one given here.
- `undefined`: no default scheduler, and no object waiting for one.

**Throws** what `register()` throws, when a waiting object can't add its jobs.

### `Scheduler.reset()`

```ts
static reset(): void
```

Forgets the default scheduler, the names, the settings given to `configure()` and the objects waiting for a scheduler. It stops nothing. Meant for tests, between cases.

### `new Scheduler({ name })`

A scheduler you create yourself takes a name with the `name` option, and jobs choose it by that name. A second scheduler with the same name throws. A stopped scheduler gives up its name, and the default role, until it is started again.

## `scheduler.register(target, options?)`

```ts
register(target: object, options?: RegisterOptions): this

interface RegisterOptions {
  prefix?: string;
  defaults?: JobOptions & { timezone?: string };
}
```

Puts every job of one object on this scheduler, whatever scheduler each job names. You need it to:

- have several objects of one class, each with a `prefix` of its own
- give job options to every job of one object, with `defaults`
- add an object with legacy decorators on a class without `@Scheduled()`

```ts
for (const tenant of tenants) {
  scheduler.register(new Reports(tenant.mailer), {
    prefix: `${tenant.id}:`,
    defaults: { timezone: tenant.timezone, timeoutMs: 60_000, data: { tenant: tenant.id } },
  });
}
```

| Option | Meaning |
| --- | --- |
| `prefix` | Put in front of every job name of the object |
| `defaults` | Job options for every job of the object. An option set in a decorator wins; the scheduler's settings apply to what neither sets. `timezone` is used by cron jobs only. `data` is merged under the job's own, not replaced by it |

- Adds all the jobs of the object or none. When it throws, the object's jobs are left as they were.
- The jobs are taken off the scheduler that had them.
- Registering an object again with options replaces its jobs. Without options it changes nothing.

**Throws** `TypeError` if the class has no decorated methods (often the class was passed instead of an object) or an option has the wrong type; otherwise what `every()`, `cron()` and `at()` throw.

## When the jobs are added

| The object is created | Standard decorators, or legacy with `@Scheduled()` | Legacy without `@Scheduled()` |
| --- | --- | --- |
| When every scheduler its jobs name exists or has settings | At once | Never, until `register()` |
| Before that | When one of those schedulers starts | Never, until `register()` |

An object adds all its jobs or none. Among objects that are waiting, the newest of each class is kept.

## Jobs that were never added

When the default scheduler or a named one starts, it gives one warning for every declared job that no object has added to a scheduler. The warning goes to the scheduler's `logger`, which is the console unless you pass one, and each job is reported once.

```
[anarchon] @Every "sync-customers" on Reports.sync is not scheduled: with legacy decorators, add @Scheduled() to the class or call scheduler.register(object)
[anarchon] @Cron("0 3 * * *") on the method "cleanup" is not scheduled: no object of its class has been created
```

| Message ends with | Meaning | Fix |
| --- | --- | --- |
| `with legacy decorators, add @Scheduled() to the class or call scheduler.register(object)` | The class is compiled with legacy decorators and has no `@Scheduled()`, and no object of it was registered | Do one of the two |
| `no object of its class has been created` | No object of the class had added its jobs when the scheduler started | Create the object, or ignore the warning if the class isn't meant to run in this process, or its objects are created later |

It is a warning, not an error: a class may be loaded on purpose in a process that doesn't run its jobs, and an object created after `start()` still adds them.

## Where errors appear

| Error | Thrown from |
| --- | --- |
| `@Every can only decorate a public instance method` | The class definition |
| Two arguments in the wrong order, such as `@Every('1h', 'sync')`, or a `name` or `scheduler` of the wrong type | The class definition |
| An invalid schedule or option, or `Job "X" is already registered` | `new YourClass()` when its schedulers exist or have settings; otherwise the `start()` that adds it, which rejects and leaves the scheduler stopped. Also `register()`, `setDefault()` and `configure()` |
| `Scheduler.configure() needs a backend` | `configure()` |
| `Scheduler "X" has no settings of its own, and the default settings hold a backend object` | `new YourClass()` or `Scheduler.get('X')` |
| `There is no scheduler named "X"` | `Scheduler.get('X')` |
| `A scheduler named "X" already exists` | `new Scheduler({ name: 'X' })`, or `start()` of a stopped one whose name was taken meanwhile |
| `register() needs an object whose class has methods decorated with @Cron, @Every or @At` | `register()` |

## What to watch for

| Caution | Why | What to do |
| --- | --- | --- |
| Default names follow the code | `Class-method` changes when the class or method is renamed, and on every build if classes are minified. A new name is a new job with a new history | Give every job a name |
| One object per class, unless each has a prefix | A second object declares the same names, so its constructor throws | `register(object, { prefix })` for each object |
| With prefixes, register each object before creating the next | With standard decorators an object first adds its jobs under their plain names, and `register()` renames them | Create the object inside the `register()` call |
| The constructor throws after the jobs were added | With standard decorators the jobs are added at the start of the constructor | Remove them by name, or don't throw from the constructor |
| Legacy decorators add nothing by themselves | They can't run code when an object is created. A starting scheduler warns about such jobs | `@Scheduled()` on the class, or `register()` |
| A typo in a scheduler name | With Redis settings or a backend function, an unknown name is a new scheduler, created from the default settings | Keep the names in constants, and check `Scheduler.all()` |
| Schedulers and settings are shared by the process | They are module state, not per test or per request | `Scheduler.reset()` between tests |
| `autoStart` hides the start | A failure to connect arrives as an `'error'` event, not as a rejected promise | Listen for `'error'`, or start the scheduler yourself |
| Short-lived objects | Each new object tries to add the same jobs, and throws | Decorate long-lived services only |
| The schedule is fixed when the class is defined | Decorator arguments are evaluated once | For schedules read from configuration later, use `every()`, `cron()` or `at()` |

## Types

| Type | What it is |
| --- | --- |
| `JobDecorator` | What `@Every`, `@Cron` and `@At` return: a method decorator in both styles |
| `ScheduledDecorator` | What `@Scheduled()` returns: a class decorator in both styles |
| `DecoratedJobOptions<Options>` | Job options plus `name?` and `scheduler?`, for the form without the name first |
| `JobPlacement` | `{ scheduler?: string \| Scheduler }` |
| `RegisterOptions` | `{ prefix?, defaults? }` of `register()` |
| `ConfigureOptions` | What `Scheduler.configure()` takes |
