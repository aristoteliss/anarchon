---
title: Options
description: Every option of the scheduler, of jobs and of each backend, in one place.
---

All options at a glance. Each links to the guide that explains it.

## Scheduler options

`new Scheduler(options)`. `backend` is required: no store is assumed. Guide: [Scheduler options](../../guides/scheduler-options/).

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `backend` | `Backend` | required | Where runs are claimed and recorded |
| `instanceId` | `string` | `hostname:pid` | Name of this instance in history |
| `name` | `string` | none | Name decorated jobs choose this scheduler by |
| `data` | value or function | none | Data for the runs of every job, read as `ctx.data` |
| `jitterMs` | `number` | `2000` | Default maximum random delay before claiming |
| `maxLateMs` | `number` | `60000` | Default lateness limit |
| `historySize` | `number` | `1000` | Default runs kept per job |
| `historyTtlMs` | `number` | none | Default maximum age of history |
| `timezone` | `string` | the server's | Default time zone for cron jobs |
| `leaseMs` | `number` | `30000` | How long a lease lasts without a heartbeat |
| `heartbeatMs` | `number` | `5000` or `leaseMs / 6` | How often the lease is renewed and backups check |
| `log` | `boolean` | `false` | One log line per start, finish, failure, skip and lost run |
| `logger` | `Logger` | `console` | Where logs and unhandled errors go |
| `unrefTimers` | `boolean` | `false` | Let the process exit while timers are pending |

## Job options

The last argument of `every()`, `cron()` and `at()`. Guide: [Job options](../../guides/job-options/).

| Option | Type | Default | Lease backend only | Meaning |
| --- | --- | --- | --- | --- |
| `jitterMs` | `number` | scheduler's, or interval / 4 if smaller | | Maximum random delay before claiming |
| `maxLateMs` | `number` | scheduler's | | Skip a run reached later than this |
| `timeoutMs` | `number` | none | | Abort `ctx.signal` and fail the run after this long |
| `overlap` | `'skip' \| 'allow'` | `'skip'` | yes | Skip a run while the previous one is going, or allow both |
| `maxAttempts` | `number` (1 to 100) | `3` | yes | Times a run may be started when runners die |
| `catchUpMs` | `number` | `300000` | yes | On start, run the latest slot if missed and due less than this ago. `0` = never |
| `historySize` | `number` | scheduler's | | Runs kept for this job |
| `historyTtlMs` | `number` | scheduler's | | Maximum age of this job's history |
| `data` | value or function | none | | Data for this job's runs, read as `ctx.data`. On top of the scheduler's |
| `offsetMs` | `number` | `0` | | `every()` only: shifts the grid |
| `timezone` | `string` | scheduler's | | `cron()` only: IANA time zone |

### Constraints

| Constraint | Checked when |
| --- | --- |
| `jitterMs` < half the time between runs | The job is added |
| `maxLateMs` > `jitterMs` | The job is added |
| `jitterMs + maxLateMs` < how long the backend remembers a run | The job is added |
| `heartbeatMs` < half of `leaseMs` | The scheduler is created |
| Interval of `every()` at least 1 second | The job is added |

## Decorator options

The options of `@Every`, `@Cron` and `@At` are the job options above, plus these. Guide: [Decorators](../../guides/decorators/).

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | `string` | `Class-method` | The job's name, when it isn't the first argument |
| `scheduler` | `string` or `Scheduler` | the default scheduler | The scheduler the job goes to. A named one is created from its settings if it doesn't exist |

## `register()` options

`scheduler.register(object, options)`.

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `prefix` | `string` | none | Put in front of every job name of the object |
| `defaults` | job options, with `timezone` | none | Job options for every job of the object. A decorator's own options win |

## `Scheduler.configure()` options

The scheduler options above, with these differences. Reference: [Decorators](../decorators/#schedulerconfigureoptions).

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `backend` | `Backend` or `(name) => Backend` | required | The backend, or a function that returns one for a scheduler's name |
| `autoStart` | `boolean` | `false` | Start the scheduler when it is created |

## `stop()` options

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `timeoutMs` | `number` | `30000` | How long to wait for running jobs before returning |

## Redis backend

`new RedisBackend(options)`. Guide: [Redis and Valkey](../../backends/redis/).

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `redis` | URL, `{ host, port, username, password, db }`, or a client | `localhost:6379` | Connection |
| `strategy` | `'lease' \| 'stream-id' \| 'idmp' \| 'script'` | `'lease'` | How one winner is picked |
| `prefix` | `string` | `'cron:'` | Key prefix |
| `idmp.durationSec` | `number` (1 to 86400) | `300` | `'idmp'`: how long a run's ID is remembered |
| `idmp.maxSize` | `number` (1 to 10000) | `1000` | `'idmp'`: how many run IDs are kept per job |
| `scriptWindowMs` | `number` | `300000` | `'script'`: how long a claimed run is remembered |

## PostgreSQL backend

`new PostgresBackend(options)`. Guide: [PostgreSQL](../../backends/postgres/).

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `connection` | connection string, `pg` Pool or Client, postgres.js instance, or `{ all, transaction }` | `postgres://localhost:5432/postgres` | Connection |
| `table` | `string` | `'anarchon_runs'` | Table name, may include a schema |

## SQLite backend

`new SqliteBackend(options)`. Guide: [SQLite and libSQL](../../backends/sqlite/).

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `database` | file path, `node:sqlite` or `better-sqlite3` database, `@libsql/client` client, or `{ all, transaction }` | `'./anarchon.db'` | Database |
| `table` | `string` | `'anarchon_runs'` | Table name |
| `busyTimeoutMs` | `number` | `5000` | How long a write waits for another process |

## RabbitMQ backend

`new RabbitMQBackend(options)`. Guide: [RabbitMQ](../../backends/rabbitmq/).

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `url` | `string` | `'amqp://localhost'` | AMQP URL |
| `connection` | `amqplib` connection | | Your own connection |
| `prefix` | `string` | `'cron.'` | Queue name prefix |
| `slotTtlMs` | `number` | `300000` | How long a run is remembered |

## NATS backend

`new NatsBackend(options)`. Guide: [NATS](../../backends/nats/).

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `servers` | `string \| string[]` | `'nats://localhost:4222'` | Server URL or URLs |
| `connection` | NATS connection | | Your own connection |
| `stream` | `string` | `'CRON'` | JetStream stream name |
| `prefix` | `string` | `'cron.'` | Subject prefix |
| `duplicateWindowMs` | `number` | `300000` | How long a run is remembered |
| `historySize` | `number` | `1000` | Messages kept per subject |
| `replicas` | `number` | `1` | Stream replicas |

## Durations

Wherever an interval is accepted as a string:

| Unit | Meaning | Example |
| --- | --- | --- |
| `ms` | milliseconds | `'500ms'` |
| `s` | seconds | `'10s'` |
| `m` | minutes | `'35m'` |
| `h` | hours | `'1h30m'` |
| `d` | days | `'2d'` |

Units combine (`'1h30m'`) and accept decimals (`'1.5h'`). A plain number, or a string of digits, is milliseconds.

All the other options ending in `Ms` take a number of milliseconds.
