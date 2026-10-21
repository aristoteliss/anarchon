# anarchon conventions

The dominant patterns in `src/` and `examples/`, written down so new code matches them. AGENTS.md
holds the general Naming, Documentation and Compatibility rules; this file adds what is specific to
this stack. Where the code is inconsistent, the choice made is noted.

## Stack and formatting

- TypeScript 7 with `strict`, `noUncheckedIndexedAccess` and `noImplicitOverride`; `module` and
  `moduleResolution` are `nodenext`; the package is CommonJS (`"type": "commonjs"`) and targets
  ES2022 on Node 20 or later (`tsconfig.json`, `package.json`).
- Biome formats and lints: 2 spaces, single quotes, line width 80, recommended rules
  (`biome.json`). Biome also sorts imports within each group that a blank line separates. Run
  `pnpm format` instead of formatting or ordering imports by hand.
- Every source file starts with the license header, then a blank line:
  `/* Copyright (C) 2026-present Aristotelis — see repository license. */`
- Type-only imports use `import type`; a mixed import marks its types inline:
  `import { abortError, type Executor } from './executor';`.
- Relative imports have no file extension (`'../types'`). Node built-ins use the `node:` prefix.
- Named exports only; there is no default export in `src/`.
- Numbers of 1,000 and above use separators (`5_000`, `86_400_000`). Port numbers are the
  exception (`6379`).

## Naming

The rules are in AGENTS.md, Naming. These are the forms this code uses.

| Kind | Form | Examples |
| --- | --- | --- |
| Files | kebab-case | `lease-runner.ts`, `claim-only-runner.ts`, `option-keys.ts` |
| Classes | PascalCase noun, with a role suffix where one applies | `RedisBackend`, `LeaseStore`, `StreamIdStrategy`, `LeaseRunner`, `Executor` |
| Interfaces and types | PascalCase noun, no `I` prefix | `Execution`, `RunRecord`, `ClaimOutcome`, `JobOptions` |
| Functions and methods | verb | `claim`, `renew`, `place`, `createJob`, `readOptions` |
| Converters | `to...` and `from...` | `toRunRow`, `toClaim`, `toResult`, `fromLibsql`, `fromPgPool` |
| Checks that throw | `refuse...`, `assert...`, `check...` | `refuseUnknown`, `refuseWithoutLeases`, `assertSimpleName`, `checkJob` |
| Constants | `UPPER_SNAKE`, with a unit suffix for quantities | `CLOCK_TOLERANCE_MS`, `BYTES_PER_RUN`, `STORE_FORMAT` |
| Option key lists | `<OWNER>_OPTIONS`, built with `keysOf<T>()` | `RABBITMQ_OPTIONS`, `LEASE_JOB_OPTIONS` |
| Durations and times | unit suffix; a number named `...At` is Unix milliseconds | `leaseMs`, `durationSec`, `startedAt` |
| Booleans | adjective, participle, or `is...`/`has...` | `started`, `lost`, `removed`, `isRunning()`, `isIdle()` |
| Error codes | `ANARCHON_<KIND>` | `ANARCHON_UNKNOWN_OPTION`, `ANARCHON_STORE` |

- Abbreviations are limited to `id`, `url`, `ttl`, `ctx`, and `tx` for a transaction. Inside one
  backend, the driver's own short names are allowed (`nc`, `js` and `jsm` in the NATS backend).
- Private state uses `private readonly` fields, not `#private` fields.

## Where code goes

