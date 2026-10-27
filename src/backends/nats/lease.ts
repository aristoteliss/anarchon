/* Copyright (C) 2026-present Aristotelis — see repository license. */

import type { JetStreamClient, JetStreamManager } from '@nats-io/jetstream';
import type { KV } from '@nats-io/kv';

import { coded } from '../../errors';
import { type ClaimRecord, claimPayload, parseJson } from '../../history';
import { checkStoreFormat, STORE_FORMAT } from '../../store-format';
import type { ClaimOutcome, RunClaim, RunStatus, RunStore } from '../../types';

/**
 * The 'lease' strategy of {@link NatsBackend}: the same lease rules as the Redis 'lease' strategy,
 * on a JetStream key-value bucket.
 *
 * **The algorithm.** Each job has one key, `<job>`, whose value holds the state of the job's runs.
 * The bucket keeps a revision per key, and a write can say "only if the key is still at revision
 * N": JetStream refuses it when anyone wrote in between. Every decision is one such write:
 *
 * 1. Read the job's runs, their revision, and the server's clock (stream info `ts`).
 * 2. Decide as the Redis CLAIM script does: no state for the run -> start it with attempt 1; a live
 *    lease -> 'running'; a lease that ran out -> the next attempt; finished -> 'done'. A new run is
 *    refused ('overlap') while an older run of the job has a live lease.
 * 3. Write the new state at the revision read. If another instance wrote first, the write is
 *    refused: read again and decide again. So of all the instances that claim one attempt, exactly
 *    one writes it.
 *
 * Heartbeat, release and finish are the same read-decide-write on the job's key, and change the
 * run only while its stored token is the caller's: after a takeover, the old runner changes nothing.
 *
 * The bucket `<stream>_RUNS` keeps the latest value only. A job's value keeps unfinished runs and
 * runs young enough that a late claim could still ask for them (`keepMs`). History (one claim per
 * attempt, one result per attempt) goes to the backend's stream, as with the 'msg-id' strategy.
 */

/** How many times in a row a write may lose its race to another instance before the call fails. */
const WRITE_TRIES = 20;
/** JetStream's answers to a write whose expected revision is out of date. */
const WRONG_REVISION = new Set([10_071, 10_164]);
/** The key that records the store format. Job names have no dots, so it can't be a job's key. */
const FORMAT_KEY = 'meta.format';

/** One run's state, with the fields of the Redis 'lease' strategy. */
interface StoredRun {
  /** Current attempt. */
  a: number;
  /** The attempt limit the run started with. */
  m?: number;
  /** Hand-overs on stop(): they don't count against the limit. */
  r?: number;
  /** The current attempt's token. */
  t: string;
  /** Status. */
  s: 'running' | 'success' | 'failed' | 'interrupted';
  /** The instance running the current attempt. */
  i: string;
  /** Lease end on the server's clock (ms); 0 once released or finished. */
  l: number;
}

/** A job's runs by slot. */
type JobRuns = Record<string, StoredRun>;

/** The value of a job's key. Fields a newer version adds are kept on every write. */
type StoredJob = Record<string, unknown> & { runs: JobRuns };

/** A job's value, the revision it was read at (0: no key yet), and the server's clock then. */
interface Snapshot {
  stored: StoredJob;
  revision: number;
  now: number;
}

/** What a claim does with the job's runs, decided on the server's clock. */
type ClaimStep =
  /** Answer without writing. */
  | { kind: 'answer'; outcome: ClaimOutcome }
  /** Write the job's runs, then answer. */
  | { kind: 'write'; runs: JobRuns; outcome: ClaimOutcome };

/**
 * The {@link RunStore} of `NatsBackend` with the 'lease' strategy. The backend creates it; reach it
 * as `backend.runs`.
 *
 * @example Which runs of a job are unfinished, and whether their runner is alive
 * ```ts
 * const backend = new NatsBackend({ servers: process.env.NATS_URL, strategy: 'lease' });
 * await backend.init();
 * for (const run of await backend.runs.active('nightly-export')) {
 *   console.log(new Date(run.slot), `attempt ${run.attempt}`, run.alive ? 'running' : 'waiting for a backup');
 * }
 * ```
 */
export class NatsLeaseStore implements RunStore {
  private kv: Promise<KV> | undefined;

