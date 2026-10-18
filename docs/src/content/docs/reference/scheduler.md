---
title: Scheduler
description: Every method and property of the Scheduler class.
---

```ts
import { Scheduler } from 'anarchon';
```

## Constructor

```ts
new Scheduler(options: SchedulerOptions)
```

Creates a scheduler. Nothing connects until `start()`. `backend` is required: no store is assumed. See [Options](../options/#scheduler-options).

**Throws** `TypeError` when `backend` is not given, or `instanceId` is empty; `RangeError` when a number is out of range, or `heartbeatMs` is not under half of `leaseMs`.

## Properties

| Property | Type | Meaning |
| --- | --- | --- |
| `instanceId` | `string` | This instance's name in history and events |
| `backend` | `Backend` | The backend in use. `backend.name` is e.g. `'redis:lease'` or `'postgres'` |
| `name` | `string \| undefined` | The name decorated jobs choose this scheduler by, if it has one |

## Defining jobs

All three return the scheduler, so they chain.

### `every(name, interval, handler, options?)`

```ts
every(name: string, interval: number | string, handler: JobHandler, options?: EveryJobOptions): this
```

Adds an interval job. `interval` is ms or a duration string (`'10s'`, `'35m'`, `'1h30m'`, `'2d'`). Minimum 1 second. Runs fall on a UTC grid.

**Throws** `RangeError` for an invalid or too short interval, or unsafe timings; `Error` if the name is already registered.

### `cron(name, expression, handler, options?)`

```ts
cron(name: string, expression: string, handler: JobHandler, options?: CronJobOptions): this
```

Adds a cron job. Five fields, or six with seconds first.

**Throws** `Error` for an invalid expression or a duplicate name; `RangeError` if the expression never runs in the future, or for unsafe timings.

### `at(name, when, handler, options?)`

```ts
at(name: string, when: Date | number | string, handler: JobHandler, options?: JobOptions): this
```

Adds a one-off job. `when` is a `Date`, ms since 1970, or an ISO string.

**Throws** `RangeError` for an invalid date.

### `register(target, options?)`

```ts
register(target: object, options?: { prefix?: string; defaults?: JobOptions & { timezone?: string } }): this
```

Puts every job declared with `@Cron`, `@Every` and `@At` on the object's class on this scheduler, whatever scheduler each decorator names. Each job calls its method on that object, and is named `Class-method` unless the decorator gives a name. Adds all the jobs or none.

A decorated object adds its jobs by itself when it is created, so you call this to decide something for one object: `prefix` goes in front of every job name, so several objects of one class can coexist, and `defaults` are job options for every job of the object. It is also how an object is added with legacy decorators on a class without `@Scheduled()`. Registering an object again with options replaces its jobs; without options it changes nothing.

**Throws** `TypeError` if the class has no decorated methods; otherwise what `every()`, `cron()` and `at()` throw.

Guide: [Decorators](../../guides/decorators/#several-objects-of-one-class). Reference: [Decorators](../decorators/).

### `remove(name)`

```ts
remove(name: string): boolean
```

Stops scheduling a job on this instance. Returns `false` if no job has that name. History is kept; a run in progress here finishes.

Guide: [Defining jobs](../../guides/defining-jobs/).

## Lifecycle

### `start()`

```ts
start(): Promise<void>
```

Connects, prepares the jobs, schedules them, and on a lease backend recovers unfinished and missed runs. Does nothing if already running.

**Rejects** when the backend can't be reached or is too old. The scheduler stays stopped.

**Throws** `Error` if called while starting or stopping.

### `stop(options?)`

```ts
stop(options?: { timeoutMs?: number }): Promise<void>
```

Stops scheduling, aborts `ctx.signal` of running jobs, waits up to `timeoutMs` (default 30000) for them, and closes connections the backend opened. Calling it again while stopping returns the same promise.

### `runNow(name, options?)`

```ts
runNow(name: string, options?: { data?: JobData }): Promise<RunRecord>
```

Runs a job now on this instance. Not deduplicated, never retried, recorded with `manual: true`. Resolves with the run's record when the handler has finished. `data` is data for this one run, on top of the job's and the scheduler's: see [Run data](../../guides/run-data/).

**Throws** `Error` if the job isn't registered here or the scheduler isn't started.

Guide: [Lifecycle](../../guides/lifecycle/).

### `setData(data)`

```ts
setData(data: JobData | undefined): this
```

Replaces the scheduler's `data`, the data handed to every handler as `ctx.data` under each job's own. Runs that start afterwards get the new one; runs in progress keep theirs. `undefined` removes it.

Guide: [Run data](../../guides/run-data/).

## Schedulers for decorated jobs

Static methods that create, find, start and stop the schedulers decorated jobs go to. They are described in the [Decorators reference](../decorators/#schedulers-for-decorated-jobs).

| Method | What it does |
| --- | --- |
| `Scheduler.configure(options)`, `Scheduler.configure(name, options)` | Stores the settings a scheduler is created from when a job needs it. A backend must be given |
| `Scheduler.get(name?)` | The default scheduler or a named one, created from its settings if it doesn't exist |
| `Scheduler.all()` | The default scheduler and every named one |
| `Scheduler.startAll()`, `Scheduler.stopAll(options?)` | Start or stop all of them |
| `Scheduler.setDefault(scheduler)` | Chooses the default scheduler |
| `Scheduler.reset()` | Forgets schedulers, names and settings. For tests |

## Reading

### `history(name, limit?)`

```ts
history(name: string, limit?: number): Promise<RunRecord[]>
```

The latest runs from all instances, newest first, one record per attempt. `limit` is 1 to 10000, default 20. Works for any job name and before `start()`.

**Throws** `RangeError` for a limit out of range.

### `lastRun(name)`

```ts
lastRun(name: string): Promise<RunRecord | null>
```

The most recent attempt, or `null` if the job never ran.

### `nextRun(name)`

```ts
nextRun(name: string): Date | null
```

When a registered job is next due, or `null` if it has no more runs.

**Throws** `Error` if the job isn't registered here.

### `jobs()`

```ts
jobs(): JobInfo[]
```

The jobs registered on this instance: `name`, `type`, `schedule`, `nextRunAt`, `runningHere`.

Guide: [History](../../guides/history/).

## Events

```ts
on<E extends keyof SchedulerEvents>(event: E, listener: (payload: SchedulerEvents[E]) => void): this
once<E extends keyof SchedulerEvents>(event: E, listener: (payload: SchedulerEvents[E]) => void): this
off<E extends keyof SchedulerEvents>(event: E, listener: (payload: SchedulerEvents[E]) => void): this
```

See [Events](../events/).

## Exports

Everything the package exports.

| Export | Kind | Purpose |
| --- | --- | --- |
| `Scheduler` | class | The scheduler |
| `RedisBackend` | class | [Redis and Valkey](../../backends/redis/) |
| `ValkeyBackend` | class | [Redis and Valkey](../../backends/redis/) |
| `PostgresBackend` | class | [PostgreSQL](../../backends/postgres/) |
| `SqliteBackend` | class | [SQLite and libSQL](../../backends/sqlite/) |
| `RabbitMQBackend` | class | [RabbitMQ](../../backends/rabbitmq/) |
| `NatsBackend` | class | [NATS](../../backends/nats/) |
| `SqlBackend` | abstract class | Base of the two SQL backends |
| `LeaseStore` | class | The Redis lease implementation |
| `Cron`, `Every`, `At` | decorators | [Declare jobs on the methods of a class](../../guides/decorators/) |
| `Scheduled` | decorator | For classes compiled with [legacy decorators](../../guides/decorators/#legacy-decorators-need-scheduled) |
| `parseDuration`, `formatDuration` | functions | `'1h30m'` to ms, and back |
| `fromIORedis`, `fromNodeRedis`, `fromValkeyGlide` | functions | Adapt a Redis client to `{ send }` |
| `fromPgPool`, `fromPgClient`, `fromPostgresJs` | functions | Adapt a Postgres client to `{ all, transaction }` |
| `fromSqliteDatabase`, `fromLibsql` | functions | Adapt a SQLite database or libSQL client |
| Types | types | See [Types](../types/) |

You rarely need the `from...` adapters: every backend recognizes these clients on its own. They are exported for building your own client wrappers.

### `parseDuration` and `formatDuration`

```ts
import { formatDuration, parseDuration } from 'anarchon';

parseDuration('1h30m'); // 5400000
parseDuration('500ms'); // 500
parseDuration(10_000);  // 10000
formatDuration(5_400_000); // '1h30m'
```
