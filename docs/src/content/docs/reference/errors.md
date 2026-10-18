---
title: Errors
description: The errors anarchon throws, what each means, and how to fix it.
---

anarchon checks settings early and says what is wrong. Errors come at three moments.

| When | What |
| --- | --- |
| `new Scheduler()`, `every()`, `cron()`, `at()` | Invalid options. Thrown synchronously |
| `start()` | The store can't be reached, is too old, or a driver is missing. The promise rejects |
| While running | Problems with the store. Reported as [`error` events](../events/#error), never thrown |

## Creating a scheduler

| Message | Cause | Fix |
| --- | --- | --- |
| `A scheduler needs a backend, e.g. backend: new RedisBackend({ redis: url }). No store is assumed` | `new Scheduler()` was given no `backend` | Pass `backend` |
| `instanceId must be a non-empty string` | `instanceId: ''`, often an unset environment variable | Check the variable, or omit the option |
| `heartbeatMs (N) must be under half of leaseMs (M), so a lease is renewed at least twice` | `heartbeatMs` too close to `leaseMs` | Lower `heartbeatMs` or raise `leaseMs` |
| `X must be a positive whole number (got N)` | A timing is zero, negative or fractional | Use whole milliseconds |
| `Unknown strategy "X"` | A typo in `strategy` | `'lease'`, `'stream-id'`, `'idmp'` or `'script'` |

## Adding a job

| Message | Cause | Fix |
| --- | --- | --- |
| `Job name must be a non-empty string` | Empty or missing name | Give the job a name |
| `Job "X" is already registered` | The same name twice on one scheduler | Use distinct names, or `remove()` first |
| `Job "X": handler must be a function` | The arguments are in the wrong order, or the handler is missing | `every(name, interval, handler, options)` |
| `Job "X": the interval must be at least 1s (got N ms)` | `every()` with less than one second | One second is the minimum |
| `Invalid duration: "X" (examples: "10s", "35m", "1h30m")` | An interval string anarchon can't read | Use `ms`, `s`, `m`, `h`, `d` |
| `Job "X": invalid cron "E": ...` | A malformed cron expression | Five fields, or six with seconds first |
| `Cron expression "E" never runs in the future` | The expression matches no future date | Check the day and month fields |
| `Job "X": invalid date ...` | `at()` with something that isn't a date | Pass a `Date`, ms, or an ISO string |
| `Job "X": jitterMs (N) must be under half the time between runs (M ms)` | Jitter too large for the interval | Lower `jitterMs`, or leave it unset |
| `Job "X": maxLateMs (N) must be bigger than jitterMs (M)` | An instance waiting its full jitter would already be late | Raise `maxLateMs` or lower `jitterMs` |
| `Job "X": jitterMs + maxLateMs (N ms) must be shorter than how long B remembers a run (M ms)...` | A late instance could claim a run the store has forgotten | Lower `maxLateMs`, or raise the backend's window (`idmp.durationSec`, `scriptWindowMs`, `slotTtlMs`, `duplicateWindowMs`) |
| `Job "X": idmp.maxSize (N) runs × G ms between runs must cover jitterMs + maxLateMs` | `'idmp'` keeps too few run IDs for this interval | Raise `idmp.maxSize` or lower `maxLateMs` |
| `Job "X": historySize (N) runs × G ms between runs must cover jitterMs + maxLateMs ... for the "script" strategy` | `'script'` finds claimed runs in the stream, which is trimmed to `historySize` | Raise `historySize` or lower `maxLateMs` |
| `Job "X": historyTtlMs must be longer than scriptWindowMs` | Same reason, by age | Raise `historyTtlMs` |
| `Job "X": overlap must be "skip" or "allow"` | A typo in `overlap` | Use one of the two |
| `Job "X": with RabbitMQ, job names may only contain letters, digits, "_" and "-"` | The name becomes a queue name or a subject | Rename the job |
| `offsetMs must be a whole number of ms` | A fractional offset | Use whole milliseconds |

## Decorators

A job declared with a decorator is added when its object is created, or when the scheduler starts if the object was created first. So the "Adding a job" errors above can also come from `new YourClass()` and from `start()`. See [Decorators](../decorators/#where-errors-appear).

| Message | Cause | Fix |
| --- | --- | --- |
| `@Every can only decorate a public instance method` (also `@Cron`, `@At`) | The decorator is on a `static` or `#private` method, or on something that isn't a method | Put it on a public instance method |
| `Job "X" is already registered`, thrown from a constructor | A second object of the same decorated class was created, or two methods share a name | Create one object per class; give each decorator its own name |
| `register() needs an object whose class has methods decorated with @Cron, @Every or @At` | The class was passed instead of an object, or the class has no decorated methods | Pass an object: `scheduler.register(new Reports())` |
| `@Cron("0 8 * * *", "Europe/Athens"): with two strings, the first is the job's name and the second the cron expression...` | A time zone, or the name, was passed as the second string | `@Cron('0 8 * * *', { timezone: 'Europe/Athens' })`, or `@Cron(name, expression)` |
| `@Every("1h", "sync"): the job's name, a string, comes first and the interval second...` (also `@At`) | The name and the schedule are in the wrong order, or the name isn't a string | `@Every('sync', '1h')` |
| Warning: `@Every "X" on Reports.sync is not scheduled: with legacy decorators, add @Scheduled() to the class or call scheduler.register(object)` | Legacy decorators (`experimentalDecorators`), no `@Scheduled()` on the class, and no object registered when the scheduler started | Add `@Scheduled()`, or call `scheduler.register(object)` |
| Warning: `@Cron("...") on the method "X" is not scheduled: no object of its class has been created` | No object of the class existed when the scheduler started | Create the object. Ignore it if the class isn't meant to run in this process |
| `Job "X" is already registered. To use several objects of one class, register each of them with a prefix of its own...` | A second object of a decorated class was created | `scheduler.register(new Reports(), { prefix: 'a:' })` for each object, created inside the call |
| `Scheduler.configure() needs a backend, e.g. backend: new RedisBackend({ redis: url })` | Settings without a backend. None is assumed | Add `backend` |
| `The default scheduler already exists: configure it before it is created` (also for a named one) | `configure()` was called after the scheduler was created | Call `configure()` first, at startup |
| `Scheduler "X" has no settings of its own, and the default settings hold a backend object...` | A job names scheduler `X`, which can only be created from the default settings, and those hold one backend object | `Scheduler.configure('X', { ... })`, or make the default `backend` a function of the name |
| `There is no default scheduler...`, `There is no scheduler named "X"...` | `Scheduler.get()` found no scheduler and no settings | Create it, or call `configure()` |
| `A scheduler named "X" already exists` | Two schedulers were given the same `name` | Use one, or another name |

## Starting

| Message | Cause | Fix |
| --- | --- | --- |
| A connection error from the driver (`ECONNREFUSED`, authentication failed...) | The store isn't reachable | Check the URL, network and credentials |
| `The "lease" strategy needs Redis 5 or newer` | A very old Redis | Upgrade Redis |
| `The "idmp" strategy needs Redis 8.6 or newer (this server is ...)` | Valkey, or Redis before 8.6 | Use `'lease'`, `'stream-id'` or `'script'` |
| `The Postgres backend needs PostgreSQL 9.5 or newer` | An old PostgreSQL | Upgrade |
| `The Postgres backend needs "pg"...` | The driver isn't installed | `pnpm add pg`, or pass your own client |
| `The SQLite backend needs SQLite 3.35 or newer for RETURNING` | An old SQLite library | Use a newer Node or `better-sqlite3` |
| `Could not open "path": this Node has no node:sqlite (Node 22.13+, or 22.5+ with --experimental-sqlite) and "better-sqlite3" isn't installed` | No SQLite driver available | Use Node 22.13+ (22.5 to 22.12 with `--experimental-sqlite`), or `pnpm add better-sqlite3` |
| `database is locked` | Another process held the SQLite file for longer than `busyTimeoutMs` | Raise `busyTimeoutMs`; check for a long-running writer |
| `The RabbitMQ backend needs RabbitMQ 3.9 or newer for stream queues` | An old RabbitMQ | Upgrade |
| `The RabbitMQ backend needs "amqplib"...` | The driver isn't installed | `pnpm add amqplib` |
| `The NATS backend needs JetStream enabled on the server (nats-server -js)` | JetStream is off | Enable it |
| `Cannot start while stopping` | `start()` called while a `stop()` is in progress | Await `stop()` first |
| `Invalid table name "X"` | `table` isn't a plain identifier (optionally `schema.table`) | Use letters, digits and `_` |
| `A custom SQL client needs both all() and transaction()` | An incomplete adapter | Provide both functions |

If `start()` rejects, the scheduler is back in the idle state. You can fix the cause and call `start()` again.

## Calling methods

| Message | Cause | Fix |
| --- | --- | --- |
| `Unknown job "X"` | `runNow()` or `nextRun()` for a job not registered on this instance | Register it here, or call a process that has it |
| `Call start() before runNow()` | The scheduler isn't running | Await `start()` first |
| `limit must be a whole number from 1 to 10000` | `history()` with a bad limit | Often a query-string value that didn't parse: validate it |
| `Could not start a manual run of "X"` | Ten manual runs of one job were requested within the same few milliseconds | Retry |

## While running

Problems with the store during normal operation are **not thrown**. They arrive as `error` events:

```ts
scheduler.on('error', (e) => {
  logger.error({ err: e.error, job: e.job, slot: e.slot }, 'scheduler backend problem');
});
```

| Situation | What happens |
| --- | --- |
| A claim couldn't be sent | That instance skips the run. Another instance may still win it |
| A heartbeat failed | It is tried again at the next heartbeat. If failures last longer than the lease, a backup takes over |
| The result couldn't be saved | The job ran, but its history record stays `running` or becomes `interrupted` |
| A listener threw | Logged; nothing else is affected |

Without an `error` listener, these are written with `logger.error`.

## Errors from your handler

An error thrown by a handler is not an anarchon error. The run is recorded as `failed` with the error's name and message, and the `failure` event carries the thrown value as `cause`. Messages longer than 2000 characters are cut in history.

| Recorded error | Meaning |
| --- | --- |
| `TimeoutError: Timed out after N ms` | The job's `timeoutMs` passed |
| `AbortError: The scheduler is stopping` | `ctx.signal.throwIfAborted()` after `stop()`. The run is `interrupted`, not `failed` |
| `AbortError: This run was taken over by another instance` | The same, after a takeover |
