---
title: NestJS
description: A scheduler as a NestJS provider, started and stopped with the application, with jobs registered by feature services.
---

In NestJS the scheduler fits naturally as a provider. One module creates it and ties it to the application's lifecycle; feature services inject it and register their own jobs.

:::note
`@nestjs/schedule` runs every `@Cron()` method in **every** instance. anarchon is what you reach for when the app runs as more than one instance and a job must run once.
:::

## The module

```ts
// cron/cron.module.ts
import { Global, Injectable, Module, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Scheduler } from 'anarchon';

/** Starts the scheduler when the app is ready, and stops it when the app shuts down. */
@Injectable()
class CronLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(private readonly scheduler: Scheduler) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.scheduler.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.scheduler.stop({ timeoutMs: 20_000 });
  }
}

@Global()
@Module({
  providers: [
    {
      provide: Scheduler,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Scheduler({
          redis: config.getOrThrow<string>('REDIS_URL'),
          prefix: 'billing:cron:',
          instanceId: config.get<string>('POD_NAME'),
          timezone: 'Europe/Athens',
        }),
    },
    CronLifecycle,
  ],
  exports: [Scheduler],
})
export class CronModule {}
```

## Registering jobs in a feature service

Register jobs in `onModuleInit`. NestJS calls it on every provider before `onApplicationBootstrap`, so all jobs exist by the time the scheduler starts.

```ts
// invoices/invoices.service.ts
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { type JobContext, Scheduler } from 'anarchon';

@Injectable()
export class InvoicesService implements OnModuleInit {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(private readonly scheduler: Scheduler) {}

  onModuleInit(): void {
    this.scheduler.cron('monthly-invoices', '0 6 1 * *', (ctx) => this.buildInvoices(ctx), {
      timeoutMs: 30 * 60_000,
      catchUpMs: 6 * 60 * 60_000,
    });
  }

  private async buildInvoices(ctx: JobContext): Promise<void> {
    this.logger.log(`building invoices for ${ctx.scheduledAt.toISOString()} (attempt ${ctx.attempt})`);
    for (const customer of await this.customers()) {
      ctx.signal.throwIfAborted();
      await this.createInvoice(customer, ctx.slot); // idempotent on (customer, slot)
    }
  }

  // ...
}
```

Use an arrow function, as above, so `this` stays the service inside the handler.

## Enable shutdown hooks

NestJS only calls `onApplicationShutdown` if shutdown hooks are enabled. Without this line, `SIGTERM` kills the process without handing running jobs over:

```ts
// main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(3000);
}
bootstrap();
```

## The lifecycle, in order

```mermaid
sequenceDiagram
  participant N as NestJS
  participant F as Feature services
  participant L as CronLifecycle
  participant S as Scheduler
  N->>F: onModuleInit()
  F->>S: cron(...), every(...)
  N->>L: onApplicationBootstrap()
  L->>S: start()
  Note over S: running
  N-->>N: SIGTERM
  N->>L: onApplicationShutdown()
  L->>S: stop()
  Note over S: running jobs are handed over
```

## Logging through Nest

```ts
import { Logger } from '@nestjs/common';

const logger = new Logger('Cron');

new Scheduler({
  redis: config.getOrThrow<string>('REDIS_URL'),
  log: true,
  logger: {
    info: (message) => logger.log(message),
    warn: (message) => logger.warn(message),
    error: (message) => logger.error(message),
  },
});
```

## Events as providers

For alerts and metrics, subscribe in a service of its own:

```ts
@Injectable()
export class CronAlerts implements OnModuleInit {
  constructor(
    private readonly scheduler: Scheduler,
    private readonly alerts: AlertsService,
  ) {}

  onModuleInit(): void {
    this.scheduler.on('failure', (run) => {
      void this.alerts.send(`${run.job} failed on ${run.instanceId}: ${run.error}`);
    });
  }
}
```

## An admin controller

```ts
import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Scheduler } from 'anarchon';

@Controller('jobs')
@UseGuards(AdminGuard)
export class JobsController {
  constructor(private readonly scheduler: Scheduler) {}

  @Get()
  list() {
    return this.scheduler.jobs();
  }

  @Get(':name/runs')
  runs(@Param('name') name: string, @Query('limit') limit = '20') {
    return this.scheduler.history(name, Number(limit));
  }

  @Post(':name/run')
  run(@Param('name') name: string) {
    return this.scheduler.runNow(name);
  }
}
```

## With PostgreSQL and TypeORM or Prisma

If the app has no Redis, use the database it already has. Give anarchon its own small pool rather than sharing the ORM's connection:

```ts
import { PostgresBackend, Scheduler } from 'anarchon';

{
  provide: Scheduler,
  inject: [ConfigService],
  useFactory: (config: ConfigService) =>
    new Scheduler({
      backend: new PostgresBackend({
        connection: config.getOrThrow<string>('DATABASE_URL'),
        table: 'jobs.cron_runs',
      }),
    }),
}
```

## Next

- [Rolling deploys on Kubernetes](../kubernetes/)
- [Writing handlers](../../guides/writing-handlers/)