| Change | Place |
| --- | --- |
| A public export | Re-export it from `src/index.ts`, then run `pnpm api:update` and review the diff of `api/anarchon.api.txt` |
| A public type | `src/types/<concern>.ts` (`jobs`, `scheduler`, `runs`, `backend`, `strategies`), re-exported by `src/types/index.ts` |
| Scheduler behavior | The part that owns it: `job.ts` (validation), `timers.ts` (when a run is due), `lease-runner.ts` and `claim-only-runner.ts` (claiming), `executor.ts` (running and recording), `data.ts` (`ctx.data`), `options.ts` (scheduler options), `logging.ts` |
| Scheduler public API and lifecycle | `src/scheduler/scheduler.ts` only; its parts receive the `SchedulerCore` view (`src/scheduler/core.ts`) |
| A backend | `src/backends/<name>.ts`, or a folder when it needs several modules (`redis/`, `sql/`). It implements `Backend`, and `RunStore` when it has leases, and passes `test/backends/contract.test.ts` |
| An option list | `src/option-keys.ts`, or next to the backend's options interface |
| An error code | The `ErrorCode` union and its JSDoc list in `src/errors.ts` |
| Schedules and durations | `src/schedule.ts` |
| History records | `src/history.ts`; the stored format version is in `src/store-format.ts` |
| Decorators; the scheduler registry | `src/decorators.ts`; `src/registry.ts` |
| A helper | The file of its caller; `src/util.ts` only when two or more modules use it |
| An example | `examples/<topic>.ts` with a `pnpm example:<topic>` script; shared code in `examples/shared.ts` |
| A framework example | A workspace package under `examples/<framework>/` with its own `package.json`, `tsconfig.json` and `biome.json` |

- The scheduler and the backends never import each other. The scheduler reaches a backend only
  through the `Backend` and `RunStore` types in `src/types/`.
- Nothing specific to NestJS or another framework belongs in `src/`, the root config files or
  `test/`.

## Shape of a function

A function reads in the order its work happens. The forms below are the ones rules 12 to 14 of
the skill ask for.

| Step | Form | Example in `src/` |
| --- | --- | --- |
| Take the input | One object parameter for more than 4 values, destructured once at the top | `addDeclared(job, name, { timezone, ...defaults })` in `src/scheduler/scheduler.ts` |
| Refuse | `refuse...` calls and coded throws on the first lines, before any write | `refuseUnknown('runNow()', options, RUN_NOW_OPTIONS)` in `Scheduler.runNow` |
| Load | One read of the state the decision needs, with `now` read once | the `SELECT ... AS now` in `SqlBackend.claimRun` |
| Decide | A `kind`-tagged outcome, computed from the state and `now` | `ClaimOutcome` in `src/types/backend.ts` |
| Act | The writes, timers and events the outcome asks for | `startRun(tx, ...)` and `recordAttempt(tx, ...)` |
| Return | The outcome, or the record built from it | `return { kind: 'won', attempt };` |

- A function over 10 lines separates these steps with single blank lines; a step has no blank
  line inside it (rule 15).
- A function that only acts (a converter, a write) skips the steps it does not need: `toRunRow`
  is only "take the input, return".
- `Date.now()` is called once per operation and the value passed down, so every check and write of
  that operation agrees on the time.
- A function that may throw lists each failure in `@throws` with its condition, as
  `Scheduler.start` does.

## Classes, functions and state

- A class holds state its methods share: backends hold connections, runners hold timers,
  strategies hold a client. Validation and conversion are functions.
- Scheduler parts take the core in the constructor (`constructor(private readonly core:
  SchedulerCore) {}`) and long methods start with `const { core } = this;`.
- A backend connects lazily, once: it caches the promise and clears it on failure, so the next call
  retries (`NatsBackend.getState`, `SqlBackend.getReady`).
- An optional driver is loaded with `await import(...)` inside the backend. A missing driver throws
  `ANARCHON_MISSING_DRIVER` with the install command in the message.
- `src/` takes configuration through options and constructor arguments only; it never reads
  `process.env`.

## Error handling

- **Throw:** `throw coded(new TypeError(message), 'ANARCHON_INVALID_ARGUMENT');`
  - `TypeError`: wrong type or shape, an unknown option, a missing handler.
  - `RangeError`: a number out of range, or timing values that conflict.
  - `Error`: the server, the store, the scheduler's state, a missing driver.
- **Message:** subject first, then the value received and what is accepted:
  `` `Job "${name}": jitterMs (${jitterMs}) must be under half the time between runs (${schedule.minGapMs} ms)` ``.
  The message may suggest the fix; the code stays stable and the text may change.
- **Codes:** a new kind of failure gets a new member of `ErrorCode` and a line in its JSDoc.
  `test/unit/errors.test.ts` scans `src/` for uncoded throws.
- **Options:** `refuseUnknown(label, options, KNOWN_KEYS)` refuses unknown keys, with a "did you
  mean" hint. `refuseWithoutLeases` refuses lease options on a backend without leases. An option is
  never silently ignored.
