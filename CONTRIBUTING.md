# Contributing

Bug reports and questions go to the [issue tracker](https://github.com/aristoteliss/anarchon/issues).
For a bug, use the bug report form: it asks for the versions, the backend and a minimal
reproduction. Never paste credentials or connection strings.

Before a larger change, open an issue to agree on it first.

## Setup

anarchon uses pnpm; npm and yarn are not supported in this repository.

```sh
pnpm install
pnpm test:servers                           # Redis 8.6, Redis 7.0, Valkey, PostgreSQL, libSQL (Docker)
COMPOSE_PROFILES=brokers pnpm test:servers  # also RabbitMQ and NATS
```

The tests run against real servers. A server that isn't running skips its tests, so name the
servers a run must have: `REQUIRE_SERVERS=redis,postgres pnpm test`. The README's
[Tests](README.md#tests) section lists the servers, their URLs and the variables that
override them.

## Before a pull request

```sh
pnpm check     # format and lint (Biome); pnpm format fixes what it can
pnpm lint      # type checks: src, test, examples
pnpm test      # every test except test/e2e
pnpm test:slow # test/e2e: cluster and failure scenarios with real processes
```

- Fix a bug by first adding a test that reproduces it.
- A change to behavior or to the public API needs an entry in `CHANGELOG.md`, and its
  documentation page in English and in Greek. The documentation is its own repository,
  [anarchon-docs](https://github.com/aristoteliss/anarchon-docs), checked out at `docs/` as a
  submodule: run `git submodule update --init` once, change the pages in `docs/src/content/docs/`
  and `docs/src/content/docs/el/`, and open the pull request in anarchon-docs. Check it with
  `pnpm docs:install`, `pnpm docs:check` and `pnpm docs:build`.
- A change to the public API needs `pnpm api:update`: it records the new declarations in
  `api/anarchon.api.txt`, and `pnpm test:release` fails while they differ. Review that diff:
  removing or renaming anything users or custom backends rely on is a breaking change.
- A new option goes in its `keysOf` list (`src/option-keys.ts`, or next to its interface), or it
  is refused at runtime as unknown. A new error is thrown with a code (`coded()`, `src/errors.ts`).
- Comments explain non-obvious concurrency or protocol constraints only.

## Compatibility

anarchon is extended without breaking the apps and the custom backends built on it. A change that
breaks one of these rules is a breaking change: it waits for a major release and goes under
"Breaking" in the changelog.

- **Public API.** Every intended change to what `src/index.ts` exports is recorded with
  `pnpm api:update`, and the diff of `api/anarchon.api.txt` is reviewed. `pnpm test:release` fails
  on an unrecorded change. Removing or renaming an export, a member or an option is breaking.
- **The backend contract** (`Backend`, `RunStore`, `SqlDialect`) is implemented outside this
  repository. A new member is optional, with a fallback in the scheduler for backends without it.
  A new method takes one object parameter, so it can grow; the positional parameters of the
  existing methods stay until a major release.
- **Types that backends produce and users read** (`RunRecord`, `StoredResult`, `ClaimOutcome`):
  a new field is optional. Backends build history with `buildHistory()`, so new fields reach them
  without changes.
- **Unions may grow:** `RunReason`, `RunStatus`, the `SkipEvent` reasons, `JobInfo.type`,
  `ClaimOutcome` kinds and `ErrorCode` may gain members in a minor release; their JSDoc says so.
  The scheduler handles a claim outcome it doesn't know like `'done'`.
- **Stored data.** Two versions of one major run side by side on one store during a rolling deploy.
  Add fields, never rename or remove them; read them with a default (`run.m or maxAttempts`);
  scripts update a stored object instead of rebuilding it, so fields a newer version wrote survive.
  A new SQL column comes with a migration in `init()` that checks for the column first (PostgreSQL
  9.5 has no `ADD COLUMN IF NOT EXISTS`). Raise `STORE_FORMAT` (`src/store-format.ts`) only for a
  change older versions can't read or would damage; that needs every instance stopped, and the
  changelog says so.
- **Options.** A new option goes in its `keysOf` list (`src/option-keys.ts` or next to its
  interface), or it is refused at runtime. An option a backend can't honour is refused, never
  ignored: absent from the types where the backend is known, and a `TypeError` elsewhere.
- **Errors.** Every thrown error has an `ErrorCode`; codes are stable, messages may be reworded.
  A new kind of failure gets a new code.
- **Dependencies.** `croner` decides run times, and every instance of a service must compute the
  same ones: a change of its major version, or of how anarchon calls it, is a breaking change.

CI runs the same commands on every pull request (`.github/workflows/ci.yml`).
