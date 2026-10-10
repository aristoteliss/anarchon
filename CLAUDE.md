# CLAUDE.md

Working instructions for coding agents in this repository. Keep this file short.

anarchon is a published library: leaderless cron for Node.js clusters on Redis/Valkey,
PostgreSQL, SQLite, RabbitMQ and NATS. The public API is exported from `src/index.ts`;
each backend lives under `src/backends/`. The `Scheduler` class (`src/scheduler/scheduler.ts`) is the
public API and lifecycle only; its parts are beside it: `job.ts` (validation), `timers.ts` (when a
run is due), `lease-runner.ts` and `claim-only-runner.ts` (claiming a run), `executor.ts` (running the
handler and recording the result).

## Commands

Use these scripts. Use pnpm only, never npm or yarn.

| Purpose | Command |
| --- | --- |
| Install | `pnpm install` |
| Start every test server (Docker) | `pnpm test:servers` (`COMPOSE_PROFILES=brokers` adds RabbitMQ and NATS) |
| Stop them and drop their data | `pnpm test:servers:down` |
| Tests, without the slow `test/e2e` files (about 2 min) | `pnpm test` |
| The `test/e2e` files only (cluster and failure scenarios) | `pnpm test:slow` |
| Every test | `pnpm test:all` |
| One test file | `pnpm test test/leases/rules.test.ts` |
| Tests in watch mode | `pnpm test:watch` |
| Coverage summary (text and `coverage/coverage-summary.json`) | `pnpm test:coverage` |
| Full run with coverage, saved to `test-run.log` | `pnpm test:all:full` |
| Summary of the last full run | `pnpm test:last:review` |
| Failures of the last full run | `pnpm test:last:fails` |
| Type checks (src, test, examples) | `pnpm lint` |
| Format and lint (Biome) | `pnpm check`, `pnpm format` |
| Build | `pnpm build` |
| Clean build (also before publishing) | `pnpm rebuild` |
| Remove build output (`clean:all` also node_modules) | `pnpm clean`, `pnpm clean:all` |
| Pack, install and load the published tarball | `pnpm test:release` |
| Everything before a release | `pnpm verify:all` |
| Failure scenarios, side by side | `pnpm scenarios` |
| Documentation site (Astro Starlight, in `docs/`) | `pnpm docs:dev`, `pnpm docs:build` |
| Check that every docs diagram parses | `pnpm docs:check` |

Run the narrowest relevant test file first, then `pnpm lint`, `pnpm check` and the full
`pnpm test` before reporting work as done.

## Tests

Layout, by what a test needs:

- `test/unit/`: pure logic, no server.
- `test/scheduler/`: the public API, on the main Redis.
- `test/backends/`: `contract` (the same checks on every backend), then what is specific to `redis`,
  `sql` (Postgres, SQLite) and `brokers` (RabbitMQ, NATS).
- `test/leases/`: the lease `rules` on each lease backend, and the `scheduler` on top of them.
- `test/e2e/`: real child processes, slow. `cluster/` (3 instances per backend) and `scenarios/`
  (kill, freeze, restart).
- `test/support/`: `servers` (URLs and probes), `specs` (one spec per backend to test), `util`.

- Vitest runs against real servers. A server that is not running makes its tests skip, so
  a green run can still hide skipped backends: read the skip count.
- The servers, their default URLs and the environment variables that override them are
  listed in the README's Tests section.
- `docker-compose.test.yml` runs every server on the default URLs; Redis 8.6 and Postgres use
  6381 and 5433 so a Redis or Postgres on the usual ports is never touched. Only the test
  "defaults to localhost:6379" uses 6379, and it skips when nothing listens there.
- `LIBSQL_URL` and `LIBSQL_AUTH_TOKEN` point the libSQL server tests at another server, such as
  Turso. The token is read from the environment only.
- Each test uses its own Redis key prefix (`test:<id>:`) or table (`t_<id>`); tests never
  flush or drop data, but they leave keys and tables behind.
- Test files run one at a time (`fileParallelism: false`): several measure timing.
- The cluster and scenario tests start child processes with `tsx`
  (`test/e2e/cluster/instance.ts`, `test/e2e/scenarios/instance.ts`).
- `test:all:full` pipes through `tee`, so its exit status does not prove success; use
  `pnpm test:last:review`.

## Rules

- Commit only after asking, and never directly on `main`.
- Commit messages and pull requests carry no AI attribution: no `Co-Authored-By` trailer
  for an AI and no "Generated with" line.
- Never place passwords, tokens or connection strings with credentials in code, tests,
  this file or any other committed file. Environment variable names are fine; pass the
  values through the environment.
- Fix a bug by first writing a test that reproduces it.
- No narration comments, decorative banners or ticket identifiers in code or test names.
  Comments explain non-obvious concurrency or protocol constraints only.
