/* Copyright (C) 2026-present Aristotelis — see repository license. */

import type {
  JetStreamClient,
  JetStreamManager,
  JsMsg,
} from '@nats-io/jetstream';
import type { NatsConnection } from '@nats-io/transport-node';
import { coded } from '../../errors';

import {
  buildHistory,
  type ClaimRecord,
  claimPayload,
  parseJson,
  toClaim,
  toResult,
} from '../../history';
import { keysOf } from '../../option-keys';
import type {
  Backend,
  ClaimInput,
  JobLimits,
  RunReason,
  RunRecord,
  RunStore,
  StoredResult,
} from '../../types';
import {
  assertSimpleName,
  claimManualSlot,
  errorMessage,
  positiveInt,
  refuseHistoryTtl,
  refuseUnknown,
} from '../../util';
import { NatsLeaseStore } from './lease';

/**
 * How {@link NatsBackend} picks the single runner of each run.
 * - `msg-id` (default): every instance publishes its claim with the same `Nats-Msg-Id`, and
 *   JetStream keeps the first one. One winner per run, nothing more.
 * - `lease`: a JetStream key-value bucket holds each job's runs, and a write succeeds only if
 *   nobody wrote since it was read. Adds no overlapping runs, backup runners when the winner dies
 *   or freezes, catch-up of a run missed while every instance was down, and retries. Needs
 *   nats-server 2.10 or newer and the `@nats-io/kv` package.
 *
 * Every instance of a service must use the same strategy: the two don't see each other's claims.
 *
 * @example
 * ```ts
 * new NatsBackend({ strategy: 'lease' }); // backups, no overlap, catch-up, retries
 * new NatsBackend();                      // 'msg-id': one winner per run
 * ```
 */
export type NatsStrategyName = 'msg-id' | 'lease';

/**
 * The parts of a NATS connection this backend uses: a connection from `@nats-io/transport-node`
 * fits. Share the app's connection instead of opening a second one.
 *
 * @example
 * ```ts
 * import { connect } from '@nats-io/transport-node';
 * const nc = await connect({ servers: process.env.NATS_URL, name: 'billing-api' });
 * new Scheduler({ backend: new NatsBackend({ connection: nc }) }); // stop() leaves nc open
 * ```
 */
export interface NatsConnectionLike {
  /** Only called on connections anarchon opened. */
  close(): Promise<void>;
}

/**
 * Options of {@link NatsBackend}.
 *
 * @example A three-node cluster: the stream replicated, so its memory of claimed runs survives a node
 * ```ts
 * new NatsBackend({
 *   servers: ['nats://n1:4222', 'nats://n2:4222', 'nats://n3:4222'],
 *   stream: 'BILLING_CRON',
 *   prefix: 'billing.cron.',
 *   replicas: 3,
 *   duplicateWindowMs: 10 * 60_000, // instances may claim up to 10 min late
 * });
 * ```
 */
export interface NatsBackendOptions<
  S extends NatsStrategyName = NatsStrategyName,
> {
  /**
   * How the single runner of each run is chosen (see {@link NatsStrategyName}). Default 'msg-id':
   * one winner per run, so a scheduler on it takes no lease options. 'lease' also gives no
   * overlapping runs, backup runners, catch-up and retries; its runs' state goes to the key-value
   * bucket `<stream>_RUNS`, so the stream name may then contain only letters, digits, "_" and "-".
   *
   * @example
   * ```ts
   * new NatsBackend({ servers: process.env.NATS_URL, strategy: 'lease' });
   * ```
   */
  strategy?: S;
  /**
   * Server URL(s). Default 'nats://localhost:4222'.
   *
   * @example
   * ```ts
   * new NatsBackend({ servers: 'nats://nats.internal:4222' });
   * new NatsBackend({ servers: ['nats://n1:4222', 'nats://n2:4222', 'nats://n3:4222'] });
   * ```
   */
  servers?: string | string[];
  /**
   * Your own connection (`await connect(...)` from @nats-io/transport-node). You keep ownership:
   * stop() doesn't close it. Takes precedence over `servers`.
   *
   * @example
   * ```ts
   * const connection = await connect({ servers: process.env.NATS_URL });
   * new NatsBackend({ connection });
   * ```
   */
  connection?: NatsConnectionLike;
  /**
   * JetStream stream name. Default 'CRON'. Created on start if it doesn't exist.
   *
   * @example
   * ```ts
   * new NatsBackend({ stream: 'BILLING_CRON', prefix: 'billing.cron.' });
   * ```
   */
  stream?: string;
  /**
   * Subject prefix: subjects are `<prefix><job>.claims` and `<prefix><job>.results`. Default 'cron.'.
   *
   * @example
   * ```ts
   * new NatsBackend({ prefix: 'billing.cron.' }); // billing.cron.sync.claims
   * ```
   */
  prefix?: string;
  /**
   * How long JetStream remembers a claimed run (the stream's duplicate window, ms). Must be longer
   * than a job's jitterMs + maxLateMs. Default 300000. With 'lease', the bucket remembers runs
   * instead, and this window only drops a history record the client sends twice.
   *
   * @example
   * ```ts
   * new NatsBackend({ duplicateWindowMs: 15 * 60_000 });
   * ```
   */
  duplicateWindowMs?: number;
  /**
   * About how many runs to keep per job. All jobs share the stream, so it keeps the largest of this
   * and every job's historySize, for each job. Default 1000.
   *
   * @example
   * ```ts
   * new NatsBackend({ historySize: 200 });
   * ```
   */
  historySize?: number;
  /**
   * Stream replicas in a NATS cluster. Use 3 so the stream, and its memory of claimed runs,
   * survives the loss of a server. A new stream gets 1 when this is not set. When it is set, an
   * existing stream is updated to it (the server refuses more replicas than it has servers); when it
   * is not set, an existing stream keeps its replicas. With 'lease', a new bucket of runs gets the
   * same number; an existing bucket keeps its own.
   *
   * @example
   * ```ts
   * new NatsBackend({ servers, replicas: 3 });
   * ```
   */
  replicas?: number;
}

