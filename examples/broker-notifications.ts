/* Copyright (C) 2026-present Aristotelis — see repository license. */

/**
 * Sending notifications on a stack that has RabbitMQ or NATS but no Redis or SQL database for the
 * scheduler. A broker picks one winner per run, but holds no lease: no backup takes over a run
 * whose instance died, no catch-up, no overlap protection. The job is written so that doesn't hurt.
 *
 *   docker compose -f test/docker-compose.test.yml --profile brokers up -d   # or your own servers
 *   npx tsx examples/broker-notifications.ts                     # NATS at nats://localhost:4222
 *   BROKER=rabbitmq npx tsx examples/broker-notifications.ts     # RabbitMQ at amqp://localhost:5672
 *   NATS_URL=... / RABBITMQ_URL=...                              # other servers
 *
 * The approach, and why:
 *   send everything outstanding   each run sends all notifications not sent yet, not "the ones of
 *                                 this run". A run that is lost (its instance crashed) or fails only
 *                                 delays them until the next run.
 *   an idempotency key            each notification goes out with its id, so the provider drops a
 *                                 repeat if an instance died between sending and marking it sent
 *   jitterMs                      spreads the runs over the instances
 *   maxLateMs < the broker's memory   the broker remembers a claimed run for slotTtlMs (RabbitMQ)
 *                                 or duplicateWindowMs (NATS), 5 min by default. A later claim
 *                                 could win the same run again, so anarchon refuses a job whose
 *                                 maxLateMs (+ jitter) is not shorter
 *   historySize                   brokers keep history by count; historyTtlMs is refused
 *   no lease options              overlap, maxAttempts, catchUpMs, leaseMs and heartbeatMs don't
 *                                 compile with a broker backend: it can't honour them
 *
 * Three instances run for 20 s; the app adds a notification every second, and one run fails
 * halfway. Every notification is still sent exactly once.
 */
import { NatsBackend, RabbitMQBackend, Scheduler } from '../src';
import { say, sleep } from './shared';

interface Notification {
  id: number;
  to: string;
  sentAt?: number;
}

/** Stands in for an outbox table the app writes to. */
const outbox: Notification[] = [];
/** Stands in for the mail provider: it drops a repeated idempotency key. */
const delivered = new Set<number>();
let runs = 0;

function broker() {
  return process.env.BROKER === 'rabbitmq'
    ? new RabbitMQBackend({ url: process.env.RABBITMQ_URL ?? 'amqp://localhost:5672', prefix: 'example.notify.', slotTtlMs: 10 * 60_000 })
    : new NatsBackend({ servers: process.env.NATS_URL ?? 'nats://localhost:4222', stream: 'EXAMPLE_NOTIFY', prefix: 'example.notify.' });
}

async function sendOutstanding(instanceId: string): Promise<void> {
  const failHalfway = ++runs === 4;
  const pending = outbox.filter((n) => n.sentAt === undefined);
  for (const [i, notification] of pending.entries()) {
    if (failHalfway && i === Math.floor(pending.length / 2)) throw new Error('mail provider: connection reset');
    delivered.add(notification.id); // the provider keys on the id
    notification.sentAt = Date.now();
  }
  say(`${instanceId}: sent ${pending.length} notification(s)`);
}

async function main() {
  const instance = (id: string) => {
    const scheduler = new Scheduler({ backend: broker(), instanceId: id });
    scheduler.every('send-notifications', '3s', (ctx) => sendOutstanding(ctx.instanceId), {
      jitterMs: 500,
      maxLateMs: 60_000,
      historySize: 100,
      timeoutMs: 2_500,
    });
    scheduler.on('failure', (run) => say(`${run.instanceId}: run failed (${run.error}); the next run sends the rest`));
    return scheduler;
  };
  const [first, ...others] = [instance('api-1'), instance('api-2'), instance('api-3')];
  const instances = [first, ...others];
  const startedAt = Date.now();
  say(`backend: ${first.backend.name}`);
  await Promise.all(instances.map((s) => s.start()));

  for (let id = 1; id <= 20; id++) {
    outbox.push({ id, to: `user${id}@example.com` });
    await sleep(1_000);
  }
  await sleep(3_500);
  const history = (await first.history('send-notifications', 50)).filter((run) => run.startedAt.getTime() >= startedAt);
  await Promise.all(instances.map((s) => s.stop()));

  const unsent = outbox.filter((n) => n.sentAt === undefined).length;
  say(`${outbox.length} notifications, ${delivered.size} delivered, ${unsent} not sent yet`);
  say(`${history.length} runs, on ${new Set(history.map((r) => r.instanceId)).size} instances`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
