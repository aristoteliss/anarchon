import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { hostname } from 'node:os';

import { RedisBackend } from './backends/redis';
import { cronSchedule, everySchedule, onceSchedule, parseDuration, type Schedule } from './schedule';
import type {
  Backend,
  ClaimInput,
  ClaimOutcome,
  CronJobOptions,
  EveryJobOptions,
  JobHandler,
  JobInfo,
  JobOptions,
  Logger,
  RunReason,
  RunRecord,
  RunStore,
  SchedulerErrorEvent,
  SchedulerEvents,
  SchedulerOptions,
  SkipEvent,
  StoredResult,
} from './types';
import { describeError, errorMessage, intInRange, nonNegativeInt, positiveInt, sleep } from './util';

/** Long waits are split so the clock is re-checked at least once a minute. */
const MAX_TIMER_MS = 60_000;
/**
 * Lease strategy: slack for clock differences and network delays when the server checks how late a
 * claim is. Its only job is to stop claims that are far too late (delayed or queued during an outage).
 */
const CLOCK_TOLERANCE_MS = 10_000;

interface Job {
  readonly name: string;
  readonly schedule: Schedule;
  readonly handler: JobHandler;
  readonly jitterMs: number;
  readonly maxLateMs: number;
  readonly historySize: number;
  readonly historyTtlMs: number | undefined;
  readonly overlap: 'skip' | 'allow';
  readonly timeoutMs: number | undefined;
  readonly maxAttempts: number;
  readonly catchUpMs: number;
  /** Lease strategy: how long the server must remember a run, so a late claim can't run it twice. */
  readonly keepMs: number;
  timer: NodeJS.Timeout | undefined;
  nextSlot: number | null;
  runningHere: number;
  prepared: Promise<void> | undefined;
  removed: boolean;
}

/** How one execution is tracked while it runs. */
interface Execution {
  attempt: number;
  reason: RunReason;
  /** Its abort() is ctx.signal's. */
  controller: AbortController;
  /** Why ctx.signal was aborted, if it was (the first reason wins). */
  abortedBy?: 'stop' | 'lost' | 'timeout';
  /** Cleans up when the run ends (removes its stop listener). */
  dispose: () => void;
  /** Lease strategy: marks the run ended in the backend, before the result is stored. */
  finish?: (status: 'success' | 'failed' | 'interrupted') => Promise<void>;
  /** Lease strategy: gives an interrupted run to a backup now. true if it was handed over. */
  release?: () => Promise<boolean>;
}

function abortError(message: string, name = 'AbortError'): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/**
 * Runs cron and interval jobs once per scheduled time across any number of instances. No leader and
 * no locks: each run is claimed with one atomic operation on the backend that only one instance can
 * win, and a random delay before claiming spreads the work.
 *
 * With a lease-capable backend (Redis/Valkey 'lease' strategy) a running job also renews a lease.
 * That gives: no overlapping runs, backup runners when the runner dies or freezes, retries, and
 * catch-up of a run that was due while every instance was down.
 */
export class Scheduler {
  readonly instanceId: string;
  readonly backend: Backend;

  private readonly defaults: {
    jitterMs: number;
    maxLateMs: number;
    historySize: number;
    historyTtlMs?: number;
    timezone?: string;
  };
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly logger: Logger;
  private readonly unrefTimers: boolean;

  private readonly registry = new Map<string, Job>();
  private readonly emitter = new EventEmitter();
  private readonly inflight = new Set<Promise<unknown>>();
  /** Runs another instance is executing, that this instance is ready to take over. */
  private readonly watchers = new Map<string, NodeJS.Timeout>();
  /**
   * Leased runs this instance is executing right now (never watched: we know they are alive), with a
   * function that stops renewing the lease.
   */
  private readonly localRuns = new Map<string, () => void>();
  private state: 'idle' | 'starting' | 'running' | 'stopping' = 'idle';
  private abort = new AbortController();
  private ready: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;

