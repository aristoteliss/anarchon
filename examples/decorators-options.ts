/* Copyright (C) 2026-present Aristotelis — see repository license. */

/**
 * The least code a job takes, and where every kind of option goes when jobs are declared with
 * decorators:
 *
 *   - a scheduler's settings: `Scheduler.configure()`, once. No scheduler is created by hand, and a
 *     backend must be given: none is assumed.
 *   - a job's options, the scheduler it goes to and its data: in its decorator
 *   - one object's options: `register(object, { prefix, defaults })`, for several objects of a class
 *   - data for the runs: `data`, handed to each run as `ctx.data`
 *
 *   npx tsx examples/decorators-options.ts
 */
import { Cron, Every, type JobContext, Scheduler } from '../src';
import { backendFromEnv, say } from './shared';

// The default scheduler's settings, also used for a named scheduler that has none of its own. The
// backend is a function of the scheduler's name, so each scheduler gets a store of its own.
Scheduler.configure({
  backend: (name) => backendFromEnv(`options_${name}`),
  timezone: 'Europe/Athens',
  jitterMs: 200,
  data: { service: 'reports-api' },
  autoStart: true, // without it, you start them: await Scheduler.startAll()
});

// One scheduler with settings of its own.
Scheduler.configure('billing', {
  backend: backendFromEnv('options_billing'),
  timezone: 'UTC',
  maxLateMs: 5 * 60_000,
  autoStart: true,
});

class Reports {
  syncs = 0;

  // On the default scheduler, with job options.
  @Every('reports-sync', '5s', { timeoutMs: 3_000, maxAttempts: 2 })
  sync(ctx: JobContext<{ service: string }>) {
    this.syncs++;
    say(`reports-sync for ${ctx.data.service}`);
  }

  // No time zone here, so the scheduler's applies: Europe/Athens.
  @Cron('reports-digest', '*/10 * * * * *')
  digest() {
    say('reports-digest');
  }

  // On the scheduler named 'billing', with data of its own: what this job is allowed to do.
  @Cron('invoices-close', '*/15 * * * * *', {
    scheduler: 'billing',
    data: { permission: 'invoices:close' },
  })
  close(ctx: JobContext<{ permission: string }>) {
    say(`invoices-close, allowed to ${ctx.data.permission}`);
  }

  // 'audit' has no settings: it is created from the default ones, with a store of its own.
  @Every('audit-export', '20s', { scheduler: 'audit' })
  audit() {
    say('audit-export');
  }
}

/** Several objects of one class: each is registered with a prefix and data of its own. */
class Tenant {
  @Every('usage', '10s')
  usage(ctx: JobContext<{ service: string; tenant: string; token: string }>) {
    say(`${ctx.name} for tenant ${ctx.data.tenant}, token ${ctx.data.token}`);
  }
}

async function main() {
  // Creating the object is all it takes: the schedulers its jobs name are created and started.
  const reports = new Reports();

  for (const tenant of ['acme', 'globex']) {
    Scheduler.get().register(new Tenant(), {
      prefix: `${tenant}:`,
      // A function is called when each run starts, so the token is the one valid at that moment.
      defaults: {
        timeoutMs: 5_000,
        data: () => ({ tenant, token: `${tenant}-${Date.now() % 10_000}` }),
      },
    });
  }

  for (const scheduler of Scheduler.all()) {
    say(`${scheduler.name ?? 'default'} (${scheduler.backend.name}):`);
    for (const job of scheduler.jobs()) {
      say(`  ${job.name.padEnd(16)} ${job.schedule}`);
    }
  }

  const shutdown = async () => {
    await Scheduler.stopAll();
    say(`stopped (${reports.syncs} syncs)`);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
