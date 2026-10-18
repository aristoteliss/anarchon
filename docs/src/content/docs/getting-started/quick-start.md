---
title: Quick start
description: A scheduler running as three instances in five minutes, with no server to install.
---

In this guide you write a small scheduler, run it as three instances, and watch one instance win each run. Then you stop and kill the instance that is running a job, and watch another start that run again.

It uses a SQLite file as the shared store, so there is nothing to install besides Node 22.13 or newer, which has SQLite built in. The three instances coordinate because they open the same file on the same machine. For instances on several machines, [switch to Redis or PostgreSQL](#switch-to-a-real-store).

## 1. Create the project

```sh
mkdir cron-demo && cd cron-demo
npm init -y
npm install anarchon
npm install --save-dev tsx
```

npm comes with Node. With pnpm or yarn, use `pnpm add` or `yarn add` instead of `npm install`.

:::note[Older Node versions]
On Node 22.5 to 22.12, start each instance with `NODE_OPTIONS=--experimental-sqlite npx tsx app.ts`. For Node 20, see the SQLite tab of [Installation](../installation/).
:::

## 2. Write the scheduler

Create `app.ts`:

```ts
import { Scheduler, SqliteBackend } from 'anarchon';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const scheduler = new Scheduler({
    // All instances must point at the same store. Here: one file.
    backend: new SqliteBackend({ database: './jobs.db' }),
    // Short lease, so a takeover is quick to watch. The default is 30 s.
    leaseMs: 6_000,
    heartbeatMs: 1_000,
    log: true,
  });

  // A quick job, every 10 seconds
  scheduler.every('sync', '10s', async () => {
    await sleep(200);
  });

  // A slow job: 20 seconds of work, every 30 seconds
  scheduler.every('report', '30s', async (ctx) => {
    for (let second = 0; second < 20; second++) {
      ctx.signal.throwIfAborted(); // stop cleanly when asked
      await sleep(1_000);
    }
  });

  await scheduler.start();
  console.log(`started as ${scheduler.instanceId}`);

  // Stop cleanly on Ctrl+C
  process.on('SIGINT', async () => {
    await scheduler.stop();
    process.exit(0);
  });
}

main();
```

## 3. Run three instances

Open three terminals **in the project folder** and run the same command in each. The folder matters: `./jobs.db` is a relative path, and the instances only see each other when they open the same file.

```sh
npx tsx app.ts
```

Each terminal prints its own name, something like `started as my-laptop:41822`. The number after the colon is the process ID; you need it in step 5. Node also prints `ExperimentalWarning: SQLite is an experimental feature`, which is expected.

Watch the output. Every 10 seconds, exactly **one** terminal prints that it started `sync`, and the other two print that they skipped it:

```
[anarchon] sync @ 2026-10-10T12:00:10.000Z: started on my-laptop:41822 (attempt 1, scheduled)
[anarchon] sync @ 2026-10-10T12:00:10.000Z: finished in 203 ms
```

```
[anarchon] sync @ 2026-10-10T12:00:10.000Z: skipped (taken)
```

Which terminal wins changes from run to run. That is the random delay at work.

:::note
Right after an instance starts you may see runs with `catch-up` instead of `scheduled`, and a `report` run `skipped (overlap)`. On start, anarchon runs the latest run if nobody ran it yet, and a new `report` run is skipped while the previous one is still going. Both are explained in [Leases](../../internals/leases/).
:::

## 4. Stop the runner gracefully

Wait until one terminal prints that it started `report`, then press **Ctrl+C** in that terminal.

Within a second or two, another terminal prints:

```
[anarchon] report @ 2026-10-10T12:00:30.000Z: started on my-laptop:41907 (attempt 2, takeover)
```

The stopped terminal prints that it gave the run up:

```
[anarchon] report @ 2026-10-10T12:00:30.000Z: interrupted after 5005 ms, handed over to another instance
```

The stopped instance *handed the run over*. This is what happens on every rolling deploy. Both lines name the same run (`12:00:30`), and the second one is attempt 2: the job starts again from the beginning on the new instance; it doesn't continue where the first one stopped.

## 5. Crash the runner

Start the stopped instance again. Wait for `report` to start somewhere, then kill that process hard, from a fourth terminal. On Linux and macOS:

```sh
kill -9 <pid>   # the number after the colon in the instance name
```

This time nothing is handed over: the process is simply gone. About 6 seconds later (the lease you set), a backup notices the lease was not renewed and takes over:

```
[anarchon] report @ 2026-10-10T12:01:00.000Z: started on my-laptop:41822 (attempt 2, takeover)
```

Check that the takeover line has the same time as the run you killed and says `attempt 2`. A line with a later time and `attempt 1` is the next scheduled run, not a takeover. The delay is the lease: with the default `leaseMs` of 30 seconds, a takeover comes about 30 seconds after a crash.

The job ran twice for that slot, once in part and once in full. That is why [handlers must be safe to run twice](../../guides/writing-handlers/#make-jobs-safe-to-run-twice).

## What just happened

```mermaid
sequenceDiagram
  participant A as Instance A
  participant B as Instance B
  participant S as jobs.db
  A->>S: claim report @ 12:01:00
  S-->>A: won (attempt 1)
  B->>S: claim report @ 12:01:00
  S-->>B: running, so B becomes a backup
  loop every second
    A->>S: heartbeat: lease ends in 6 s
  end
  Note over A: kill -9
  loop every 1 to 2 seconds
    B->>S: is the lease still alive?
  end
  Note over S: 6 s without a heartbeat
  B->>S: claim attempt 2
  S-->>B: won (attempt 2)
  Note over B: runs the job again
```

## Switch to a real store

Install the driver for your store, and have the server running at the URL you pass:

```sh
npm install redis   # Redis or Valkey
npm install pg      # PostgreSQL
```

Then change one line. Everything else stays the same.

```ts
// Redis or Valkey
const scheduler = new Scheduler({ backend: new RedisBackend({ redis: 'redis://localhost:6379' }) });

// PostgreSQL
import { PostgresBackend, RedisBackend } from 'anarchon';
const scheduler = new Scheduler({
  backend: new PostgresBackend({ connection: process.env.DATABASE_URL }),
});
```

## Next

- [Core concepts](../core-concepts/): slot, claim, jitter and lease, defined
- [Defining jobs](../../guides/defining-jobs/): cron expressions, intervals and one-off jobs
- [Decorators](../../guides/decorators/): declare the same jobs on the methods of a class
- [Writing handlers](../../guides/writing-handlers/): what `ctx` holds and why `ctx.signal` matters
