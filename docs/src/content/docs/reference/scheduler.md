---
title: Scheduler
description: Every method and property of the Scheduler class.
---

```ts
import { Scheduler } from 'anarchon';
```

## Constructor

```ts
new Scheduler(options?: SchedulerOptions)
```

Creates a scheduler. Nothing connects until `start()`. See [Options](../options/#scheduler-options).

**Throws** `TypeError` when both `backend` and a Redis shortcut are given, or `instanceId` is empty; `RangeError` when a number is out of range, or `heartbeatMs` is not under half of `leaseMs`.

## Properties

| Property | Type | Meaning |
| --- | --- | --- |
| `instanceId` | `string` | This instance's name in history and events |
| `backend` | `Backend` | The backend in use. `backend.name` is e.g. `'redis:lease'` or `'postgres'` |

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

### `runNow(name)`

```ts
runNow(name: string): Promise<RunRecord>
```

Runs a job now on this instance. Not deduplicated, never retried, recorded with `manual: true`. Resolves with the run's record when the handler has finished.

**Throws** `Error` if the job isn't registered here or the scheduler isn't started.

Guide: [Lifecycle](../../guides/lifecycle/).

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
| `PostgresBackend` | class | [PostgreSQL](../../backends/postgres/) |
| `SqliteBackend` | class | [SQLite and libSQL](../../backends/sqlite/) |
| `RabbitMQBackend` | class | [RabbitMQ](../../backends/rabbitmq/) |
| `NatsBackend` | class | [NATS](../../backends/nats/) |
| `SqlBackend` | abstract class | Base of the two SQL backends |
| `LeaseStore` | class | The Redis lease implementation |
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
