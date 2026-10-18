---
title: Decorators
description: Declare jobs on the methods of a class with @Cron, @Every and @At. An object adds its own jobs when it is created, and the scheduler can be created for you from settings you give once.
---

Jobs can be declared on the methods of a class instead of being passed to `every()`, `cron()` and `at()`. When an object of the class is created, it adds its jobs to the scheduler by itself.

```ts
import { At, Cron, Every, type JobContext, RedisBackend, Scheduler } from 'anarchon';

Scheduler.configure({ backend: new RedisBackend({ redis: process.env.REDIS_URL }), autoStart: true });

class Reports {
  constructor(private readonly mailer: Mailer) {}

  @Cron('weekday-digest', '0 8 * * 1-5', { timezone: 'Europe/Athens' })
  async digest(ctx: JobContext) {
    await this.mailer.send(await buildDigest(ctx.scheduledAt));
  }

  @Every('sync-customers', '10s', { timeoutMs: 8_000 })
  async sync() {
    await syncCustomers();
  }

  @At('announce-launch', '2026-12-01T09:00:00Z')
  async announce() {
    await this.mailer.send('We are live');
  }
}

new Reports(mailer); // a scheduler is created and started, and has the three jobs
```

There is no framework in this: `Reports` is an ordinary class, and you create the object yourself or let a container do it. The decorators need no `reflect-metadata`.

