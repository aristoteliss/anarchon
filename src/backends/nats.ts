/* Copyright (C) 2026-present Aristotelis — see repository license. */

import type {
  JetStreamClient,
  JetStreamManager,
  JsMsg,
} from '@nats-io/jetstream';
import type { NatsConnection } from '@nats-io/transport-node';
import { coded } from '../errors';

import {
  buildHistory,
  type ClaimRecord,
  claimPayload,
  parseJson,
  toClaim,
  toResult,
} from '../history';
import { keysOf } from '../option-keys';
import type {
  Backend,
  ClaimInput,
  JobLimits,
  RunRecord,
  StoredResult,
} from '../types';
import {
  assertSimpleName,
  errorMessage,
  positiveInt,
  refuseHistoryTtl,
  refuseUnknown,
} from '../util';

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
export interface NatsBackendOptions {
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
   * than a job's jitterMs + maxLateMs. Default 300000.
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
   * is not set, an existing stream keeps its replicas.
   *
   * @example
   * ```ts
   * new NatsBackend({ servers, replicas: 3 });
   * ```
   */
  replicas?: number;
}

const NATS_OPTIONS = keysOf<NatsBackendOptions>({
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
 * Simple claim only: this decides who runs each time. There are no leases, so no backup runners,
 * no overlap protection and no catch-up; for those use Redis 'lease', Postgres or SQLite.
 * Job names may contain letters, digits, "_" and "-" only (they become subjects).
 *
 * @example
 * ```ts
 * new Scheduler({ backend: new NatsBackend({ servers: 'nats://nats.internal:4222' }) });
 * ```
 *
 * @example A NATS cluster: three replicas, and your own connection
 * ```ts
 * const connection = await connect({ servers: ['nats://n1:4222', 'nats://n2:4222', 'nats://n3:4222'] });
 * new Scheduler({ backend: new NatsBackend({ connection, stream: 'BILLING_CRON', replicas: 3 }) });
 * ```
 */
export class NatsBackend implements Backend {
  readonly name = 'nats';
  /** duplicateWindowMs: how long the stream recognizes a repeated message ID. */
  readonly dedupeWindowMs: number;

  private readonly servers: string | string[];
  private readonly userConnection: NatsConnectionLike | undefined;
  private readonly stream: string;
  private readonly prefix: string;
  private historySize: number;
  private streamHistorySize = 0;
  private readonly replicas: number | undefined;
  private state: Promise<JetStreamState> | undefined;

  /** Validates the options. Nothing connects until init(). */
  constructor(options: NatsBackendOptions = {}) {
    refuseUnknown('NatsBackend', options, NATS_OPTIONS);
    this.dedupeWindowMs = positiveInt(
      'duplicateWindowMs',
      options.duplicateWindowMs ?? 300_000,
    );
    this.historySize = positiveInt('historySize', options.historySize ?? 1_000);
    this.replicas =
      options.replicas === undefined
        ? undefined
        : positiveInt('replicas', options.replicas);

    this.servers = options.servers ?? 'nats://localhost:4222';
    this.userConnection = options.connection;
    this.stream = options.stream ?? 'CRON';
    this.prefix = options.prefix ?? 'cron.';
  }

  /** Job names become subjects: letters, digits, '_' and '-' only. History is kept by count. */
  checkJob(job: JobLimits): void {
    assertSimpleName('NATS', job.name);
    refuseHistoryTtl(this.name, job);
    this.historySize = Math.max(this.historySize, job.historySize);
  }

  /** Connects, and creates the stream or brings its duplicate window and limits up to date. */
  async init(): Promise<void> {
    await this.getState();
  }

  /** All jobs share the stream: makes it keep at least this job's historySize runs per job. */
  async prepareJob(_job: string, historySize: number): Promise<void> {
    this.historySize = Math.max(this.historySize, historySize);
    const { jsm } = await this.getState();
    if (this.streamHistorySize < this.historySize) await this.ensureStream(jsm);
  }

  /**
   * Publishes the claim with the message ID `<job>:<slot>`. Won unless the ack says duplicate; a
   * duplicate carrying our own token is our own retry.
   */
  async claim(input: ClaimInput): Promise<boolean> {
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

  /** Publishes a runNow() run without a message ID, so it is never deduplicated. */
  async recordManualRun(input: ClaimInput): Promise<undefined> {
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

  /** Reads the job's claims and results from the stream and joins them. */
  async history(job: string, limit: number): Promise<RunRecord[]> {
    const { js, jsm } = await this.getState();
    const filter = `${this.prefix}${job}.*`;
    const count = await this.countMessages(jsm, filter);
    if (count === 0) return []; // never ran

    const { claims, results } = await this.readRecords(js, filter, count);
    return buildHistory({ job, claims, results, limit });
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
      duplicate_window: this.dedupeWindowMs * 1_000_000, // nanoseconds
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
  if (claim) claims.push(claim);
}
