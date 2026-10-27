---
title: Brokers and leases
description: Why RabbitMQ and NATS 'msg-id' are claim-only, how the NATS 'lease' strategy gets leases, and which RabbitMQ features could close the gap.
---

The RabbitMQ backend, and NATS with its default `msg-id` strategy, give one guarantee: one instance wins each run. NATS with the `lease` strategy gives everything Redis, PostgreSQL and SQLite give. This page explains why the claim-only ones stop where they do, how NATS gets leases, and which RabbitMQ features could add backups, overlap protection and catch-up.

:::caution[Not implemented for RabbitMQ]
The RabbitMQ part of "Closing the gap" is design notes, not behaviour. Today RabbitMQ is claim-only: a run whose runner dies is lost.
:::

## Why they are claim-only

Backups, overlap protection and catch-up all depend on a **lease**: a record per run saying who is running it and until when. Other instances must be able to read that record and replace it in one atomic step.

| Backend | How it does "read the run, decide, write" as one step |
| --- | --- |
| Redis `lease` | A Lua script |
| PostgreSQL | A transaction on the run's row |
| SQLite | A `BEGIN IMMEDIATE` transaction |
| NATS `lease` | A key-value write at the revision that was read (compare-and-swap) |

RabbitMQ and NATS `msg-id` use a primitive that answers one question only: "was I first?"

| Backend | The primitive | What it leaves behind |
| --- | --- | --- |
| RabbitMQ | A queue that holds one message and rejects the rest, with publisher confirms | A message nobody consumes |
| NATS `msg-id` | JetStream de-duplication by `Nats-Msg-Id` | A message ID remembered for the duplicate window |

Both pick exactly one winner. Neither result can be renewed, expire early or be taken over, so nothing records that a runner stopped:

- **No backups.** If the runner dies, no instance can tell.
- **No overlap protection.** There is no live lease showing that the previous run is still going.
- **No catch-up.** A claim says a run was taken, not that it finished.

The same limits apply to the Redis `stream-id`, `idmp` and `script` strategies. They come from the claim primitive, not from brokers as such.

## Closing the gap

### RabbitMQ

Dead-lettering alone doesn't detect a dead runner. The feature that does is **manual acknowledgement with redelivery**: a consumer holds the run's message unacknowledged while the job runs, and if its connection drops, the broker gives the message to another consumer.

| Missing part | RabbitMQ feature | Catch |
| --- | --- | --- |
| Backups | An unacknowledged message is redelivered when the runner's connection drops | Detection follows the AMQP heartbeat, not `leaseMs` |
| `maxAttempts` | `x-delivery-limit` on a quorum queue, then dead-letter as "failed" | Needs quorum queues |
| Stale runs | Per-message TTL; expired messages are dead-lettered as "skipped" | None serious: the broker's clock decides |
| Overlap `skip` | Single active consumer with a prefetch of 1 on a queue per job | The next run waits instead of being skipped, and one instance runs every run of the job |
| Catch-up | A durable message waits for the first instance that comes back | Only if an instance was up to publish the run |

Three problems remain:

- **The broker would hand out the runs.** Today each instance decides on its own timer when to claim. With consumers, RabbitMQ pushes a run to an instance, which is a different model from both the lease and the claim-only ones.
- **The gate queue has to stay.** Something must still stop a late instance from publishing the same run twice. A crash between winning the gate and publishing the run's message loses the run.
- **Long jobs hit the acknowledgement timeout.** RabbitMQ closes a channel that holds a delivery unacknowledged for too long, 30 minutes by default.

So RabbitMQ could get backups and retries, but overlap `skip` only approximately.

### NATS: the `lease` strategy

NATS doesn't need the queue workaround. The JetStream **key-value store** has `create`, which succeeds only if the key is absent, and `update` with an expected revision, which succeeds only if nobody wrote in between. That is compare-and-swap, and it is enough for a real lease. The `lease` strategy uses it:

| Lease operation | Key-value operation |
| --- | --- |
| Claim a run | `create`, or `update` on the revision that was read. A conflict means another instance was first |
| Heartbeat | `update` on the revision the runner last wrote |
| Takeover | `update` on the revision of the expired lease |
| Refuse an old runner | Its revision is out of date, so its heartbeat and "finished" fail |
| Overlap `skip` | One key per job holds the state of its runs, so the check and the write are one step |

So NATS with `lease` is a lease backend with the same guarantees as Redis, PostgreSQL and SQLite.

**Lease expiry on the store's clock.** A compare-and-swap in NATS can't read the server's time. So each decision reads it just before, from the bucket's stream info (`ts`, reported by nats-server 2.10 and newer). If that read is a little old by the time the write lands, the write still holds: it succeeds only if nobody changed the job's runs in between. See [NATS](../nats/#how-one-instance-wins-with-lease).

## What to use today

| You need | Use |
| --- | --- |
| One winner per run, and a lost run now and then is acceptable | RabbitMQ, or NATS with `msg-id` |
| Backups, overlap protection, catch-up or hand-over | Redis `lease`, PostgreSQL, SQLite, or NATS with `lease` |

On a claim-only backend, write each run to work on [everything outstanding](../../reference/guarantees/#that-every-slot-runs). A lost run then costs a delay, not lost work.

The options only leases can honour aren't available on a claim-only backend: `overlap`, `maxAttempts` and `catchUpMs` on jobs, `leaseMs` and `heartbeatMs` on the scheduler. Typed code that sets them doesn't compile, and a decorator or JavaScript that sets them gets an error when the job or scheduler is created. This also covers Redis and Valkey with a strategy other than `lease`, and NATS with `msg-id`.

## Next

- [Backends overview](../overview/)
- [Leases](../../internals/leases/)
- [Guarantees and limits](../../reference/guarantees/)
