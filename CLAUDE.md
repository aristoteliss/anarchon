# CLAUDE.md

Working instructions for coding agents, loaded every session. Keep it under 16 KB (the
validator checks). `AGENTS.md` holds the full rules and wins over this file.

anarchon is a published library: leaderless cron for Node.js clusters on Redis/Valkey,
PostgreSQL, SQLite, RabbitMQ and NATS.

- `src/index.ts`: the public API. Each backend lives under `src/backends/`.
- `src/scheduler/scheduler.ts`: the `Scheduler` class, public API and lifecycle only. Its parts
  are beside it: `job.ts` (validation), `timers.ts` (when a run is due), `lease-runner.ts` and
  `claim-only-runner.ts` (claiming a run), `executor.ts` (running the handler and recording the
  result), `data.ts` (builds `ctx.data` for a run), `options.ts` (checks the options of `new Scheduler()`).
- `src/decorators.ts`: `@Cron`, `@Every`, `@At` and `@Scheduled`.
- `src/registry.ts`: which schedulers exist (default, named, created from `Scheduler.configure()`
  settings) and where each decorated object's jobs live.

## Read order

Before a large task, and again after compaction or when uncertain:

1. `CLAUDE.md`.
2. [AGENTS.md](AGENTS.md): working discipline and non-negotiable repository rules. It wins
   over anything here.
3. [.claude/codebase-map.md](.claude/codebase-map.md): shape, stack, entry points,
   directories, commands, gotchas.
4. The active task file under `.claude/tasks/`, if the task has one.
5. The nested `CLAUDE.md` of the directory you are editing, if one exists.

## Using the codebase map

- It is a **compact orientation map, not a replacement for reading source**. Use it to find
  where to look, then open the actual files.
- **Verify before relying on it.** Confirm any claim that drives a change against the source
  file it names. When the map, a README or a summary disagrees with the code, the code wins;
  fix the map afterwards.
- Sections wrapped in `context:generated-*` markers are machine-written and rewritten on every
  regeneration. Sections wrapped in `context:manual-*` markers are human-owned and preserved;
  edit those by hand.

Explore in this order:

1. The map's Repository Shape, Directory Map and Critical Modules.
2. The nested `CLAUDE.md` files and the documentation of the area in scope.
3. Only the modules and symbols the task touches, plus their direct callers and tests.

Do not scan the whole repository. A repo-wide sweep needs an explicit reason (a rename, a
contract audit, a security review); say what it is before doing one.

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
| Full run with coverage, saved to `test/test-run.log` | `pnpm test:all:full` |
| Summary of the last full run | `pnpm test:last:review` |
| Failures of the last full run | `pnpm test:last:fails` |
| Type checks (src, test, examples) | `pnpm lint` |
| Format and lint (Biome) | `pnpm check`, `pnpm format` |
| Build | `pnpm build` |
| Clean build (also before publishing) | `pnpm rebuild` |
| Remove build output (`clean:all` also node_modules) | `pnpm clean`, `pnpm clean:all` |
| Pack, install and load the published tarball; check the API snapshot | `pnpm test:release` |
| Record an intended change of the public API (`api/anarchon.api.txt`) | `pnpm api:update` |
| Everything before a release | `pnpm verify:all` |
| Failure scenarios, side by side | `pnpm scenarios` |
| Documentation site (Astro Starlight, in `docs/`) | `pnpm docs:dev`, `pnpm docs:build` |
| Check that every docs diagram parses | `pnpm docs:check` |
| Regenerate the codebase map | `python3 scripts/update-claude-snapshot.py` |
| Check the map is current | `python3 scripts/update-claude-snapshot.py --check` |
| Validate all context files | `python3 scripts/validate-claude-context.py` |

Run the narrowest relevant test file first, then `pnpm lint`, `pnpm check` and the full
`pnpm test` before reporting work as done.

## Tests

Layout, by what a test needs:

- `test/unit/`: pure logic, no server.
- `test/scheduler/`: the public API, on the main Redis.
- `test/backends/`: `contract` (the same checks on every backend), then what is specific to `redis`,
  `sql` (Postgres, SQLite) and `brokers` (RabbitMQ, NATS).
