---
title: Defining jobs
description: Interval jobs, cron jobs and one-off jobs, with the rules each follows.
---

A job has a **name**, a **schedule** and a **handler**. There are three kinds of schedule, each with its own method. All three return the scheduler, so they chain.

```ts
scheduler
  .every('sync', '10s', syncCustomers)             // an interval
  .cron('digest', '0 8 * * 1-5', sendDigest)       // a cron expression
  .at('launch', '2026-12-01T09:00:00Z', announce); // once
```

:::tip[The one rule]
Register the same jobs, with the same names and schedules, on every instance. Instances agree on run times because they compute them from the same schedule.
:::

## Interval jobs: `every()`

```ts
scheduler.every(name, interval, handler, options?)
```

The interval is a number of milliseconds or a duration string.

| Written as | Means |
| --- | --- |
| `10_000` | 10 seconds |
| `'10s'` | 10 seconds |
| `'35m'` | 35 minutes |
| `'1h30m'` | 1 hour 30 minutes |
| `'2d'` | 2 days |
| `'1.5h'` | 1 hour 30 minutes |

The units are `ms`, `s`, `m`, `h` and `d`. The shortest interval is 1 second.

### Runs fall on a fixed grid

`every('10s')` does **not** mean "10 seconds after the process started". It means every multiple of 10 seconds counted from 1970-01-01 UTC: :00, :10, :20 and so on.

This matters for two reasons:

- Every instance computes the same times, whenever it started. That is what lets them compete for the same run.
- A restart doesn't shift the schedule.

```
every('10s')   12:00:00  12:00:10  12:00:20  12:00:30
every('1h')    12:00:00  13:00:00  14:00:00
every('1d')    00:00:00 UTC each day
```

### Shifting the grid: `offsetMs`

Two hourly jobs would both start on the hour. `offsetMs` moves one of them:

```ts
scheduler.every('rates', '1h', fetchRates);                             // 12:00, 13:00, ...
scheduler.every('invoices', '1h', buildInvoices, { offsetMs: 30 * 60_000 }); // 12:30, 13:30, ...
```

The offset must be the same on every instance.

:::caution
`every()` works in UTC. `every('1d')` runs at midnight UTC, not midnight where you are. For wall-clock times in a time zone, use `cron()`.
:::

## Cron jobs: `cron()`

```ts
scheduler.cron(name, expression, handler, options?)
```

A cron expression has five fields, or six when the first one is seconds:

```
┌──────── second (optional, 0-59)
│ ┌────── minute (0-59)
│ │ ┌──── hour (0-23)
│ │ │ ┌── day of month (1-31)
│ │ │ │ ┌ month (1-12)
│ │ │ │ │ ┌ day of week (0-7, Sunday is 0 or 7)
* * * * * *
```

| Expression | Runs |
| --- | --- |
| `0 8 * * 1-5` | 08:00, Monday to Friday |
| `30 3 * * *` | 03:30 every day |
| `0 */2 * * *` | Every 2 hours, on the hour |
| `0 0 1 * *` | Midnight on the 1st of each month |
| `*/15 * * * * *` | Every 15 seconds (six fields) |

Expressions are parsed by [croner](https://github.com/hexagon/croner), so its syntax applies.

### Time zones

By default a cron expression is read in the server's local time zone. That can differ between machines, so set it:

```ts
// Per job
scheduler.cron('open-market', '30 9 * * 1-5', open, { timezone: 'America/New_York' });

// Or once for every cron job
const scheduler = new Scheduler({ timezone: 'Europe/Athens' });
```

Use IANA names such as `Europe/Athens` or `UTC`. Daylight-saving changes are handled by the cron library: "08:00 Athens time" stays 08:00 local all year.

## One-off jobs: `at()`

```ts
scheduler.at(name, when, handler, options?)
```

Runs once, on one instance. `when` is a `Date`, milliseconds since 1970, or an ISO string:

```ts
scheduler.at('launch', '2026-12-01T09:00:00Z', announce);
scheduler.at('reminder', new Date(Date.now() + 60 * 60_000), remind); // in one hour
scheduler.at('cutover', 1796115600000, cutOver);
```

Every instance registers the job, and one of them runs it, the same as any other run.

A one-off job whose time has already passed does not run when you register it, with one exception: on a lease backend, if it was due less than `catchUpMs` ago (5 minutes by default) and no instance ran it, the first instance to start runs it. That is the same [catch-up](../../internals/leases/#catch-up-on-start) rule as for other jobs.

## Job names

- Must be unique within a scheduler. Registering a name twice throws.
- The name is part of the keys or rows in the store. Renaming a job starts a new history.
- With RabbitMQ and NATS, names may only contain letters, digits, `_` and `-`, because they become queue names and subjects.

## Adding and removing jobs at run time

Jobs can be added before or after `start()`.

```ts
await scheduler.start();
scheduler.every('late-addition', '1m', work); // scheduled at once
```

`remove(name)` stops scheduling a job on this instance. It returns `false` if there is no such job.

```ts
scheduler.remove('sync');
scheduler.every('sync', '30s', syncCustomers); // the same name with a new schedule
```

Removing a job affects only this instance. Other instances keep running it, its history stays, and a run in progress here finishes.

:::caution
During a rolling deploy that changes a schedule, old and new instances briefly disagree on run times. Each computes its own slots, so for that moment both schedules are active. If that matters, deploy the change in one step or use a new job name.
:::

## Choosing between `every()` and `cron()`

| You want | Use |
| --- | --- |
| "Every N seconds/minutes/hours", time of day doesn't matter | `every()` |
| A specific wall-clock time, weekdays, or a time zone | `cron()` |
| Something that happens once | `at()` |

## Next

- [Job options](../job-options/): timeouts, overlap, retries and more
- [Writing handlers](../writing-handlers/): the function a job runs
