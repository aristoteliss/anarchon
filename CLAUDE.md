# CLAUDE.md

anarchon is a published library: leaderless cron for Node.js clusters on Redis/Valkey, PostgreSQL,
SQLite, RabbitMQ and NATS. [AGENTS.md](AGENTS.md) holds the full rules, commands and procedures,
and wins over this file. Keep this file under 40 lines.

Before a large task, and again after compaction, read [AGENTS.md](AGENTS.md), then
[.claude/codebase-map.md](.claude/codebase-map.md) (an index; the code wins when they disagree),
then the active task file under `.claude/tasks/`, if the task has one.

## Rules

1. Before writing, refactoring or reviewing code in `src/` or `examples/`, load the
   `readable-code` skill ([.claude/skills/readable-code/SKILL.md](.claude/skills/readable-code/SKILL.md)).
2. Functions stay within 40 lines, 3 nesting levels and 4 positional parameters. Checks run before
   any write, decisions take `now`, input objects are destructured once, and a line holds one step.
3. No interface, base class or layer without two implementations today, unless it belongs to the
   published backend contract.
4. Every `throw` in `src/` uses `coded(...)` with an `ANARCHON_*` code.
5. Fix a bug by first writing a test that reproduces it. Add no production code for tests.
6. Record public API changes with `pnpm api:update`; removing or renaming an export is breaking.
7. `src/` reads no environment variables. No secrets in any file.
8. No narration comments, banners or ticket ids; comments state concurrency or protocol constraints.
9. pnpm only. Commit only after asking, never on `main`, and with no AI attribution.
10. Track multi-step work in a task file under `.claude/tasks/` (procedure in AGENTS.md).

## Commands

| Purpose | Command |
| --- | --- |
| Start the test servers (Docker) | `pnpm test:servers` |
| One test file | `pnpm test test/leases/rules.test.ts` |
| Tests without `test/e2e`; e2e only; all | `pnpm test`; `pnpm test:slow`; `pnpm test:all` |
| Type check (src, test, examples) | `pnpm lint` |
| Lint and format check; fix (Biome) | `pnpm check`; `pnpm format` |
| Public API and tarball check | `pnpm test:release` |

Before reporting work as done, run the narrowest test file, then `pnpm lint`, `pnpm check` and
`pnpm test`, and read the skip count: a backend whose server is down is skipped, not passed.