:::note[Legacy decorators]
With `experimentalDecorators` in `tsconfig.json`, also put `@Scheduled()` on the class. See [Legacy decorators](#legacy-decorators-need-scheduled).
:::

## Two ways to have a scheduler

A decorated job needs a scheduler to go to. You either give the settings once and let anarchon create it, or create it yourself.

| | Settings: `Scheduler.configure()` | By hand: `new Scheduler()` |
| --- | --- | --- |
| The scheduler is created | When the first object that needs it is | When you write `new Scheduler(...)` |
| Backend | Must be given. None is assumed | Must be given. None is assumed |
| Started | By `autoStart: true`, or by you | By you |
| You get the object with | `Scheduler.get()` | The variable you assigned |

### From settings

```ts
Scheduler.configure({
  backend: new PostgresBackend({ connection: process.env.DATABASE_URL }),
  timezone: 'Europe/Athens',
  autoStart: true,
});
```

`configure()` takes the [scheduler options](../scheduler-options/) and `autoStart`. It creates nothing: the scheduler is created when an object with decorated jobs is, or when you call `Scheduler.get()`.

- **A backend is required.** Without `backend`, `configure()` throws: a scheduler is never created on a store you didn't choose.
- **Starting is your decision.** With `autoStart: true` the scheduler starts when it is created, and a failure to start is reported as an [`'error'` event](../events-and-logging/). Without it, nothing connects until you start it:

  ```ts
  await Scheduler.get().start();   // one scheduler
  await Scheduler.startAll();      // the default one and every named one
  ```

- **Stop them on shutdown** with `await Scheduler.stopAll()`, so running jobs are handed over.

### By hand

```ts
const scheduler = new Scheduler({ backend: new RedisBackend({ redis: process.env.REDIS_URL }) });
new Reports(mailer);
await scheduler.start();
```

The first scheduler you create without a `name` is the **default scheduler**: it takes the decorated jobs that don't name another one.

## The three decorators

Each decorator takes the same arguments as the method it stands for, without the handler.

| Decorator | Same as | Schedule |
| --- | --- | --- |
| `@Every(name?, interval, options?)` | [`every()`](../defining-jobs/#interval-jobs-every) | Milliseconds or a duration string such as `'10s'` |
| `@Cron(name?, expression, options?)` | [`cron()`](../defining-jobs/#cron-jobs-cron) | A cron expression with 5 or 6 fields |
| `@At(name?, when, options?)` | [`at()`](../defining-jobs/#one-off-jobs-at) | A `Date`, ms since 1970, or an ISO string |

The options are the [job options](../job-options/) of that method (`timeoutMs`, `overlap`, `maxAttempts`, `catchUpMs`, `timezone`, [`data`](../run-data/) and the rest), plus two of the decorator's own:

| Option | Meaning |
| --- | --- |
| `name` | The job's name, when it isn't the first argument |
| `scheduler` | The scheduler the job goes to: a name or a `Scheduler`. Default: the default scheduler |

The method receives the same [`ctx`](../writing-handlers/) as any handler, and may ignore it. One method can carry several decorators, each with its own name:

```ts
class Sync {
  @Every('sync-fast', '10s')
  @Cron('sync-nightly', '0 3 * * *')
  async run() {}
}
```

## Naming a job

There are three ways, and they can be mixed in one class.

```ts
class Customers {
  @Every('sync-customers', '10s')           // the name first, as in scheduler.every()
  async sync() {}

  @Every('1h', { name: 'prune-customers' }) // the name in the options
  async prune() {}

  @Every('1d')                              // no name: 'Customers-report'
  async report() {}
}
```

Without a name, a job is called `Class-method`.

:::caution[Give jobs a name]
The name is the job's identity in the store, and every instance must use the same one. A default name changes when you rename the class or the method, and on every build if a minifier renames classes. Each change starts a new history, and during a rolling deploy the old and the new name run side by side. A name you write yourself never changes.
:::

The name comes first and the schedule second. Two arguments in the wrong order, such as `@Every('1h', 'sync')` or `@Cron('0 8 * * *', 'Europe/Athens')`, throw `TypeError` when the class is defined, with the right form in the message.

## Choosing a scheduler for a job

A job goes to the default scheduler unless its decorator says otherwise. Jobs that give the same name share one scheduler, so ten jobs can be on one scheduler, on ten, or anything between.

```ts
class Jobs {
  @Cron('job-1', '*/10 * * * * *')                            // the default scheduler
  one() {}

  @Cron('job-2', '*/10 * * * * *', { scheduler: 'billing' })  // the scheduler named 'billing'
  two() {}

  @Every('job-3', '5s', { scheduler: 'billing' })             // the same one as job-2
  three() {}

  @Every('job-4', '5s', { scheduler: reports })               // a Scheduler you created
  four() {}
}
```

A named scheduler that doesn't exist yet is created the first time a job needs it. Its settings are, in this order:

| Settings | Example |
| --- | --- |
| Its own | `Scheduler.configure('billing', { backend: new RedisBackend({ redis: BILLING_REDIS_URL }), leaseMs: 10_000 })` |
| The default settings, when `backend` is a function of the name | `Scheduler.configure({ backend: (name) => new PostgresBackend({ connection: pool, table: 'cron_' + name }) })` |

On Redis, the function gives each name its own key prefix: `backend: (name) => new RedisBackend({ redis: REDIS_URL, prefix: 'cron:' + name + ':' })`.

So two schedulers never share job state by accident. If the default settings hold a backend object, a named scheduler without settings of its own can't be created, because two schedulers can't share one backend object: the error tells you to configure that name or to make `backend` a function.

A scheduler you create yourself takes a name with `new Scheduler({ name: 'billing', ... })`. Names are unique in the process.

## When an object gets its jobs

| The object is created | Its jobs are added |
| --- | --- |
| When every scheduler its jobs name exists or has settings | At once. `new Reports()` throws if a job is invalid or its name is taken |
| Before that | When one of those schedulers starts. `start()` rejects if a job is invalid or its name is taken, and the scheduler stays stopped |

So the order doesn't matter, which is what a dependency-injection container needs: it may create your services before or after the scheduler. An object adds all its jobs or none.

A job added this way is an ordinary job. `remove()`, `runNow()`, `history()` and the [events](../events-and-logging/) work on it by name.

### Jobs that were declared but never added

A decorator does nothing until an object of its class exists. When the default scheduler or a named one starts, it warns once about every declared job that no object has added, through its [`logger`](../scheduler-options/) (the console by default):

```
[anarchon] @Cron("0 3 * * *") on the method "cleanup" is not scheduled: no object of its class has been created
```

It is a warning and not an error, because a class can be loaded on purpose in a process that doesn't run it, and an object created after `start()` still adds its jobs.

## Several objects of one class

Job names are unique in a scheduler, so a second object of the same class is refused: its constructor throws `Job "..." is already registered`. To have several, register each one with a prefix of its own:

```ts
for (const tenant of tenants) {
  scheduler.register(new Reports(tenant.mailer), {
    prefix: `${tenant.id}:`,                                      // 'acme:weekday-digest', 'acme:sync-customers'
    defaults: { timezone: tenant.timezone, timeoutMs: 60_000 },   // for every job of this object
  });
}
```

`register(object, options)` decides things for one object:

| Option | Meaning |
| --- | --- |
| `prefix` | Put in front of every job name of the object |
| `defaults` | [Job options](../job-options/) for every job of the object. An option set in a decorator wins, and the scheduler's settings apply to what neither sets. `timezone` is used by cron jobs only |

The call also puts **every** job of the object on that scheduler, whatever scheduler a decorator names. Registering an object again with options replaces its jobs; without options it changes nothing.

:::caution[Register each object before you create the next]
With standard decorators an object adds its jobs when it is created, under their plain names, and `register()` then renames them. Two objects created one after the other, before either is registered, would both claim the plain names, and the second constructor throws. Create each object inside the `register()` call, as above.
:::

## Legacy decorators need `@Scheduled()`

Standard decorators can run code when an object is created, and that is how an object adds its jobs. Legacy decorators (`experimentalDecorators`, the style NestJS and Angular use) can't, so the class needs one more decorator:

```ts
import { Every, Scheduled } from 'anarchon';

@Scheduled()
class Reports {
  @Every('sync-customers', '10s')
  async sync() {}
}
```

`@Scheduled()` changes nothing with standard decorators, so code that has it works in both styles. With legacy decorators it replaces the class with a subclass of the same name that adds the jobs at the end of the constructor.

If you'd rather not change the class, leave `@Scheduled()` out and call `scheduler.register(object)` yourself.

| | Standard decorators | Legacy decorators |
| --- | --- | --- |
| `tsconfig.json` | Nothing to set | `"experimentalDecorators": true` |
| `@Every`, `@Cron`, `@At` on methods | Yes | Yes |
| An object adds its jobs when created | Always | Only with `@Scheduled()` on the class |
| `@Scheduled()` | Not needed, and harmless | Needed, unless you call `register()` |

:::caution[With neither, the jobs are not added]
With legacy decorators, a class that has no `@Scheduled()` and whose objects are never passed to `register()` adds no jobs. The scheduler tells you when it starts:

```
[anarchon] @Every "sync-customers" on Reports.sync is not scheduled: with legacy decorators, add @Scheduled() to the class or call scheduler.register(object)
```
:::

Node.js doesn't run decorator syntax by itself, so the code must be compiled. `tsc` and `tsx` both do it. Standard decorators need TypeScript 5.0 or newer; `emitDecoratorMetadata` is never needed.

## Data for the runs: `data`

A job often needs something it can't take from its surroundings: the permission it runs with, the tenant it runs for, a token that must be fresh. Give it as `data`, and each run receives it as `ctx.data`:

```ts
class Reports {
  @Cron('export', '0 2 * * *', { data: { permission: 'reports:export' } })
  async export(ctx: JobContext<{ tenant: string; permission: string }>) {
    await exportFor(ctx.data.tenant, ctx.data.permission);
  }
}

scheduler.register(new Reports(), { prefix: 'acme:', defaults: { data: { tenant: 'acme' } } });
```

The scheduler's data, the object's (from `register()`) and the job's are merged, the more specific on top. See [Run data](../run-data/).

## In tests

The default scheduler, the named ones and the settings are shared by the whole process. Reset them between tests, so that an object from one test doesn't reach the scheduler of the next:

```ts
afterEach(async () => {
  await Scheduler.stopAll();
  Scheduler.reset(); // no schedulers, no settings, no object waiting for a scheduler
});
```

A service with decorated methods can be created in a unit test without any scheduler or settings: nothing runs, and its methods can be called directly.

## One-off jobs take an absolute time

`@At` takes a point in time, not a delay. Every instance must agree on when a run is due, and "5 seconds after this process started" is a different moment on each instance, so each one would run the job. This is why there is no `@Timeout`.

To run something once per deployment, compute a time every instance agrees on, for example from the release timestamp:

```ts
class Migration {
  @At('backfill-2026-12', process.env.RELEASED_AT ?? '2026-12-01T09:00:00Z')
  async backfill() {}
}
```

## Inheritance

A subclass inherits the jobs of its parent. Default names use the subclass. A method that overrides a decorated one replaces it, decorators included: decorate the override to keep the job.

```ts
class Base {
  @Every('10s')
  async sync() {}
}

class Customers extends Base {}

new Customers(); // adds 'Customers-sync'
```

## Limits

- Only public instance methods can be jobs. Decorating a `static` or `#private` method throws `TypeError` when the class is defined.
- The schedule in a decorator is fixed when the class is defined. For a schedule that comes from configuration read later, use `every()`, `cron()` or `at()`.
- With standard decorators, an object adds its jobs at the start of its constructor. If the constructor then throws, the jobs stay on the scheduler: remove them by name.
- `Scheduler.configure()` must be called before the scheduler it describes exists. Afterwards it throws.

## Examples to run

| Example | Shows | Run it |
| --- | --- | --- |
| [`examples/decorators.ts`](https://github.com/aristoteliss/anarchon/blob/main/examples/decorators.ts) | Standard decorators, with no `@Scheduled()` | `pnpm example:decorators` |
| [`examples/decorators-legacy.ts`](https://github.com/aristoteliss/anarchon/blob/main/examples/decorators-legacy.ts) | Legacy decorators: `@Scheduled()` and `register()` | `pnpm example:decorators:legacy` |
| [`examples/decorators-startup.ts`](https://github.com/aristoteliss/anarchon/blob/main/examples/decorators-startup.ts) | The three ways to start: `autoStart`, `Scheduler.startAll()`, or a scheduler created by hand | `pnpm example:decorators:startup auto` |
| [`examples/decorators-options.ts`](https://github.com/aristoteliss/anarchon/blob/main/examples/decorators-options.ts) | Schedulers created from settings, a scheduler per job, several objects of a class, and run data | `pnpm example:decorators:options` |
| [`examples/nestjs`](https://github.com/aristoteliss/anarchon/tree/main/examples/nestjs) | A NestJS app, checked on NestJS 11 and 12 | `pnpm --filter anarchon-example-nestjs start` |

They need no server: the jobs are coordinated through a SQLite file in the temp folder.

## Next

- [Run data](../run-data/): values for the runs, fixed or read when each run starts
- [Job options](../job-options/): what the options of each decorator accept
- [NestJS](../../recipes/nestjs/#declaring-jobs-with-decorators): providers that declare jobs
- [Decorators reference](../../reference/decorators/): every signature, where errors appear and what to watch for
