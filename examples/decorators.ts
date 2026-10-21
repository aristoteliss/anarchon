/* Copyright (C) 2026-present Aristotelis — see repository license. */

/**
 * Jobs declared with decorators on the methods of a class, in the standard decorator style: what
 * TypeScript 5+ compiles with no flag. No framework is involved and nothing registers the class:
 * creating a `Reports` object adds its jobs to the scheduler. Start it in 2 or 3 terminals:
 *
 *   npx tsx examples/decorators.ts
 *   BACKEND=redis npx tsx examples/decorators.ts
 *
 * Each run still happens on one instance only. For a project that sets `experimentalDecorators`
 * (NestJS, Angular), see decorators-legacy.ts.
 */
import { At, Cron, Every, type JobContext, Scheduler } from '../src';
import { backendFromEnv, say, sleep, work } from './shared';

class Mailer {
  async send(subject: string): Promise<void> {
    await sleep(100);
    say(`mail sent: ${subject}`);
  }
}

class Reports {
  sent = 0;

  constructor(private readonly mailer: Mailer) {}

  @Every('sync', '10s')
  async sync(ctx: JobContext) {
    await this.mailer.send(
      `sync of ${ctx.scheduledAt.toISOString()} (${++this.sent} sent by this instance)`,
    );
  }

  @Cron('half-minute-digest', '*/30 * * * * *', { timezone: 'Europe/Athens' })
  async digest() {
    await this.mailer.send('digest');
  }

  // No name given: the job is called 'Reports-export'. Renaming the class or the method renames the job.
  @Every('1m', { timeoutMs: 45_000, maxAttempts: 2 })
  async export(ctx: JobContext) {
    await work(ctx.signal, 5_000);
  }

  // An absolute time that every instance computes the same way, so the cluster has one slot for the job.
  @At('next-full-minute', new Date(Date.now() - (Date.now() % 60_000) + 60_000))
  async nextFullMinute() {
    say('a one-off job: at the next full minute, on one instance');
  }
}

async function main() {
  // The first scheduler created is the default one: decorated objects add their jobs to it.
  const scheduler = new Scheduler({
    backend: backendFromEnv('decorators'),
    log: true,
  });
  // One object per class: a second `new Reports()` would throw 'Job "sync" is already registered'.
  const reports = new Reports(new Mailer());

  await scheduler.start();
  say(`started as ${scheduler.instanceId} on ${scheduler.backend.name}`);
  for (const job of scheduler.jobs()) {
    say(`  ${job.name.padEnd(22)} ${job.schedule}`);
  }

  const shutdown = async () => {
    await scheduler.stop();
    say(`stopped (${reports.sent} syncs sent)`);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
