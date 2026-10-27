/* Copyright (C) 2026-present Aristotelis — see repository license. */

/**
 * Charging customers once a day: a job that must never charge twice, and must still charge when
 * every instance was down at the time it was due.
 *
 *   npx tsx examples/billing.ts                 # SQLite file in the temp folder
 *   BACKEND=postgres POSTGRES_URL=... npx tsx examples/billing.ts
 *
 * Needs a backend with leases (SQLite, PostgreSQL, Redis or Valkey 'lease'): `maxAttempts` and
 * `catchUpMs` don't exist without one. The day is compressed to 10 s so it can be watched.
 *
 * The options, and why:
 *   cron + timezone   charges at 06:00 Athens time all year, whatever zone the servers are in
 *   maxAttempts: 1    a charge whose runner died is NOT started again by a backup: a half-done
 *                     run needs a person, not a retry. (The default, 3, suits jobs safe to redo.)
 *   catchUpMs         after a full outage, the day's run still happens when an instance starts,
 *                     if it is at most this late. It covers the latest missed day only: if a
 *                     longer outage must not skip a day, have each run charge every day not
 *                     charged yet, up to ctx.slot
 *   timeoutMs         a run that hangs is cut off and recorded as failed, so tomorrow's can start
 *   ctx.slot          the key of each charge: the same on every instance and every attempt, so the
 *                     ledger refuses a second charge for the same day even if one slipped through
 *
 * What happens: two instances start, and the day that was due just before is caught up at once
 * (nobody ran it: on a first deploy that is yesterday's run, if it is within catchUpMs). They
 * charge the next day as usual, then both go down while a day is due; when they come back, that
 * day is caught up, once. The ledger ends with every customer charged once a day.
 */
import { type JobContext, Scheduler } from '../src';
import { backendFromEnv, say, sleep } from './shared';

const DAY_MS = 10_000;
const CUSTOMERS = ['acme', 'globex', 'initech'];

/** Stands in for a table with a unique key on (customer, day): INSERT ... ON CONFLICT DO NOTHING. */
const ledger = new Map<string, { customer: string; day: number; by: string }>();

function charge(customer: string, day: number, by: string): boolean {
  const key = `${customer}:${day}`;
  if (ledger.has(key)) return false;
  ledger.set(key, { customer, day, by });
  return true;
}

/** Charges every customer for the run's day; the ledger refuses a day charged before. */
async function chargeCards(ctx: JobContext): Promise<void> {
  const late =
    ctx.reason === 'catch-up'
      ? ` (caught up ${Date.now() - ctx.slot} ms late: nobody ran it when it was due)`
      : '';
  const day = ctx.scheduledAt.toISOString().slice(11, 19);

  for (const customer of CUSTOMERS) {
    ctx.signal.throwIfAborted();
    const charged = charge(customer, ctx.slot, ctx.instanceId);
    const outcome = charged ? 'charged' : 'already charged';
    say(`${ctx.instanceId}: ${customer} for ${day} ${outcome}${late}`);
  }
}

function instance(id: string): Scheduler {
  const scheduler = new Scheduler({
    backend: backendFromEnv('billing'),
    instanceId: id,
    timezone: 'Europe/Athens',
  });

  // Real life: '0 6 * * *'. Here: every 10 s (six fields, seconds first).
  scheduler.cron('charge-cards', '*/10 * * * * *', chargeCards, {
    maxAttempts: 1,
    catchUpMs: 60_000,
    timeoutMs: 8_000,
  });
  scheduler.on('failure', (run) =>
    say(`${run.instanceId}: charge run failed, needs a look: ${run.error}`),
  );

  return scheduler;
}

const nextSuccess = (schedulers: Scheduler[]) =>
  new Promise<void>((resolve) => {
    for (const s of schedulers) {
      s.once('success', () => resolve());
    }
  });

async function main() {
  const startedAt = Date.now();
  const a = instance('billing-a');
  const b = instance('billing-b');
  await Promise.all([a.start(), b.start()]);
  say('two instances up; each "day" is charged by one of them');

  await nextSuccess([a, b]);
  await nextSuccess([a, b]);

  await Promise.all([a.stop(), b.stop()]);
  const missed = Math.ceil(Date.now() / DAY_MS) * DAY_MS;
  say(
    `outage: both instances down while ${new Date(missed).toISOString().slice(11, 19)} is due`,
  );
  await sleep(missed - Date.now() + 3_000);

  await Promise.all([a.start(), b.start()]);
  say('back up: the missed day is caught up by one instance');
  await nextSuccess([a, b]);
  await nextSuccess([a, b]);
  const history = (await a.history('charge-cards', 20))
    .filter((run) => run.startedAt.getTime() >= startedAt)
    .reverse();
  await Promise.all([a.stop(), b.stop()]);

  const days = new Map<number, number>();
  for (const { day } of ledger.values()) {
    days.set(day, (days.get(day) ?? 0) + 1);
  }
  const even = [...days.values()].every((n) => n === CUSTOMERS.length);
  const verdict = even ? 'each customer once a day' : 'UNEVEN';
  say(`ledger: ${ledger.size} charges over ${days.size} days, ${verdict}`);
  for (const run of history) {
    say(
      `  ${run.scheduledAt.toISOString().slice(11, 19)}  ${run.status.padEnd(8)} on ${run.instanceId}  (${run.reason})`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