const NATS_OPTIONS = keysOf<NatsBackendOptions>({
  strategy: true,
  servers: true,
  connection: true,
  stream: true,
  prefix: true,
  duplicateWindowMs: true,
  historySize: true,
  replicas: true,
});

/** The connection, the JetStream client and its manager, opened together. */
interface JetStreamState {
  nc: NatsConnection;
  js: JetStreamClient;
  jsm: JetStreamManager;
}

/** The stream settings this backend relies on. */
interface StreamSettings {
  subjects: string[];
  duplicate_window: number;
  max_msgs_per_subject: number;
  num_replicas?: number;
}

/**
 * NATS JetStream. Every instance publishes its claim with the header `Nats-Msg-Id: <job>:<slot>`.
 * JetStream stores the first one and answers repeats with `duplicate: true` (within the stream's
 * duplicate window), so the publisher knows right away whether it won.
 *
 * **How each run gets exactly one runner.** The feature used is JetStream's message de-duplication:
 *
 * 1. Each instance publishes its claim to `<prefix><job>.claims` with the header
 *    `Nats-Msg-Id: <job>:<slot>`, the same ID on every instance.
 * 2. The stream stores the first message with that ID. For every later one, inside the stream's
 *    duplicate window, the publish acknowledgement says `duplicate: true` and nothing is stored.
 * 3. An instance won if its acknowledgement is not a duplicate. The stream (its leader, in a
 *    cluster) orders the publishes, so exactly one is first.
 *
 * That is the default 'msg-id' strategy: it decides who runs each time, and holds no lease, so no
 * backup runners, no overlap protection and no catch-up. The 'lease' strategy adds them, with a
 * JetStream key-value bucket (see {@link NatsStrategyName}).
 * Job names may contain letters, digits, "_" and "-" only (they become subjects).
 *
 * @example
 * ```ts
 * new Scheduler({ backend: new NatsBackend({ servers: 'nats://nats.internal:4222' }) });
 * ```
 *
 * @example Leases: backup runners, no overlapping runs, catch-up and retries
 * ```ts
 * new Scheduler({ backend: new NatsBackend({ servers: process.env.NATS_URL, strategy: 'lease' }), leaseMs: 10_000 });
 * ```
 *
 * @example A NATS cluster: three replicas, and your own connection
 * ```ts
 * const connection = await connect({ servers: ['nats://n1:4222', 'nats://n2:4222', 'nats://n3:4222'] });
 * new Scheduler({ backend: new NatsBackend({ connection, stream: 'BILLING_CRON', replicas: 3 }) });
 * ```
 */
