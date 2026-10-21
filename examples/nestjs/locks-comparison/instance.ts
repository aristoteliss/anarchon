/* Copyright (C) 2026-present Aristotelis — see repository license. */

/**
 * One instance of a NestJS app with one job, "report", due every 2 s. compare.ts starts it as a
 * child process and reads what it reports over IPC:
 *
 *   node instance.js <anarchon|anarchon-yield|nestjs-locks> <instance> <key> <healthy|fails|hangs>
 *
 * Both apps get the same lease (2 s) and the same rule: no two runs of the job at once.
 */
import 'reflect-metadata';

import {
  Injectable,
  Module,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { LocksModule, OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron as NestCron, ScheduleModule } from '@nestjs/schedule';
import {
  Cron,
  type JobContext,
  RedisBackend,
  Scheduled,
  Scheduler,
} from 'anarchon';

import { RedisModule } from './redis.module';
import { RedisLockStore } from './redis-lock.store';
import {
  type Behaviour,
  EVERY_2_SECONDS,
  INTERVAL_MS,
  type InstanceEvent,
  JOB_MS,
  LEASE_MS,
  type Library,
  REDIS_URL,
  sleep,
} from './shared';

/** anarchon marks a run failed after this long, and the next runs go ahead. */
const TIMEOUT_MS = 1_000;

const [library, instance = '', key = '', behaviour] = process.argv.slice(2) as [
  Library,
  string,
  string,
  Behaviour,
];

const report = (event: InstanceEvent) => process.send?.(event);

async function runReport(slot: number): Promise<void> {
  report({ type: 'start', instance, slot });
  // Never settles, and ignores ctx.signal: the worst kind of hang.
  if (behaviour === 'hangs') await new Promise(() => {});
  await sleep(JOB_MS);

  if (behaviour === 'fails') {
    report({ type: 'failure', instance, slot });
    throw new Error(`${instance}: the database is unreachable from this pod`);
  }
  report({ type: 'success', instance, slot });
}

@Injectable()
@Scheduled()
class AnarchonReport {
  // catchUpMs 0: @nestjs/locks has no catch-up, and it is not what this example compares.
  @Cron('report', EVERY_2_SECONDS, {
    timeoutMs: TIMEOUT_MS,
    catchUpMs: 0,
    yieldAfterFailure: library === 'anarchon-yield',
  })
  run(ctx: JobContext): Promise<void> {
    return runReport(ctx.slot);
  }
}

@Module({
  providers: [
    {
      provide: Scheduler,
      useFactory: () =>
        new Scheduler({
          backend: new RedisBackend({ redis: REDIS_URL, prefix: `${key}:` }),
          instanceId: instance,
          leaseMs: LEASE_MS,
          heartbeatMs: LEASE_MS / 4,
        }),
    },
    AnarchonReport,
  ],
})
class AnarchonApp implements OnApplicationBootstrap {
  constructor(private readonly scheduler: Scheduler) {}

  onApplicationBootstrap(): Promise<void> {
    return this.scheduler.start();
  }
}

@Injectable()
class NestLocksReport {
  @NestCron(EVERY_2_SECONDS)
  @OnOneInstance({ key })
  @WithoutOverlapping()
  run(): Promise<void> {
    return runReport(Math.floor(Date.now() / INTERVAL_MS) * INTERVAL_MS);
  }
}

@Module({
  imports: [
    ScheduleModule.forRoot(),
    LocksModule.forRoot({ ttl: LEASE_MS }),
    RedisModule,
  ],
  providers: [RedisLockStore, NestLocksReport],
})
class NestLocksApp {}

async function main(): Promise<void> {
  const app = library === 'nestjs-locks' ? NestLocksApp : AnarchonApp;
  await NestFactory.createApplicationContext(app, { logger: false });
  report({ type: 'ready', instance });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