  constructor(options: SchedulerOptions = {}) {
    this.instanceId = options.instanceId ?? `${hostname()}:${process.pid}`;
    if (typeof this.instanceId !== 'string' || this.instanceId === '') throw new TypeError('instanceId must be a non-empty string');
    const redisShortcuts =
      options.redis !== undefined || options.strategy !== undefined || options.prefix !== undefined || options.idmp !== undefined;
    if (options.backend && redisShortcuts) {
      throw new TypeError('Pass either backend, or the Redis shortcuts (redis, strategy, prefix, idmp), not both');
    }
    this.backend =
      options.backend ?? new RedisBackend({ redis: options.redis, strategy: options.strategy, prefix: options.prefix, idmp: options.idmp });
    this.defaults = {
      jitterMs: nonNegativeInt('jitterMs', options.jitterMs ?? 2_000),
      maxLateMs: positiveInt('maxLateMs', options.maxLateMs ?? 60_000),
      historySize: positiveInt('historySize', options.historySize ?? 1_000),
      timezone: options.timezone,
    };
    if (options.historyTtlMs !== undefined) this.defaults.historyTtlMs = positiveInt('historyTtlMs', options.historyTtlMs);
    this.leaseMs = positiveInt('leaseMs', options.leaseMs ?? 30_000);
    this.heartbeatMs = positiveInt('heartbeatMs', options.heartbeatMs ?? Math.min(5_000, Math.floor(this.leaseMs / 6)));
    if (this.heartbeatMs * 2 >= this.leaseMs) {
      throw new RangeError(
        `heartbeatMs (${this.heartbeatMs}) must be under half of leaseMs (${this.leaseMs}), so a lease is renewed at least twice`,
      );
    }
    this.logger = options.logger ?? console;
    this.unrefTimers = options.unrefTimers ?? false;
    if (options.log) this.logRuns();
  }

  // ---------------------------------------------------------------- jobs

  /** Adds a cron job. 5 fields, or 6 with seconds first: `'*\/10 * * * * *'`. */
  cron(name: string, expression: string, handler: JobHandler, options: CronJobOptions = {}): this {
    let schedule: Schedule;
    try {
      schedule = cronSchedule(expression, options.timezone ?? this.defaults.timezone);
    } catch (error) {
      throw new Error(`Job "${name}": invalid cron "${expression}": ${errorMessage(error)}`);
    }
    return this.add(name, schedule, handler, options);
  }

  /** Adds an interval job: ms or a string like `'10s'`, `'35m'`, `'1h30m'`. */
  every(name: string, interval: number | string, handler: JobHandler, options: EveryJobOptions = {}): this {
    const ms = parseDuration(interval);
    if (ms < 1_000) throw new RangeError(`Job "${name}": the interval must be at least 1s (got ${ms} ms)`);
    return this.add(name, everySchedule(ms, options.offsetMs ?? 0), handler, options);
  }

  /**
   * Adds a one-off job: it runs once, at `when`, on one instance (like SyncedCron's one-off jobs).
   * `when` is a Date, ms since epoch, or an ISO date string.
   */
  at(name: string, when: Date | number | string, handler: JobHandler, options: JobOptions = {}): this {
    const time = when instanceof Date ? when.getTime() : typeof when === 'number' ? when : Date.parse(when);
    if (!Number.isFinite(time)) throw new RangeError(`Job "${name}": invalid date ${String(when)}`);
    return this.add(name, onceSchedule(time), handler, options);
  }

  /** Stops scheduling a job on this instance. History is kept. */
  remove(name: string): boolean {
    const job = this.registry.get(name);
    if (!job) return false;
    job.removed = true;
    this.disarm(job);
    for (const [key, timer] of this.watchers) {
      if (key.startsWith(`${name}\u0000`)) {
        clearTimeout(timer);
        this.watchers.delete(key);
      }
    }
    this.registry.delete(name);
    return true;
  }

