# Codebase Map

Compact orientation map for automated and human readers. It is a starting point, not a
substitute for reading source. Sections marked *generated* are rewritten by
`scripts/update-claude-snapshot.py`; sections wrapped in `context:manual-*` markers are
preserved across regeneration and are owned by humans.

## Purpose

<!-- context:manual-start purpose -->
anarchon, one published npm package (the repository root): leaderless cron for Node.js
services. An atomic claim in the shared store selects one runner per attempt of a run. Redis/Valkey,
PostgreSQL and SQLite add a lease (retry after a runner fails, skip while a run is live,
catch-up of the latest missed run); RabbitMQ and NATS are claim only. `docs/` is the documentation site and
`examples/` holds runnable examples, one of them a NestJS workspace package.
<!-- context:manual-end purpose -->

## Repository Shape

<!-- context:generated-start repository-shape -->
- **Shape**: monorepo with workspace globs `.`, `docs`, `examples/nestjs` (3 workspace packages).
- **Publishable packages**: 1; private: `docs`, `examples/nestjs`.
- **Runnable workspaces**: `docs`, `examples/nestjs`.
- **Versions**: `0.0.0`, `0.4.0`.
- **Packages**: see the Workspace packages table under Directory Map.
<!-- context:generated-end repository-shape -->

## Technology Stack

<!-- context:generated-start technology-stack -->
- **Languages** (file counts, excluded directories omitted): `.md` 95, `.ts` 91, `.mjs` 7, `.py` 2
- **Runtime engines** (root `package.json`): `node` >=20
- **Package manager evidence**: `pnpm-lock.yaml`.
- **Integrations**: listed with their purpose under Dependencies and Integrations.
<!-- context:generated-end technology-stack -->

## Entry Points

<!-- context:generated-start entry-points -->
| Path | Role | Invocation |
| --- | --- | --- |
| `.github/workflows/ci.yml` | CI pipeline definition | Runs in CI |
| `.github/workflows/deploy-docs.yml` | CI pipeline definition | Runs in CI |
| `docs/check-diagrams.mjs` | Referenced by a package script | `pnpm --filter anarchon-docs` `check:diagrams` |
| `examples/basic.ts` | Referenced by a root script | `pnpm example` |
| `examples/billing.ts` | Referenced by a root script | `pnpm example:billing` |
| `examples/broker-notifications.ts` | Referenced by a root script | `pnpm example:brokers` |
| `examples/cache-refresh.ts` | Referenced by a root script | `pnpm example:cache` |
| `examples/decorators-legacy.ts` | Referenced by a root script | `pnpm example:decorators:legacy` |
| `examples/decorators-options.ts` | Referenced by a root script | `pnpm example:decorators:options` |
| `examples/decorators-startup.ts` | Referenced by a root script | `pnpm example:decorators:startup` |
| `examples/decorators.ts` | Referenced by a root script | `pnpm example:decorators` |
| `examples/failover.ts` | Referenced by a root script | `pnpm example:failover` |
| `examples/http-api.ts` | Referenced by a root script | `pnpm example:api` |
| `examples/nestjs/check.mjs` | Referenced by a package script | `pnpm --filter anarchon-example-nestjs` `start`, `start:nest11`, `test` |
| `examples/nestjs/src/main.ts` | Process entry point | workspace `anarchon-example-nestjs` |
| `examples/nightly-export.ts` | Referenced by a root script | `pnpm example:export` |
| `examples/options-and-events.ts` | Referenced by a root script | `pnpm example:options` |
| `examples/own-clients.ts` | Referenced by a root script | `pnpm example:clients` |
| `examples/run-data.ts` | Referenced by a root script | `pnpm example:run-data` |
| `examples/tenants.ts` | Referenced by a root script | `pnpm example:tenants` |
| `examples/walkthrough.ts` | Referenced by a root script | `pnpm example:walkthrough` |
| `scripts/api-snapshot.mjs` | Referenced by a root script | `pnpm api:update`; `pnpm test:release` |
| `scripts/release-check.mjs` | Referenced by a root script | `pnpm test:release` |
| `scripts/test-log.mjs` | Referenced by a root script | `pnpm test:last:fails`; `pnpm test:last:review` |
| `test/e2e/scenarios/report.ts` | Referenced by a root script | `pnpm scenarios` |

Package public entry (barrel): `<package>/src/index.ts` in 1 workspace packages; exceptions are listed above.

Published packages additionally expose their built `main` (`dist/index.js`, produced by `pnpm build`), imported by package name.
<!-- context:generated-end entry-points -->

