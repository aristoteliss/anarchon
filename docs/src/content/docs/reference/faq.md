---
title: FAQ
description: Short answers to common questions.
---

## General

### Do I need a leader or a lock?

No. Every instance runs the same code. For each run they all ask the shared store, and the store lets one win. There is nothing to elect and nothing to release.

### How is this different from a plain cron library?

A cron library such as `croner` fires a timer in the process it runs in. With three instances, the job runs three times. anarchon adds the step that selects one instance: an atomic claim in a store all instances share. It uses `croner` only to compute *when* a cron expression is next due.

`node-cron` can also pick one runner per scheduled time with its `distributed` option. [Choosing anarchon](../../getting-started/choosing-anarchon/) compares the two, and BullMQ and Kubernetes CronJobs.

### How is this different from a job queue?

A queue distributes many pieces of work to workers. anarchon decides which instance runs a job at each scheduled time. They combine well: a scheduled job can enqueue work for a queue.

### Can I use it with a single instance?

Yes. It behaves like a normal scheduler, and you get history, plus overlap protection and catch-up after restarts on a lease backend. It is also ready for the day you add a second instance.

### Which Node versions are supported?

Node.js 20 and newer. The built-in SQLite driver needs Node 22.13 (or 22.5 with the `--experimental-sqlite` flag); on older versions use `better-sqlite3` (version 12 on Node 20).

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

Handlers are ordinary functions, so they can close over what they need. For data you decide where the job or the scheduler is defined, such as a permission, a tenant or a fresh token, give a [`data`](../../guides/run-data/) and read it as `ctx.data`. There is no per-run payload from another instance, because a run is defined by its time, not by a message.

### Can I declare jobs with decorators, as in NestJS?

Yes, with `@Every`, `@Cron` and `@At` on the methods of any class, with or without a framework. An object adds its jobs to the scheduler when it is created, so there is nothing to register. See [Decorators](../../guides/decorators/).

### Do I have to create a scheduler to use the decorators?

No. Give the settings once with `Scheduler.configure({ backend: new RedisBackend({ redis: url }), autoStart: true })`, and the scheduler is created and started when the first decorated object is. A backend must be in the settings; none is assumed. See [Decorators](../../guides/decorators/#two-ways-to-have-a-scheduler).

### Can different jobs use different schedulers?

Yes. A decorator names one with `{ scheduler: 'billing' }`, and jobs with the same name share it. See [Choosing a scheduler for a job](../../guides/decorators/#choosing-a-scheduler-for-a-job).

### Can I have several objects of one decorated class?

Yes, each with a prefix of its own: `scheduler.register(new Reports(), { prefix: 'acme:' })`. See [Several objects of one class](../../guides/decorators/#several-objects-of-one-class).

### Why does my decorated job never run?

Look for a warning that starts with `[anarchon] @Every ... is not scheduled` in the output of `start()`: the scheduler gives one for every declared job that no object has added, and it says why.

Most often the project compiles with legacy decorators (`"experimentalDecorators": true`) and the class has no `@Scheduled()`. In that style a method decorator can't act when an object is created, so add `@Scheduled()` to the class or call `scheduler.register(object)`. The other cause is that no object of the class is created at all. `scheduler.jobs()` lists what was added.

### What does the warning `ANARCHON_DUPLICATE_COPY` mean?

anarchon is installed twice in your app, usually because a dependency asks for another version. Each copy has its own list of schedulers, so jobs declared with one copy's decorators are never added to a scheduler of the other. `npm ls anarchon` (or `pnpm why anarchon`) shows where the copies come from; make them resolve to one version.

### Why is there no `@Timeout` decorator?

A timeout counts from the start of each process, so every instance would compute a different time and run the job. `@At` takes an absolute time that all instances agree on.

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

The store you already have. Redis, PostgreSQL, SQLite and NATS with `strategy: 'lease'` give the full feature set. RabbitMQ, and NATS with its default strategy, only guarantee one winner per run. See [Backends overview](../../backends/overview/).

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

anarchon is dual-licensed: GNU AGPLv3, or a commercial license for applications that can't be released under the AGPL. The repository's `LICENSE` and `COMMERCIAL_LICENSE.txt` files have the terms, and [Licensing](../licensing/) summarizes them: the revenue tiers, how to register for the free tier, and who to contact.
