/* Copyright (C) 2026-present Aristotelis — see repository license. */

/**
 * The jobs of decorators.ts in the legacy decorator style: what TypeScript compiles with
 * `"experimentalDecorators": true`, the setting NestJS and Angular projects use.
 *
 *   TSX_TSCONFIG_PATH=examples/tsconfig.legacy.json npx tsx examples/decorators-legacy.ts
 *
 * A legacy decorator can't run code when an object is created, so the jobs of a class are added in
 * one of two ways:
 *
 *   - `@Scheduled()` on the class: its objects add their jobs by themselves (Reports), or
 *   - `scheduler.register(object)`: you add them (Cleanup).
 *
 * With neither, the jobs are not added, and the scheduler says so when it starts. Both ways are
 * harmless with standard decorators, so this file runs in either style.
 */
import { Cron, Every, type JobContext, Scheduled, Scheduler } from '../src';
import { backendFromEnv, say, sleep } from './shared';

// A legacy decorator is called with (target, key, descriptor); a standard one with (method, context).
let style = 'standard';
const detectStyle = (...args: unknown[]): void => {
  if (args.length === 3) style = 'legacy';
};

@Scheduled()
class Reports {
  sent = 0;

  @Every('sync', '10s')
  async sync(ctx: JobContext) {
    await sleep(100);
    say(
      `sync of ${ctx.scheduledAt.toISOString()} (${++this.sent} run by this instance)`,
    );
  }

  @Cron('half-minute-digest', '*/30 * * * * *', { timezone: 'Europe/Athens' })
  async digest() {
    say('digest sent');
  }

  @detectStyle
  notAJob() {}
}

class Cleanup {
  @Every('cleanup', '20s', { timeoutMs: 10_000 })
  async run() {
    say('cleaned up');
  }
}

async function main() {
  const scheduler = new Scheduler({
    backend: backendFromEnv('decorators_legacy'),
    log: true,
  });

  const reports = new Reports();
  scheduler.register(new Cleanup());

  await scheduler.start();
  say(
    `compiled with ${style} decorators; started as ${scheduler.instanceId} on ${scheduler.backend.name}`,
  );
  for (const job of scheduler.jobs()) {
    say(`  ${job.name.padEnd(22)} ${job.schedule}`);
  }

  const shutdown = async () => {
    await scheduler.stop();
    say(`stopped (${reports.sent} syncs run)`);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
