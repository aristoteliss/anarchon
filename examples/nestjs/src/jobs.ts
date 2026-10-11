/* Copyright (C) 2026-present Aristotelis — see repository license. */

// NestJS compiles with legacy decorators, where a method decorator can't act when an object is
// created. So each provider below gets its jobs onto the scheduler in one of the two ways there
// are, and the last one in neither, to show what the scheduler says about it.
//
// `Scheduler` and `Mailer` are imported as values, not with `import type`: Nest reads the types of
// constructor parameters at run time to inject them.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Cron, Every, type JobContext, Scheduled, Scheduler } from 'anarchon';

/** Something to inject: it shows that Nest still resolves the dependencies of a class that declares jobs. */
@Injectable()
export class Mailer {
  send(from: string, ctx: JobContext): void {
    console.log(`ran ${ctx.name} in ${from} (attempt ${ctx.attempt})`);
  }
}

/** Decorators only. @Scheduled() makes the provider add its jobs when Nest creates it. */
@Injectable()
@Scheduled()
export class ReportsService {
  constructor(private readonly mailer: Mailer) {}

  @Every('nest-reports-sync', '2s')
  sync(ctx: JobContext): void {
    this.mailer.send('ReportsService', ctx);
  }
}

/** The same with the two class decorators the other way round. */
@Scheduled()
@Injectable()
export class AuditService {
  constructor(private readonly mailer: Mailer) {}

  @Cron('nest-audit', '*/2 * * * * *', { timezone: 'Europe/Athens' })
  audit(ctx: JobContext): void {
    this.mailer.send('AuditService', ctx);
  }
}

/** Without @Scheduled(): the provider registers itself, and the class stays exactly as written. */
@Injectable()
export class InvoicesService implements OnModuleInit {
  constructor(
    private readonly scheduler: Scheduler,
    private readonly mailer: Mailer,
  ) {}

  onModuleInit(): void {
    this.scheduler.register(this);
  }

  @Every('nest-invoices', '2s', { timeoutMs: 1_500 })
  build(ctx: JobContext): void {
    this.mailer.send('InvoicesService', ctx);
  }
}

/** Neither of the two: the job is not added, and the scheduler warns about it when it starts. */
@Injectable()
export class ForgottenService {
  @Every('nest-forgotten', '2s')
  run(): void {
    console.log('never printed');
  }
}
