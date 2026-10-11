---
title: Types
description: The TypeScript types the package exports.
---

All types are exported from the package root.

```ts
import type { JobContext, JobHandler, RunRecord, SchedulerOptions } from 'anarchon';
```

## Jobs

### `JobHandler`

```ts
type JobHandler<Data = unknown> = (ctx: JobContext<Data>) => unknown;
```

The function a job runs. Sync or async. Returning means success; throwing means failure, or `interrupted` when `ctx.signal` was aborted by `stop()` or a takeover first.

### `JobContext`

```ts
interface JobContext<Data = unknown> {
  name: string;
  slot: number;
  scheduledAt: Date;
  instanceId: string;
  manual: boolean;
  data: Data;
  signal: AbortSignal;
  attempt: number;
  reason: RunReason;
}
```

Guide: [Writing handlers](../../guides/writing-handlers/#the-context-ctx).

### `JobData`, `JobDataProvider`

```ts
type JobData = object | string | number | boolean | null | JobDataProvider;
type JobDataProvider = (run: Omit<JobContext, 'data'>) => unknown; // may return a promise
```

What the `data` option of a scheduler, a job and `runNow()` takes: a value, or a function called when a run starts. Guide: [Run data](../../guides/run-data/).

### `RunReason`

```ts
type RunReason = 'scheduled' | 'manual' | 'catch-up' | 'takeover';
```

| Value | Meaning |
| --- | --- |
| `'scheduled'` | The run was due |
| `'manual'` | `runNow()` was called |
| `'catch-up'` | It was due while every instance was down |
| `'takeover'` | A backup started the next attempt of a run whose runner was gone |

### `JobOptions`, `EveryJobOptions`, `CronJobOptions`

```ts
interface JobOptions {
  jitterMs?: number;
  maxLateMs?: number;
  historySize?: number;
  historyTtlMs?: number;
  overlap?: 'skip' | 'allow';
  timeoutMs?: number;
  maxAttempts?: number;
  catchUpMs?: number;
}

interface EveryJobOptions extends JobOptions {
  offsetMs?: number;
}

interface CronJobOptions extends JobOptions {
  timezone?: string;
}
```

See [Options](../options/#job-options).

### Decorator types

```ts
type DecoratedJobOptions<Options> = Options & {
  name?: string;                  // default: Class-method
  scheduler?: string | Scheduler; // default: the default scheduler
};

interface RegisterOptions {
  prefix?: string;
  defaults?: JobOptions & { timezone?: string };
}

interface ConfigureOptions extends Omit<SchedulerOptions, 'backend' | 'name'> {
  backend?: Backend | ((name: string) => Backend);
  autoStart?: boolean;
}
```

| Type | What it is |
| --- | --- |
| `DecoratedJobOptions` | What `@Every`, `@Cron` and `@At` accept when the name isn't the first argument |
| `JobPlacement` | `{ scheduler? }`, the part of it that the form with the name first also accepts |
| `JobDecorator`, `ScheduledDecorator` | What the method decorators and `@Scheduled()` return: decorators in both the standard and the legacy style |
| `RegisterOptions` | The options of `scheduler.register()` |
| `ConfigureOptions` | The settings `Scheduler.configure()` takes |

See [Decorators](../decorators/).

### `JobInfo`

What `jobs()` returns for each job.

```ts
interface JobInfo {
  name: string;
  type: 'cron' | 'every' | 'once';
  schedule: string;        // e.g. 'every 10s', 'cron "0 8 * * 1-5" (Europe/Athens)'
  nextRunAt: Date | null;
  runningHere: number;     // runs of this job executing on this instance now
}
```

## Runs

### `RunRecord`

One attempt of one run. Returned by `history()`, `lastRun()` and `runNow()`, and the payload of `success`.

```ts
interface RunRecord {
  job: string;
  slot: number;
  scheduledAt: Date;
  instanceId: string;
  manual: boolean;
  attempt: number;
  reason?: RunReason;
  status: RunStatus;
  startedAt: Date;
  finishedAt?: Date;
  durationMs?: number;
  error?: string;
}
```

### `RunStatus`

```ts
type RunStatus = 'running' | 'success' | 'failed' | 'interrupted';
```

Guide: [History](../../guides/history/#status).

## Scheduler

### `SchedulerOptions`

See [Options](../options/#scheduler-options).

### `Logger`

```ts
interface Logger {
  info?(message: string, ...meta: unknown[]): void;
  warn(message: string, ...meta: unknown[]): void;
  error(message: string, ...meta: unknown[]): void;
}
```

`console`, pino and winston loggers all fit.

### `RedisStrategyName`

```ts
type RedisStrategyName = 'lease' | 'stream-id' | 'idmp' | 'script';
```

### `IdmpOptions`

```ts
interface IdmpOptions {
  durationSec?: number; // 1 to 86400, default 300
  maxSize?: number;     // 1 to 10000, default 1000
}
```

## Events

`SchedulerEvents`, `RunStartEvent`, `RunFailureEvent`, `RunInterruptedEvent`, `SkipEvent`, `LostEvent` and `SchedulerErrorEvent` are described in [Events](../events/).

## Backends

These matter when you [write a backend](../../backends/custom/).

### `Backend`

```ts
interface Backend {
  readonly name: string;
  readonly dedupeWindowMs: number;
  checkJob?(job: JobLimits): void;
  init(): Promise<void>;
  prepareJob(job: string, historySize: number): Promise<void>;
  claim(input: ClaimInput): Promise<boolean>;
  recordClaim?(input: ClaimInput): Promise<void>;
  recordManualRun(input: ClaimInput): Promise<number | void>;
  saveResult(job: string, result: StoredResult, historySize: number, historyTtlMs?: number): Promise<void>;
  history(job: string, limit: number): Promise<RunRecord[]>;
  readonly runs?: RunStore;
  close(): Promise<void>;
}
```

### `ClaimInput`

```ts
interface ClaimInput {
  job: string;
  slot: number;
  token: string;
  instanceId: string;
  historySize: number;
  historyTtlMs?: number;
}
```

### `StoredResult`

What the runner stores when an attempt ends.

```ts
interface StoredResult {
  slot: number;
  by: string;
  attempt?: number;
  status: 'success' | 'failed' | 'interrupted';
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  error?: string;
}
```

### `JobLimits`

What `checkJob()` receives, so a backend can refuse a job it can't run safely.

```ts
interface JobLimits {
  name: string;
  jitterMs: number;
  maxLateMs: number;
  minGapMs: number; // the smallest gap between two runs
  historySize: number;
  historyTtlMs?: number;
}
```

### `RunStore`

The optional lease capability of a backend.

```ts
interface RunStore {
  claim(input: RunClaim): Promise<ClaimOutcome>;
  heartbeat(job: string, slot: number, token: string, leaseMs: number): Promise<boolean>;
  finish(job: string, slot: number, token: string, status: 'success' | 'failed' | 'interrupted'): Promise<boolean>;
  release(job: string, slot: number, token: string): Promise<boolean>;
  active(job: string): Promise<Array<{ slot: number; attempt: number; alive: boolean }>>;
}
```

### `RunClaim`

```ts
interface RunClaim extends ClaimInput {
  mode: 'new' | 'takeover';
  reason: RunReason;
  leaseMs: number;
  overlap: 'skip' | 'allow';
  maxAttempts: number;
  maxLateMs?: number;
  keepMs?: number;
}
```

### `ClaimOutcome`

```ts
type ClaimOutcome =
  | { kind: 'won'; attempt: number }
  | { kind: 'running'; attempt: number }
  | { kind: 'done' }
  | { kind: 'overlap'; slot: number }
  | { kind: 'none' }
  | { kind: 'late'; lateMs: number };
```

Each outcome is explained in [Run lifecycle](../../internals/run-lifecycle/#3-the-claim).

## Client shapes

The minimal shape anarchon needs from each client library. You pass a real client; these types exist so anarchon doesn't depend on the libraries themselves.

| Type | Matches |
| --- | --- |
| `RedisInput` | Anything accepted as `redis` |
| `RedisCommandClient` | `{ send(command, args) }` |
| `RedisConnectionOptions` | `{ host, port, username, password, db }` |
| `IORedisLike`, `NodeRedisLike`, `ValkeyGlideLike` | ioredis / iovalkey, node-redis, Valkey GLIDE |
| `PgPoolLike`, `PgClientLike`, `PostgresJsLike` | `pg` Pool, `pg` Client, postgres.js |
| `SqliteDatabaseLike`, `LibsqlClientLike` | `node:sqlite` / `better-sqlite3`, `@libsql/client` |
| `SqlClient`, `SqlQuery`, `SqlRow`, `SqlValue` | The `{ all, transaction }` adapter of the SQL backends |
| `RabbitMQConnectionLike`, `NatsConnectionLike` | An `amqplib` connection, a NATS connection |

Backend option types: `RedisBackendOptions`, `PostgresBackendOptions`, `SqliteBackendOptions`, `RabbitMQBackendOptions`, `NatsBackendOptions`. See [Options](../options/).
