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

More in the documentation: [NestJS recipe](https://aristoteliss.github.io/anarchon/recipes/nestjs/) and [Decorators](https://aristoteliss.github.io/anarchon/guides/decorators/).
