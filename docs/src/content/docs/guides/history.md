---
title: History
description: Ask who ran a job, when it finished and how it ended, from any instance.
---

Every run is recorded in the store. Any instance can read that record, including a process that doesn't run jobs at all.

```ts
const runs = await scheduler.history('sync', 5); // newest first
const last = await scheduler.lastRun('sync');
const next = scheduler.nextRun('sync');
const jobs = scheduler.jobs();
```

## `history(name, limit?)`

Returns the latest runs of a job from **all instances**, newest first. `limit` is 1 to 10000 and defaults to 20.

```ts
for (const run of await scheduler.history('sync', 5)) {
  console.log(run.scheduledAt.toISOString(), run.instanceId, run.attempt, run.status, run.durationMs);
}
```

```
2026-10-10T12:00:20.000Z api-1 1 success 198
2026-10-10T12:00:10.000Z api-3 1 success 212
2026-10-10T12:00:00.000Z api-2 1 success 205
```

There is **one record per attempt**. A run that was taken over shows twice: the attempt that didn't finish, and the one that did.

```
2026-10-10T12:00:00.000Z api-2 2 success      4010     <- a backup finished it
2026-10-10T12:00:00.000Z api-1 1 interrupted           <- its first runner died
```

`history()` works for any job name, even one not registered on this instance, and connects on its own if `start()` hasn't been called.

## The run record

| Field | Type | Meaning |
| --- | --- | --- |
| `job` | `string` | The job's name |
| `slot` | `number` | Scheduled time, ms since 1970 |
| `scheduledAt` | `Date` | `slot` as a Date |
| `instanceId` | `string` | Who ran this attempt |
| `attempt` | `number` | `1`, or `2` and up when a backup took over |
| `reason` | `string` | `'scheduled'`, `'manual'`, `'catch-up'` or `'takeover'` |
| `manual` | `boolean` | `true` for `runNow()` |
| `status` | `string` | See below |
| `startedAt` | `Date` | When the instance claimed and started it |
| `finishedAt` | `Date` | When it ended. Missing while it runs |
| `durationMs` | `number` | Missing while it runs |
| `error` | `string` | The error message, when `status` is `'failed'` |

### Status

| Status | Meaning |
| --- | --- |
| `running` | In progress |
| `success` | The handler returned |
| `failed` | The handler threw or timed out |
| `interrupted` | The attempt didn't finish: its runner died or froze, lost the run to a backup, or was stopped |

:::note
`interrupted` for a dead runner needs a lease backend, which can tell that the runner is gone. On claim-only backends a run whose runner died keeps showing `running`, because nothing ever marks it otherwise.
:::

## `lastRun(name)`

The most recent attempt, or `null` if the job never ran.

```ts
const last = await scheduler.lastRun('sync');
const healthy = last?.status === 'success' && Date.now() - last.startedAt.getTime() < 60_000;
```

## `nextRun(name)`

When a registered job is next due, as a `Date`, or `null` if there are no more runs (a one-off job in the past). The run starts up to `jitterMs` later, on whichever instance claims it.

It throws if the job isn't registered on this instance.

## `jobs()`

The jobs registered on this instance.

```ts
console.table(scheduler.jobs());
```

| name | type | schedule | nextRunAt | runningHere |
| --- | --- | --- | --- | --- |
| sync | every | every 10s | 2026-10-10T12:00:10.000Z | 0 |
| digest | cron | cron "0 8 * * 1-5" (Europe/Athens) | 2026-10-12T05:00:00.000Z | 0 |

`runningHere` is how many runs of that job this instance is executing right now.

## A read-only process

A dashboard or admin API doesn't have to run jobs. Create a scheduler pointing at the same store, register nothing, and read:

```ts
const reader = new Scheduler({ backend: new RedisBackend({ redis: process.env.REDIS_URL, prefix: 'billing:cron:' }) });

app.get('/jobs/:name/runs', async (req, res) => {
  res.json(await reader.history(req.params.name, 50));
});
```

It must use the same store, and the same `prefix` or `table`, as the instances that run the jobs.

## Health checks

```ts
app.get('/health/cron', async (_req, res) => {
  const last = await scheduler.lastRun('sync');
  const ageMs = last ? Date.now() - last.startedAt.getTime() : Infinity;
  const ok = last?.status !== 'failed' && ageMs < 3 * 10_000; // "sync" runs every 10 s
  res.status(ok ? 200 : 503).json({ ok, last });
});
```

Checking the **store** rather than local state means the check passes on every instance as long as some instance is running the job, which is what you want behind a load balancer.

## How much is kept

`historySize` (default 1000 runs per job) and `historyTtlMs` (no limit by default) control what is kept. Both are [job options](../job-options/#historysize-and-historyttlms) with scheduler-wide defaults.

Where it is kept depends on the backend:

| Backend | Where history lives |
| --- | --- |
| Redis / Valkey | A stream of claims and a sorted set of results, per job |
| PostgreSQL / SQLite | The `<table>_attempts` table |
| RabbitMQ | A stream queue per job |
| NATS | The JetStream stream, on the job's subjects |

## Next

- [Events and logging](../events-and-logging/)
- [Express recipe](../../recipes/express/): history behind an HTTP API
