/* Copyright (C) 2026-present Aristotelis — see repository license. */

/**
 * Runs real processes against Redis and breaks them on purpose (kill -9, pause, restart all),
 * then reports what happened to each scheduled run.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';

import { type RunRecord, Scheduler } from '../../../src';
import { scenarioBackend } from './backend';

export interface ScenarioConfig {
  /** A Redis strategy ('lease', 'stream-id', ...), or 'postgres' / 'sqlite' (both with leases). */
  strategy: string;
  redisUrl: string;
  prefix: string;
  intervalMs: number;
  jobMs: number;
  jitterMs?: number;
  leaseMs?: number;
  heartbeatMs?: number;
}

export interface Ev {
  type: string;
  t: number;
  instance: string;
  pid: number;
  slot?: number;
  attempt?: number;
  reason?: string;
  aborted?: boolean;
  error?: string;
}

export interface Execution {
  slot: number;
  attempt: number;
  reason: string;
  instance: string;
  pid: number;
  start: number;
  end: number | null;
  aborted: boolean;
  /** The process died before the run ended. */
  killed: boolean;
}

const FIXTURE = join(__dirname, 'instance.ts');
export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export class Cluster {
  readonly events: Ev[] = [];
  private readonly procs = new Map<string, ChildProcess>();
  private readonly waiters: Array<{
    match: (e: Ev) => boolean;
    resolve: (e: Ev) => void;
  }> = [];

  constructor(readonly cfg: ScenarioConfig) {}

  /** Starts an instance and waits until its scheduler is running. */
  start(instance: string): Promise<void> {
    const child = spawn(process.execPath, ['--import', 'tsx', FIXTURE], {
      env: {
        ...process.env,
        SCENARIO: JSON.stringify({ ...this.cfg, instanceId: instance }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.procs.set(instance, child);
    let buffer = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      for (
        let newline = buffer.indexOf('\n');
        newline >= 0;
        newline = buffer.indexOf('\n')
      ) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('{')) continue;
        const event = JSON.parse(line) as Ev;
        this.events.push(event);
        for (const waiter of [...this.waiters]) {
          if (waiter.match(event)) {
            this.waiters.splice(this.waiters.indexOf(waiter), 1);
            waiter.resolve(event);
          }
        }
      }
    });
    child.stderr!.on('data', () => {});
    return this.waitFor(
      (e) => e.type === 'ready' && e.pid === child.pid,
      15_000,
    ).then(() => undefined);
  }

  /** Kills an instance like a crash (default) and records when. */
  kill(instance: string, signal: NodeJS.Signals = 'SIGKILL'): void {
    const child = this.procs.get(instance);
    if (!child || child.exitCode !== null) return;
    child.kill(signal);
    this.events.push({
      type: 'killed',
      t: Date.now(),
      instance,
      pid: child.pid!,
    });
  }

  /** Freezes an instance (like a long GC pause or a stalled VM). */
  pause(instance: string): void {
    this.procs.get(instance)?.kill('SIGSTOP');
    this.events.push({
      type: 'paused',
      t: Date.now(),
      instance,
      pid: this.procs.get(instance)!.pid!,
    });
  }

  resume(instance: string): void {
    this.procs.get(instance)?.kill('SIGCONT');
    this.events.push({
      type: 'resumed',
      t: Date.now(),
      instance,
      pid: this.procs.get(instance)!.pid!,
    });
  }

  waitFor(match: (e: Ev) => boolean, timeoutMs: number): Promise<Ev> {
    const found = this.events.find(match);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          reject(
            new Error(`timed out after ${timeoutMs} ms waiting for an event`),
          );
        }
      }, timeoutMs);
    });
  }

  killAll(): void {
    for (const instance of this.procs.keys()) this.kill(instance);
  }

  /** Every execution of the job, rebuilt from the events of all processes. */
  executions(): Execution[] {
    const list: Execution[] = [];
    for (const e of this.events.filter((x) => x.type === 'run-start')) {
      const end = this.events.find(
        (x) =>
          x.type === 'run-end' &&
          x.pid === e.pid &&
          x.slot === e.slot &&
          x.attempt === e.attempt &&
          x.t >= e.t,
      );
      const death = this.events.find(
        (x) => x.type === 'killed' && x.pid === e.pid && x.t >= e.t,
      );
      const killed = !end && !!death;
      list.push({
        slot: e.slot!,
        attempt: e.attempt ?? 1,
        reason: e.reason ?? 'scheduled',
        instance: e.instance,
        pid: e.pid,
        start: e.t,
        end: end?.t ?? death?.t ?? null,
        aborted: end?.aborted ?? false,
        killed,
      });
    }
    return list.sort((a, b) => a.start - b.start);
  }

  async history(limit = 50): Promise<RunRecord[]> {
    const reader = new Scheduler({
      backend: scenarioBackend(this.cfg),
    });
    try {
      return await reader.history('job', limit);
    } finally {
      await reader.stop();
    }
  }
}

