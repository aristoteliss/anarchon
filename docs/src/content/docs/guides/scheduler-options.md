---
title: Scheduler options
description: Every option of new Scheduler(), with examples.
---

`new Scheduler(options)` takes one object. Everything in it is optional: `new Scheduler()` connects to Redis on `localhost:6379`.

Give every instance of a service the same options, apart from `instanceId`.

## Where runs are stored

You choose a store in one of two ways, never both.

### The Redis shortcuts

For Redis and Valkey you can pass the connection directly:

```ts
new Scheduler();                                              // redis://localhost:6379
new Scheduler({ redis: 'redis://cache.internal:6379' });
new Scheduler({ redis: 'rediss://user:secret@host:6380/2' }); // TLS, user, password, database 2
new Scheduler({ redis: { host: 'localhost', port: 6390 } });  // Valkey works the same
new Scheduler({ redis: existingIoredisClient });              // your client; stop() leaves it open
```

| Option | Default | Meaning |
| --- | --- | --- |
| `redis` | `localhost:6379` | A URL, `{ host, port, password, db }`, or a client you already have (ioredis, iovalkey, node-redis, Valkey GLIDE, or any object with `send(command, args)`) |
| `strategy` | `'lease'` | How one winner is picked. See [Redis and Valkey](../../backends/redis/) |
| `prefix` | `'cron:'` | Prefix of every key |
| `idmp` | | Settings for the `'idmp'` strategy |

### Any other backend

```ts
import { PostgresBackend, Scheduler, SqliteBackend } from 'anarchon';

new Scheduler({ backend: new PostgresBackend({ connection: process.env.DATABASE_URL }) });
new Scheduler({ backend: new SqliteBackend({ database: './jobs.db' }) });
```

Passing both `backend` and a Redis shortcut throws a `TypeError`.

## Identity

### `instanceId`

The name of this instance in history and events. The default is `hostname:pid`.

It must differ between instances, or history can't tell them apart. A pod name reads better than a process id:

```ts
new Scheduler({ redis, instanceId: process.env.POD_NAME });
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
  redis,
  timezone: 'Europe/Athens',
  historySize: 200,
  historyTtlMs: 7 * 24 * 60 * 60_000, // one week
});
```

:::tip
Always set `timezone` if you use `cron()`. The default is the server's local zone, which can differ between your laptop, your CI and production.
:::

## Lease timing

*Lease backends only.*

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
new Scheduler({ redis, leaseMs: 10_000, heartbeatMs: 2_000 }); // a dead runner is replaced within about 14 s
```

[Leases](../../internals/leases/) explains the mechanism.

## Logging

| Option | Default | Meaning |
| --- | --- | --- |
| `log` | `false` | Write one line per start, finish, failure, interruption, skip and lost run |
| `logger` | `console` | Where those lines, and errors nobody listens for, are written |

```ts
import pino from 'pino';

new Scheduler({ redis, log: true, logger: pino() });
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
import { Scheduler } from 'anarchon';

export const scheduler = new Scheduler({
  redis: process.env.REDIS_URL,
  prefix: 'billing:cron:',          // this service's own keys
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
| Both `backend` and a Redis shortcut | `TypeError` |
| `instanceId` is an empty string | `TypeError` |
| A number is negative, zero where not allowed, or not a whole number | `RangeError` |
| `heartbeatMs` is not under half of `leaseMs` | `RangeError` |

Nothing connects in the constructor. Connection problems appear when you call `start()`.

## Next

- [Writing handlers](../writing-handlers/)
- [Lifecycle](../lifecycle/)