  /**
   * @param state The backend's connection, opened on first use.
   * @param bucket The key-value bucket of the runs' state.
   * @param prefix The backend's subject prefix: claims go to `<prefix><job>.claims`.
   * @param replicas Replicas of a new bucket; undefined: 1. An existing bucket keeps its own.
   */
  constructor(
    private readonly state: () => Promise<{
      js: JetStreamClient;
      jsm: JetStreamManager;
    }>,
    private readonly bucket: string,
    private readonly prefix: string,
    private readonly replicas: number | undefined,
  ) {}

  /** Opens or creates the bucket, checks the server reports its clock, and checks the store format. */
  async init(): Promise<void> {
    const kv = await this.open();
    await this.serverNow();

    await kv.create(FORMAT_KEY, String(STORE_FORMAT)).catch(ignoreConflict);
    const format = await kv.get(FORMAT_KEY);
    checkStoreFormat(format?.string(), `The NATS bucket "${this.bucket}"`);
  }

  /** Reads the job's runs, decides, and writes at the revision read: one winner per attempt. */
  async claim(input: RunClaim): Promise<ClaimOutcome> {
    const { job } = input;

    for (let tries = 0; tries < WRITE_TRIES; tries++) {
      const { stored, revision, now } = await this.load(job);
      const step = decideClaim(stored.runs, input, now);
      if (step.kind === 'answer') return step.outcome;

      const value = { ...stored, runs: step.runs };
      const saved = await this.save(job, value, revision);
      if (!saved) continue; // another instance wrote first: decide again

      // The attempt is stored: if recording it in history fails, the claim fails, nobody renews
      // the lease, and a backup takes the run over once it runs out.
      if (step.outcome.kind === 'won') {
        await this.recordAttempt(input, step.outcome.attempt, now);
      }
      return step.outcome;
    }

    throw lostRaces(job);
  }

  /** Moves the lease end to now + leaseMs, if the run still carries this token. */
  async heartbeat(
    job: string,
    slot: number,
    token: string,
    leaseMs: number,
  ): Promise<boolean> {
    // A released lease (l = 0) stays released: a heartbeat sent before the release can arrive after it.
    return this.change(job, slot, (run, now) => {
      const renewable = run.t === token && run.s === 'running' && run.l !== 0;
      return renewable ? { ...run, l: now + leaseMs } : undefined;
    });
  }

  /** Marks the run ended, if it still carries this token. */
  async finish(
    job: string,
    slot: number,
    token: string,
    status: 'success' | 'failed' | 'interrupted',
  ): Promise<boolean> {
    return this.change(job, slot, (run) =>
      run.t === token ? { ...run, s: status, l: 0 } : undefined,
    );
  }

  /** Ends a live lease now and counts a hand-over, if the run still carries this token. */
  async release(job: string, slot: number, token: string): Promise<boolean> {
    // Only a live lease can be released; a runner whose lease already ran out counts as having died.
    return this.change(job, slot, (run, now) => {
      const live = run.t === token && run.s === 'running' && run.l >= now;
      return live ? { ...run, l: 0, r: (run.r ?? 0) + 1 } : undefined;
    });
  }

  /** The job's unfinished runs, each with whether its lease is alive on the server's clock. */
  async active(
    job: string,
  ): Promise<Array<{ slot: number; attempt: number; alive: boolean }>> {
    const { stored, now } = await this.load(job);

    return Object.entries(stored.runs)
      .filter(([, run]) => run.s === 'running')
      .map(([slot, run]) => ({
        slot: Number(slot),
        attempt: run.a,
        alive: run.l >= now,
      }))
      .sort((x, y) => x.slot - y.slot);
  }

  /**
   * For history(): the status of an attempt without a result. 'running' only while it is the
   * current attempt with a live lease; otherwise 'interrupted'.
   */
  async pendingStatus(
    job: string,
  ): Promise<(claim: ClaimRecord & { attempt: number }) => RunStatus> {
    const { stored, now } = await this.load(job);
    return (claim) =>
      pendingStatusOf(stored.runs[claim.slot], claim.attempt, now);
  }

  /** Forgets the bucket handle: the backend closed the connection it belongs to. */
  close(): void {
    this.kv = undefined;
  }

  /** Rewrites one run with what `next` returns; false when the run is gone or `next` refuses. */
  private async change(
    job: string,
    slot: number,
    next: (run: StoredRun, now: number) => StoredRun | undefined,
  ): Promise<boolean> {
    for (let tries = 0; tries < WRITE_TRIES; tries++) {
      const { stored, revision, now } = await this.load(job);
      const run = stored.runs[slot];
      const changed = run && next(run, now);
      if (!changed) return false;

      const runs = { ...stored.runs, [slot]: changed };
      const saved = await this.save(job, { ...stored, runs }, revision);
      if (saved) return true;
    }

    throw lostRaces(job);
  }

