/* Copyright (C) 2026-present Aristotelis — see repository license. */

/**
 * A SaaS where every tenant gets the same jobs, on its own schedule: a digest at 08:00 in the
 * tenant's time zone, a usage sync with a token fresh for each run, and a schedule that depends on
 * the tenant's plan. Tenants come and go while the service runs.
 *
 *   npx tsx examples/tenants.ts                 # SQLite file in the temp folder
 *   BACKEND=redis npx tsx examples/tenants.ts   # see examples/shared.ts
 *
 * The approach, and why:
 *   `${tenant}:job` names   one job per tenant and kind: history, runNow() and remove() work per tenant
 *   timezone per job        '0 8 * * *' means 08:00 where the tenant is, summer and winter
 *   data, a value           what the handler needs about the tenant (its id, its plan)
 *   data, a function        called when each run starts: the token is valid at that moment, not
 *                           when the service started
 *   catchUpMs               a digest missed while every instance was down is still sent (here up
 *                           to 2 h late, also for a tenant added just after its time); a frequent
 *                           sync is never caught up (0)
 *   remove()                a tenant that leaves stops having jobs, on this instance
 *   runNow(name, { data })  a preview run for one tenant, with data for that run only
 *
 * Run the same code on every instance, with the same tenants: each run still happens once. With
 * decorators, the same is done by `register(object, { prefix, defaults })`: see
 * decorators-options.ts. Real life: the digest is '0 8 * * *' and the sync '1h'; here they run
 * every few seconds.
 */
import { randomBytes } from 'node:crypto';
import { type JobContext, Scheduler } from '../src';
import { backendFromEnv, say, sleep } from './shared';

interface Tenant {
  id: string;
  timezone: string;
  plan: 'free' | 'pro';
}
type DigestData = { tenant: string; plan: Tenant['plan']; preview?: boolean };
type SyncData = { tenant: string; token: string };

/** Stands in for the tenants table. */
const tenants: Tenant[] = [
  { id: 'acme', timezone: 'Europe/Athens', plan: 'pro' },
  { id: 'globex', timezone: 'America/New_York', plan: 'free' },
];

/** Stands in for an auth service: a short-lived token per tenant. */
const issueToken = async (tenant: string) => `${tenant}-${randomBytes(3).toString('hex')}`;

function addTenant(scheduler: Scheduler, tenant: Tenant): void {
  scheduler.cron(
    `${tenant.id}:digest`,
    tenant.plan === 'pro' ? '*/8 * * * * *' : '*/16 * * * * *', // real life: daily for pro, weekly for free
    (ctx: JobContext<DigestData>) => {
      const local = ctx.scheduledAt.toLocaleTimeString('en-GB', { timeZone: tenant.timezone });
      const why = ctx.reason === 'scheduled' ? '' : ` (${ctx.reason})`;
      say(`${ctx.name}: ${ctx.data.preview ? 'PREVIEW of the ' : ''}${ctx.data.plan} digest, ${local} in ${tenant.timezone}${why}`);
    },
    // A digest missed during a deploy is still sent, up to 2 h late (the default is 5 min).
    { timezone: tenant.timezone, data: { tenant: tenant.id, plan: tenant.plan }, catchUpMs: 2 * 60 * 60_000 },
  );
  scheduler.every(`${tenant.id}:sync-usage`, '5s', (ctx: JobContext<SyncData>) => say(`${ctx.name}: synced with token ${ctx.data.token}`), {
    data: async () => ({ tenant: tenant.id, token: await issueToken(tenant.id) }),
    timeoutMs: 4_000,
    catchUpMs: 0, // the next sync is moments away
  });
}

function removeTenant(scheduler: Scheduler, id: string): void {
  for (const job of scheduler.jobs()) if (job.name.startsWith(`${id}:`)) scheduler.remove(job.name);
}

function printJobs(scheduler: Scheduler): void {
  for (const job of scheduler.jobs()) say(`  ${job.name.padEnd(20)} ${job.schedule.padEnd(46)} next ${job.nextRunAt?.toISOString()}`);
}

async function main() {
  const scheduler = new Scheduler({ backend: backendFromEnv('tenants'), instanceId: 'saas-1' });
  for (const tenant of tenants) addTenant(scheduler, tenant);
  await scheduler.start();
  say('jobs per tenant:');
  printJobs(scheduler);

  await sleep(9_000);
  const initech: Tenant = { id: 'initech', timezone: 'Asia/Tokyo', plan: 'pro' };
  say('initech signs up: its jobs are added while the scheduler runs');
  addTenant(scheduler, initech);

  await sleep(6_000);
  say("a support agent previews acme's digest: a manual run with data for that run only");
  const preview = await scheduler.runNow('acme:digest', { data: { preview: true } });
  say(`preview run: ${preview.status}, manual: ${preview.manual}`);

  await sleep(3_000);
  say('globex leaves: its jobs are removed');
  removeTenant(scheduler, 'globex');
  printJobs(scheduler);

  await sleep(8_000);
  await scheduler.stop();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
