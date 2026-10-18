# anarchon

[![npm version](https://img.shields.io/npm/v/anarchon.svg)](https://www.npmjs.com/package/anarchon)
[![npm downloads](https://img.shields.io/npm/dm/anarchon.svg)](https://www.npmjs.com/package/anarchon)
[![node](https://img.shields.io/node/v/anarchon.svg)](https://www.npmjs.com/package/anarchon)
[![license](https://img.shields.io/badge/license-AGPL--3.0%20or%20commercial-blue.svg)](https://github.com/aristoteliss/anarchon#license-and-commercial-use)

[**Documentation**](https://aristoteliss.github.io/anarchon/) · [Quick start](https://aristoteliss.github.io/anarchon/getting-started/quick-start/) · [Guarantees and limits](https://aristoteliss.github.io/anarchon/reference/guarantees/) · [Examples](#examples) · [License](#license-and-commercial-use)

Leaderless scheduling for Node.js clusters. Run the same jobs in every instance; an atomic claim in Redis, Valkey, PostgreSQL or SQLite selects one runner for each scheduled slot. The default `lease` strategy retries after a runner stops renewing its lease. That gives at-least-once execution after failures, not exactly-once side effects: handlers should be idempotent, and a frozen runner can briefly overlap its replacement.

<p align="center">
  <img src="https://raw.githubusercontent.com/aristoteliss/anarchon/main/assets/quick-start.gif" alt="Three anarchon processes on one SQLite file: one wins each run; after a graceful stop and after kill -9, another process starts the same run again as attempt 2" width="900" />
</p>

anarchon also handles what goes wrong in real clusters:
- jobs that run longer than their interval
- an instance crashing or freezing mid-run
- rolling deploys, and every instance restarting at once

```ts
import { RedisBackend, Scheduler } from 'anarchon';

const scheduler = new Scheduler({ backend: new RedisBackend({ redis: 'redis://localhost:6379' }) }); // a backend is required: none is assumed

scheduler
  .every('sync', '10s', async (ctx) => { /* ... */ })
  .every('report', '35m', async (ctx) => { /* ... */ }, { timeoutMs: 20 * 60_000 })
  .cron('digest', '0 */2 * * *', async (ctx) => { /* ... */ }, { timezone: 'Europe/Athens' })
  .at('migrate', new Date('2026-12-01T03:00:00Z'), async (ctx) => { /* a one-off job: one slot */ });

await scheduler.start();
```

Put the same code in every instance.

## Try it with three instances

The recording above is `examples/quick-start.ts`: three processes on one machine share a SQLite file and one job that takes 4 seconds. Run it with `npx tsx examples/quick-start.ts` in the repository. In about 23 seconds it shows:

1. **One winner.** One process starts the run; the other two skip it (`taken`).
2. **A graceful stop.** The runner gets `SIGINT` (Ctrl+C) mid-run and hands the run over. Another process starts the same run again as attempt 2, within two heartbeats.
3. **A crash.** The next runner gets `SIGKILL` (`kill -9`). Nothing is handed over, so the others wait for its lease to run out, and one starts the same run again as attempt 2 about 3 seconds after the kill.

The demo sets the lease to 3 seconds and the heartbeat to 0.5 seconds so the takeover is quick to watch. With the defaults (30 s and 5 s) a takeover comes about 30 seconds after a crash. A takeover starts the handler from the beginning, which is why handlers must be idempotent.

For a no-server demo you build yourself, follow the [five-minute SQLite quick start](https://aristoteliss.github.io/anarchon/getting-started/quick-start/). It runs three processes against one shared SQLite file on the same machine. To try the Redis-backed `examples/basic.ts` demo instead, start Redis, open three terminals in the repository, and run this command in each:

```sh
pnpm install
npx tsx examples/basic.ts
```

The example connects to `redis://localhost:6379` unless `REDIS_URL` is set. Watch `sync` run on one instance per slot; then stop the instance running `report` with Ctrl+C to see a graceful handover. The [examples](#examples) section lists PostgreSQL and SQLite variants too.

## Install

```sh
pnpm add anarchon redis
```

`npm install` and `yarn add` work the same way.

`redis` (node-redis) is only needed if you let anarchon open the connection. You can pass your own ioredis, iovalkey, node-redis or Valkey GLIDE client instead. It works with Redis 5+ and Valkey.

For another backend, install its driver instead (see [Backends](#backends)):

```sh
pnpm add anarchon pg                    # PostgreSQL (or bring your own pg / postgres.js client)
pnpm add anarchon                       # SQLite with node:sqlite (Node 22.13+), or add better-sqlite3 / @libsql/client
pnpm add anarchon amqplib               # RabbitMQ
pnpm add anarchon @nats-io/transport-node @nats-io/jetstream   # NATS JetStream
```

## How it works

1. **Every instance computes the same run times.** Each scheduled run has a time, called its *slot*. Intervals use a grid counted from 1970 UTC, so "every 10s" means :00, :10, :20…. Cron jobs use the expression. All instances agree on the slots, whenever each one started.
2. **Each instance waits a random delay.** It waits until the slot plus a random 0 to `jitterMs` (default 2 s). The delay is what spreads the work across instances.
3. **One atomic claim decides.** Each instance runs the same Lua script, which records the run unless it's already there. Redis runs scripts one at a time, so exactly one instance wins.
4. **The winner runs the job under a lease.** It renews the lease every few seconds, and the other instances become its backups.

```
06:00:10.300  B: claim slot 06:00:10 → won      → B runs the job, renewing its lease
06:00:11.400  A: claim slot 06:00:10 → running  → skip, and back B up
06:00:11.900  C: claim slot 06:00:10 → running  → skip, and back B up
```

This is the same idea as Meteor's SyncedCron, where every server inserts `{ name, intendedAt }` into a collection with a unique index and the first insert wins. anarchon adds leases, so the cluster also notices when the winner dies.

## When things go wrong

These are real runs with three processes on Redis 8.6, broken on purpose with `kill -9`, `SIGSTOP`, `SIGTERM` and full restarts. Run them yourself with `pnpm run scenarios`.

| What happens | Simple claim (`stream-id`) | anarchon (`lease`, the default) |
|---|---|---|
| A 7 s job runs every 3 s | **3 copies run at the same time** | 1 at a time; runs due meanwhile are skipped (`skip`, reason `overlap`) |
| The winner is killed mid-run | **The run is lost**; history says `running` forever | A backup takes over about one lease later and finishes it as attempt 2 |
| The winner freezes (GC pause, stalled VM) longer than its lease | No backup; the run waits | A backup takes over. When the frozen one wakes up, `ctx.signal` aborts and it emits `lost` |
| A non-winner restarts mid-run | Fine: runs once | Fine: runs once, and the restarted instance becomes a backup |
| The winner is stopped mid-run (`SIGTERM`, rolling deploy) | **The run is lost**; history says `interrupted` | It hands the run over at once; a backup finishes it as attempt 2 |
| All 3 are killed mid-run, then restart | **The run is lost** | After the restart, one instance re-runs it as attempt 2 |
| All 3 are down when a run is due | **The run never happens** | On start, it's caught up if it was due less than `catchUpMs` ago (default 5 min) |

A takeover starts the handler again from the beginning, as a new attempt. It doesn't resume where the previous runner stopped.

### How the lease works

- **Claiming.** A claim stores the run with a lease that ends `leaseMs` (default 30 s) from now, measured on the Redis server clock, so clock differences between instances don't matter. The runner renews the lease every `heartbeatMs` (default 5 s).
- **Backups.** Instances that saw the run taken check on it every 1 to 2 heartbeats. If the lease ran out before the run finished, they all try to claim the next attempt, and only one wins. A crashed run is taken over about one lease after the crash (at most `leaseMs` + 2 × `heartbeatMs`). It is started up to `maxAttempts` times in all (default 3), and only while it's still the latest run of its job: if the next run starts first (a crash within about a lease of the next run), the crashed one is marked `interrupted` and the next run replaces it.
- **Graceful stop.** On `stop()`, a job that throws once `ctx.signal` aborts (for example with `ctx.signal.throwIfAborted()`) gives its run up. A backup takes it over at its next check (within 2 heartbeats) without waiting for the lease to run out, and this doesn't count toward `maxAttempts`. A job that returns normally counts as finished. A job still running when the stop timeout passes stops renewing its lease, so a backup takes it over once the lease runs out.
- **No overlap.** A new run isn't started while an earlier run of the same job still holds a live lease. Set `overlap: 'allow'` to run them side by side.
- **Fencing.** Every attempt has its own token. Heartbeats and "finished" only work with the current token, so a runner that was taken over finds out at its next heartbeat. Its `ctx.signal` aborts and it emits `lost`.
- **Catch-up.** On start, each instance first picks up unfinished runs whose runner is gone. Then, if the latest run was never claimed and was due less than `catchUpMs` ago, it runs it now with `reason: 'catch-up'`.
- **Late claims.** Redis checks how late a new claim is on its own clock, so a claim that was delayed or queued (the client queues commands while it reconnects) can't start a stale run. A run is never trimmed from the state while a late claim could still ask for it, whatever `historySize` is.

A lease isn't a lock you hold and release. Every decision is still a single atomic claim, and the lease only says "the runner is still alive". A frozen runner can't know it was taken over until it wakes up, so two attempts can briefly overlap in that case. Check `ctx.signal` before side effects, and keep jobs idempotent.

## API

### `new Scheduler(options)`

`backend` is required. No store is assumed: `new Scheduler()` throws.

| Option | Default | Meaning |
|---|---|---|
| `backend` | none: required | Where runs are stored: `new RedisBackend(...)`, `new PostgresBackend(...)`, `new SqliteBackend(...)` and the rest. See [Backends](#backends) |
| `instanceId` | `hostname:pid` | Name shown in history |
| `jitterMs` | `2000` | Maximum random delay before claiming a run. Lowered automatically for short intervals |
| `maxLateMs` | `60000` | Skip a run if this instance reaches it later than this |
| `historySize` | `1000` | Runs kept per job |
| `historyTtlMs` | none | Also drop history older than this, like SyncedCron's `collectionTTL` |
| `timezone` | server's | Default time zone for cron jobs |
| `leaseMs` | `30000` | How long a running job's lease lasts without a heartbeat |
| `heartbeatMs` | `5000` | How often a running job renews its lease, and how often backups check on it |
| `log` | `false` | Log one line per start, finish, failure, skip and lost run |
| `logger` | `console` | Where logs and unhandled errors go |
| `unrefTimers` | `false` | Let the process exit even while timers are pending |

A shorter `leaseMs` means faster takeover after a crash. A longer one tolerates longer pauses before a backup steps in.

### Jobs

```ts
scheduler.every(name, interval, handler, options?)   // '10s', '35m', '1h30m', or ms
scheduler.cron(name, expression, handler, options?)  // 5 fields, or 6 with seconds first
scheduler.at(name, when, handler, options?)          // once, at a Date / ms / ISO string
```

#### Decorators

The same jobs can be declared on the methods of a class. There is no framework, no `reflect-metadata` and no register call: an object adds its jobs when it is created, and the scheduler can be created for you from settings you give once.

```ts
import { At, Cron, Every, type JobContext, RedisBackend, Scheduler } from 'anarchon';

Scheduler.configure({ backend: new RedisBackend({ redis: process.env.REDIS_URL }), autoStart: true }); // a backend must be given: none is assumed

class Reports {
  @Cron('weekday-digest', '0 8 * * 1-5', { timezone: 'Europe/Athens' })
  async digest(ctx: JobContext) {}

  @Every('sync-customers', '10s', { timeoutMs: 8_000 })
  async sync() {}

  @At('announce-launch', '2026-12-01T09:00:00Z')
  async announce() {}
}

new Reports(); // a scheduler is created and started, and has the three jobs
```

Each decorator takes the arguments of its method without the handler: `@Every(name?, interval, options?)`, `@Cron(name?, expression, options?)`, `@At(name?, when, options?)`. The name can also go in the options (`{ name }`), and every job option can be passed.

**Who creates and starts the scheduler** is your choice:

| | Code |
|---|---|
| Settings, started for you | `Scheduler.configure({ backend, autoStart: true })` |
| Settings, started by you | `Scheduler.configure({ backend })`, then `await Scheduler.startAll()` |
| By hand | `const scheduler = new Scheduler({ backend })`, then `await scheduler.start()` |

Stop them on shutdown with `await Scheduler.stopAll()`.

**A job can choose its scheduler.** Jobs that give the same name share one, so ten jobs can be on one scheduler, on ten, or anything between. A named scheduler that doesn't exist yet is created from its settings.

```ts
Scheduler.configure({ backend: (name) => new PostgresBackend({ connection: pool, table: `cron_${name}` }) });
Scheduler.configure('billing', { backend: new RedisBackend({ redis: process.env.BILLING_REDIS_URL }), leaseMs: 10_000 }); // optional: settings of its own

class Jobs {
  @Cron('job-1', '*/10 * * * * *')                            // the default scheduler
  one() {}
  @Cron('job-2', '*/10 * * * * *', { scheduler: 'billing' })  // the scheduler named 'billing'
  two() {}
  @Every('job-3', '5s', { scheduler: 'reports' })             // created from the default settings: table cron_reports
  three() {}
}
```

**Several objects of one class** each get a prefix, and can get job options of their own:

```ts
for (const tenant of tenants) {
  scheduler.register(new Reports(), {
    prefix: `${tenant.id}:`, // 'acme:weekday-digest', 'acme:sync-customers'
    defaults: { timezone: tenant.timezone, data: { tenant: tenant.id } },
  });
}
```

**Legacy decorators** (`"experimentalDecorators": true`, the style NestJS and Angular use) can't run code when an object is created, so add `@Scheduled()` to the class, or call `scheduler.register(object)`:

```ts
@Scheduled() // objects of this class add their jobs when they are created
class Reports {
  @Every('sync-customers', '10s')
  async sync() {}
}
```

| | Standard | Legacy |
|---|---|---|
| `tsconfig.json` | nothing to set | `"experimentalDecorators": true` |
| An object adds its jobs when created | always | only with `@Scheduled()` on the class |
| `@Scheduled()` | not needed, harmless | needed, unless you call `register()` |

Things to know:

- **A backend is required in settings.** `Scheduler.configure()` throws without `backend`: a scheduler is never created on a store you didn't choose.
- **The name comes first.** `@Every('1h', 'sync')` and `@Cron('0 8 * * *', 'Europe/Athens')` throw when the class is defined, with the right form in the message. A time zone goes in the options.
- **Name your jobs.** Without a name a job is called `Class-method`. That changes when the class or the method is renamed, and on every build if a minifier renames classes. A changed name is a new job with a new history.
- **Legacy style: `@Scheduled()` or `register()`.** With neither, the jobs of a class are not added. A starting scheduler warns about every such job, and about jobs of a class that never got an object.
- **One object per class, unless each has a prefix.** A second object declares the same job names, and its constructor throws. With prefixes, create each object inside its `register()` call.
- **Where an invalid job shows up.** `new Reports()` throws if its schedulers exist or have settings. If the object was created first, the `start()` that adds it rejects and the scheduler stays stopped.
- **`autoStart` hides the start.** A failure to connect arrives as an `'error'` event, not as a rejected promise.
- **`@At` takes an absolute time.** A delay counted from process start differs on every instance, so each one would run the job. There is no `@Timeout`.
- **Tests.** Schedulers and settings are shared by the whole process: call `Scheduler.reset()` between tests.

Runnable examples: [examples/decorators.ts](examples/decorators.ts) (standard decorators), [examples/decorators-legacy.ts](examples/decorators-legacy.ts) (legacy decorators), [examples/decorators-startup.ts](examples/decorators-startup.ts) (the three ways to start), [examples/decorators-options.ts](examples/decorators-options.ts) (schedulers from settings, a scheduler per job, several objects of a class, run data) and [examples/nestjs](examples/nestjs) (a NestJS app, checked on NestJS 11 and 12).

More in the [decorators guide](https://aristoteliss.github.io/anarchon/guides/decorators/), the [decorators reference](https://aristoteliss.github.io/anarchon/reference/decorators/) and the [NestJS recipe](https://aristoteliss.github.io/anarchon/recipes/nestjs/#declaring-jobs-with-decorators).

#### Run data

A job often needs something it can't take from its surroundings: the tenant it runs for, the permission it runs with, a token that must be fresh. Give it as `data`, and each run reads it as `ctx.data`.

```ts
const scheduler = new Scheduler({ backend, data: { tenant: 'acme' } });               // for every job

scheduler.every('export', '1h', async (ctx: JobContext<{ tenant: string; permission: string }>) => {
  await exportFor(ctx.data.tenant, ctx.data.permission);
}, { data: { permission: 'reports:export' } });                                     // for this job, on top

scheduler.every('sync', '5m', sync, { data: async () => ({ token: await freshToken() }) }); // read when each run starts

await scheduler.runNow('export', { data: { requestedBy: user.id } });               // for one manual run
scheduler.setData({ tenant: 'acme', plan: 'pro' });                                 // replace the scheduler's while it runs
```

The layers are merged from the most general to the most specific: two plain objects are merged, any other value replaces. A function that throws fails the run. The data is not stored and not shared between instances, so it can hold secrets and clients. More in the [run data guide](https://aristoteliss.github.io/anarchon/guides/run-data/); runnable in [examples/run-data.ts](examples/run-data.ts).

`handler(ctx)` receives `{ name, slot, scheduledAt, instanceId, manual, attempt, reason, signal, data }`:
- `attempt` is 1, or 2+ when a backup took over.
- `reason` is `'scheduled'`, `'manual'`, `'catch-up'` or `'takeover'`.
- `signal` aborts on `stop()`, on timeout, and when a backup took the run over. Throw when it aborts (`ctx.signal.throwIfAborted()`) so a stopped run is handed over instead of counting as finished.

| Job option | Default | Meaning |
|---|---|---|
| `jitterMs`, `maxLateMs`, `historySize`, `historyTtlMs` | scheduler's | Per-job overrides |
| `timeoutMs` | none | Abort `ctx.signal` and mark the run failed after this long |
| `overlap` | `'skip'` | Skip a run while the previous one is still running, or `'allow'` both |
| `maxAttempts` | `3` | How many times a run may be started when runners die (hand-overs on `stop()` don't count) |
| `catchUpMs` | `300000` | On start, run the latest run if it was missed and due less than this ago. `0` turns it off |
| `offsetMs` | `0` | `every()` only: shift the grid |
| `timezone` | scheduler's | `cron()` only |
| `data` | none | Data for this job's runs, read as `ctx.data`. A value, or a function called when a run starts |

### Lifecycle

- **`start()`** connects, checks the server, schedules every job, and picks up unfinished and missed runs.
- **`stop({ timeoutMs = 30000 })`** stops scheduling, aborts `ctx.signal`, waits for running jobs, and closes the connection if anarchon opened it. Jobs that throw on abort are handed to another instance (see Graceful stop above). After `stop()` returns, anarchon sends nothing more to Redis.

```ts
process.on('SIGTERM', async () => {
  await scheduler.stop();
  process.exit(0);
});
```
- **`runNow(name, { data }?)`** runs a job immediately on this instance, without deduplication, and records it as a manual run. Manual runs are never retried. `data` is for that one run.
- **`remove(name)`** stops scheduling a job on this instance.

### Who ran it and when it finished

```ts
await scheduler.history('sync', 20); // newest first, from all instances, one record per attempt
await scheduler.lastRun('sync');
scheduler.nextRun('sync');           // Date, or null for a one-off job that already ran
scheduler.jobs();                    // jobs on this instance + next run
```

Each attempt is a `RunRecord`:

```ts
{
  job: 'sync',
  slot: 1791520280000,
  scheduledAt: Date,        // 06:31:20.000
  instanceId: 'api-2:4182', // who ran it
  manual: false,
  attempt: 1,               // 2+ when a backup took over
  reason: 'scheduled',      // 'scheduled' | 'manual' | 'catch-up' | 'takeover'
  status: 'success',        // 'running' | 'success' | 'failed' | 'interrupted'
  startedAt: Date,
  finishedAt: Date,
  durationMs: 201,
  error: undefined,         // 'Error: …' when it failed
}
```

`interrupted` means the attempt didn't finish: its runner died or froze, lost the run to a backup, or was stopped. `history()` works for any job name, so a separate API process can read it without registering the jobs. See `examples/http-api.ts`.

### Events

```ts
scheduler.on('start',       (e) => {});  // this instance is starting a run (attempt, reason)
scheduler.on('success',     (r) => {});  // RunRecord
scheduler.on('failure',     (r) => {});  // RunRecord + cause (what the job threw)
scheduler.on('interrupted', (r) => {});  // stopped or taken over mid-run, not a failure (+ cause, handedOver)
scheduler.on('skip',        (e) => {});  // reason: 'taken' | 'late' | 'overlap'
scheduler.on('lost',        (e) => {});  // a backup took over a run this instance was running
scheduler.on('error',       (e) => {});  // Redis problems; logged if nobody listens
```

## Strategies

`lease` is the default and the only strategy with backups, no-overlap, retries and catch-up. The simple strategies only decide who runs each slot, and are kept for comparison and minimal setups:

| Strategy | Claim | Why only one wins | Needs |
|---|---|---|---|
| `lease` (default) | Lua script on `{cron:<job>}:state` | The script runs atomically | Redis 5+ or Valkey |
| `stream-id` | `XADD cron:<job>:runs <slot>-0 …` | A new stream ID must be bigger than the last one | Redis 5+ or Valkey |
| `idmp` | `XADD … IDMP <job> <slot> * …` | Redis keeps the first entry with that idempotency key | Redis 8.6+ |
| `script` | Lua: look for the slot in the stream, else `XADD` | The script runs atomically | Redis 5+ or Valkey |

With `lease`, each job has these keys, all with one hash tag so Redis Cluster keeps them together:
- `{cron:<job>}:state`: each run's attempt, token, status and lease
- `{cron:<job>}:active`: unfinished runs
- `{cron:<job>}:slots`: used for trimming
- `{cron:<job>}:runs`: a stream with one entry per attempt
- `{cron:<job>}:results`: one result per attempt

## Backends

Redis, Valkey, PostgreSQL and SQLite get everything described above: leases, backups, no overlap, catch-up and hand-over on `stop()`. RabbitMQ and NATS only make sure one instance wins each run (like the simple `stream-id` claim): they can't hold a lease that a backup could check.

```ts
import { NatsBackend, PostgresBackend, RabbitMQBackend, RedisBackend, Scheduler, SqliteBackend } from 'anarchon';

new Scheduler({ backend: new RedisBackend({ redis: 'redis://localhost:6379' }) });
new Scheduler({ backend: new PostgresBackend({ connection: 'postgres://user:pass@db/app' }) });
new Scheduler({ backend: new SqliteBackend({ database: './anarchon.db' }) });
new Scheduler({ backend: new RabbitMQBackend({ url: 'amqp://localhost' }) });
new Scheduler({ backend: new NatsBackend({ servers: 'nats://localhost:4222' }) });
```

| Backend | How one instance wins | Leases, backups, catch-up | Needs |
|---|---|---|---|
| Redis / Valkey | One Lua script per claim (see Strategies) | Yes (`lease`, the default) | Redis 5+ or Valkey |
| PostgreSQL | One short transaction per claim. Its first statement writes the job's row in `<table>_jobs`, so claims of one job take turns | Yes | PostgreSQL 9.5+; `pg` or your own `pg` Pool / Client or postgres.js |
| SQLite | One `BEGIN IMMEDIATE` transaction per claim; SQLite has one writer at a time | Yes | SQLite 3.35+; node:sqlite, better-sqlite3 or `@libsql/client` |
| RabbitMQ | A gate queue per run that holds one message (`x-max-length: 1`, `reject-publish`); publisher confirms say who was first | No | RabbitMQ 3.9+, `amqplib` |
| NATS | JetStream publish with `Nats-Msg-Id: <job>:<slot>`; repeats come back as duplicates | No | JetStream enabled, `@nats-io/transport-node` + `@nats-io/jetstream` |

`new RedisBackend(options)`:

| Option | Default | Meaning |
|---|---|---|
| `redis` | `localhost:6379` | `{ host, port, password, db }`, a URL, or your own client: ioredis, iovalkey, node-redis, Valkey GLIDE, or any `{ send(command, args) }`. Clients you pass aren't closed on stop |
| `strategy` | `'lease'` | `'lease'`, or one of the simple claims: `'stream-id'`, `'idmp'` (Redis 8.6+), `'script'` |
| `prefix` | `'cron:'` | Key prefix |

Notes:
- **Postgres and SQLite** create two tables on start: `anarchon_runs` (one row per run: attempt, token, status, lease end) and `anarchon_runs_attempts` (one row per attempt: the history). Postgres adds `anarchon_runs_jobs`. Pick another name with `table` (Postgres may include a schema). Leases use the database's clock.
- **SQLite** only coordinates processes that open the same file: one machine, or a volume with working file locks (not NFS). For several machines, use Postgres or a libSQL server (`@libsql/client` with a remote URL).
- **RabbitMQ and NATS** remember a run for `slotTtlMs` / `duplicateWindowMs` (default 5 min), so `jitterMs + maxLateMs` must be shorter. Job names may only use letters, digits, `_` and `-`. A claim whose answer is lost (connection dropped mid-publish) is skipped by that instance rather than risk running twice.

## Guarantees and limits

- **One winner per attempt.** For one slot, only one instance wins each attempt. A slot gets another attempt only after its runner stopped renewing its lease.
- **At-least-once for crashed runs, by design.** A run whose runner died is started again. Keep jobs idempotent, and check `ctx.signal`.
- **A hung job blocks its job.** With `overlap: 'skip'`, a hung job keeps renewing its lease and blocks later runs. Set `timeoutMs`.
- **Keep clocks in sync (NTP).** Run times come from each instance's clock; leases use the Redis server's clock.
- **`every()` runs on a UTC grid.** For wall-clock times in a time zone, use `cron()` with `timezone`.

## Documentation

**Read the [hosted documentation](https://aristoteliss.github.io/anarchon/)** for guides to every option and method, the claim
and lease algorithms step by step with diagrams, one page per backend, and recipes (Express, NestJS,
Kubernetes, long-running jobs). [Choosing anarchon](https://aristoteliss.github.io/anarchon/getting-started/choosing-anarchon/)
compares it with BullMQ, node-cron, your own lock and Kubernetes CronJobs, and says when another tool fits better.

```sh
pnpm docs:dev     # http://localhost:4321
pnpm docs:build   # static site in docs/dist
```

## Examples

```sh
npx tsx examples/quick-start.ts         # the recording above: 3 processes on SQLite, a graceful stop, then kill -9
npx tsx examples/basic.ts               # run it in 3 terminals, then kill one (BACKEND=postgres or sqlite for those)
npx tsx examples/http-api.ts            # Express: GET /jobs, /jobs/:name/runs, POST /jobs/:name/run
                                        # examples/http-api.http has every request, for the VS Code REST Client
npx tsx examples/walkthrough.ts         # one run from the timer to history, made for stepping through in a debugger
npx tsx examples/failover.ts            # 3 instances in one process: a graceful hand-over, then a crash and takeover
npx tsx examples/options-and-events.ts  # every job option and every event
npx tsx examples/own-clients.ts         # pass in your own ioredis client or pg Pool
npx tsx examples/decorators.ts          # jobs declared with @Cron, @Every and @At on a class (standard decorators)
TSX_TSCONFIG_PATH=examples/tsconfig.legacy.json npx tsx examples/decorators-legacy.ts
                                        # the same with legacy decorators (experimentalDecorators): @Scheduled() and register()
npx tsx examples/decorators-startup.ts auto     # the three ways to start: auto (autoStart), manual (startAll) or hand (new Scheduler)
npx tsx examples/decorators-options.ts  # schedulers from settings, a scheduler per job, several objects of a class, run data
npx tsx examples/run-data.ts            # run data: the scheduler's, a job's, a function read at each run, runNow() and setData()
pnpm --filter anarchon-example-nestjs start         # a very small NestJS app whose providers declare jobs with decorators (examples/nestjs)
pnpm --filter anarchon-example-nestjs start:nest11  # the same source on NestJS 11
pnpm --filter anarchon-example-nestjs test          # checks the app on NestJS 11 and 12
```

All but `basic.ts` need no server (`quick-start.ts` always uses a SQLite file): they use a SQLite file in the temp folder unless `BACKEND=redis` or
`BACKEND=postgres` is set (`own-clients.ts` always needs Redis or Postgres). `.vscode/launch.json`
has a debug configuration for each; start with "Example: walkthrough", which pauses before `start()`
and lists where to step.

## Tests

The tests run against real servers, and any server that isn't running is skipped. `test/docker-compose.test.yml` starts every one of them on the default URLs below:

```sh
pnpm test:servers                          # Redis 8.6, Redis 7.0, Valkey, PostgreSQL, libSQL
COMPOSE_PROFILES=brokers pnpm test:servers # also RabbitMQ and NATS
pnpm test:servers:down                     # remove them and their data
```

| Server | Default URL | Variable |
|---|---|---|
| Redis 8.6+ | `redis://localhost:6381` | `REDIS_URL` |
| Older Redis (optional) | `redis://localhost:6380` | `REDIS_OLD_URL` |
| Valkey (optional) | `redis://localhost:6390` | `VALKEY_URL` |
| PostgreSQL (optional) | `postgres://postgres:postgres@localhost:5433/anarchon_test` | `POSTGRES_URL` |
| RabbitMQ (optional) | `amqp://localhost` | `RABBITMQ_URL` |
| NATS with JetStream (optional) | `nats://localhost:4222` | `NATS_URL` |
| libSQL server: sqld or Turso (optional) | `http://localhost:8081` | `LIBSQL_URL`, token in `LIBSQL_AUTH_TOKEN` |

SQLite needs no server (node:sqlite on Node 22.13+; files go to the temp folder, or `SQLITE_DIR`).

To make a run fail when a server is missing, instead of skipping its tests, name the servers it must have in `REQUIRE_SERVERS`: `redis`, `redis-old`, `valkey`, `postgres`, `sqlite`, `libsql`, `rabbitmq`, `nats`. CI sets it in every test job (`.github/workflows/ci.yml`).

```sh
REQUIRE_SERVERS=redis,postgres pnpm test
```

```sh
pnpm test              # everything below except test/e2e
pnpm test:slow         # test/e2e: the cluster and failure-scenario tests (real processes, real clock)
pnpm test:all          # every test
pnpm test:all:full     # the same with coverage, saved to test/test-run.log
pnpm test:last:review  # summary of the last full run (test:last:fails: failures only)
pnpm scenarios         # the failure scenarios: simple claim vs lease on Redis, Postgres, SQLite
```

This covers:
- for every backend (each Redis strategy on Redis 8.6, Redis 7.0 and Valkey 9.1; Postgres; SQLite with each driver; RabbitMQ; NATS): a race where three clients fight over 40 runs, retry-safety, and history
- a cluster test that starts 3 separate processes per backend and checks that every run happened exactly once, the work was spread, and history names the right instance
- the lease state machine, step by step, plus hand-over on `stop()`, late claims and trimming, on every backend with leases
- seven failure scenarios with real processes (`kill -9`, `SIGSTOP`, `SIGTERM`, full restarts) on Redis, Postgres and SQLite

## Credits

The claim-by-unique-record design comes from Meteor's SyncedCron, as do one-off jobs, run logging and the history time-to-live.

## License and Commercial Use

This software is **Dual-Licensed**.

The project offers the **GNU AGPLv3** (see [`LICENSE`](LICENSE)) and a separate commercial license (see [`COMMERCIAL_LICENSE.txt`](COMMERCIAL_LICENSE.txt)). The AGPLv3 is a copyleft license; review its terms to determine how they apply to your use. The commercial license allows commercial integration without AGPL copyleft obligations and sets an annual fee based on the licensee's gross global revenue. Review the full terms and fee schedule in the linked files before adopting either option.

For a concise comparison, see the [commercial license terms](COMMERCIAL_LICENSE.txt), including eligibility, annual revenue bands, and fees. The [licensing page](https://aristoteliss.github.io/anarchon/reference/licensing/) answers the common questions: which revenue counts, how to register for the free tier, and who to contact.