/** Largest number of executions of the job running at the same moment. */
export function maxConcurrency(
  executions: Execution[],
  until = Date.now(),
): number {
  const points = executions.flatMap((e) => [
    { t: e.start, d: 1 },
    { t: e.end ?? until, d: -1 },
  ]);
  points.sort((a, b) => a.t - b.t || a.d - b.d);
  let current = 0;
  let max = 0;
  for (const p of points) {
    current += p.d;
    max = Math.max(max, current);
  }
  return max;
}

const completed = (e: Execution) => e.end !== null && !e.aborted && !e.killed;
/**
 * A run that started on time, so the next one is a whole interval away. (A catch-up run at start-up
 * can be late in its cycle; if it crashed, the next run would simply replace it.)
 */
const onTimeRun = (e: Ev) =>
  e.type === 'run-start' && (e.reason ?? 'scheduled') === 'scheduled';
const describe = (e: Execution) =>
  `${e.instance}#${e.attempt}${e.reason !== 'scheduled' ? `(${e.reason})` : ''}`;

export interface ScenarioResult {
  name: string;
  summary: string;
  facts: Record<string, unknown>;
}

const IDS = ['A', 'B', 'C'];

/** 1. The job takes longer than its interval (7 s job, every 3 s). */
export async function longRuns(base: ScenarioConfig): Promise<ScenarioResult> {
  const c = new Cluster({ ...base, intervalMs: 3_000, jobMs: 7_000 });
  await Promise.all(IDS.map((id) => c.start(id)));
  await sleep(15_000);
  c.killAll();
  const ex = c.executions();
  const facts = {
    executions: ex.length,
    maxRunningAtOnce: maxConcurrency(ex),
    overlapSkips: c.events.filter(
      (e) => e.type === 'skip' && e.reason === 'overlap',
    ).length,
    errors: c.events.filter((e) => e.type === 'error').length,
  };
  return {
    name: 'Long runs (7 s job every 3 s)',
    summary: `${facts.maxRunningAtOnce} running at the same time, ${facts.overlapSkips} runs skipped because one was still running`,
    facts,
  };
}

/** 2. The instance running the job crashes 1 s into a 4 s run. */
export async function winnerCrashes(
  base: ScenarioConfig,
): Promise<ScenarioResult> {
  const c = new Cluster({ ...base, intervalMs: 10_000, jobMs: 4_000 });
  await Promise.all(IDS.map((id) => c.start(id)));
  const first = await c.waitFor(onTimeRun, 25_000);
  await sleep(1_000);
  c.kill(first.instance);
  const crashAt = Date.now();
  await sleep(8_000);
  c.killAll();
  const ofSlot = c.executions().filter((e) => e.slot === first.slot);
  const finisher = ofSlot.find(
    (e) => e.instance !== first.instance && completed(e),
  );
  const history = (await c.history()).filter((r) => r.slot === first.slot);
  const facts = {
    crashed: first.instance,
    finishedBy: finisher ? describe(finisher) : null,
    takeoverAfterMs: finisher ? finisher.start - crashAt : null,
    history: history.map(
      (r) =>
        `${r.instanceId}#${(r as { attempt?: number }).attempt ?? 1}:${r.status}`,
    ),
  };
  return {
    name: 'Winner crashes mid-run',
    summary: finisher
      ? `backup ${describe(finisher)} took over ${facts.takeoverAfterMs} ms after the crash and finished the run`
      : `nobody finished the run; history still says: ${facts.history.join(', ')}`,
    facts,
  };
}

/** 3. A non-winner is killed and restarted while the winner is mid-run. */
export async function nonWinnerRestarts(
  base: ScenarioConfig,
): Promise<ScenarioResult> {
  const c = new Cluster({ ...base, intervalMs: 10_000, jobMs: 4_000 });
  await Promise.all(IDS.map((id) => c.start(id)));
  const first = await c.waitFor(onTimeRun, 25_000);
  const other = IDS.find((id) => id !== first.instance)!;
  await sleep(500);
  c.kill(other);
  await sleep(300);
  await c.start(other);
  await sleep(5_000);
  c.killAll();
  const ofSlot = c.executions().filter((e) => e.slot === first.slot);
  const facts = {
    runner: first.instance,
    restarted: other,
    executionsOfThatRun: ofSlot.map(describe),
    finishedOnce: ofSlot.filter(completed).length === 1,
  };
  return {
    name: 'A non-winner restarts in the middle of a run',
    summary: `that run executed ${ofSlot.length} time(s): ${facts.executionsOfThatRun.join(', ')}`,
    facts,
  };
}

