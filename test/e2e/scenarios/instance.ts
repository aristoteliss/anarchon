/* Copyright (C) 2026-present Aristotelis — see repository license. */

/**
 * One instance for the failure scenarios: a single job ("job") that runs for jobMs every intervalMs.
 * Every event is logged as a JSON line with a timestamp so the test can rebuild what happened.
 */
import { Scheduler } from '../../../src';
import { scenarioBackend } from './backend';

interface Config {
  strategy: string;
  redisUrl: string;
  prefix: string;
  instanceId: string;
  intervalMs: number;
  jobMs: number;
  jitterMs?: number;
  leaseMs?: number;
  heartbeatMs?: number;
}

const cfg = JSON.parse(process.env.SCENARIO ?? '{}') as Config;
const log = (event: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify({ ...event, t: Date.now(), pid: process.pid, instance: cfg.instanceId })}\n`);

/** Waits for ms, or until the signal aborts. Returns true if aborted. */
function work(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(true);
    const timer = setTimeout(() => resolve(false), ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      { once: true },
    );
  });
}

const backend = scenarioBackend(cfg);
const options: Record<string, unknown> = { instanceId: cfg.instanceId };
if (backend.runs && cfg.leaseMs) options.leaseMs = cfg.leaseMs;
if (backend.runs && cfg.heartbeatMs) options.heartbeatMs = cfg.heartbeatMs;

const scheduler = new Scheduler({ backend, ...options });

scheduler.every(
  'job',
  cfg.intervalMs,
  async (ctx) => {
    log({ type: 'run-start', slot: ctx.slot, attempt: ctx.attempt, reason: ctx.reason });
    const aborted = await work(cfg.jobMs, ctx.signal);
    log({ type: 'run-end', slot: ctx.slot, attempt: ctx.attempt, aborted });
    ctx.signal.throwIfAborted(); // stopped or taken over: this run didn't finish
  },
  { jitterMs: cfg.jitterMs ?? 200 },
);

scheduler.on('skip', (e) => log({ type: 'skip', slot: e.slot, reason: e.reason }));
scheduler.on('error', (e) => log({ type: 'error', error: String(e.error) }));
scheduler.on('lost', (e) => log({ type: 'lost', slot: e.slot, attempt: e.attempt }));
scheduler.on('interrupted', (e) => log({ type: 'interrupted', slot: e.slot, attempt: e.attempt, handedOver: e.handedOver }));

// A graceful shutdown, like a rolling deploy (SIGKILL is the crash case).
process.on('SIGTERM', () => {
  void scheduler.stop({ timeoutMs: 5_000 }).finally(() => {
    log({ type: 'stopped' });
    process.exit(0);
  });
});

scheduler
  .start()
  .then(() => log({ type: 'ready' }))
  .catch((error: unknown) => {
    log({ type: 'fatal', error: String(error) });
    process.exit(1);
  });