  /** The job's value and its revision, read together with the server's clock. */
  private async load(job: string): Promise<Snapshot> {
    const kv = await this.open();
    const [entry, now] = await Promise.all([kv.get(job), this.serverNow()]);

    const stored =
      entry?.operation === 'PUT' ? toStoredJob(job, entry.string()) : undefined;
    return {
      stored: stored ?? { runs: {} },
      revision: entry?.revision ?? 0,
      now,
    };
  }

  /** Writes the job's value if nobody wrote since `revision`; false when another instance did. */
  private async save(
    job: string,
    value: StoredJob,
    revision: number,
  ): Promise<boolean> {
    const kv = await this.open();
    const text = JSON.stringify(value);

    try {
      if (revision === 0) await kv.create(job, text);
      else await kv.update(job, text, revision);
      return true;
    } catch (error) {
      if (isConflict(error)) return false;
      throw error;
    }
  }

  /** Appends the won attempt to the job's history in the backend's stream. */
  private async recordAttempt(
    input: RunClaim,
    attempt: number,
    now: number,
  ): Promise<void> {
    const { job, slot, reason } = input;
    const { js } = await this.state();
    const claim = claimPayload(input, reason === 'manual');
    const record = { ...claim, at: now, attempt, reason };

    // The ID makes a publish the client sends twice one record.
    await js.publish(`${this.prefix}${job}.claims`, JSON.stringify(record), {
      msgID: `${job}:${slot}:${attempt}`,
    });
  }

  /** The NATS server's clock (ms): leases are decided on it, never on an instance's clock. */
  private async serverNow(): Promise<number> {
    const { jsm } = await this.state();
    const { ts } = await jsm.streams.info(`KV_${this.bucket}`);

    const now = Date.parse(ts ?? '');
    if (Number.isNaN(now)) {
      throw coded(
        new Error(
          'The NATS "lease" strategy needs nats-server 2.10 or newer, which reports its clock',
        ),
        'ANARCHON_SERVER',
      );
    }
    return now;
  }

  private open(): Promise<KV> {
    this.kv ??= this.openBucket().catch((error: unknown) => {
      this.kv = undefined;
      throw error;
    });
    return this.kv;
  }

  /** Opens the bucket, creating it on first use. */
  private async openBucket(): Promise<KV> {
    const { js } = await this.state();
    const { Kvm } = await loadKv();

    // One value per key: a job's runs are rewritten in place, and older revisions serve nobody.
    return new Kvm(js).create(this.bucket, {
      history: 1,
      replicas: this.replicas ?? 1,
    });
  }
}

/** The lease state machine, the same as the Redis CLAIM script, and in its order. */
function decideClaim(runs: JobRuns, input: RunClaim, now: number): ClaimStep {
  const run = runs[input.slot];
  if (!run) {
    return input.mode === 'takeover'
      ? answer({ kind: 'none' })
      : startRun(runs, input, now);
  }

  // Our own claim, sent again.
  if (run.t === input.token && run.s === 'running') {
    return answer({ kind: 'won', attempt: run.a });
  }
  if (run.s !== 'running') return answer({ kind: 'done' });
  if (run.l >= now) return answer({ kind: 'running', attempt: run.a });

  return takeOver(runs, run, input, now);
}

/** A run nobody claimed yet: refused when too late or overlapping a live run, else attempt 1. */
function startRun(runs: JobRuns, input: RunClaim, now: number): ClaimStep {
  const { slot, maxLateMs, overlap, keepMs } = input;

  // A claim that arrives too late (delayed, or queued while the server was unreachable) must not
  // start a stale run, or one so old that it may have been trimmed already.
  const lateMs = now - slot;
  if (maxLateMs && lateMs > maxLateMs) return answer({ kind: 'late', lateMs });

  const live = liveSlot(runs, now);
  if (overlap === 'skip' && live !== undefined) {
    return answer({ kind: 'overlap', slot: live });
  }

  const started = {
    ...endDeadRuns(runs, slot, now),
    [slot]: newRun(input, now),
  };
  return write(trim(started, now, keepMs ?? 0), { kind: 'won', attempt: 1 });
}

