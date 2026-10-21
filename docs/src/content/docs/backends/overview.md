---
title: Backends overview
description: Which store to use, and what each one gives you.
---

A **backend** is the adapter between anarchon and the store your instances share. Every backend makes sure one instance wins each run. Some can also hold a lease, which is what enables backups, overlap protection and catch-up.

## Choosing

```mermaid
flowchart TD
  start{"What do your instances<br/>already share?"}
  start -- "Redis or Valkey" --> redis["Redis backend, 'lease' strategy<br/>(the default)"]
  start -- "PostgreSQL" --> pg["PostgresBackend"]
  start -- "Only one machine" --> sqlite["SqliteBackend on a file"]
  start -- "A libSQL server or Turso" --> libsql["SqliteBackend with a libSQL client"]
  start -- "Only RabbitMQ" --> rabbit["RabbitMQBackend<br/>(claim only)"]
  start -- "Only NATS" --> nats["NatsBackend<br/>(claim only)"]
```

Use what you already run. If you have both Redis and PostgreSQL, Redis has the lower latency per claim; PostgreSQL keeps the job history next to your data.

## What each backend gives you

"Other strategies" means Redis or Valkey with `stream-id` or `script`, and Redis with `idmp`.

| | Redis / Valkey `lease` | Redis / Valkey other strategies | PostgreSQL | SQLite / libSQL | RabbitMQ | NATS |
| --- | --- | --- | --- | --- | --- | --- |
| One winner per run | yes | yes | yes | yes | yes | yes |
| A backup takes over a dead runner | yes | no | yes | yes | no | no |
| No overlapping runs (`overlap: 'skip'`) | yes | no | yes | yes | no | no |
| Retries after a dead runner (`maxAttempts`) | yes | no | yes | yes | no | no |
| Catch-up after downtime (`catchUpMs`) | yes | no | yes | yes | no | no |
| Healthy instances claim first after a failure (`yieldAfterFailure`) | yes | no | yes | yes | no | no |
| Hand-over on `stop()` | yes | no | yes | yes | no | no |
| History (`history()`, `lastRun()`) | yes | yes | yes | yes | yes | yes |
| History by age (`historyTtlMs`) | yes | yes ¹ | yes | yes | no | no |
| `historySize` per job | yes | yes | yes | yes | yes | shared ² |
| How long a claimed run is remembered | always | `stream-id` always, `idmp` `durationSec`, `script` `windowMs` | always | always | `slotTtlMs` | `duplicateWindowMs` |
| Job names | any | any | any | any | letters, digits, `_`, `-` | letters, digits, `_`, `-` |
| Instances on several machines | yes | yes | yes | with a libSQL server | yes | yes |
| Needs | Redis 5+ or Valkey | Redis 5+ or Valkey; `idmp` Redis 8.6+ | PostgreSQL 9.5+ | SQLite 3.35+ | RabbitMQ 3.9+ | JetStream |

¹ With `script`, `historyTtlMs` must be longer than the strategy's `windowMs`.
² NATS keeps one history size for all its jobs: the largest of the backend's `historySize` and every job's.

## Which options each backend takes

Most options work everywhere. The ones that need a lease are refused elsewhere, so a setting can never be silently ignored: typed code doesn't compile, and a job or scheduler set up from a decorator or plain JavaScript throws a `TypeError` that names the option and the backend.

| Option | Set on | Lease backends | Claim-only backends | Notes |
| --- | --- | --- | --- | --- |
| `jitterMs`, `timeoutMs`, `data`, `offsetMs`, `timezone` | job, scheduler | yes | yes | |
| `maxLateMs` | job, scheduler | yes | yes | On claim-only backends `jitterMs + maxLateMs` must be shorter than how long the backend remembers a run; checked when the job is added |
| `historySize` | job, scheduler | yes | yes | NATS: the largest wins, see ² |
| `historyTtlMs` | job, scheduler | yes | Redis/Valkey only | RabbitMQ and NATS refuse it |
| `overlap`, `maxAttempts`, `catchUpMs`, `yieldAfterFailure` | job | yes | refused | `at()` never takes `overlap` |
| `leaseMs`, `heartbeatMs` | scheduler | yes | refused | |

