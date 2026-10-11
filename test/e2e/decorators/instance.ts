/* Copyright (C) 2026-present Aristotelis — see repository license. */

// Declares jobs with decorator syntax and no register(), runs one, and prints what happened as one
// line of JSON. Started by syntax.test.ts once per decorator style; the tsconfig given to tsx
// selects the style.
import { At, type Backend, Cron, Every, type JobContext, Scheduled, Scheduler } from '../../../src';

const backend: Backend = {
  name: 'memory',
  dedupeWindowMs: Infinity,
  init: async () => {},
  prepareJob: async () => {},
  claim: async () => true,
  recordManualRun: async () => undefined,
  saveResult: async () => {},
  history: async () => [],
  close: async () => {},
};

// Legacy decorators are called with (target, key, descriptor), standard ones with (method, context).
let style = '';
const probe = (...args: unknown[]): void => {
  style = args.length === 3 ? 'legacy' : 'standard';
};

@Scheduled()
class Reports {
  ran: string[] = [];

  constructor(readonly label: string) {}

  @Cron('0 8 * * 1-5', { timezone: 'Europe/Athens' })
  digest() {}

  @Every('sync', '1h', { timeoutMs: 5_000 })
  sync(ctx: JobContext) {
    this.ran.push(`${this.label}:${ctx.name}`);
  }

  @At('2030-01-01T00:00:00Z')
  launch() {}

  @probe
  notAJob() {}
}

/** Without @Scheduled(): its objects add their jobs with standard decorators only. */
class Unmarked {
  @Every('unmarked', '1h')
  run() {}
}

/** Its job names a scheduler that is created from settings when an object of the class is. */
@Scheduled()
class Elsewhere {
  @Every('extra-job', '1h', { scheduler: 'extra' })
  run() {}
}

/** Several objects of one class: each is registered with a prefix of its own. */
class Tenant {
  runs = 0;

  @Every('tenant-sync', '1h')
  sync() {
    this.runs++;
  }
}

async function main(): Promise<void> {
  const names = () => scheduler.jobs().map((job) => job.name);

  const reports = new Reports('early');
  const scheduler = new Scheduler({ backend });
  const unmarked = new Unmarked();
  const beforeStart = names();

  await scheduler.start();
  const run = await scheduler.runNow('sync');

  const a = new Tenant();
  scheduler.register(a, { prefix: 'a-' });
  const b = new Tenant();
  scheduler.register(b, { prefix: 'b-', defaults: { timeoutMs: 5_000 } });
  await scheduler.runNow('b-tenant-sync');

  Scheduler.configure('extra', { backend: { ...backend, name: 'extra-memory' }, autoStart: true });
  new Elsewhere();
  const extra = Scheduler.get('extra');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const extraRun = await extra.runNow('extra-job');
  const extraJobs = extra.jobs().map((job) => job.name);
  await Scheduler.stopAll();
  console.log(
    JSON.stringify({
      style,
      beforeStart,
      jobs: names(),
      status: run.status,
      ran: reports.ran,
      unmarked: unmarked instanceof Unmarked,
      tenantRuns: [a.runs, b.runs],
      extra: [extra.backend.name, extraJobs, extraRun.status],
    }),
  );
}

void main();