- `test/leases/`: the lease `rules` on each lease backend, and the `scheduler` on top of them.
- `test/e2e/`: real child processes, slow. `cluster/` (3 instances per backend), `scenarios/`
  (kill, freeze, restart) and `decorators/` (decorator syntax compiled in both styles).
- `test/support/`: `servers` (URLs and probes), `specs` (one spec per backend to test), `util`.
- `test/vitest.config.mts`, `test/docker-compose.test.yml` and `test/test-run.log` (ignored by git)
  live in `test/` too. The scripts pass the config; a bare `vitest` needs
  `--config test/vitest.config.mts`.
- `examples/nestjs/`: one NestJS app in a workspace package of its own, with its own TypeScript and
  Biome settings. `pnpm --filter anarchon-example-nestjs test` checks it on NestJS 11 and 12.
  Nothing specific to NestJS belongs in `src/`, in the root config files or in `test/`. The root
  type check covers `examples/*.ts` only; a folder under `examples/` is a package with its own config.

How they run:

- Vitest runs against real servers. A server that is not running makes its tests skip, so
  a green run can still hide skipped backends: read the skip count, or name the servers a run
  must have in `REQUIRE_SERVERS` (`test/support/require-servers.ts`), as every CI job does.
- The servers, their default URLs and the environment variables that override them are
  listed in the README's Tests section.
- `test/docker-compose.test.yml` runs every server on the default URLs; Redis 8.6 and Postgres use
  6381 and 5433 so a Redis or Postgres on the usual ports is never touched. No test uses 6379 or
  5432: a scheduler has no default backend, so `backend` is always given.
- `LIBSQL_URL` and `LIBSQL_AUTH_TOKEN` point the libSQL server tests at another server, such as
  Turso. The token is read from the environment only.
- Each test uses its own Redis key prefix (`test:<id>:`) or table (`t_<id>`); tests never
  flush or drop data, but they leave keys and tables behind.
- Test files run one at a time (`fileParallelism: false`): several measure timing.
- The cluster and scenario tests start child processes with `tsx`
  (`test/e2e/cluster/instance.ts`, `test/e2e/scenarios/instance.ts`).
- `test:all:full` pipes through `tee`, so its exit status does not prove success; use
  `pnpm test:last:review`.

## Task files

For any task that is large, multi-step, or likely to span sessions, create
`.claude/tasks/<task-id>.md` from [.claude/tasks/TEMPLATE.md](.claude/tasks/TEMPLATE.md).
Git ignores everything in `.claude/tasks/` except the template, so task files stay local.

- Use a short, stable, descriptive task id (`lease-renew-retry`, not `fix-1`).
- Update it after each meaningful milestone: status, decisions, modified files,
  verification results, next steps.
- Record what was *verified*, not what was intended. Name commands and their outcome.
- Never put secrets, credentials, tokens, customer data or personal information in a task
  id or a task file.
- A task file is for active work. When the task is done, move anything durable to the place
  that owns it (source, a documentation page or the README), then delete the file.

## Keeping the map current

Propose a map update, never silently skip it, when a change affects architecture, module
responsibilities, dependencies, entry points, commands, or repository conventions.

1. Run `python3 scripts/update-claude-snapshot.py` (regenerates the generated sections only).
2. Hand-edit the manual sections that the change invalidates (Architecture, Critical
   Modules, Conventions, Testing Strategy, Security and Operational Notes, Gotchas).
3. Run `python3 scripts/validate-claude-context.py`.
4. Mention the map change in your summary so the owner can review it.

## Rules

The ones that apply in every session; `AGENTS.md` has the rest.

- Commit only after asking, and never directly on `main`.
- Commit messages and pull requests carry no AI attribution: no `Co-Authored-By` trailer
  for an AI and no "Generated with" line.
- No secrets in any committed file or context file (code, tests, docs, the map, task files):
  not passwords, tokens, private keys or connection strings with credentials. Environment
  variable names are fine; values come from the environment. `.env*` files are never read
  into context files.
- Fix a bug by first writing a test that reproduces it.
- No narration comments, decorative banners or ticket identifiers in code or test names.
  Comments explain non-obvious concurrency or protocol constraints only.
