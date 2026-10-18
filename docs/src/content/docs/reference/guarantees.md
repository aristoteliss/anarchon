---
title: Guarantees and limits
description: Exactly what anarchon promises, what it doesn't, and what that means for your jobs.
---

A scheduler is easy to over-trust. This page states precisely what anarchon guarantees, and where the guarantee ends.

## What is guaranteed

### One winner per attempt

For one job and one slot, only one instance wins each attempt. This holds on every backend, because the claim is a single atomic step in the store.

### A second attempt only after the first stopped renewing

*Lease backends.* A run gets another attempt only when its runner stopped renewing the lease, or released it on `stop()`. A healthy runner is never replaced.

### No two live runs of one job

*Lease backends, `overlap: 'skip'`.* A new run of a job doesn't start while an earlier run of the same job holds a live lease.

### A crashed run is started again

*Lease backends.* If the runner dies, a backup starts the run again, up to `maxAttempts` times, unless a newer run of the job starts first.

### Stale runs don't start

A run isn't started more than `maxLateMs` after its time. On lease backends this is also checked on the store's clock, so a delayed or queued claim can't start one.

### An old runner can't change a run

*Lease backends.* After a takeover, the previous runner's heartbeats and "finished" are refused.

## What is not guaranteed

### Exactly-once execution

anarchon gives **at-least-once** execution for runs whose runner dies. A handler may execute more than once for the same slot:

- A runner crashes after doing half the work. Attempt 2 starts from the beginning.
- A runner freezes, a backup takes over, and the frozen one wakes and runs a little longer before it learns it lost the run.

No scheduler can give exactly-once execution of arbitrary code: the system can't tell "the work was done and the acknowledgement was lost" from "the work was not done". What it can do is give you a stable key, `ctx.slot`, so you can make the work idempotent.

**What to do:** [make jobs safe to run twice](../../guides/writing-handlers/#make-jobs-safe-to-run-twice).

### That every slot runs

A run can be skipped, by design:

| When | Why |
| --- | --- |
| The previous run is still going | `overlap: 'skip'` |
| Every instance was down for longer than `catchUpMs` | Catch-up covers only the latest run, and only if recent |
| The instance was too late | `maxLateMs` |
| A runner died and a newer run of the job started first | The newer run replaces it |
| The store was unreachable when the run was due | Nobody could claim it. Running instances wait for the next slot; on a lease backend it is caught up only if an instance starts within `catchUpMs` after the store returns |

anarchon is not a queue of work to be done. If every slot must produce a result, have each run work on **everything outstanding** rather than on "its" slot only:

```ts
scheduler.every('send-pending-emails', '1m', async (ctx) => {
  for (const email of await pendingEmails()) {  // whatever is outstanding
    ctx.signal.throwIfAborted();
    await send(email);
  }
});
```

A skipped run then costs a delay, not lost work.

### Exact start times

A run starts between its slot and `slot + jitterMs`, on some instance. Don't rely on the start being exact; use `ctx.scheduledAt` for the nominal time.

### Order between jobs

Different jobs are independent. Two jobs due at the same time may run on different instances, in either order.

### Anything on claim-only backends beyond the claim

With RabbitMQ, NATS and the Redis `stream-id`, `idmp` and `script` strategies, a run whose runner dies is **lost**. There are no backups, no overlap protection and no catch-up.

## What the store must provide

anarchon is as reliable as its store.

| If the store | Then |
| --- | --- |
| Is unreachable | No run can be claimed. Running jobs continue, but can't renew: after `leaseMs` they are considered dead |
| Loses acknowledged writes (asynchronous replication with a failover) | A claimed run may look unclaimed, and run again |
| Has several primaries accepting the same writes | The atomic claim no longer holds |

Use a store configured for durability appropriate to your jobs. For jobs where a rare duplicate is unacceptable, idempotency in the handler is the real protection, not the store.

## Clocks

| Assumption | If it doesn't hold |
| --- | --- |
| Instances' clocks agree within a second or so | The faster instance wins more often. Nothing breaks |
| Clocks agree within `maxLateMs` | An instance far behind has its runs refused as late; one far ahead claims early |
| The store's clock moves forward steadily | Leases are computed on it. A jump forward can expire leases early |

Run NTP or your platform's time sync.

## Limits

| Limit | Value |
| --- | --- |
| Shortest interval | 1 second |
| `history()` limit | 1 to 10000 |
| `maxAttempts` | 1 to 100 |
| Stored error message | 2000 characters |
| Longest internal timer | 1 minute, then the clock is re-read |
| Node.js | 20 or newer |

## A handler written for these guarantees

```ts
scheduler.every(
  'settle-payments',
  '5m',
  async (ctx) => {
    // The same window on every attempt
    const to = ctx.slot;
    const from = to - 5 * 60_000;

    for (const payment of await unsettledBetween(from, to)) {
      ctx.signal.throwIfAborted();                         // stop when asked
      await settle(payment, { idempotencyKey: payment.id }); // safe to repeat
    }
  },
  {
    timeoutMs: 4 * 60_000, // can't hang forever
    maxAttempts: 3,        // retried if the runner dies
  },
);
```

## Upgrades

- **Rolling deploys within a major version are supported.** Instances on two releases of the same major version can share one store while the new one rolls out: data is only extended, and each version keeps the fields it doesn't know.
- **The store records its format.** If a release ever has to change the layout in a way older versions can't read, its changelog says so, every instance must be stopped before the upgrade, and an older instance that meets the new data refuses to start (`ANARCHON_STORE_FORMAT`) instead of misreading it.
- **Run one version on all instances of a service** once the deploy is done. Run times come from the cron library anarchon depends on, and instances must compute the same ones.

## Next

- [Writing handlers](../../guides/writing-handlers/)
- [Failure scenarios](../../internals/failure-scenarios/)