/** The runner stopped renewing its lease before finishing: it died, froze, or handed the run over. */
function takeOver(
  runs: JobRuns,
  run: StoredRun,
  input: RunClaim,
  now: number,
): ClaimStep {
  const { slot, token, instanceId, leaseMs } = input;

  // A run keeps the attempt limit it started with (manual runs: 1); hand-overs don't count.
  const limit = run.m ?? input.maxAttempts;
  if (run.a - (run.r ?? 0) >= limit) {
    const ended: StoredRun = { ...run, s: 'interrupted' };
    return write({ ...runs, [slot]: ended }, { kind: 'done' });
  }

  const attempt = run.a + 1;
  const next: StoredRun = {
    ...run,
    a: attempt,
    m: limit,
    t: token,
    i: instanceId,
    l: now + leaseMs,
  };
  return write({ ...runs, [slot]: next }, { kind: 'won', attempt });
}

/** The first attempt of a run, with a lease from now. */
function newRun(input: RunClaim, now: number): StoredRun {
  const { maxAttempts, token, instanceId, leaseMs } = input;
  return {
    a: 1,
    m: maxAttempts,
    t: token,
    s: 'running',
    i: instanceId,
    l: now + leaseMs,
  };
}

/** The earliest run of the job that a live runner holds; undefined when there is none. */
function liveSlot(runs: JobRuns, now: number): number | undefined {
  const live = Object.entries(runs)
    .filter(([, run]) => run.s === 'running' && run.l >= now)
    .map(([slot]) => Number(slot));

  return live.length > 0 ? Math.min(...live) : undefined;
}

/** Older runs whose runner died stop waiting for a backup once a newer run starts. */
function endDeadRuns(runs: JobRuns, slot: number, now: number): JobRuns {
  const ended: JobRuns = {};
  for (const [key, run] of Object.entries(runs)) {
    const dead = run.s === 'running' && run.l < now && Number(key) < slot;
    ended[key] = dead ? { ...run, s: 'interrupted' } : run;
  }
  return ended;
}

/**
 * Forgets finished runs no claim can ask about any more: a new claim later than its maxLateMs is
 * refused, and keepMs covers the maxLateMs of every claim of the job.
 */
function trim(runs: JobRuns, now: number, keepMs: number): JobRuns {
  const kept = Object.entries(runs).filter(
    ([slot, run]) => run.s === 'running' || now - Number(slot) <= keepMs,
  );
  return Object.fromEntries(kept);
}

/** An attempt without a result is 'running' only while it is the current attempt with a live lease. */
function pendingStatusOf(
  run: StoredRun | undefined,
  attempt: number,
  now: number,
): RunStatus {
  if (!run || run.a !== attempt) return 'interrupted';
  if (run.s === 'running') return run.l >= now ? 'running' : 'interrupted';
  return run.s;
}

function answer(outcome: ClaimOutcome): ClaimStep {
  return { kind: 'answer', outcome };
}

function write(runs: JobRuns, outcome: ClaimOutcome): ClaimStep {
  return { kind: 'write', runs, outcome };
}

/** The value of a job's key; refuses a value that is not a job's runs. */
function toStoredJob(job: string, text: string): StoredJob {
  const value = parseJson(text) as Partial<StoredJob> | null;
  if (value?.runs && typeof value.runs === 'object') return value as StoredJob;

  throw coded(
    new Error(
      `The NATS key "${job}" holds a value that is not the state of anarchon runs`,
    ),
    'ANARCHON_STORE',
  );
}

function isConflict(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return WRONG_REVISION.has(Number(code));
}

/** A create that lost to another instance's create is fine: the key holds what both wrote. */
function ignoreConflict(error: unknown): void {
  if (!isConflict(error)) throw error;
}

function lostRaces(job: string): Error {
  return coded(
    new Error(
      `Job "${job}": other instances wrote its state ${WRITE_TRIES} times in a row while this one tried to; try again`,
    ),
    'ANARCHON_STORE',
  );
}

/** Loads the key-value client; refuses when it is not installed. */
async function loadKv(): Promise<typeof import('@nats-io/kv')> {
  try {
    return await import('@nats-io/kv');
  } catch {
    throw coded(
      new Error(
        'The NATS "lease" strategy needs "@nats-io/kv": run `npm install @nats-io/kv`.',
      ),
      'ANARCHON_MISSING_DRIVER',
    );
  }
}
