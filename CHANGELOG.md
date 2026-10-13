# Changelog

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
