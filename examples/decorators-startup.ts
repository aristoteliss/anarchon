/* Copyright (C) 2026-present Aristotelis — see repository license. */

/**
 * Three ways to get from a class with decorated jobs to jobs that run. The class is the same in
 * all three; what changes is who creates the schedulers and who starts them. Pick one:
 *
 *   npx tsx examples/decorators-startup.ts auto     settings with autoStart: nothing to start
 *   npx tsx examples/decorators-startup.ts manual   settings, and you start them when you decide
 *   npx tsx examples/decorators-startup.ts hand     no settings: you create each scheduler yourself
 */
import { Cron, Every, Scheduler } from '../src';
import { backendFromEnv, say } from './shared';

const flow = process.argv[2] ?? 'auto';
/** A store for each scheduler, by its name. In settings, a backend must be given: none is assumed. */
const storeFor = (name: string) => backendFromEnv(`startup_${flow}_${name}`);

class Jobs {
  ticks = 0;

  @Every('tick', '5s')
  tick() {
    this.ticks++;
    say('tick    on the default scheduler');
  }

  @Cron('report', '*/10 * * * * *', { scheduler: 'reports' })
  report() {
    say('report  on the scheduler named "reports"');
  }
}

async function main() {
  let jobs: Jobs;
  if (flow === 'auto') {
    // The schedulers are created and started when the object is. This is all there is to write.
    Scheduler.configure({ backend: storeFor, autoStart: true });
    jobs = new Jobs();
    // With autoStart nobody awaits start(), so a failure to connect arrives as an 'error' event.
    for (const scheduler of Scheduler.all()) scheduler.on('error', ({ error }) => console.error('scheduler error:', error));
  } else if (flow === 'manual') {
    // The schedulers are created when the object is, and stay stopped until you start them: do it
    // when the rest of your app is ready. A failure to connect rejects here, where you can handle it.
    Scheduler.configure({ backend: storeFor });
    jobs = new Jobs();
    say(`created ${Scheduler.all().length} schedulers, none started yet`);
    await Scheduler.startAll();
  } else if (flow === 'hand') {
    // No settings. The object can be created first: it waits, and adds its jobs when one of the
    // schedulers they name starts. The first scheduler without a name is the default one.
    jobs = new Jobs();
    const main = new Scheduler({ backend: storeFor('default') });
    const reports = new Scheduler({ name: 'reports', backend: storeFor('reports') });
    await main.start();
    await reports.start();
  } else {
    throw new Error(`Unknown flow "${flow}": use auto, manual or hand`);
  }

  say(`flow "${flow}":`);
  for (const scheduler of Scheduler.all()) {
    say(
      `  ${(scheduler.name ?? 'default').padEnd(8)} ${scheduler
        .jobs()
        .map((job) => `${job.name} (${job.schedule})`)
        .join(', ')}`,
    );
  }

  const shutdown = async () => {
    await Scheduler.stopAll();
    say(`stopped (${jobs.ticks} ticks)`);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