```ts
const onPostgres = new Scheduler({ backend: new PostgresBackend({ connection: pool }), leaseMs: 10_000 });
onPostgres.every('export', '1h', exportAll, { overlap: 'skip', maxAttempts: 2, catchUpMs: 30 * 60_000 }); // all fine

const onNats = new Scheduler({ backend: new NatsBackend() });
onNats.every('notify', '1m', notify, { timeoutMs: 30_000, maxLateMs: 60_000 }); // fine
onNats.every('notify', '1m', notify, { maxAttempts: 2 }); // type error: NATS has no leases
```

## Each backend's own options

The options of the backend objects themselves. Every backend also accepts a client your app already has, and never closes it.

| Backend | Option | Default | What it is for |
| --- | --- | --- | --- |
| `RedisBackend` | `redis` | `localhost:6379` | A URL, `{ host, port, ... }`, or your client |
| | `strategy` | `'lease'` | A name, or `{ name: 'idmp', durationSec, maxSize }` / `{ name: 'script', windowMs }` |
| | `prefix` | `'cron:'` | Keeps services that share a Redis apart |
| `ValkeyBackend` | `valkey` | `localhost:6379` | Like `redis` |
| | `strategy` | `'lease'` | As above, without `idmp` |
| | `prefix` | `'cron:'` | As above |
| `PostgresBackend` | `connection` | pg's defaults | A connection string, a pg Pool or Client, postgres.js, or `{ all, transaction }` |
| | `table` | `'anarchon_runs'` | The tables' name, schema allowed; keeps services apart |
| `SqliteBackend` | `database` | `'./anarchon.db'` | A file path, a node:sqlite or better-sqlite3 database, or a libSQL client |
| | `table` | `'anarchon_runs'` | As above |
| | `busyTimeoutMs` | `5000` | How long a claim waits for another process's write |
| `RabbitMQBackend` | `url` / `connection` | `amqp://localhost` | Where RabbitMQ is, or your amqplib connection |
| | `prefix` | `'cron.'` | Queue names |
| | `slotTtlMs` | `300000` | How long a claimed run is remembered |
| `NatsBackend` | `servers` / `connection` | `nats://localhost:4222` | Where NATS is, or your connection |
| | `stream`, `prefix` | `'CRON'`, `'cron.'` | The JetStream stream and its subjects |
| | `duplicateWindowMs` | `300000` | How long a claimed run is remembered |
| | `historySize` | `1000` | Runs kept per job, at least |
| | `replicas` | `1` | Stream replicas; `3` in a NATS cluster |

```ts
new RedisBackend({ redis: process.env.REDIS_URL, strategy: { name: 'script', windowMs: 10 * 60_000 }, prefix: 'billing:cron:' });
new ValkeyBackend({ valkey: process.env.VALKEY_URL });
new PostgresBackend({ connection: pool, table: 'scheduler.runs' });
new SqliteBackend({ database: '/var/lib/app/jobs.db', busyTimeoutMs: 10_000 });
new RabbitMQBackend({ url: process.env.AMQP_URL, prefix: 'billing.cron.', slotTtlMs: 10 * 60_000 });
new NatsBackend({ servers: ['nats://n1:4222', 'nats://n2:4222'], replicas: 3, duplicateWindowMs: 10 * 60_000 });
```

## Choosing by what a job needs

| The job | Needs | Backends that fit |
| --- | --- | --- |
| Must not run twice, even if its runner dies (payments) | `maxAttempts: 1`, writes keyed by `ctx.slot` | Any lease backend |
| Must still run after a full outage (daily reports) | `catchUpMs` | Any lease backend |
| Takes longer than its interval (exports) | `overlap: 'skip'`, hand-over on deploy | Any lease backend |
| Cheap and frequent, a missed run doesn't matter (cache refresh) | jitter, a short `maxLateMs` | Any backend |
| Sends whatever is outstanding (notifications from an outbox) | nothing special | Any backend, brokers included |

