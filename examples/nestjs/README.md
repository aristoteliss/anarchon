# anarchon in a NestJS app

A very small NestJS application whose providers declare [anarchon](../../README.md) jobs with decorators. It uses only anarchon's public API: there is no adapter package, and the same source runs on NestJS 11 and 12.

From the repository root:

```sh
pnpm install
pnpm --filter anarchon-example-nestjs start          # runs on the installed NestJS (12)
pnpm --filter anarchon-example-nestjs start:nest11   # runs the same source on NestJS 11
pnpm --filter anarchon-example-nestjs test           # checks the app on both
```

It needs no server. The jobs are coordinated through a SQLite file in the temp folder, so two copies of the app started side by side still run each job once. Set `SQLITE_FILE` to use another file. Ctrl+C stops the app cleanly.

## What it shows

NestJS compiles with legacy decorators (`experimentalDecorators`). In that style a method decorator can't act when a provider is created, so a provider gets its jobs onto the scheduler in one of two ways. [src/jobs.ts](src/jobs.ts) has one provider for each case:

| Provider | How its jobs are added |
| --- | --- |
| `ReportsService` | `@Scheduled()` on the class, under `@Injectable()` |
| `AuditService` | `@Scheduled()` on the class, over `@Injectable()` |
| `InvoicesService` | `this.scheduler.register(this)` in `onModuleInit` |
| `ForgottenService` | Neither: the job is not added, and the scheduler warns about it when it starts |

[src/app.module.ts](src/app.module.ts) creates the scheduler as a provider, starts it in `onApplicationBootstrap` and stops it in `onApplicationShutdown`.

## Things to know

- Import the classes Nest injects, such as `Scheduler`, as values. Nest reads the types of constructor parameters at run time, and `import type` removes them. This folder's [biome.json](biome.json) turns off the lint rule that would rewrite those imports.
- Use decorators on singleton providers only. A second object of a decorated class declares the same job names, and its constructor throws.
- Import `Cron` from `anarchon`, not from `@nestjs/schedule`, which runs the method in every instance.

## How the check works

[check.mjs](check.mjs) builds anarchon and the app, runs the app for five seconds in a real Nest container, and checks what each provider did. For NestJS 11 it copies the source into `dist/nest-11` and installs NestJS 11 there, so the same source is type-checked and run against that version.

## Compared with @nestjs/locks when the runner is sick

[locks-comparison/](locks-comparison/) runs the same job, due every 2 s, in two NestJS instances with each library, on the same Redis and with the same 2 s lease. It needs the test Redis from `pnpm test:servers` (`REDIS_URL` overrides it):

```sh
pnpm --filter anarchon-example-nestjs locks:compare   # about a minute
```

Instance A starts first, so `@nestjs/locks` makes it the owner of the job. A healthy instance B joins, and the next five runs are reported. anarchon runs twice: with its defaults, and with `yieldAfterFailure: true`.

| Scenario | anarchon | `@nestjs/locks` (`@OnOneInstance()` and `@WithoutOverlapping()`) | anarchon, `yieldAfterFailure: true` |
| --- | --- | --- | --- |
| Control: A and B are healthy | 5 of 5 succeed | 5 of 5 succeed, all on A | 5 of 5 succeed |
| A throws in every run | The runs B claims succeed (1 to 3 of 5 in our runs) | 0 of 5: every run fails on A, B skips every run | 5 of 5: after A's first failure, B claims every run |
| A never ends a run | A's runs fail after a 1 s `timeoutMs`, and the runs B claims succeed (2 to 5 of 5 in our runs) | 0 of 5: no instance runs the job again | 5 of 5: after A's first timeout, B claims every run |

Why, in `@nestjs/locks` 0.0.4:

- **The owner keeps the job while its process is up.** `@OnOneInstance()` takes a lease on the job and renews it in the background; a failing run does not give it back. Another instance takes over only when the owner stops renewing: it crashed, froze or was restarted.
- **A hung run holds its lock for good.** `@WithoutOverlapping()` renews the run lock while the run lasts, and there is no run timeout, so every later run is skipped on every instance until the owner's process dies. Without `@WithoutOverlapping()`, runs pile up on the owner instead.
- **The Redis store is yours.** The package ships only `InMemoryLockStore` (`pnpm locks:stores` prints it). [redis-lock.store.ts](locks-comparison/redis-lock.store.ts) and [redis.module.ts](locks-comparison/redis.module.ts) are copied from the test fixtures of the nestjs/locks repository: Lua scripts, a fencing counter that needs Redis persistence, and a client to wire up. PostgreSQL needs a table, a sequence and their migrations.

What anarchon does not do either:

- By default it does not avoid a failing instance: each run goes to whichever instance claims it first, so a sick A still fails the runs it claims. With `yieldAfterFailure: true`, an instance whose last run failed waits until `slot + jitterMs + heartbeatMs` before claiming, so a healthy instance claims first; A's first failed run is still lost.
- A run that throws is not retried on another instance.
- `timeoutMs` marks a hung run failed and lets the next runs go ahead, but it does not stop the handler: a handler that ignores `ctx.signal` keeps its resources.

More in the documentation: [NestJS recipe](https://aristoteliss.github.io/anarchon/recipes/nestjs/) and [Decorators](https://aristoteliss.github.io/anarchon/guides/decorators/).
