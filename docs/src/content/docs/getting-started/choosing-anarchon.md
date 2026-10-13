---
title: Choosing anarchon
description: When anarchon fits, when BullMQ, node-cron, your own lock or a Kubernetes CronJob fits better, and what each one asks of you.
---

anarchon is one of several ways to run scheduled work in a service with more than one instance. This page says where it fits, where another tool fits better, and what each choice leaves for you to handle.

What this page says about other tools was checked on **13 October 2026** against the versions and pages listed under [Sources](#sources). Those tools change: read their own documentation before you decide.

## In short

| Approach | Good fit | What you take on |
| --- | --- | --- |
| anarchon | Recurring handlers that run inside your service's instances, coordinated through a store they already share | Recovery depends on the backend; attempts are bounded; handlers must be idempotent; some slots are skipped by design |
| BullMQ | Queued work: a backlog, retries with backoff, rate limits, flows of dependent jobs | Queue concepts and configuration; workers to run, in your application's process or in separate ones |
| node-cron | Timers in one process, or one runner per scheduled time with its `distributed` option | What happens to a run whose runner dies; the lease must be longer than the run |
| Your own timer and lock | A team that wants to own the scheduling and locking code | Renewal, recovery, history, shutdown and failure behavior are yours to design and test |
| Kubernetes CronJob | Batch work that should run as its own container, apart from the service | A Pod started per run; Job and Pod lifecycle; manifests to maintain |

## anarchon

- **Where the job runs.** Inside the instances of your service: the handler is a function in your application.
- **What it needs.** A store all instances reach: Redis, Valkey, PostgreSQL, SQLite on one machine, or a libSQL server. RabbitMQ and NATS work with fewer features.
- **Who runs a scheduled time.** Every instance computes the same slot and tries to claim it; one atomic step in the store lets one instance win each attempt.
- **When the runner dies.** On a lease backend, another instance starts the run again as a new attempt, about one lease later, up to `maxAttempts`. The handler starts from the beginning. On RabbitMQ, NATS and the simple Redis strategies the run is lost.
- **Long runs.** On a lease backend the next run of a job is skipped while the current one holds a live lease.
- **Missed schedules.** On start, only the latest missed run is run, and only if it was due within `catchUpMs`. Older runs are not replayed.

The [backend table](../../backends/overview/#what-each-backend-gives-you) shows which backend has which of these, and [Guarantees and limits](../../reference/guarantees/) states what is and isn't promised.

## BullMQ

BullMQ is a queue for jobs and messages. Its Job Schedulers produce jobs from an interval or a cron pattern, and workers process them.

- **Where the job runs.** In a `Worker`, which you create in a Node.js process. That can be your application's process or a separate one; a separate deployment is your choice, not a requirement.
- **What it needs.** Redis by default. Its documentation also describes an optional PostgreSQL backend (PostgreSQL 13 or newer) that runs the same API, and calls the Redis backend "the default and the most battle-tested option".
- **When a worker stops renewing a job's lock.** The documentation says "a stalled job is moved back to the waiting status and will be processed again by another worker", and that a job that reaches its maximum number of stalls is moved to the failed set.
- **Schedules.** A Job Scheduler "will only generate new jobs when the last job begins processing", so a busy queue can produce jobs less often than the interval.

Choose BullMQ when the work is a queue: many jobs waiting, each one to be processed, with retries and backoff, priorities, rate limits or flows. anarchon has none of that. It decides which instance runs a job at each scheduled time and keeps no backlog.

## node-cron

node-cron runs a function on a timer in the process that scheduled it. Without more, three instances run the job three times.

- **Overlap.** `noOverlap` skips a run while the previous one is still going.
- **Several instances.** With `distributed: true` a task "fires on exactly one instance per scheduled time". By default this reads the `NODE_CRON_RUN` environment variable: you mark one instance as the runner, and if that instance is down the task doesn't run. For high availability its documentation points to `@node-cron/redis-coordinator`, where instances claim each scheduled time under a lease (`distributedLease`, 30 s by default), and the lease must be longer than the task's run time.
- **Limits it states.** Its documentation calls this "a coordination primitive, not a transactional queue", says a fire can run more than once after a crash and retry or with large clock skew, and advises idempotent tasks. It does not say that another instance takes over a run whose runner died.

Choose node-cron when one process runs the schedule, or when one runner per scheduled time is all you need. anarchon adds a renewed lease with takeover of a dead runner's run, hand-over on shutdown, catch-up after downtime, and a run history, on stores other than Redis too.

## Your own timer and lock

A timer library and a distributed lock, such as the Redlock algorithm, can be combined: each instance tries to take a lock for the scheduled time, and the holder runs the job.

The Redis documentation of Redlock states the limits you then own:

- A lock has a validity time and is released automatically when it ends. Mutual exclusion "is guaranteed only as long as the client holding the lock terminates its work within the lock validity time", so a longer job must extend the lock.
- It tells you not to assume "that a lock is retained as long as the process that had acquired it is alive", and to implement fencing tokens.
- Redis doesn't use a monotonic clock for expiry, so a clock shift can let more than one process hold the lock.

A lock answers "who may run now". It doesn't record that a run happened, start an abandoned run again, hand a run over on shutdown, or catch up a missed one. With this approach, that code is yours. anarchon implements those parts, and its [failure scenarios](../../internals/failure-scenarios/) test them with real processes.

## Kubernetes CronJob

A CronJob creates a Job on a schedule, and the Job starts Pods that run your container.

- **Where the job runs.** In its own Pod, started for each run, apart from your service.
- **Overlap.** `concurrencyPolicy` is `Allow` by default; `Forbid` skips a run while the previous Job is running; `Replace` replaces the running Job.
- **Missed schedules.** `startingDeadlineSeconds` sets how late a Job may start. If more than 100 schedules were missed, the controller doesn't start the Job and logs an error.
- **Duplicates.** The documentation says "there are certain circumstances where two Jobs might be created, or no Job might be created", and that Jobs should therefore be idempotent.
- **Pods.** The CronJob "is only responsible for creating Jobs that match its schedule, and the Job in turn is responsible for the management of the Pods it represents".

Choose a CronJob when the work is a batch program with its own image, resources and lifecycle, or when it shouldn't share a process with request traffic. Choose anarchon when the job is a function of the service: it uses the connections, configuration and code the service already has, and runs in a process that is already started. [Rolling deploys on Kubernetes](../../recipes/kubernetes/) shows anarchon inside a Deployment.

## When anarchon is the wrong tool

- **Every occurrence must be processed.** anarchon skips slots by design: while the previous run is going, after long downtime, or when an instance is too late. Use a queue, or have each run work on everything outstanding.
- **Workflows.** It has no dependent jobs, fan-out, priorities or rate limits.
- **Hard real-time.** A run starts between its slot and `slot + jitterMs`, and a takeover comes about one lease after a crash.
- **Exactly-once side effects.** A run whose runner fails is started again from the beginning. No scheduler removes the need for idempotent handlers.
- **No shared store.** Instances that share nothing can't coordinate through anarchon.
- **The license doesn't fit.** anarchon is offered under the AGPLv3 or a commercial license; BullMQ and redlock are MIT, node-cron is ISC and Kubernetes is Apache-2.0. See [Licensing](../../reference/licensing/).

## Sources

| Tool | Version checked | Pages |
| --- | --- | --- |
| BullMQ | 6.3.14 | [Workers](https://docs.bullmq.io/guide/workers), [Stalled jobs](https://docs.bullmq.io/guide/workers/stalled-jobs), [Job Schedulers](https://docs.bullmq.io/guide/job-schedulers), [PostgreSQL backend](https://docs.bullmq.io/guide/postgresql) |
| node-cron | 4.6.0, with `@node-cron/redis-coordinator` 0.1.0 | [README](https://github.com/node-cron/node-cron), [Distributed coordination](https://nodecron.com/distributed-coordination) |
| Redlock | The algorithm as documented by Redis | [Distributed Locks with Redis](https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/) |
| Kubernetes | Documentation for v1.37 | [CronJob](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/) |
