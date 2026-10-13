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
- A change to behavior or to the public API needs its documentation page, in English and
  in Greek (`docs/src/content/docs/` and `docs/src/content/docs/el/`), and an entry in
  `CHANGELOG.md`.
- A change to the documentation needs `pnpm docs:check` and `pnpm docs:build`.
- Comments explain non-obvious concurrency or protocol constraints only.

CI runs the same commands on every pull request (`.github/workflows/ci.yml`).
