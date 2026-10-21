/* Copyright (C) 2026-present Aristotelis — see repository license. */

import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  Injectable,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Scheduler, SqliteBackend } from 'anarchon';

import {
  AuditService,
  ForgottenService,
  InvoicesService,
  Mailer,
  ReportsService,
} from './jobs';

/** Starts the scheduler when every provider exists, and stops it when the app shuts down. */
@Injectable()
class SchedulerLifecycle
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  constructor(private readonly scheduler: Scheduler) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.scheduler.start();
    console.log(
      `jobs: ${this.scheduler
        .jobs()
        .map((job) => job.name)
        .join(', ')}`,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.scheduler.stop();
    console.log('stopped');
  }
}

@Module({
  providers: [
    {
      // The first scheduler created is the default one: decorated providers add their jobs to it.
      provide: Scheduler,
      useFactory: () =>
        new Scheduler({
          backend: new SqliteBackend({
            database:
              process.env.SQLITE_FILE ??
              join(tmpdir(), 'anarchon-nestjs-example.db'),
          }),
        }),
    },
    SchedulerLifecycle,
    Mailer,
    ReportsService,
    AuditService,
    InvoicesService,
    ForgottenService,
  ],
})
export class AppModule {}