export class NatsBackend<S extends NatsStrategyName = 'msg-id'>
  implements Backend
{
  /** 'nats', or 'nats:lease' with the 'lease' strategy. */
  readonly name: S extends 'lease' ? 'nats:lease' : 'nats';
  /** The strategy: 'msg-id' (the default) or 'lease'. */
  readonly strategy: S;
  /**
   * 'msg-id': duplicateWindowMs, how long the stream recognizes a repeated message ID. 'lease':
   * Infinity, since a run is remembered while a late claim could still ask for it.
   */
  readonly dedupeWindowMs: number;
  /** Set with the 'lease' strategy only: lets the scheduler use leases, backups and catch-up. */
  readonly runs: S extends 'lease' ? RunStore : undefined;
  private readonly lease?: NatsLeaseStore;

  private readonly servers: string | string[];
  private readonly userConnection: NatsConnectionLike | undefined;
  private readonly stream: string;
  private readonly prefix: string;
  private readonly duplicateWindowMs: number;
  private historySize: number;
  private streamHistorySize = 0;
  private readonly replicas: number | undefined;
  private state: Promise<JetStreamState> | undefined;

  /** Validates the options. Nothing connects until init(). */
  constructor(options: NatsBackendOptions<S> = {}) {
    refuseUnknown('NatsBackend', options, NATS_OPTIONS);
    const strategy = readStrategy(options.strategy);
    const stream = options.stream ?? 'CRON';
    const bucket = strategy === 'lease' ? leaseBucket(stream) : undefined;
    this.duplicateWindowMs = positiveInt(
      'duplicateWindowMs',
      options.duplicateWindowMs ?? 300_000,
    );
    this.historySize = positiveInt('historySize', options.historySize ?? 1_000);
    this.replicas =
      options.replicas === undefined
        ? undefined
        : positiveInt('replicas', options.replicas);

    this.strategy = strategy as S;
    this.name = (bucket ? 'nats:lease' : 'nats') as this['name'];
    this.dedupeWindowMs = bucket ? Infinity : this.duplicateWindowMs;
    this.servers = options.servers ?? 'nats://localhost:4222';
    this.userConnection = options.connection;
    this.stream = stream;
    this.prefix = options.prefix ?? 'cron.';
    if (bucket) {
      const state = () => this.getState();
      this.lease = new NatsLeaseStore(
        state,
        bucket,
        this.prefix,
        this.replicas,
      );
    }
    this.runs = this.lease as this['runs'];
  }

  /** Job names become subjects: letters, digits, '_' and '-' only. History is kept by count. */
  checkJob(job: JobLimits): void {
    assertSimpleName('NATS', job.name);
    refuseHistoryTtl(this.name, job);
    this.historySize = Math.max(this.historySize, job.historySize);
  }

  /**
   * Connects, and creates the stream or brings its duplicate window and limits up to date. With
   * 'lease', also creates the bucket of runs and checks the server reports its clock (2.10+).
   */
  async init(): Promise<void> {
    await this.getState();
    await this.lease?.init();
  }

  /** All jobs share the stream: makes it keep at least this job's historySize runs per job. */
  async prepareJob(_job: string, historySize: number): Promise<void> {
    this.historySize = Math.max(this.historySize, historySize);
    const { jsm } = await this.getState();
    if (this.streamHistorySize < this.historySize) await this.ensureStream(jsm);
  }

  /**
   * 'msg-id': publishes the claim with the message ID `<job>:<slot>`. Won unless the ack says
   * duplicate; a duplicate carrying our own token is our own retry. ('lease': the scheduler claims
   * through `runs` instead.)
   */
  async claim(input: ClaimInput): Promise<boolean> {
    if (this.lease) {
      // Used only without the scheduler's lease handling: a long lease, no backups.
      const outcome = await this.lease.claim({
        ...input,
        mode: 'new',
        reason: 'scheduled',
        leaseMs: 86_400_000,
        overlap: 'allow',
        maxAttempts: 1,
      });
      return outcome.kind === 'won';
    }

    const { js, jsm } = await this.getState();
    const payload = JSON.stringify(claimPayload(input, false));
    const ack = await js.publish(this.subject(input.job, 'claims'), payload, {
      msgID: `${input.job}:${input.slot}`,
    });
    if (!ack.duplicate) return true;

    // A duplicate: normally another instance won. It can be ours if the client retried the publish.
    try {
      const stored = await jsm.streams.getMessage(this.stream, {
        seq: ack.seq,
      });
      const text = stored?.string() ?? '';
      const claim = parseJson(text) as { token?: string } | null;
      return claim?.token === input.token;
    } catch {
      return false;
    }
  }

  /**
   * Records a runNow() run. 'lease': claims a run of its own at the first free millisecond and
   * returns that slot. 'msg-id': publishes the claim without a message ID, so it is never
   * deduplicated.
   */
  async recordManualRun(input: ClaimInput): Promise<number | undefined> {
    if (this.lease) return claimManualSlot(this.lease, input);

    const { js } = await this.getState();
    const payload = JSON.stringify(claimPayload(input, true));
    await js.publish(this.subject(input.job, 'claims'), payload);
  }

  /** Publishes the result to the job's results subject. */
  async saveResult(job: string, result: StoredResult): Promise<void> {
    const { js } = await this.getState();
    await js.publish(
      this.subject(job, 'results'),
      JSON.stringify({ type: 'result', ...result }),
    );
  }

  /**
   * Reads the job's claims and results from the stream and joins them. With 'lease', an attempt
   * without a result is 'running' only while it is the current attempt with a live lease.
   */
  async history(job: string, limit: number): Promise<RunRecord[]> {
    const { js, jsm } = await this.getState();
    const filter = `${this.prefix}${job}.*`;
    const count = await this.countMessages(jsm, filter);
    if (count === 0) return []; // never ran

    const { claims, results } = await this.readRecords(js, filter, count);
    const pendingStatus = await this.lease?.pendingStatus(job);
    return buildHistory({ job, claims, results, limit, pendingStatus });
  }

  /** How many messages the subjects under the filter hold, so each fetch can ask for exactly what is there. */
  private async countMessages(
    jsm: JetStreamManager,
    filter: string,
  ): Promise<number> {
    const info = await jsm.streams.info(this.stream, {
      subjects_filter: filter,
    });
    const counts = Object.values(info.state.subjects ?? {});
    return counts.reduce((sum, count) => sum + count, 0);
  }

  /** Reads the messages under the filter through a consumer of their own, sorted into claims and results. */
  private async readRecords(
    js: JetStreamClient,
    filter: string,
    count: number,
  ): Promise<{ claims: ClaimRecord[]; results: StoredResult[] }> {
    const claims: ClaimRecord[] = [];
    const results: StoredResult[] = [];
    const consumer = await js.consumers.get(this.stream, {
      filter_subjects: [filter],
    });

    try {
      let remaining = count;
      while (remaining > 0) {
        const batch = await consumer.fetch({
          max_messages: Math.min(remaining, 1_000),
          expires: 5_000,
        });
        const { received, caughtUp } = await readBatch(batch, claims, results);
        if (received === 0) break;

        remaining = caughtUp ? 0 : remaining - received;
      }
    } finally {
      // The server keeps an ordered consumer for minutes after its last use.
      await consumer.delete().catch(() => {});
    }

    return { claims, results };
  }

  /** Closes the connection if this backend opened it. One that was passed in stays open. */
  async close(): Promise<void> {
    const state = this.state;
    this.state = undefined;
    this.lease?.close();
    if (!state || this.userConnection) return;

    try {
      const { nc } = await state;
      await nc.close();
    } catch {
      // never connected
    }
  }

  private getState(): Promise<JetStreamState> {
    this.state ??= this.connect().catch((error: unknown) => {
      this.state = undefined;
      throw error;
    });
    return this.state;
  }

  /** Connects (unless a connection was given), then checks JetStream and the stream. */
  private async connect(): Promise<JetStreamState> {
    const { transport, jetstreamModule } = await loadNats();
    const nc: NatsConnection =
      (this.userConnection as NatsConnection | undefined) ??
      (await transport.connect({ servers: this.servers }));
    const jsm = await this.openManager(jetstreamModule, nc);

    try {
      await this.ensureStream(jsm);
    } catch (error) {
      await this.closeOwned(nc);
      throw error;
    }

    return { nc, jsm, js: jetstreamModule.jetstream(nc) as JetStreamClient };
  }

  /** The JetStream manager; refuses a server without JetStream. */
  private async openManager(
    jetstreamModule: typeof import('@nats-io/jetstream'),
    nc: NatsConnection,
  ): Promise<JetStreamManager> {
    try {
      return await jetstreamModule.jetstreamManager(nc);
    } catch (error) {
      await this.closeOwned(nc);

      throw coded(
        new Error(
          `The NATS backend needs JetStream enabled on the server (nats-server -js): ${errorMessage(error)}`,
        ),
        'ANARCHON_SERVER',
      );
    }
  }

  /** Closes the connection if this backend opened it; a failure to close changes nothing. */
  private async closeOwned(nc: NatsConnection): Promise<void> {
    if (!this.userConnection) await nc.close().catch(() => {});
  }

  /** Creates the stream, or updates the settings this backend relies on. */
  private async ensureStream(jsm: JetStreamManager): Promise<void> {
    const wanted: StreamSettings = {
      subjects: [`${this.prefix}>`],
      duplicate_window: this.duplicateWindowMs * 1_000_000, // nanoseconds
      max_msgs_per_subject: this.historySize,
      // Only when asked for: an existing stream's replication is the operator's, not every instance's default.
      ...(this.replicas === undefined ? {} : { num_replicas: this.replicas }),
    };

    for (let attempt = 0; attempt < 3; attempt++) {
      const found = await this.updateStream(jsm, wanted);
      if (found) return;

      try {
        await jsm.streams.add({
          name: this.stream,
          num_replicas: 1,
          ...wanted,
        } as never);
        this.streamHistorySize = wanted.max_msgs_per_subject;
        return;
      } catch (error) {
        // Another instance created it at the same moment: loop and check its settings.
        if (attempt === 2) throw error;
      }
    }
  }

  /** Brings an existing stream's settings up to date; false when there is no stream yet. */
  private async updateStream(
    jsm: JetStreamManager,
    wanted: StreamSettings,
  ): Promise<boolean> {
    try {
      const { config } = await jsm.streams.info(this.stream);
      const same =
        config.duplicate_window === wanted.duplicate_window &&
        config.max_msgs_per_subject === wanted.max_msgs_per_subject &&
        (wanted.num_replicas === undefined ||
          config.num_replicas === wanted.num_replicas) &&
        wanted.subjects.every((s) => config.subjects?.includes(s));
      if (!same) {
        const subjects = new Set([
          ...(config.subjects ?? []),
          ...wanted.subjects,
        ]);
        await jsm.streams.update(this.stream, {
          ...config,
          ...wanted,
          subjects: [...subjects],
        });
      }

      this.streamHistorySize = wanted.max_msgs_per_subject;
      return true;
    } catch (error) {
      if (!/not found/i.test(errorMessage(error))) throw error;
      return false;
    }
  }

  private subject(job: string, kind: 'claims' | 'results'): string {
    return `${this.prefix}${job}.${kind}`;
  }
}

