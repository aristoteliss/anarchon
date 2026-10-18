---
title: Testing and debugging
description: Test handlers and schedules without a server, and step through a run in a debugger.
---

## Testing a handler

A handler is a function. The most useful tests call it directly with a context you build yourself. No scheduler is involved.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JobContext } from 'anarchon';
import { buildInvoices } from './invoices';

function context(overrides: Partial<JobContext> = {}): JobContext {
  const slot = Date.UTC(2026, 9, 1, 6); // 2026-10-01T06:00:00Z
  return {
    name: 'monthly-invoices',
    slot,
    scheduledAt: new Date(slot),
    instanceId: 'test',
    manual: false,
    attempt: 1,
    reason: 'scheduled',
    signal: new AbortController().signal,
    ...overrides,
  };
}

test('running twice for the same slot creates each invoice once', async () => {
  await buildInvoices(context());
  await buildInvoices(context({ attempt: 2, reason: 'takeover' }));
  assert.equal(await countInvoices(), 3);
});

test('stops when the signal aborts', async () => {
  const controller = new AbortController();
  const run = buildInvoices(context({ signal: controller.signal }));
  controller.abort();
  await assert.rejects(run, { name: 'AbortError' });
});
```

Those two tests cover the two things a handler owes the scheduler: being safe to run twice, and stopping when asked.

## Testing with a real scheduler

To test the wiring, use `SqliteBackend` on a temporary file. It needs no server and behaves like the production lease backends.

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Scheduler, SqliteBackend } from 'anarchon';

function testScheduler(instanceId = 'test') {
  const file = join(mkdtempSync(join(tmpdir(), 'cron-test-')), 'jobs.db');
  return new Scheduler({
    backend: new SqliteBackend({ database: file }),
    instanceId,
    unrefTimers: true, // don't keep the test process alive
  });
}
```

### Run a job without waiting for its schedule

`runNow()` executes the job at once and returns its record:

```ts
test('the sync job succeeds', async () => {
  const scheduler = testScheduler();
  scheduler.every('sync', '1h', syncCustomers, { catchUpMs: 0 });
  await scheduler.start();
  try {
    const run = await scheduler.runNow('sync');
    assert.equal(run.status, 'success');
  } finally {
    await scheduler.stop();
  }
});
```

`catchUpMs: 0` stops the scheduler from also running the latest slot on start, which would otherwise add a run you didn't ask for.

### Two instances

To see that a run happens once, share the file between two schedulers:

```ts
test('two instances, one run per slot', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'cron-test-')), 'jobs.db');
  const ran: string[] = [];
  const instances = ['A', 'B'].map(
    (instanceId) => new Scheduler({ backend: new SqliteBackend({ database: file }), instanceId, unrefTimers: true }),
  );
  for (const scheduler of instances) {
    scheduler.every('tick', '1s', (ctx) => void ran.push(`${ctx.slot}`), { catchUpMs: 0 });
  }
  await Promise.all(instances.map((s) => s.start()));
  await new Promise((resolve) => setTimeout(resolve, 3_500));
  await Promise.all(instances.map((s) => s.stop()));

  assert.equal(new Set(ran).size, ran.length, 'no slot ran twice');
});
```

### Validation is checked at registration

Bad options throw when the job is added, so they are easy to test without starting anything:

```ts
test('refuses a jitter longer than half the interval', () => {
  const scheduler = testScheduler();
  assert.throws(() => scheduler.every('bad', '2s', () => {}, { jitterMs: 1_500 }), RangeError);
});
```

## Don't mock the clock around a real backend

Fake timers move your process's clock, but the store keeps its own. On a lease backend the lease end is the store's time, so advancing a fake clock by an hour doesn't expire a lease, and the test ends up exercising something that can't happen. Test handlers with a fake context, and test wiring with `runNow()` and short real intervals.

## Debugging a run

The repository ships examples made for a debugger. From a checkout:

```sh
pnpm install
npx tsx examples/walkthrough.ts
```

`examples/walkthrough.ts` runs two instances in one process against a SQLite file, with a 10-minute lease and lateness limit, so sitting on a breakpoint doesn't change the outcome. Its header lists the functions a run passes through, in order.

In VS Code, open **Run and Debug**, choose **Example: walkthrough (step through one run)** and press F5. It pauses just before `start()`. Step in with F11, or set breakpoints on:

| File under `src/scheduler/` | Function | What happens there |
| --- | --- | --- |
| `timers.ts` | `arm()` | The next slot is computed and a timer is set |
| `scheduler.ts` | `fire()` | The timer fired: the run is due |
| `lease-runner.ts` | `run()` | The claim is sent and its outcome handled |
| `lease-runner.ts` | `executeLeased()` | The heartbeat starts |
| `executor.ts` | `execute()` | Your handler is called, and the result stored |
| `lease-runner.ts` | `watch()` | A backup schedules its next check |

:::caution
A paused debugger stops your process's clock but not the store's. With normal lease timings, pausing on a breakpoint for longer than `leaseMs` makes a backup take the run over. That is the library working; raise `leaseMs` while you debug.
:::

Other examples in the repository:

