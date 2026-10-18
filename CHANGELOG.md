# Changelog

## Unreleased

### Breaking

- **`backend` is the only way to choose a store.** The Redis options `redis`, `strategy`,
  `prefix` and `idmp` are no longer accepted by `new Scheduler()` or `Scheduler.configure()`;
  they are options of `new RedisBackend()`:
  `new Scheduler({ backend: new RedisBackend({ redis: url, prefix: 'billing:cron:' }) })`.
  `backend` is required in `SchedulerOptions` and `ConfigureOptions`.
- **A named scheduler created from default settings needs a `backend` function.** Settings with
  `redis` gave each named scheduler the key prefix `cron:<name>:`. Write it as
  `` backend: (name) => new RedisBackend({ redis: url, prefix: `cron:${name}:` }) ``.
- **`RedisStrategyName` is now `KeyValueStrategyName`.** Same values (`'lease' | 'stream-id' |
  'idmp' | 'script'`); `KeyValueStrategyName<'valkey'>` lists the ones Valkey supports, and
  `KeyValueStrategies` lists them by server.
- **A strategy's settings go inside it.** `RedisBackend` no longer takes `idmp` and
  `scriptWindowMs`: write `strategy: { name: 'idmp', durationSec, maxSize }` and
  `strategy: { name: 'script', windowMs }`. A setting of another strategy is a type error, and an
  error when the backend is created. `KeyValueStrategy` is now a name or such an object.
- **Lease options need a backend with leases.** `overlap`, `maxAttempts` and `catchUpMs` on jobs,
  and `leaseMs` and `heartbeatMs` on the scheduler, did nothing on RabbitMQ, NATS, or Redis/Valkey
  without the `lease` strategy. They now fail to compile there, and throw when set from a
  decorator or JavaScript. `overlap: 'skip'` was never enforced on those backends.
- **RabbitMQ and NATS refuse `historyTtlMs`.** They keep history by count only and ignored it.
- **`at()` takes no `overlap`.** `overlap` from `register()` defaults is left out of one-off jobs.
- **The Redis connection types are named for both servers.** `RedisInput`,
  `RedisConnectionOptions` and `RedisCommandClient` are `KeyValueConnection`,
  `KeyValueConnectionOptions` and `KeyValueClient`.

### Added

- **`ValkeyBackend`.** A `RedisBackend` for Valkey that takes `valkey` in place of `redis` and
  accepts only the strategies Valkey supports: `strategy: 'idmp'` is a type error instead of an
  error from `start()`. `RedisBackend` still works with Valkey.
- **`Scheduler<B>` knows its backend's type.** `new Scheduler({ backend })` infers it, so the
  options of the scheduler and of `every()`, `cron()` and `at()` match the backend. New types:
  `LeaseJobOptions`, `LeaseSchedulerOptions`, `JobOptionsFor`, `AtJobOptions`, `ScriptOptions`.
- **`RunKey` and `RunEvent`.** The fields every run event and history record share (`job`,
  `slot`, `scheduledAt`, `instanceId`), as types of their own: one function can read any of them.
- **The 'lost' event has `scheduledAt`,** like the other run events.

### Changed

- **NATS keeps the history its jobs ask for.** The stream keeps the largest of the backend's
  `historySize` and every job's, for each job; a job's own `historySize` was ignored before.

## 0.3.3

Fixes a heartbeat regression of 0.3.2 and an error message. The API is that of 0.3.2.

### Fixed

- **Heartbeats and hand-over are as fast as before 0.3.2.** 0.3.2 sent a heartbeat only after the
  previous one answered, and `stop()` waited for heartbeats in flight before handing a run
  over. With a slow store, a runner whose run was taken over could notice too late and finish
  without `ctx.signal` aborting, and a hand-over could arrive after the lease ran out.
  Heartbeats go out every `heartbeatMs` again, and `stop()` hands over at once.
- **A late heartbeat cannot undo a hand-over.** The store no longer renews a released lease, so
  a heartbeat sent before `stop()` released the run and arriving after it (possible on a
  connection pool) leaves the run to the backup. Redis `lease`, PostgreSQL and SQLite.
- **SQLite: the error for a missing driver names the Node versions that work.** On Node 22.5 to
  22.12 without `--experimental-sqlite`, the message said `node:sqlite` needs "Node 22.5+", a
  version the user already had. It now says Node 22.13+, or 22.5+ with
  `--experimental-sqlite`, and still names `better-sqlite3` as the alternative.