/** Loads the NATS client packages; refuses when they are not installed. */
async function loadNats(): Promise<{
  transport: typeof import('@nats-io/transport-node');
  jetstreamModule: typeof import('@nats-io/jetstream');
}> {
  try {
    const transport = await import('@nats-io/transport-node');
    const jetstreamModule = await import('@nats-io/jetstream');

    return { transport, jetstreamModule };
  } catch {
    throw coded(
      new Error(
        'The NATS backend needs "@nats-io/transport-node" and "@nats-io/jetstream": run `npm install @nats-io/transport-node @nats-io/jetstream`.',
      ),
      'ANARCHON_MISSING_DRIVER',
    );
  }
}

/** Sorts one fetched batch into claims and results; caughtUp once the server has nothing newer. */
async function readBatch(
  batch: AsyncIterable<JsMsg>,
  claims: ClaimRecord[],
  results: StoredResult[],
): Promise<{ received: number; caughtUp: boolean }> {
  let received = 0;
  let caughtUp = false;
  for await (const message of batch) {
    received++;
    addRecord(message.string(), claims, results);
    if (message.info.pending === 0) caughtUp = true; // nothing newer to wait for
  }

  return { received, caughtUp };
}

/** Adds one stream message to the claims or to the results; anything else is skipped. */
function addRecord(
  text: string,
  claims: ClaimRecord[],
  results: StoredResult[],
): void {
  const record = parseJson(text);
  if (!record || typeof record !== 'object') return;

  const raw = record as Record<string, unknown>;
  if (raw.type === 'result') {
    const result = toResult(raw);
    if (result) results.push(result);
    return;
  }
  const claim = toClaim(raw);
  if (claim) claims.push(withAttempt(claim, raw));
}

/** A 'lease' claim record also says which attempt it is, and why it started. */
function withAttempt(
  claim: ClaimRecord,
  raw: Record<string, unknown>,
): ClaimRecord {
  if (typeof raw.attempt !== 'number') return claim;
  return { ...claim, attempt: raw.attempt, reason: raw.reason as RunReason };
}

/** The strategy's name; refuses an unknown one. */
function readStrategy(name: unknown): NatsStrategyName {
  if (name === undefined || name === 'msg-id') return 'msg-id';
  if (name === 'lease') return name;

  throw coded(
    new TypeError(
      `NatsBackend: unknown strategy "${String(name)}" (use "msg-id" or "lease")`,
    ),
    'ANARCHON_INVALID_ARGUMENT',
  );
}

/** The key-value bucket of the 'lease' strategy, named after the stream; refuses a stream name a bucket can't take. */
function leaseBucket(stream: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(stream)) return `${stream}_RUNS`;

  throw coded(
    new TypeError(
      `NatsBackend: with strategy "lease", the stream name "${stream}" may only contain letters, digits, "_" and "-" (it names the bucket "<stream>_RUNS")`,
    ),
    'ANARCHON_INVALID_ARGUMENT',
  );
}