| Example | Shows |
| --- | --- |
| [`examples/failover.ts`](https://github.com/aristoteliss/anarchon/blob/main/examples/failover.ts) | Three instances: a graceful hand-over, then a crash and takeover |
| [`examples/options-and-events.ts`](https://github.com/aristoteliss/anarchon/blob/main/examples/options-and-events.ts) | Every job option and every event |
| [`examples/http-api.ts`](https://github.com/aristoteliss/anarchon/blob/main/examples/http-api.ts) | The [Express API](../express/) |
| [`examples/own-clients.ts`](https://github.com/aristoteliss/anarchon/blob/main/examples/own-clients.ts) | Passing in your own Redis client or Postgres pool |
| [`examples/basic.ts`](https://github.com/aristoteliss/anarchon/blob/main/examples/basic.ts) | Run it in three terminals and kill one |
| [`examples/decorators.ts`](https://github.com/aristoteliss/anarchon/blob/main/examples/decorators.ts) | Jobs declared with [`@Every`, `@Cron` and `@At`](../../guides/decorators/) on a class, with standard decorators |
| [`examples/decorators-legacy.ts`](https://github.com/aristoteliss/anarchon/blob/main/examples/decorators-legacy.ts) | The same with legacy decorators (`experimentalDecorators`): `@Scheduled()` and `register()` |
| [`examples/decorators-startup.ts`](https://github.com/aristoteliss/anarchon/blob/main/examples/decorators-startup.ts) | The three ways to start decorated jobs: `autoStart`, `Scheduler.startAll()`, or a scheduler created by hand |
| [`examples/decorators-options.ts`](https://github.com/aristoteliss/anarchon/blob/main/examples/decorators-options.ts) | Schedulers created from settings, a scheduler per job, several objects of a class, and run data |
| [`examples/run-data.ts`](https://github.com/aristoteliss/anarchon/blob/main/examples/run-data.ts) | [Run data](../../guides/run-data/): the scheduler's, a job's, a function read at each run, `runNow()` and `setData()` |
| [`examples/nestjs`](https://github.com/aristoteliss/anarchon/tree/main/examples/nestjs) | A small [NestJS](../nestjs/#declaring-jobs-with-decorators) app whose providers declare jobs with decorators. Checked on NestJS 11 and 12 |

Real-life setups: each is a situation solved with a different set of options, and its header explains every choice.

| Example | Situation | Options approach |
| --- | --- | --- |
| [`examples/billing.ts`](https://github.com/aristoteliss/anarchon/blob/main/examples/billing.ts) | Charge customers once a day, and still charge after an outage | `maxAttempts: 1`, `catchUpMs`, `timeoutMs`, `timezone`, writes keyed by `ctx.slot` |
| [`examples/cache-refresh.ts`](https://github.com/aristoteliss/anarchon/blob/main/examples/cache-refresh.ts) | A cheap refresh every few seconds on three instances | `jitterMs` to spread it, a short `maxLateMs`, `catchUpMs: 0`, a small `historySize` |
| [`examples/nightly-export.ts`](https://github.com/aristoteliss/anarchon/blob/main/examples/nightly-export.ts) | A long export interrupted by a deploy | `ctx.signal` between pages, a checkpoint per run, `ctx.attempt`, `stop({ timeoutMs })` |
| [`examples/tenants.ts`](https://github.com/aristoteliss/anarchon/blob/main/examples/tenants.ts) | The same jobs per tenant, each in its own time zone | one job per tenant, `timezone` and `data` per job, a data function, `remove()`, `runNow()` with data |
| [`examples/broker-notifications.ts`](https://github.com/aristoteliss/anarchon/blob/main/examples/broker-notifications.ts) | Only RabbitMQ or NATS: no leases | every run sends everything outstanding, `maxLateMs` under the broker's memory, no lease options |

## Seeing what an instance does

Turn on the built-in log while you investigate:

```ts
new Scheduler({ backend, log: true });
```

Or log every event with its payload:

```ts
for (const event of ['start', 'success', 'failure', 'interrupted', 'skip', 'lost', 'error'] as const) {
  scheduler.on(event, (payload) => console.log(event, payload));
}
```

Then compare with the cluster-wide view:

```ts
console.table(
  (await scheduler.history('sync', 10)).map((r) => ({
    scheduled: r.scheduledAt.toISOString(),
    by: r.instanceId,
    attempt: r.attempt,
    reason: r.reason,
    status: r.status,
    ms: r.durationMs,
  })),
);
```

## Common surprises

| What you see | Why |
| --- | --- |
| A run starts right after `start()` with reason `catch-up` | The latest slot was due recently and nobody ran it. Set `catchUpMs: 0` to turn that off |
| Every instance but one logs `skipped (taken)` | That is normal: one winner per run |
| `skipped (overlap)` | The previous run of that job is still going |
| A run shows twice in history | One record per attempt: it was taken over |
| A job runs on the same instance every time | `jitterMs` is 0, or that instance's clock is ahead |
| `lost` events | The instance couldn't renew its lease in time: it was paused, blocked or cut off from the store |

## Next

- [Events and logging](../../guides/events-and-logging/)
- [Run lifecycle](../../internals/run-lifecycle/)