The [examples folder](https://github.com/aristoteliss/anarchon/tree/main/examples) has a runnable file for each of these: `billing.ts`, `nightly-export.ts`, `cache-refresh.ts`, `broker-notifications.ts`, and `tenants.ts` for per-tenant jobs.

## Lease backends and claim-only backends

The split comes from what the store can express.

A **lease backend** stores, for each run, who is running it and until when. Other instances can read that and act on it. Redis (with a Lua script), PostgreSQL and SQLite (with a transaction) can all do "read the run, decide, write" as one atomic step.

A **claim-only backend** can answer exactly one question atomically: "was I first?" RabbitMQ and NATS are message brokers, and the feature each backend uses can tell a publisher it was first, but leaves no record that a backup could check later and atomically replace. [Brokers and leases](../brokers-and-leases/) explains why, and what could change it.

```mermaid
flowchart LR
  subgraph lease["Lease backend"]
    direction TB
    l1["claim: who runs it?"] --> l2["heartbeat: still alive?"] --> l3["takeover when the lease runs out"]
  end
  subgraph claim["Claim-only backend"]
    direction TB
    c1["claim: who runs it?"] --> c2["the winner runs it.<br/>If it dies, the run is lost"]
  end
```

Use a claim-only backend when losing the occasional run to a crash is acceptable and you don't want another piece of infrastructure.

## How each one picks the winner

Each store has a different primitive that lets exactly one writer succeed. The details, with diagrams, are in [Claim algorithms](../../internals/claim-algorithms/).

| Backend | The atomic step |
| --- | --- |
| Redis `lease` | A Lua script that reads the run's state and writes the claim |
| Redis `stream-id` | `XADD` with the run time as the entry ID; Redis refuses an ID that isn't greater than the last |
| Redis `idmp` | `XADD ... IDMP`; Redis keeps the first entry for an idempotency key |
| Redis `script` | A Lua script that appends the run only if it isn't in the stream |
| PostgreSQL | One transaction on the run's row, serialized per job |
| SQLite | One `BEGIN IMMEDIATE` transaction; SQLite has one writer at a time |
| RabbitMQ | A queue that holds one message and rejects the rest, with publisher confirms |
| NATS | JetStream de-duplication by message ID |

## Using a backend

Every backend is created and passed in as `backend`:

```ts
import { NatsBackend, PostgresBackend, RabbitMQBackend, RedisBackend, Scheduler, SqliteBackend } from 'anarchon';

new Scheduler({ backend: new RedisBackend({ redis: 'redis://localhost:6379' }) });
new Scheduler({ backend: new PostgresBackend({ connection: process.env.DATABASE_URL }) });
new Scheduler({ backend: new SqliteBackend({ database: './jobs.db' }) });
new Scheduler({ backend: new RabbitMQBackend({ url: 'amqp://localhost' }) });
new Scheduler({ backend: new NatsBackend({ servers: 'nats://localhost:4222' }) });
```

`scheduler.backend.name` tells you which one is in use: `'redis:lease'`, `'postgres'`, `'sqlite'`, `'rabbitmq'` or `'nats'`.

## Your own connections

Every backend accepts a client your app already has. anarchon never closes a client it didn't open, so `stop()` leaves yours usable.

```ts
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const scheduler = new Scheduler({ backend: new PostgresBackend({ connection: pool }) });

await scheduler.stop();
await pool.query('SELECT 1'); // still works
```

## Sharing a store between services

Two services on the same Redis or database must not see each other's jobs. Give each its own namespace:

| Backend | Option | Default |
| --- | --- | --- |
| Redis / Valkey | `prefix` | `'cron:'` |
| PostgreSQL / SQLite | `table` | `'anarchon_runs'` |
| RabbitMQ | `prefix` | `'cron.'` |
| NATS | `prefix` and `stream` | `'cron.'`, `'CRON'` |

Instances of the **same** service must use the same value. See [Several services on one store](../../recipes/several-services/).

## Next

Pick your store: [Redis and Valkey](../redis/), [PostgreSQL](../postgres/), [SQLite and libSQL](../sqlite/), [RabbitMQ](../rabbitmq/), [NATS](../nats/), or [write your own](../custom/).