## Directory Map

<!-- context:generated-start directory-map -->
Only directories that carry responsibility are listed. Generated output, caches and
editor/tooling directories are excluded (see Snapshot Metadata).

| Directory | Responsibility |
| --- | --- |
| `.claude/` | Needs verification |
| `.github/` | Needs verification |
| `api/` | Needs verification |
| `assets/` | Needs verification |
| `docs/` | The documentation site, built with Astro and Starlight. |
| `examples/` | Workspace container: 1 package(s); see the workspace table below |
| `scripts/` | Needs verification |
| `src/` | Needs verification |
| `test/` | Needs verification |

Root files: `.gitignore`, `AGENTS.md`, `CHANGELOG.md`, `CLAUDE.md`, `COMMERCIAL_LICENSE.txt`, `CONTRIBUTING.md`, `LICENSE`, `README.md`, `biome.json`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.json`, `tsconfig.test.json`

### Workspace packages

Each has a `README.md`.

| Path | Package | Source layout |
| --- | --- | --- |
| `.` | `anarchon` | `backends`, `scheduler`, `types` |
| `docs` | `anarchon-docs` | `content`, `styles` |
| `examples/nestjs` | `anarchon-example-nestjs` | flat |
<!-- context:generated-end directory-map -->

## Architecture

<!-- context:manual-start architecture -->
*Manual section: the generator never overwrites it. Verify each claim against the source
path given before relying on it.*

- **Public API**: everything a consumer imports is exported from `src/index.ts`; the
  release check (`scripts/release-check.mjs`) compares those runtime exports with the packed
  tarball's.
- **Scheduler** (`src/scheduler/scheduler.ts`): public API and lifecycle only. It owns the
  state and hands each part the `SchedulerCore` view (`src/scheduler/core.ts`): `job.ts`
  validates jobs, `timers.ts` decides when a run is due, `lease-runner.ts` and
  `claim-only-runner.ts` claim a run, `executor.ts` runs the handler and records the result,
  `data.ts` builds `ctx.data`, `logging.ts` logs runs, `options.ts` checks the scheduler's options.
- **Backends** (`src/backends/`): each implements `Backend`, and the lease backends also
  `RunStore` (`src/types/backend.ts`). Redis (`src/backends/redis/`: client adapters, `lease.ts`, `scripts.ts` (Lua by hash), and the
  stream-id, idmp and script claim strategies in `strategies.ts`); SQL (`src/backends/sql/base.ts` with
  `postgres.ts` and `sqlite.ts` dialects and client adapters); `rabbitmq.ts` and `nats.ts`
  claim only, without leases.
- **Decorators and registry**: `src/decorators.ts` (`@Cron`, `@Every`, `@At`,
  `@Scheduled`, standard and legacy syntax); `src/registry.ts` holds the default, named and
  configured schedulers and where each decorated object's jobs live.
- **Schedules and history**: `src/schedule.ts` (durations, every/once/cron schedules on
  `croner`); `src/history.ts` (claim and result records, run history merge).
<!-- context:manual-end architecture -->

## Critical Modules

<!-- context:manual-start critical-modules -->
*Manual section: the generator never overwrites it.*

### Claiming and leases: `src/scheduler/lease-runner.ts`, `src/backends/redis/lease.ts`, `src/backends/sql/base.ts`

- `RunStore.claim` must give exactly one caller `won` per attempt of a run; heartbeats,
  `finish` and `release` return `false` once a backup has taken the run over. Changes here
  need the lease rules tests on every lease backend (`test/leases/rules.test.ts`) and the e2e
  scenarios (`test/e2e/scenarios/`).

### Public types: `src/types/` (one module per concern, re-exported by `index.ts`)

- `jobs.ts` (handler context, job options), `scheduler.ts` (scheduler options, `JobOptionsFor`),
  `runs.ts` (run records, events), `strategies.ts` (Redis/Valkey strategies), `backend.ts`.

### Backend contract: `src/types/backend.ts` (`Backend`, `RunStore`)

- `dedupeWindowMs` bounds `jitterMs + maxLateMs` of every job. Every backend passes the
  shared checks in `test/backends/contract.test.ts`; a contract change touches every backend.
- Implemented outside this repository too: new members are optional (AGENTS.md, Compatibility).
  `buildHistory()` (`src/history.ts`) builds history records; `src/store-format.ts` versions the
  stored layout.

### Published surface: `src/index.ts`, `scripts/release-check.mjs`, `api/anarchon.api.txt`

- Removing or renaming an export is a breaking change for external consumers.
- `pnpm test:release` compares the built declarations with `api/anarchon.api.txt`; record an
  intended change with `pnpm api:update` (a clean build first, so no stale `dist/` file is read).
- Options and errors: `src/option-keys.ts` (`keysOf` lists, unknown keys refused), `src/errors.ts`
  (`ErrorCode`, every throw coded; `test/unit/errors.test.ts` scans for uncoded throws).
<!-- context:manual-end critical-modules -->

## Dependencies and Integrations

<!-- context:generated-start dependencies -->
External dependency names and declared ranges only. No credential, endpoint or
environment value is read or reproduced here.

| Integration | Packages | Declared in |
| --- | --- | --- |
| Croner: Cron expression parsing and next-run calculation | `croner` | `.` |
| Redis / Valkey: Lease and claim backend | `redis`, `ioredis`, `iovalkey`, … (+1) | `.` |
| PostgreSQL: SQL lease backend | `pg`, `postgres` | `.` |
| SQLite / libSQL: SQL lease backend, local and server | `better-sqlite3`, `@libsql/client` | `.` |
| RabbitMQ: Claim-only broker backend | `amqplib` | `.` |
| NATS JetStream: Claim-only broker backend | `@nats-io/transport-node`, `@nats-io/jetstream` | `.` |
| NestJS: Example application framework | `@nestjs/common`, `@nestjs/core` | `examples/nestjs` |
| Express: Example HTTP API | `express` | `.` |
| Astro Starlight: Documentation site | `astro`, `@astrojs/starlight` | `docs` |
| Mermaid: Documentation diagrams | `mermaid`, `astro-mermaid` | `docs` |
| Vitest: Test runner and coverage | `vitest`, `@vitest/coverage-v8` | `.` |
| tsx: TypeScript runner for examples and child-process tests | `tsx` | `.` |
| Biome: Formatter and linter | `@biomejs/biome` | `.` |
| TypeScript: Language and type checker | `typescript` | `.`, `examples/nestjs` |

### Declared dependencies per workspace

| Workspace | Internal | External | Peers |
| --- | --- | --- | --- |
| `.` | — | `croner` | `@nats-io/jetstream`, `@nats-io/transport-node`, `amqplib`, `better-sqlite3`, `pg`, `redis` |
| `docs` | — | `@astrojs/starlight`, `astro`, `astro-mermaid`, `mermaid`, `sharp` | — |
| `examples/nestjs` | `anarchon` | `@nestjs/common`, `@nestjs/core`, `reflect-metadata`, `rxjs` | — |

### Environment variables referenced in source

Names only; values are never read by the generator.

`AMQP_URL`, `BACKEND`, `BILLING_REDIS_URL`, `BROKER`, `CRON_STRATEGY`, `DATABASE_URL`, `EXIT_AFTER_MS`, `INSTANCE_ID`, `JOB_TIMEOUT`, `LIBSQL_AUTH_TOKEN`, `LIBSQL_URL`, `NATS_URL`, `POD_NAME`, `PORT`, `POSTGRES_URL`, `RABBITMQ_URL`, `REDIS_OLD_URL`, `REDIS_PASSWORD`, `REDIS_URL`, `REQUIRE_SERVERS`, `RUN_MS`, `SCENARIO`, `SPEC`, `SQLITE_DIR`, `SQLITE_FILE`, `STRATEGY`, `VALKEY_URL`
<!-- context:generated-end dependencies -->

## Conventions

<!-- context:manual-start conventions -->
*Manual section: the generator never overwrites it. Naming, comments and documentation
rules live in `AGENTS.md`.*

| Area | Convention | Evidence |
| --- | --- | --- |
| Tooling | pnpm only; Biome (2 spaces, single quotes, line width 140); strict `tsc` with `module: nodenext` | `biome.json`, `tsconfig.json`, `CLAUDE.md` |
| Configuration | The library reads no environment; options and constructor arguments only | `AGENTS.md` rule 6 |
| Framework neutrality | Nothing specific to NestJS in `src/`, the root config files or `test/` | `CLAUDE.md`, Tests |
| License | Every source file starts with the repository license header | the files themselves |
| Files | kebab-case | `src/scheduler/` |
| Backend-specific options | An option a backend or strategy can't honour is absent from the types where the backend is known (`Scheduler<B>`, `JobOptionsFor<B>`, a strategy's settings inside `{ name }`) and throws where it isn't (decorators, JavaScript); never silently ignored | `src/types/scheduler.ts`, `src/scheduler/job.ts` (`refuseWithoutLeases`), `src/backends/redis/index.ts` |
<!-- context:manual-end conventions -->

## Commands

<!-- context:generated-start commands -->
Commands are read from manifests. The generator does not execute them; treat every
row as *declared* unless you have run it yourself in this checkout.

### Root scripts (`package.json`)

| Command | Script body |
| --- | --- |
| `pnpm api:update` | `pnpm rebuild && node scripts/api-snapshot.mjs --update` |
| `pnpm build` | `tsc -p tsconfig.json` |
| `pnpm check` | `biome check .` |
| `pnpm clean` | `rm -rf dist coverage` |
| `pnpm clean:all` | `rm -rf node_modules dist coverage test/test-run.log` |
| `pnpm docs:build` | `pnpm --filter anarchon-docs build` |
| `pnpm docs:check` | `pnpm --filter anarchon-docs check:diagrams` |
| `pnpm docs:dev` | `pnpm --filter anarchon-docs dev` |
| `pnpm docs:preview` | `pnpm --filter anarchon-docs preview` |
| `pnpm example` | `tsx examples/basic.ts` |
| `pnpm example:api` | `tsx examples/http-api.ts` |
| `pnpm example:billing` | `tsx examples/billing.ts` |
| `pnpm example:brokers` | `tsx examples/broker-notifications.ts` |
| `pnpm example:cache` | `tsx examples/cache-refresh.ts` |
| `pnpm example:clients` | `tsx examples/own-clients.ts` |
| `pnpm example:decorators` | `tsx examples/decorators.ts` |
| `pnpm example:decorators:legacy` | `TSX_TSCONFIG_PATH=examples/tsconfig.legacy.json tsx examples/decorators…` |
| `pnpm example:decorators:options` | `tsx examples/decorators-options.ts` |
| `pnpm example:decorators:startup` | `tsx examples/decorators-startup.ts` |
| `pnpm example:export` | `tsx examples/nightly-export.ts` |
| `pnpm example:failover` | `tsx examples/failover.ts` |
| `pnpm example:options` | `tsx examples/options-and-events.ts` |
| `pnpm example:run-data` | `tsx examples/run-data.ts` |
| `pnpm example:tenants` | `tsx examples/tenants.ts` |
| `pnpm example:walkthrough` | `tsx examples/walkthrough.ts` |
| `pnpm format` | `biome check --write .` |
| `pnpm lint` | `tsc -p tsconfig.test.json` |
| `pnpm prepublishOnly` | `pnpm rebuild` |
| `pnpm rebuild` | `pnpm clean && pnpm build` |
| `pnpm scenarios` | `tsx test/e2e/scenarios/report.ts stream-id lease postgres sqlite` |
| `pnpm test` | `vitest --config test/vitest.config.mts run --exclude 'test/e2e/**'` |
| `pnpm test:all` | `vitest --config test/vitest.config.mts run` |
| `pnpm test:all:full` | `vitest --config test/vitest.config.mts run --coverage --coverage.report…` |
| `pnpm test:coverage` | `vitest --config test/vitest.config.mts run --coverage --coverage.report…` |
| `pnpm test:last:fails` | `node scripts/test-log.mjs fails` |
| `pnpm test:last:log` | `less -R test/test-run.log` |
| `pnpm test:last:review` | `node scripts/test-log.mjs review` |
| `pnpm test:release` | `pnpm rebuild && node scripts/api-snapshot.mjs --check && node scripts/r…` |
| `pnpm test:servers` | `docker compose -f test/docker-compose.test.yml up -d --wait` |
| `pnpm test:servers:down` | `docker compose -f test/docker-compose.test.yml --profile '*' down` |
| `pnpm test:slow` | `vitest --config test/vitest.config.mts run test/e2e` |
| `pnpm test:watch` | `vitest --config test/vitest.config.mts --exclude 'test/e2e/**'` |
| `pnpm typecheck` | `tsc -p tsconfig.test.json` |
| `pnpm verify:all` | `pnpm test:servers && pnpm lint && pnpm check && pnpm test:all && pnpm t…` |

### Workspace scripts

Workspaces with the same scripts share a row.

| Workspaces | Scripts |
| --- | --- |
| `docs` | `build`, `check`, `check:diagrams`, `dev`, `preview` |
| `examples/nestjs` | `start`, `start:nest11`, `test` |

### Context-management commands

| Command | Purpose |
| --- | --- |
| `python3 scripts/update-claude-snapshot.py` | Regenerate this map. |
| `python3 scripts/update-claude-snapshot.py --check` | Fail if the committed map is stale. |
| `python3 scripts/validate-claude-context.py` | Run all context checks. |
<!-- context:generated-end commands -->

## Testing Strategy

<!-- context:manual-start testing-strategy -->
*Manual section: the generator never overwrites it.*

- **Framework**: Vitest (`test/vitest.config.mts`), files run one at a time
  (`fileParallelism: false`) because several measure timing; coverage with v8 over
  `src/**/*.ts`, no thresholds.
- **Layout**: `test/unit`, `test/scheduler`, `test/backends`, `test/leases`, `test/e2e`,
  `test/support`; see `CLAUDE.md`, Tests.
- **Servers**: real servers from `test/docker-compose.test.yml` (`pnpm test:servers`); a
  missing server skips its tests, so read the skip count. `REQUIRE_SERVERS` names servers a
  run must have (`test/support/require-servers.ts`, a Vitest global setup).
- **CI** (`.github/workflows/ci.yml`): checks and docs build; tests on Node 22 and 24 (Vitest
  needs Node 22.12); brokers; `test/e2e`; the release check; and
  `scripts/consumer-smoke.mjs`, which installs the tarball and runs a job on Node 20, 22 and 24.
- **Release**: `pnpm test:release` packs, installs and loads the tarball through
  `require()`, `import` and Bun.
- **Example**: `pnpm --filter anarchon-example-nestjs test` checks the NestJS example on
  NestJS 11 and 12.
<!-- context:manual-end testing-strategy -->

## Security and Operational Notes

<!-- context:manual-start security-notes -->
*Manual section: the generator never overwrites it. Names and mechanisms only; never a
secret value.*

- The library takes connections and credentials through options only; tests and examples
  read them from environment variables by name (`REDIS_URL`, `DATABASE_URL`,
  `LIBSQL_AUTH_TOKEN`, ...).
- `.env*` files are gitignored and never read into context files.
<!-- context:manual-end security-notes -->

## Important Gotchas

<!-- context:manual-start gotchas -->
*Manual section: the generator never overwrites it. Every entry cites a source.*

- **The environment variable list includes JSDoc examples.** Names such as `POD_NAME`,
  `REDIS_PASSWORD`, `CRON_STRATEGY` and `JOB_TIMEOUT` appear only in `@example` blocks across
  `src/` (the public API's examples read credentials from `process.env`); the library itself
  reads no environment.
- **The root is a workspace package.** `pnpm-workspace.yaml` lists `.`, so the map's
  workspace table shows the published package as `.`.
- **`test:all:full` pipes through `tee`.** Its exit status does not prove success; use
  `pnpm test:last:review` (`package.json`).
- **No test uses ports 6379 or 5432.** The test Redis and Postgres run on 6381 and 5433
  (`test/docker-compose.test.yml`).
<!-- context:manual-end gotchas -->

## Snapshot Metadata

<!-- context:generated-start metadata -->
- Generated at: 2026-10-18T12:59:40Z
- Git commit: 5d20b08dfe8e2c8effce1aa9a56781e195eb0e20
- Git branch: release-0.4.0b
- Uncommitted changes when generated: no
- Generator: `scripts/update-claude-snapshot.py` version 1.0.0
- Snapshot status: generated by structural inspection only; no code executed
- Files inspected: 231
- Included top-level directories: `.claude`, `.github`, `api`, `assets`, `docs`, `examples`, `scripts`, `src`, `test`
- Excluded directory names: `.cache`, `.git`, `.gradle`, `.idea`, `.mypy_cache`, `.next`, `.nuxt`, `.parcel-cache`, `.pnpm-store`, `.pytest_cache`, `.ruff_cache`, `.svelte-kit`, `.terraform`, `.tmp`, `.tox`, `.turbo`, `.venv`, `.vscode`, `__pycache__`, `bower_components`, `build`, `coverage`, `dist`, `node_modules`, `out`, `target`, `vendor`, `venv`, `virtualenv`
- Excluded file patterns: `.env`, `.env.*`, `*.env`, `*.pem`, `*.key`, `*.pfx`, `*.p12`, `*.jks`, `*.keystore`, `id_rsa*`, `id_ed25519*`, `*credentials*`, `*.secret`, `secrets.*`

The four volatile fields above (timestamp, commit, branch, dirty flag) are ignored by
`--check`, so routine commits do not mark the map stale; structural drift does.
<!-- context:generated-end metadata -->
