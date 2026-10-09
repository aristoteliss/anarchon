# anarchon

Leaderless cron for Node.js clusters. Run the same jobs in every instance of your service, and each scheduled run happens **once**, on one instance picked at random. There is no leader to elect and no lock to hold: one atomic call to Redis, Valkey, PostgreSQL or SQLite decides who runs each time.

anarchon also handles what goes wrong in real clusters:
- jobs that run longer than their interval
- an instance crashing or freezing mid-run
- rolling deploys, and every instance restarting at once

```ts
import { Scheduler } from 'anarchon';

const scheduler = new Scheduler(); // Redis on localhost:6379

scheduler
  .every('sync', '10s', async (ctx) => { /* ... */ })
  .every('report', '35m', async (ctx) => { /* ... */ }, { timeoutMs: 20 * 60_000 })
  .cron('digest', '0 */2 * * *', async (ctx) => { /* ... */ }, { timezone: 'Europe/Athens' })
  .at('migrate', new Date('2026-12-01T03:00:00Z'), async (ctx) => { /* runs once, ever */ });

await scheduler.start();
```

Put the same code in every instance.

## Install

```sh
pnpm add anarchon ioredis
```

`ioredis` is only needed if you let anarchon open the connection. You can pass your own ioredis, iovalkey, node-redis or Valkey GLIDE client instead. It works with Redis 5+ and Valkey.

For another backend, install its driver instead (see [Backends](#backends)):

```sh
pnpm add anarchon pg                    # PostgreSQL (or bring your own pg / postgres.js client)
pnpm add anarchon                       # SQLite with node:sqlite (Node 22.5+), or add better-sqlite3 / @libsql/client
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

### How the lease works

- **Claiming.** A claim stores the run with a lease that ends `leaseMs` (default 30 s) from now, measured on the Redis server clock, so clock differences between instances don't matter. The runner renews the lease every `heartbeatMs` (default 5 s).
- **Backups.** Instances that saw the run taken check on it every 1 to 2 heartbeats. If the lease ran out before the run finished, they all try to claim the next attempt, and only one wins. A crashed run is taken over about one lease after the crash (at most `leaseMs` + 2 × `heartbeatMs`). It is started up to `maxAttempts` times in all (default 3), and only while it's still the latest run of its job: if the next run starts first (a crash within about a lease of the next run), the crashed one is marked `interrupted` and the next run replaces it.
- **Graceful stop.** On `stop()`, a job that throws once `ctx.signal` aborts (for example with `ctx.signal.throwIfAborted()`) gives its run up. A backup takes it over at its next check (within 2 heartbeats) without waiting for the lease to run out, and this doesn't count toward `maxAttempts`. A job that returns normally counts as finished. A job still running when the stop timeout passes stops renewing its lease, so a backup takes it over once the lease runs out.
- **No overlap.** A new run isn't started while an earlier run of the same job still holds a live lease. Set `overlap: 'allow'` to run them side by side.
- **Fencing.** Every attempt has its own token. Heartbeats and "finished" only work with the current token, so a runner that was taken over finds out at its next heartbeat. Its `ctx.signal` aborts and it emits `lost`.
- **Catch-up.** On start, each instance first picks up unfinished runs whose runner is gone. Then, if the latest run was never claimed and was due less than `catchUpMs` ago, it runs it now with `reason: 'catch-up'`.
- **Late claims.** Redis checks how late a new claim is on its own clock, so a claim that was delayed or queued (ioredis queues commands while it reconnects) can't start a stale run. A run is never trimmed from the state while a late claim could still ask for it, whatever `historySize` is.

A lease isn't a lock you hold and release. Every decision is still a single atomic claim, and the lease only says "the runner is still alive". A frozen runner can't know it was taken over until it wakes up, so two attempts can briefly overlap in that case. Check `ctx.signal` before side effects, and keep jobs idempotent.

## API

### `new Scheduler(options?)`

| Option | Default | Meaning |
|---|---|---|
| `redis` | localhost:6379 | `{ host, port, password, db }`, a URL, or your own client: ioredis, iovalkey, node-redis, Valkey GLIDE, or any `{ send(command, args) }`. Clients you pass aren't closed on stop |
| `strategy` | `'lease'` | `'lease'`, or one of the simple claims: `'stream-id'`, `'idmp'` (Redis 8.6+), `'script'` |
| `prefix` | `'cron:'` | Key prefix |
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

`handler(ctx)` receives `{ name, slot, scheduledAt, instanceId, manual, attempt, reason, signal }`:
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

### Lifecycle

- **`start()`** connects, checks the server, schedules every job, and picks up unfinished and missed runs.
- **`stop({ timeoutMs = 30000 })`** stops scheduling, aborts `ctx.signal`, waits for running jobs, and closes the connection if anarchon opened it. Jobs that throw on abort are handed to another instance (see Graceful stop above). After `stop()` returns, anarchon sends nothing more to Redis.

```ts
process.on('SIGTERM', async () => {
  await scheduler.stop();
  process.exit(0);
});
```
- **`runNow(name)`** runs a job immediately on this instance, without deduplication, and records it as a manual run. Manual runs are never retried.
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
import { NatsBackend, PostgresBackend, RabbitMQBackend, Scheduler, SqliteBackend } from 'anarchon';

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

## Examples

```sh
npx tsx examples/basic.ts       # run it in 3 terminals, then kill one (BACKEND=postgres or sqlite for those)
npx tsx examples/http-api.ts    # GET /jobs, /jobs/:name/runs, POST /jobs/:name/run
```

## Tests

The tests run against real servers, and any server that isn't running is skipped:

| Server | Default URL | Variable |
|---|---|---|
| Redis 8.6+ | `redis://localhost:6379` | `REDIS_URL` |
| Older Redis (optional) | `redis://localhost:6380` | `REDIS_OLD_URL` |
| Valkey (optional) | `redis://localhost:6390` | `VALKEY_URL` |
| PostgreSQL (optional) | `postgres://postgres:postgres@localhost:5432/anarchon_test` | `POSTGRES_URL` |
| RabbitMQ (optional) | `amqp://localhost` | `RABBITMQ_URL` |
| NATS with JetStream (optional) | `nats://localhost:4222` | `NATS_URL` |

SQLite needs no server (node:sqlite on Node 22.5+; files go to the temp folder, or `SQLITE_DIR`).

```sh
pnpm test            # everything below
pnpm run scenarios   # the failure scenarios: simple claim vs lease on Redis, Postgres, SQLite
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

By default, this project is licensed under the **GNU AGPLv3** (see the `LICENSE` file). You can use, modify, and distribute it freely, provided your entire application is also open-sourced under the AGPLv3.

**Commercial License (No AGPL Restrictions)**

If you are using this software commercially and cannot (or do not want to) open-source your application under the AGPLv3, you must use the **Commercial License** (see `COMMERCIAL_LICENSE.txt`).

Revenue-based pricing:

| Annual Gross Revenue | Fee |
|---|---|
| Under $500,000 | **Free** |
| $500,001 — $10,000,000 | 0.1% of gross revenue |
| $10,000,001 — $50,000,000 | 0.05% of gross revenue |
| Over $50,000,000 | 0.01% of gross revenue (capped at $50,000/year) |

