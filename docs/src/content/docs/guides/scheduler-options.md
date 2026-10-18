---
title: Scheduler options
description: Every option of new Scheduler(), with examples.
---

`new Scheduler(options)` takes one object. One thing in it is required: where runs are stored, given as `backend`. No store is assumed, so `new Scheduler()` throws. Everything else is optional.

Give every instance of a service the same options, apart from `instanceId`.

## Where runs are stored

`backend` is the store: a `RedisBackend` for Redis and Valkey, or any other backend.

```ts
import { PostgresBackend, RedisBackend, Scheduler, SqliteBackend } from 'anarchon';

new Scheduler({ backend: new RedisBackend({ redis: 'redis://localhost:6379' }) });
new Scheduler({ backend: new RedisBackend({ redis: 'rediss://user:secret@host:6380/2' }) }); // TLS, user, password, database 2
new Scheduler({ backend: new RedisBackend({ redis: { host: 'localhost', port: 6390 } }) });  // Valkey works the same
new Scheduler({ backend: new RedisBackend({ redis: existingIoredisClient }) });              // your client; stop() leaves it open
new Scheduler({ backend: new PostgresBackend({ connection: process.env.DATABASE_URL }) });
new Scheduler({ backend: new SqliteBackend({ database: './jobs.db' }) });
```

The Redis connection, strategy and key prefix are options of `RedisBackend`: see [Redis and Valkey](../../backends/redis/).

## Identity

### `instanceId`

The name of this instance in history and events. The default is `hostname:pid`.

It must differ between instances, or history can't tell them apart. A pod name reads better than a process id:

```ts
new Scheduler({ backend, instanceId: process.env.POD_NAME });
```

## Defaults for every job

These set the default of the [job option](../job-options/) with the same name. A job can still override each one.

| Option | Default | Meaning |
| --- | --- | --- |
| `jitterMs` | `2000` | Maximum random delay before claiming. Lowered automatically for short intervals |
| `maxLateMs` | `60000` | Skip a run this instance reaches later than this |
| `historySize` | `1000` | Runs kept per job |
| `historyTtlMs` | none | Also drop history older than this |
| `timezone` | the server's | Time zone for cron expressions |

```ts
new Scheduler({
  backend,
  timezone: 'Europe/Athens',
  historySize: 200,
  historyTtlMs: 7 * 24 * 60 * 60_000, // one week
});
```

:::tip
Always set `timezone` if you use `cron()`. The default is the server's local zone, which can differ between your laptop, your CI and production.
:::

## Name and data

| Option | Default | Meaning |
| --- | --- | --- |
| `name` | none | A name for the scheduler, unique in the process. Jobs declared with decorators choose a scheduler by it: see [Decorators](../decorators/#choosing-a-scheduler-for-a-job) |
| `data` | none | Data for the runs of every job, read in the handler as `ctx.data`: a value, or a function called when a run starts. See [Run data](../run-data/) |

## Lease timing

*Lease backends only.* With RabbitMQ, NATS, or Redis/Valkey without the `lease` strategy, `new Scheduler()` doesn't offer `leaseMs` and `heartbeatMs`, and refuses them if they are set anyway.

| Option | Default | Meaning |
| --- | --- | --- |
| `leaseMs` | `30000` | How long a running job's lease lasts without a heartbeat |
| `heartbeatMs` | `5000`, or `leaseMs / 6` if smaller | How often the runner renews its lease, and how often backups check on it (every 1 to 2 heartbeats) |

`heartbeatMs` must be under half of `leaseMs`, so a lease is renewed at least twice before it can run out.

These two numbers decide how quickly a dead runner is replaced:

```mermaid
flowchart LR
  crash["runner dies"] --> expire["lease runs out<br/>up to leaseMs later"] --> notice["a backup checks<br/>within 2 heartbeats"] --> takeover["takeover"]
```

So a crashed run is taken over at most `leaseMs + 2 × heartbeatMs` after the runner's last heartbeat. With the defaults that is 40 seconds.

| Goal | Setting | Trade-off |
| --- | --- | --- |
| Faster failover | `leaseMs: 6_000, heartbeatMs: 1_000` | More heartbeat traffic. A pause longer than 6 s (a long GC, a brief network drop) causes a takeover while the original runner is still alive |
| Tolerate long pauses | `leaseMs: 120_000` | A really dead runner is replaced only after 2 minutes |

```ts
new Scheduler({ backend, leaseMs: 10_000, heartbeatMs: 2_000 }); // a dead runner is replaced within about 14 s
```

[Leases](../../internals/leases/) explains the mechanism.

## Logging

| Option | Default | Meaning |
| --- | --- | --- |
| `log` | `false` | Write one line per start, finish, failure, interruption, skip and lost run |
| `logger` | `console` | Where those lines, and errors nobody listens for, are written |

```ts
import pino from 'pino';

new Scheduler({ backend, log: true, logger: pino() });
```

A logger needs `warn` and `error`. `info` is optional; without it, run messages go to `console.log`. See [Events and logging](../events-and-logging/).

## Process behavior

### `unrefTimers`

By default the scheduler's timers keep the Node process alive, which is what a service wants. Set `unrefTimers: true` to let the process exit even while runs are scheduled. This is useful in scripts and tests.

```ts
new Scheduler({ backend, unrefTimers: true });
```

## A production-style setup

```ts
import pino from 'pino';
import { RedisBackend, Scheduler } from 'anarchon';

export const scheduler = new Scheduler({
  backend: new RedisBackend({ redis: process.env.REDIS_URL, prefix: 'billing:cron:' }), // this service's own keys
  instanceId: process.env.POD_NAME, // readable names in history
  timezone: 'Europe/Athens',
  logger: pino(),
  log: true,
});
```

## What throws

The constructor validates its options and throws at once, so a bad setting can't reach production silently:

| Problem | Error |
| --- | --- |
| No `backend` | `TypeError` |
| `instanceId` is an empty string | `TypeError` |
| A number is negative, zero where not allowed, or not a whole number | `RangeError` |
| `heartbeatMs` is not under half of `leaseMs` | `RangeError` |
| `leaseMs` or `heartbeatMs` with a backend that has no leases | `TypeError` |

Nothing connects in the constructor. Connection problems appear when you call `start()`.

## Next

- [Writing handlers](../writing-handlers/)
- [Lifecycle](../lifecycle/)