## 0.3.2

Fixes for runs that were lost or recorded wrongly in edge cases, and for the RabbitMQ and NATS
backends. It also includes the changes of 0.3.1, which was not published.

### Fixed

- **Redis `stream-id`, `idmp` and `script`: `runNow()` could cancel a scheduled run.** A manual
  run made after a run was due, and before the instances claimed it, made every instance skip
  that run with `taken`. Manual runs now go to their own stream, `<prefix><job>:manual`, and
  `history()` reads both streams. Entries already in `<prefix><job>:runs` stay readable.
- **A run that ends while `stop()` waits is recorded as ended.** A store error at that moment
  stopped the retry, so the run stayed `running` and a backup ran the finished job again.
- **No false `lost` event after a successful run.** A heartbeat that reached the store after the
  run ended emitted `lost` and aborted `ctx.signal`. One heartbeat is sent at a time, and a
  refused one after the end is ignored.
- **`stop()` hands a run over for good.** `stop()` waits for the heartbeat in flight before it
  releases the run, so a late heartbeat cannot renew the lease it just gave up.
- **Redis `lease`: history keeps the result of an attempt after more than 100 hand-overs.**
- **SQLite: a libSQL server no longer blocks other databases.** Statements on a client with
  `protocol` `http` or `ws` run in a queue of their own, not in the one every local SQLite
  statement in the process shares. `LibsqlClientLike` has an optional `protocol` member; a
  client without it keeps the shared queue.
- **NATS: `history()` deletes the consumer it creates**, instead of leaving it on the server
  for five minutes.
- **RabbitMQ: a queue that exists with other arguments is used as it is.** Instances with a
  different `slotTtlMs` or `historySize` used to fail their claims, or `prepareJob`, and the
  failure closed the channel that other jobs shared. A queue keeps the arguments it was created
  with.

## 0.3.1

Package metadata and license text. The compiled code is the same as 0.3.0.

### Changed

- **Commercial license, version 1.1.** The revenue tiers are marginal brackets: each rate
  applies only to the portion of gross revenue inside its bracket, and the annual fee is the
  sum. Under version 1.0 each rate applied to total revenue, so the fee fell when revenue
  crossed a tier boundary. The $50,000 yearly cap and the $0 tier up to $500,000 stay.
  `COMMERCIAL_LICENSE.txt` has the terms and an example.
- The package description states what each backend provides: an atomic claim selects one
  runner per attempt, lease backends start a failed runner's run again, and RabbitMQ and
  NATS are claim only.
- The package homepage is the documentation site, https://aristoteliss.github.io/anarchon/.
- README: the built-in SQLite driver needs Node 22.13 (22.5 to 22.12 with
  `--experimental-sqlite`), not 22.5; a takeover starts the handler again as a new attempt.

### Runtime

- Node.js 20 or newer. On Node 20, SQLite needs `better-sqlite3@12`: version 13 requires
  Node 22.

## 0.3.0

### Added

- Decorators: `@Cron`, `@Every` and `@At` declare jobs on the methods of a class, with
  TypeScript's standard decorators or `experimentalDecorators`. `@Scheduled()` on a class
  and `scheduler.register(object, { prefix, defaults })` add the jobs of an object in the
  legacy style.
- Schedulers from settings: `Scheduler.configure()` for the default scheduler or a named
  one, `Scheduler.get()`, `Scheduler.all()`, `Scheduler.startAll()`, `Scheduler.stopAll()`,
  `Scheduler.setDefault()` and `Scheduler.reset()`. A job chooses its scheduler with the
  `scheduler` option.
- Run data: the `data` option of a scheduler and of a job, read by a run as `ctx.data`; a
  function is called when each run starts. `scheduler.setData()` replaces the scheduler's
  data, and `scheduler.runNow(name, { data })` gives data to one manual run.
  `JobContext` takes the data's type: `JobContext<{ tenant: string }>`.
- A runnable NestJS application in `examples/nestjs`, checked on NestJS 11 and 12.

### Breaking

- A backend is required. `new Scheduler()` without `redis` or `backend` throws; 0.2.0
  connected to Redis on `localhost:6379`. Pass `{ redis: 'redis://localhost:6379' }` to keep
  that behavior.

## 0.2.0

The first release on npm: leaderless cron and interval scheduling on Redis and Valkey
(the `lease` strategy and the claim-only `stream-id`, `idmp` and `script` strategies),
PostgreSQL and SQLite with leases, and RabbitMQ and NATS claim only.