  // ---------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    if (this.state === 'running') return;
    if (this.state !== 'idle') throw new Error(`Cannot start while ${this.state}`);
    this.state = 'starting';
    try {
      await this.ensureReady();
      await Promise.all([...this.registry.values()].map((job) => this.prepare(job)));
    } catch (error) {
      this.state = 'idle';
      await this.closeBackend();
      throw error;
    }
    if ((this.state as string) !== 'starting') return; // stop() was called meanwhile
    this.abort = new AbortController();
    this.state = 'running';
    for (const job of this.registry.values()) {
      this.arm(job);
      if (this.backend.runs) void this.track(this.recover(job));
    }
  }

  /**
   * Stops scheduling, aborts `ctx.signal`, waits up to `timeoutMs` for running jobs to finish, then
   * closes the connections the backend opened.
   *
   * Lease strategy: a job that throws once its signal is aborted (e.g. `ctx.signal.throwIfAborted()`)
   * is handed to another instance right away. A job still running when the timeout passes stops
   * renewing its lease, so a backup takes it over when the lease runs out.
   */
  stop(options: { timeoutMs?: number } = {}): Promise<void> {
    this.stopping ??= this.doStop(options.timeoutMs ?? 30_000).finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }

  /** Runs a job now on this instance (not deduplicated) and records it in history. */
  async runNow(name: string): Promise<RunRecord> {
    const job = this.getJob(name);
    if (this.state !== 'running') throw new Error('Call start() before runNow()');
    await this.prepare(job);
    const runs = this.backend.runs;
    if (runs) {
      const token = randomUUID();
      for (let slot = Date.now(), tries = 0; tries < 10; slot++, tries++) {
        const outcome = await runs.claim({
          ...this.claimInput(job, slot),
          token,
          mode: 'new',
          reason: 'manual',
          leaseMs: this.leaseMs,
          overlap: 'allow',
          maxAttempts: 1,
          keepMs: job.keepMs,
        });
        if (outcome.kind === 'won') return this.track(this.executeLeased(runs, job, slot, token, 1, 'manual'));
      }
      throw new Error(`Could not start a manual run of "${name}"`);
    }
    const requested = Date.now();
    const slot = (await this.backend.recordManualRun(this.claimInput(job, requested))) ?? requested;
    return this.track(this.execute(job, slot, this.newRun(1, 'manual')));
  }

  // ---------------------------------------------------------------- read API

  /**
   * The latest runs of a job across all instances, newest first: who ran it, when it started, when it
   * finished and how it ended. Works for any job name, even one not registered here.
   */
  async history(name: string, limit = 20): Promise<RunRecord[]> {
    intInRange('limit', limit, 1, 10_000);
    await this.ensureReady();
    return this.backend.history(name, limit);
  }

  /** The most recent run of a job, or null if it never ran. */
  async lastRun(name: string): Promise<RunRecord | null> {
    const [last] = await this.history(name, 1);
    return last ?? null;
  }

  /** Next scheduled run of a registered job. */
  nextRun(name: string): Date | null {
    return this.nextRunOf(this.getJob(name));
  }

  /** The jobs registered on this instance. */
  jobs(): JobInfo[] {
    return [...this.registry.values()].map((job) => ({
      name: job.name,
      type: job.schedule.type,
      schedule: job.schedule.description,
      nextRunAt: this.nextRunOf(job),
      runningHere: job.runningHere,
    }));
  }

  // ---------------------------------------------------------------- events

  on<E extends keyof SchedulerEvents>(event: E, listener: (payload: SchedulerEvents[E]) => void): this {
    this.emitter.on(event, listener);
    return this;
  }

  once<E extends keyof SchedulerEvents>(event: E, listener: (payload: SchedulerEvents[E]) => void): this {
    this.emitter.once(event, listener);
    return this;
  }

  off<E extends keyof SchedulerEvents>(event: E, listener: (payload: SchedulerEvents[E]) => void): this {
    this.emitter.off(event, listener);
    return this;
  }

  // ---------------------------------------------------------------- scheduling

  private add(name: string, schedule: Schedule, handler: JobHandler, options: JobOptions): this {
    if (typeof name !== 'string' || name.trim() === '') throw new TypeError('Job name must be a non-empty string');
    if (this.registry.has(name)) throw new Error(`Job "${name}" is already registered`);
    if (typeof handler !== 'function') throw new TypeError(`Job "${name}": handler must be a function`);

    const jitterMs =
      options.jitterMs !== undefined
        ? nonNegativeInt('jitterMs', options.jitterMs)
        : Math.min(this.defaults.jitterMs, Math.floor(schedule.minGapMs / 4));
    if (jitterMs * 2 >= schedule.minGapMs) {
      throw new RangeError(`Job "${name}": jitterMs (${jitterMs}) must be under half the time between runs (${schedule.minGapMs} ms)`);
    }
    const maxLateMs =
      options.maxLateMs !== undefined ? positiveInt('maxLateMs', options.maxLateMs) : Math.max(this.defaults.maxLateMs, jitterMs + 1_000);
    if (maxLateMs <= jitterMs) {
      throw new RangeError(`Job "${name}": maxLateMs (${maxLateMs}) must be bigger than jitterMs (${jitterMs})`);
    }
    if (jitterMs + maxLateMs >= this.backend.dedupeWindowMs) {
      throw new RangeError(
        `Job "${name}": jitterMs + maxLateMs (${jitterMs + maxLateMs} ms) must be shorter than how long ` +
          `${this.backend.name} remembers a run (${this.backend.dedupeWindowMs} ms), or a late instance could run it again`,
      );
    }
    const historySize = options.historySize !== undefined ? positiveInt('historySize', options.historySize) : this.defaults.historySize;
    const historyTtlMs =
      options.historyTtlMs !== undefined ? positiveInt('historyTtlMs', options.historyTtlMs) : this.defaults.historyTtlMs;
    if (options.overlap !== undefined && options.overlap !== 'skip' && options.overlap !== 'allow') {
      throw new TypeError(`Job "${name}": overlap must be "skip" or "allow"`);
    }
    const timeoutMs = options.timeoutMs !== undefined ? positiveInt('timeoutMs', options.timeoutMs) : undefined;
    const maxAttempts = intInRange('maxAttempts', options.maxAttempts ?? 3, 1, 100);
    const catchUpMs = nonNegativeInt('catchUpMs', options.catchUpMs ?? 300_000);
    this.backend.checkJob?.({ name, jitterMs, maxLateMs, minGapMs: schedule.minGapMs, historySize, historyTtlMs });

    const job: Job = {
      name,
      schedule,
      handler,
      jitterMs,
      maxLateMs,
      historySize,
      historyTtlMs,
      overlap: options.overlap ?? 'skip',
      timeoutMs,
      maxAttempts,
      catchUpMs,
      // Covers the latest claim this job can make: a scheduled run up to maxLateMs late, or a
      // catch-up up to catchUpMs + jitterMs late.
      keepMs: Math.max(maxLateMs, catchUpMs + jitterMs) + CLOCK_TOLERANCE_MS,
      timer: undefined,
      nextSlot: null,
      runningHere: 0,
      prepared: undefined,
      removed: false,
    };
    this.registry.set(name, job);
    if (this.state === 'running') {
      this.arm(job);
      if (this.backend.runs) void this.track(this.recover(job));
    }
    return this;
  }

  /** Schedules the job's next run on this instance: run time + a random 0..jitterMs delay. */
  private arm(job: Job): void {
    if (this.state !== 'running' || job.removed) return;
    const slot = job.schedule.next(Date.now());
    job.nextSlot = slot;
    if (slot === null) return;
    this.sleepUntil(job, slot + this.jitter(job), () => {
      void this.track(this.fire(job, slot));
    });
  }

  private jitter(job: Job): number {
    return job.jitterMs > 0 ? Math.floor(Math.random() * (job.jitterMs + 1)) : 0;
  }

  private sleepUntil(job: Job, at: number, then: () => void): void {
    const wait = Math.max(0, Math.min(at - Date.now(), MAX_TIMER_MS));
    job.timer = setTimeout(() => {
      job.timer = undefined;
      if (this.state !== 'running' || job.removed) return;
      if (Date.now() < at) this.sleepUntil(job, at, then);
      else then();
    }, wait);
    if (this.unrefTimers) job.timer.unref();
  }

  private disarm(job: Job): void {
    if (job.timer) clearTimeout(job.timer);
    job.timer = undefined;
  }

  /** A scheduled run is due. Never rejects: problems are reported as events. */
  private async fire(job: Job, slot: number): Promise<void> {
    this.arm(job); // schedule the next run first, so a long job doesn't delay it

    const lateMs = Date.now() - slot;
    if (lateMs > job.maxLateMs) {
      this.emit('skip', { job: job.name, slot, scheduledAt: new Date(slot), instanceId: this.instanceId, reason: 'late', lateMs });
      return;
    }
    if (this.backend.runs) return this.claimRun(this.backend.runs, job, slot, 'scheduled');

    const input = this.claimInput(job, slot);
    let won: boolean;
    try {
      await this.ensureReady();
      await this.prepare(job);
      won = await this.backend.claim(input);
    } catch (error) {
      this.emit('error', { error, job: job.name, slot });
      return;
    }
    if (!won) {
      this.emit('skip', { job: job.name, slot, scheduledAt: new Date(slot), instanceId: this.instanceId, reason: 'taken' });
      return;
    }
    if (this.backend.recordClaim) {
      // The run is ours either way; a failed history write must not cancel it.
      await this.backend.recordClaim(input).catch((error: unknown) => this.emit('error', { error, job: job.name, slot }));
    }
    await this.execute(job, slot, this.newRun(1, 'scheduled'));
  }

  // ---------------------------------------------------------------- lease strategy

  /**
   * Called on start and when a job is added: picks up what other instances left behind.
   * - unfinished runs whose runner died (e.g. every instance restarted mid-run): take them over
   * - unfinished runs that are still alive: watch them, to back them up
   * - the latest run, if it was due while every instance was down: run it now (catch-up)
   */
  private async recover(job: Job): Promise<void> {
    const runs = this.backend.runs!;
    try {
      await this.ensureReady();
      const latest = job.schedule.prev(Date.now());
      for (const run of await runs.active(job.name)) {
        if (this.state !== 'running' || job.removed) return;
        if (run.alive) this.watch(runs, job, run.slot);
        // Retry a dead run only while it is still the latest run of the job; an older one is
        // superseded (it is marked interrupted when the next run starts).
        else if (latest === null || run.slot >= latest) void this.track(this.claimRun(runs, job, run.slot, 'takeover'));
      }
    } catch (error) {
      this.emit('error', { error, job: job.name });
    }
    if (job.catchUpMs === 0) return;
    const now = Date.now();
    const previous = job.schedule.prev(now);
    if (previous === null || now - previous > job.catchUpMs) return;
    await sleep(this.jitter(job)); // spread which instance catches up
    if (this.state === 'running' && !job.removed) await this.claimRun(runs, job, previous, 'catch-up');
  }

  /** Claims a run (or the next attempt of a dead one) and runs it if this instance wins. */
  private async claimRun(runs: RunStore, job: Job, slot: number, reason: RunReason): Promise<void> {
    const input = this.claimInput(job, slot);
    let outcome: ClaimOutcome;
    try {
      await this.ensureReady();
      outcome = await runs.claim({
        ...input,
        mode: reason === 'takeover' ? 'takeover' : 'new',
        reason,
        leaseMs: this.leaseMs,
        overlap: job.overlap,
        maxAttempts: job.maxAttempts,
        // Checked again on the server's clock, in case this claim was delayed on its way
        maxLateMs: (reason === 'catch-up' ? job.catchUpMs + job.jitterMs : job.maxLateMs) + CLOCK_TOLERANCE_MS,
        keepMs: job.keepMs,
      });
    } catch (error) {
      this.emit('error', { error, job: job.name, slot });
      if (reason === 'takeover') this.watch(runs, job, slot); // try again later
      return;
    }
    const skip = (why: SkipEvent['reason'], lateMs?: number) => {
      if (reason === 'takeover' || reason === 'catch-up') return; // background checks don't report skips
      const event: SkipEvent = { job: job.name, slot, scheduledAt: new Date(slot), instanceId: this.instanceId, reason: why };
      if (lateMs !== undefined) event.lateMs = lateMs;
      this.emit('skip', event);
    };
    switch (outcome.kind) {
      case 'won':
        this.unwatch(job, slot);
        await this.executeLeased(runs, job, slot, input.token, outcome.attempt, outcome.attempt > 1 ? 'takeover' : reason);
        return;
      case 'running': // someone alive runs it: be its backup
        skip('taken');
        this.watch(runs, job, slot);
        return;
      case 'overlap': // the previous run is still going: skip this one, back that one up
        skip('overlap');
        this.watch(runs, job, outcome.slot);
        // Another instance may still start this run once the previous one ends: be its backup then.
        this.watch(runs, job, slot);
        return;
      case 'late':
        skip('late', outcome.lateMs);
        return;
      case 'none': {
        // Skipped here as an overlap, and not started by anyone yet. Keep checking while another
        // instance could still start it: it is the job's latest run and not too late.
        const now = Date.now();
        const latest = job.schedule.prev(now);
        if ((latest === null || slot >= latest) && now - slot <= job.maxLateMs + CLOCK_TOLERANCE_MS) this.watch(runs, job, slot);
        return;
      }
      default: // done, given up, or never claimed
        this.unwatch(job, slot);
        skip('taken');
    }
  }

  /**
   * Checks a run another instance is executing every 1 to 2 heartbeats, until it ends or dies. So a
   * crashed run is taken over soon after its lease runs out, and a released one within 2 heartbeats.
   */
  private watch(runs: RunStore, job: Job, slot: number): void {
    const key = `${job.name}\u0000${slot}`;
    if (this.watchers.has(key) || this.localRuns.has(key) || this.state !== 'running' || job.removed) return;
    // At a random moment, so backups don't all try at once.
    const delay = Math.floor(this.heartbeatMs * (1 + Math.random()));
    const timer = setTimeout(() => {
      this.watchers.delete(key);
      if (this.state === 'running' && !job.removed) void this.track(this.claimRun(runs, job, slot, 'takeover'));
    }, delay);
    if (this.unrefTimers) timer.unref();
    this.watchers.set(key, timer);
  }

  private unwatch(job: Job, slot: number): void {
    const key = `${job.name}\u0000${slot}`;
    const timer = this.watchers.get(key);
    if (timer) clearTimeout(timer);
    this.watchers.delete(key);
  }

  /** Runs a job this instance claimed, renewing its lease until it ends. */
  private async executeLeased(
    runs: RunStore,
    job: Job,
    slot: number,
    token: string,
    attempt: number,
    reason: RunReason,
  ): Promise<RunRecord> {
    const run = this.newRun(attempt, reason);
    const key = `${job.name}\u0000${slot}`;
    let lost = false;
    const markLost = () => {
      if (lost) return;
      lost = true;
      this.abortRun(run, 'lost', abortError('This run was taken over by another instance'));
      this.emit('lost', { job: job.name, slot, attempt, instanceId: this.instanceId });
    };
    const heartbeat = setInterval(() => {
      runs.heartbeat(job.name, slot, token, this.leaseMs).then(
        (ok) => {
          if (!ok) markLost();
        },
        (error: unknown) => this.emit('error', { error, job: job.name, slot }),
      );
    }, this.heartbeatMs);
    if (this.unrefTimers) heartbeat.unref();
    this.localRuns.set(key, () => clearInterval(heartbeat));

    run.finish = async (status) => {
      // Keep renewing the lease until the end is stored: if Redis is briefly unreachable here, a
      // backup must not re-run a job that already completed.
      for (let delay = 200; !lost && this.state !== 'idle'; delay = Math.min(delay * 2, this.heartbeatMs)) {
        try {
          if (!(await runs.finish(job.name, slot, token, status))) markLost();
          break;
        } catch (error) {
          this.emit('error', { error, job: job.name, slot });
          if (this.state !== 'running') break;
          await sleep(delay);
        }
      }
      clearInterval(heartbeat);
    };
    run.release = async () => {
      clearInterval(heartbeat);
      if (lost) return false;
      try {
        return await runs.release(job.name, slot, token);
      } catch (error) {
        this.emit('error', { error, job: job.name, slot });
        return false; // the lease runs out on its own, then a backup takes over
      }
    };
    try {
      return await this.execute(job, slot, run);
    } finally {
      clearInterval(heartbeat);
      this.localRuns.delete(key);
    }
  }

  // ---------------------------------------------------------------- running a job

  private async execute(job: Job, slot: number, run: Execution): Promise<RunRecord> {
    const scheduledAt = new Date(slot);
    const startedAt = Date.now();
    const manual = run.reason === 'manual';
    job.runningHere++;
    this.emit('start', { job: job.name, slot, scheduledAt, instanceId: this.instanceId, manual, attempt: run.attempt, reason: run.reason });

    let failure: { cause: unknown } | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      const work = Promise.resolve().then(() =>
        job.handler({
          name: job.name,
          slot,
          scheduledAt,
          instanceId: this.instanceId,
          manual,
          signal: run.controller.signal,
          attempt: run.attempt,
          reason: run.reason,
        }),
      );
      if (job.timeoutMs === undefined) {
        await work;
      } else {
        work.catch(() => {}); // it may fail after the timeout; that is already reported
        await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              const error = abortError(`Timed out after ${job.timeoutMs} ms`, 'TimeoutError');
              this.abortRun(run, 'timeout', error);
              reject(error);
            }, job.timeoutMs);
          }),
        ]);
      }
    } catch (cause) {
      failure = { cause };
    } finally {
      clearTimeout(timer);
      run.dispose();
      job.runningHere--;
    }

    // A job that throws after stop() or a takeover aborted it didn't fail: it was interrupted.
    const interrupted = failure !== undefined && (run.abortedBy === 'stop' || run.abortedBy === 'lost');
    const status = interrupted ? 'interrupted' : failure ? 'failed' : 'success';
    // After stop() has returned, nothing is written any more (the lease runs out on its own).
    const stopped = this.state === 'idle';
    let handedOver = false;
    if (!stopped) {
      // Stopped mid-run: give the run to another instance now. Manual runs are never retried.
      if (interrupted && run.abortedBy === 'stop' && run.release && !manual) handedOver = await run.release();
      else await run.finish?.(status);
    }
    const finishedAt = Date.now();
    const result: StoredResult = {
      slot,
      by: this.instanceId,
      attempt: run.attempt,
      status,
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
    };
    if (failure) result.error = describeError(failure.cause);

    if (!stopped) {
      try {
        await this.ensureReady();
        await this.backend.saveResult(job.name, result, job.historySize, job.historyTtlMs);
      } catch (error) {
        this.emit('error', { error, job: job.name, slot });
      }
    }

    const record: RunRecord = {
      job: job.name,
      slot,
      scheduledAt,
      instanceId: this.instanceId,
      manual,
      attempt: run.attempt,
      reason: run.reason,
      status,
      startedAt: new Date(startedAt),
      finishedAt: new Date(finishedAt),
      durationMs: result.durationMs,
    };
    if (result.error !== undefined) record.error = result.error;
    if (interrupted) this.emit('interrupted', { ...record, cause: failure!.cause, handedOver });
    else if (failure) this.emit('failure', { ...record, cause: failure.cause });
    else this.emit('success', record);
    return record;
  }

  /** A new execution. Its signal aborts when the scheduler stops; the listener goes when the run ends. */
  private newRun(attempt: number, reason: RunReason): Execution {
    const parent = this.abort.signal;
    const run: Execution = { attempt, reason, controller: new AbortController(), dispose: () => {} };
    const onStop = () => this.abortRun(run, 'stop', abortError('The scheduler is stopping'));
    if (parent.aborted) {
      onStop();
    } else {
      parent.addEventListener('abort', onStop, { once: true });
      run.dispose = () => parent.removeEventListener('abort', onStop);
    }
    return run;
  }

  private abortRun(run: Execution, by: 'stop' | 'lost' | 'timeout', reason: Error): void {
    if (run.controller.signal.aborted) return;
    run.abortedBy = by;
    run.controller.abort(reason);
  }

  private claimInput(job: Job, slot: number): ClaimInput {
    const input: ClaimInput = { job: job.name, slot, token: randomUUID(), instanceId: this.instanceId, historySize: job.historySize };
    if (job.historyTtlMs !== undefined) input.historyTtlMs = job.historyTtlMs;
    return input;
  }

  /** `log: true`: one line per start, success, failure, skip and lost run. */
  private logRuns(): void {
    const info = (message: string) => (this.logger.info ? this.logger.info(message) : console.log(message));
    const at = (slot: number) => new Date(slot).toISOString();
    this.on('start', (e) => info(`[anarchon] ${e.job} @ ${at(e.slot)}: started on ${e.instanceId} (attempt ${e.attempt}, ${e.reason})`));
    this.on('success', (r) => info(`[anarchon] ${r.job} @ ${at(r.slot)}: finished in ${r.durationMs} ms`));
    this.on('failure', (r) => this.logger.warn(`[anarchon] ${r.job} @ ${at(r.slot)}: failed after ${r.durationMs} ms: ${r.error}`));
    this.on('interrupted', (r) =>
      info(
        `[anarchon] ${r.job} @ ${at(r.slot)}: interrupted after ${r.durationMs} ms${r.handedOver ? ', handed over to another instance' : ''}`,
      ),
    );
    this.on('skip', (e) => info(`[anarchon] ${e.job} @ ${at(e.slot)}: skipped (${e.reason})`));
    this.on('lost', (e) => this.logger.warn(`[anarchon] ${e.job} @ ${at(e.slot)}: attempt ${e.attempt} was taken over by a backup`));
  }

  // ---------------------------------------------------------------- plumbing

  private async doStop(timeoutMs: number): Promise<void> {
    if (this.state === 'running' || this.state === 'starting') {
      this.state = 'stopping';
      for (const job of this.registry.values()) this.disarm(job);
      for (const timer of this.watchers.values()) clearTimeout(timer);
      this.watchers.clear();
      this.abort.abort();
      await this.waitForRuns(timeoutMs);
      // Runs still going now are left to their lease: it runs out, and a backup takes them over.
      for (const stopRenewing of this.localRuns.values()) stopRenewing();
    }
    this.state = 'idle';
    await this.closeBackend();
  }

  private async waitForRuns(timeoutMs: number): Promise<void> {
    if (this.inflight.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    await Promise.race([Promise.allSettled([...this.inflight]), timeout]);
    clearTimeout(timer);
  }

  private ensureReady(): Promise<void> {
    this.ready ??= this.backend.init().catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  private prepare(job: Job): Promise<void> {
    job.prepared ??= this.backend.prepareJob(job.name, job.historySize).catch((error: unknown) => {
      job.prepared = undefined;
      throw error;
    });
    return job.prepared;
  }

  private async closeBackend(): Promise<void> {
    this.ready = undefined;
    for (const job of this.registry.values()) job.prepared = undefined;
    try {
      await this.backend.close();
    } catch (error) {
      this.logger.warn(`[anarchon] closing ${this.backend.name} failed: ${errorMessage(error)}`);
    }
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.inflight.add(promise);
    const remove = () => {
      this.inflight.delete(promise);
    };
    promise.then(remove, remove);
    return promise;
  }

  private emit<E extends keyof SchedulerEvents>(event: E, payload: SchedulerEvents[E]): void {
    if (event === 'error' && this.emitter.listenerCount('error') === 0) {
      const { error, job } = payload as SchedulerErrorEvent;
      this.logger.error(`[anarchon]${job ? ` job "${job}":` : ''} ${errorMessage(error)}`);
      return;
    }
    try {
      this.emitter.emit(event, payload);
    } catch (error) {
      this.logger.error(`[anarchon] a "${event}" listener threw: ${errorMessage(error)}`);
    }
  }

  private getJob(name: string): Job {
    const job = this.registry.get(name);
    if (!job) throw new Error(`Unknown job "${name}"`);
    return job;
  }

  private nextRunOf(job: Job): Date | null {
    const slot = this.state === 'running' ? job.nextSlot : job.schedule.next(Date.now());
    return slot === null ? null : new Date(slot);
  }
}