/** 4. All three instances crash 1 s into a 4 s run, and come back 1 s later. */
export async function allRestartMidRun(
  base: ScenarioConfig,
): Promise<ScenarioResult> {
  const c = new Cluster({ ...base, intervalMs: 10_000, jobMs: 4_000 });
  await Promise.all(IDS.map((id) => c.start(id)));
  const first = await c.waitFor(onTimeRun, 25_000);
  await sleep(1_000);
  c.killAll();
  await sleep(1_000);
  await Promise.all(IDS.map((id) => c.start(id)));
  await sleep(7_000);
  c.killAll();
  const ofSlot = c.executions().filter((e) => e.slot === first.slot);
  const finished = ofSlot.filter(completed);
  const facts = {
    executionsOfThatRun: ofSlot.map(describe),
    finished: finished.map(describe),
    history: (await c.history())
      .filter((r) => r.slot === first.slot)
      .map(
        (r) =>
          `${r.instanceId}#${(r as { attempt?: number }).attempt ?? 1}:${r.status}`,
      ),
  };
  return {
    name: 'All 3 restart in the middle of a run',
    summary: finished.length
      ? `the interrupted run was finished by ${facts.finished.join(', ')}`
      : `the run was lost; history: ${facts.history.join(', ')}`,
    facts,
  };
}

/** 5. All three instances are down when a run is due, and start 2 s later. */
export async function allDownAtRunTime(
  base: ScenarioConfig,
): Promise<ScenarioResult> {
  const interval = 10_000;
  const c = new Cluster({ ...base, intervalMs: interval, jobMs: 1_000 });
  await Promise.all(IDS.map((id) => c.start(id)));
  let slot = (Math.floor(Date.now() / interval) + 1) * interval;
  if (slot - Date.now() < 2_500) slot += interval;
  await sleep(slot - 1_000 - Date.now());
  c.killAll();
  await sleep(slot + 2_000 - Date.now());
  await Promise.all(IDS.map((id) => c.start(id)));
  await sleep(4_000);
  c.killAll();
  const ofSlot = c.executions().filter((e) => e.slot === slot);
  const facts = {
    missedRun: new Date(slot).toISOString(),
    executions: ofSlot.map(describe),
  };
  return {
    name: 'All 3 down when a run is due',
    summary: ofSlot.length
      ? `the missed run ran after the restart: ${facts.executions.join(', ')}`
      : 'the missed run never ran',
    facts,
  };
}

/** 6. The winner freezes (like a long GC pause) for longer than the lease, then wakes up. */
export async function winnerFreezes(
  base: ScenarioConfig,
): Promise<ScenarioResult> {
  const c = new Cluster({ ...base, intervalMs: 10_000, jobMs: 5_000 });
  await Promise.all(IDS.map((id) => c.start(id)));
  const first = await c.waitFor(onTimeRun, 25_000);
  await sleep(500);
  c.pause(first.instance);
  await sleep(4_000);
  c.resume(first.instance);
  await sleep(6_000);
  c.killAll();
  const ofSlot = c.executions().filter((e) => e.slot === first.slot);
  const original = ofSlot.find(
    (e) => e.instance === first.instance && e.attempt === (first.attempt ?? 1),
  );
  const backup = ofSlot.find((e) => e.instance !== first.instance);
  const facts = {
    frozen: first.instance,
    backup: backup ? describe(backup) : null,
    backupFinished: backup ? completed(backup) : false,
    originalAbortedAfterWaking: original?.aborted ?? false,
    lostEvents: c.events.filter((e) => e.type === 'lost').length,
  };
  return {
    name: 'Winner freezes longer than the lease',
    summary: backup
      ? `backup ${describe(backup)} took over; the frozen one ${facts.originalAbortedAfterWaking ? 'saw ctx.signal abort when it woke up' : 'kept running after it woke up'}`
      : 'no backup; the run just waited for the frozen instance',
    facts,
  };
}

/** 7. Rolling deploy: the winner gets SIGTERM 1 s into a 4 s run and shuts down gracefully. */
export async function winnerStopsGracefully(
  base: ScenarioConfig,
): Promise<ScenarioResult> {
  const c = new Cluster({ ...base, intervalMs: 10_000, jobMs: 4_000 });
  await Promise.all(IDS.map((id) => c.start(id)));
  const first = await c.waitFor(onTimeRun, 25_000);
  await sleep(1_000);
  c.kill(first.instance, 'SIGTERM');
  const stopAt = Date.now();
  await sleep(7_000);
  c.killAll();
  const ofSlot = c.executions().filter((e) => e.slot === first.slot);
  const finisher = ofSlot.find(
    (e) => e.instance !== first.instance && completed(e),
  );
  const history = (await c.history()).filter((r) => r.slot === first.slot);
  const facts = {
    stopped: first.instance,
    finishedBy: finisher ? describe(finisher) : null,
    handoverAfterMs: finisher ? finisher.start - stopAt : null,
    history: history.map((r) => `${r.instanceId}#${r.attempt}:${r.status}`),
  };
  return {
    name: 'Rolling deploy: the winner is stopped (SIGTERM) mid-run',
    summary: finisher
      ? `the stopped instance handed the run over; ${describe(finisher)} started it ${facts.handoverAfterMs} ms later and finished it`
      : `nobody finished the run; history: ${facts.history.join(', ')}`,
    facts,
  };
}

export const SCENARIOS = [
  longRuns,
  winnerCrashes,
  nonWinnerRestarts,
  allRestartMidRun,
  allDownAtRunTime,
  winnerFreezes,
  winnerStopsGracefully,
];
