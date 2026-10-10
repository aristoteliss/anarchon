---
title: FAQ
description: Short answers to common questions.
---

## General

### Do I need a leader or a lock?

No. Every instance runs the same code. For each run they all ask the shared store, and the store lets one win. There is nothing to elect and nothing to release.

### How is this different from a plain cron library?

A library such as `node-cron` or `croner` fires a timer in the process it runs in. With three instances, the job runs three times. anarchon adds the step that makes it run once: an atomic claim in a store all instances share. It uses `croner` only to compute *when* a cron expression is next due.

### How is this different from a job queue?

A queue distributes many pieces of work to workers. anarchon decides which instance runs a job at each scheduled time. They combine well: a scheduled job can enqueue work for a queue.

### Can I use it with a single instance?

Yes. It behaves like a normal scheduler, and you get history, plus overlap protection and catch-up after restarts on a lease backend. It is also ready for the day you add a second instance.

### Which Node versions are supported?

Node.js 20 and newer. The built-in SQLite driver needs Node 22.5; on older versions use `better-sqlite3`.

## Jobs

### Why did my job run on start, outside its schedule?

That is catch-up: the latest slot was due recently and nobody had run it, for example right after a full restart. Set `catchUpMs: 0` on the job to turn it off.

### Why does a job show `skipped (taken)` on most instances?

Because one instance won the run and the others didn't. With three instances, two skips per run is normal.

### Why was a run skipped as `overlap`?

The previous run of that job was still going. Runs of one job don't overlap unless you set `overlap: 'allow'`.

### Does a failed job get retried?

No. A handler that throws is recorded as `failed`, and the next run is the next scheduled slot. Retries are for runners that **die**, not for errors. Retry errors inside your handler if you want that.

### Can a job run twice for the same slot?

Yes, when its runner dies or freezes mid-run and a backup starts it again. Use `ctx.slot` as an idempotency key. See [Guarantees and limits](../guarantees/).

### How do I run a job right now?

`await scheduler.runNow('name')`. It runs on the instance you call it on, isn't deduplicated, and is recorded as a manual run.

### Can I change a job's schedule without a restart?

`scheduler.remove('name')`, then add it again with the new schedule. Do it on every instance.

### Can jobs be added after `start()`?

Yes. They are scheduled at once.

### How do I pass data to a job?

Handlers are ordinary functions: close over what they need. There is no per-run payload, because a run is defined by its time, not by a message.

## Timing

### Does `every('1d')` run at midnight my time?

No, at midnight UTC. Use `cron('0 0 * * *', handler, { timezone: 'Europe/Athens' })` for a local time.

### Why doesn't my job start exactly on the second?

Each instance waits a random delay up to `jitterMs` (2 seconds by default) before claiming, to spread the work. Set `jitterMs: 0` for a start on the dot; the fastest instance then wins every time.

### How fast is a dead runner replaced?

Within `leaseMs + 2 × heartbeatMs`: 40 seconds with the defaults. Lower `leaseMs` for faster failover.

### What if my instances' clocks differ?

A small difference only changes which instance tends to win. Leases use the store's clock, so they aren't affected. Keep clocks synced with NTP.

## Stores

### Which backend should I use?

The store you already have. Redis, PostgreSQL and SQLite give the full feature set. RabbitMQ and NATS only guarantee one winner per run. See [Backends overview](../../backends/overview/).

### Can two services share one Redis or database?

Yes, with a different `prefix` (Redis, RabbitMQ, NATS) or `table` (PostgreSQL, SQLite) each. See [Several services on one store](../../recipes/several-services/).

### Does anarchon close my Redis client or database pool?

No. It closes only connections it opened itself.

### What happens if the store is down?

No run can be claimed, so scheduled runs are skipped on every instance, with `error` events. Jobs already running continue. When the store returns, scheduling resumes, and on a lease backend the latest missed run is caught up if it is within `catchUpMs`.

### Does it work with Redis Cluster?

The `lease` strategy puts all keys of one job under one hash tag, so its scripts run on a single node. Pass a cluster client you created. The built-in tests run against single servers.

### Can I use SQLite across several machines?

Not with a plain file. Use a libSQL server or Turso, or PostgreSQL.

## Operations

### How do I stop cleanly during a deploy?

Call `await scheduler.stop()` on `SIGTERM`, and make handlers throw when `ctx.signal` aborts. The run is handed to another instance. See [Rolling deploys on Kubernetes](../../recipes/kubernetes/).

### How do I see what ran?

`scheduler.history('name')` returns the runs from all instances. `log: true` prints a line per event on each instance.

### How do I monitor it?

Count `failure`, `lost` and non-`taken` `skip` events as metrics, and alert on `lastRun()` being too old or failed. See [Events and logging](../../guides/events-and-logging/#metrics).

### How much load does it put on the store?

Per run: one claim per instance, a heartbeat every `heartbeatMs` from the runner, a check every one to two heartbeats from each backup, and two writes at the end. For most services that is a handful of small operations per job per minute.

### Is the stored format stable?

The keys, tables and message formats are internal and may change between versions. Read through `history()`.

## Licensing

### What is the license?

anarchon is dual-licensed: GNU AGPLv3, or a commercial license for applications that can't be released under the AGPL. The repository's `LICENSE` and `COMMERCIAL_LICENSE.txt` files have the terms.