- **Numbers:** validate with `positiveInt`, `nonNegativeInt` and `intInRange` from `src/util.ts`.
- **Background work:** timers, heartbeats and result writes report failures with
  `core.emit('error', { error, job: job.name, slot })`. A method that must not reject says "Never
  rejects" in its JSDoc and catches at its boundary.
- **Cleanup:** `.catch(() => {})` only where failure changes nothing (closing a channel, cancelling
  or deleting a consumer, a rollback after a failed transaction). Add a short comment when the
  reason is not obvious.
- **Examples:** a plain `throw new Error(...)` is fine, since examples are not part of the error
  contract.

## Logging

- `src/` logs only through the `log` and `logger` options (`src/scheduler/logging.ts`). No other
  `console` call belongs in `src/`.
- Examples log with `console.log`, or with `say()` from `examples/shared.ts` for timestamped lines.

## Examples

- Each example runs with `tsx` through a root script (`pnpm example:<topic>`) and imports the
  library from `'../src'`.
- Examples read connection details from the environment by name, with local defaults
  (`process.env.REDIS_URL ?? 'redis://localhost:6379'`); never write a credential.
- `pnpm lint` type-checks `examples/*.ts` only. A folder under `examples/` is a package with its own
  config: `pnpm --filter anarchon-example-nestjs test` checks the NestJS app on NestJS 11 and 12.

## Tests

The readability rules do not cover `test/`, but these conventions do.

Layout, by what a test needs:

- `test/unit/`: pure logic, no server.
- `test/scheduler/`: the public API, on the main Redis.
- `test/backends/`: `contract` (the same checks on every backend), then what is specific to `redis`,
  `sql` (Postgres, SQLite) and `brokers` (RabbitMQ, NATS).
- `test/leases/`: the lease `rules` on each lease backend, and the `scheduler` on top of them.
- `test/e2e/`: real child processes, slow. `cluster/` (3 instances per backend), `scenarios/` (kill,
  freeze, restart) and `decorators/` (decorator syntax compiled in both styles).
- `test/support/`: `servers` (URLs and probes), `specs` (one spec per backend to test), `util`.
- `test/vitest.config.mts`, `test/docker-compose.test.yml` and `test/test-run.log` (ignored by git)
  live in `test/` too. The scripts pass the config; a bare `vitest` needs
  `--config test/vitest.config.mts`.

How they run:

- Vitest runs against real servers. A server that is not running makes its tests skip, so a green
  run can still hide skipped backends: read the skip count, or name the servers a run must have in
  `REQUIRE_SERVERS` (`test/support/require-servers.ts`), as every CI job does.
- The servers, their default URLs and the environment variables that override them are listed in
  the README's Tests section.
- `test/docker-compose.test.yml` runs every server on the default URLs; Redis 8.6 and Postgres use
  6381 and 5433 so a Redis or Postgres on the usual ports is never touched. No test uses 6379 or
  5432: a scheduler has no default backend, so `backend` is always given.
- `LIBSQL_URL` and `LIBSQL_AUTH_TOKEN` point the libSQL server tests at another server, such as
  Turso. The token is read from the environment only.
- Each test uses its own Redis key prefix (`test:<id>:`) or table (`t_<id>`); tests never flush or
  drop data, but they leave keys and tables behind.
- Test files run one at a time (`fileParallelism: false`): several measure timing.
- The cluster and scenario tests start child processes with `tsx` (`test/e2e/cluster/instance.ts`,
  `test/e2e/scenarios/instance.ts`).
- `test:all:full` pipes through `tee`, so its exit status does not prove success; use
  `pnpm test:last:review`.

How they are written:

- Top-level `test(...)` calls; `it` is not used. A title is a lowercase sentence that states the
  behavior or contract: `'a crashed manual run is never retried by a backup'`.
- Tests that run on several backends loop over the specs in `test/support/specs.ts` and wrap each in
  `describe.skipIf(skip)(label, ...)`.
- No ticket, task or review identifiers in titles, file names or variable names.
- A test reaches the code through the surface real callers use. Where a module boundary must be
  crossed, `vi.mock` the module (`test/unit/sqlite-driver.test.ts`); never add a parameter, export
  or option for a test.
- A bug fix starts with a test that reproduces the bug.
