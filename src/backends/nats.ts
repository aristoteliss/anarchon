/* Copyright (C) 2026-present Aristotelis — see repository license. */

import type { JetStreamClient, JetStreamManager } from '@nats-io/jetstream';
import type { NatsConnection } from '@nats-io/transport-node';

import { type ClaimRecord, claimPayload, mergeRuns, parseJson, toClaim, toResult } from '../history';
import type { Backend, ClaimInput, JobLimits, RunRecord, StoredResult } from '../types';
import { assertSimpleName, errorMessage, positiveInt, refuseHistoryTtl } from '../util';

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
   * survives the loss of a server. Default 1.
   *
   * @example
   * ```ts
   * new NatsBackend({ servers, replicas: 3 });
   * ```
   */
  replicas?: number;
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
  private readonly replicas: number;
  private state: Promise<{ nc: NatsConnection; js: JetStreamClient; jsm: JetStreamManager }> | undefined;

  /** Validates the options. Nothing connects until init(). */
  constructor(options: NatsBackendOptions = {}) {
    this.servers = options.servers ?? 'nats://localhost:4222';
    this.userConnection = options.connection;
    this.stream = options.stream ?? 'CRON';
    this.prefix = options.prefix ?? 'cron.';
    this.dedupeWindowMs = positiveInt('duplicateWindowMs', options.duplicateWindowMs ?? 300_000);
    this.historySize = positiveInt('historySize', options.historySize ?? 1_000);
    this.replicas = positiveInt('replicas', options.replicas ?? 1);
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
    const ack = await js.publish(this.subject(input.job, 'claims'), JSON.stringify(claimPayload(input, false)), {
      msgID: `${input.job}:${input.slot}`,
    });
    if (!ack.duplicate) return true;
    // A duplicate: normally another instance won. It can be ours if the client retried the publish.
    try {
      const stored = await jsm.streams.getMessage(this.stream, { seq: ack.seq });
      return (parseJson(stored?.string() ?? '') as { token?: string } | null)?.token === input.token;
    } catch {
      return false;
    }
  }

  /** Publishes a runNow() run without a message ID, so it is never deduplicated. */
  async recordManualRun(input: ClaimInput): Promise<undefined> {
    const { js } = await this.getState();
    await js.publish(this.subject(input.job, 'claims'), JSON.stringify(claimPayload(input, true)));
  }

  /** Publishes the result to the job's results subject. */
  async saveResult(job: string, result: StoredResult): Promise<void> {
    const { js } = await this.getState();
    await js.publish(this.subject(job, 'results'), JSON.stringify({ type: 'result', ...result }));
  }

  /** Reads the job's claims and results from the stream and joins them. */
  async history(job: string, limit: number): Promise<RunRecord[]> {
    const { js, jsm } = await this.getState();
    const filter = `${this.prefix}${job}.*`;
    // How many messages this job has, so each fetch can ask for exactly what is there.
    const info = await jsm.streams.info(this.stream, { subjects_filter: filter });
    let remaining = Object.values(info.state.subjects ?? {}).reduce((sum, count) => sum + count, 0);
    if (remaining === 0) return []; // never ran

    const claims: ClaimRecord[] = [];
    const results: StoredResult[] = [];
    const consumer = await js.consumers.get(this.stream, { filter_subjects: [filter] });
    try {
      while (remaining > 0) {
        const batch = await consumer.fetch({ max_messages: Math.min(remaining, 1_000), expires: 5_000 });
        let received = 0;
        for await (const message of batch) {
          received++;
          const record = parseJson(message.string());
          if (record && typeof record === 'object') {
            const raw = record as Record<string, unknown>;
            if (raw.type === 'result') {
              const result = toResult(raw);
              if (result) results.push(result);
            } else {
              const claim = toClaim(raw);
              if (claim) claims.push(claim);
            }
          }
          if (message.info.pending === 0) remaining = received; // nothing newer to wait for
        }
        if (received === 0) break;
        remaining -= received;
      }
    } finally {
      // The server keeps an ordered consumer for minutes after its last use.
      await consumer.delete().catch(() => {});
    }
    return mergeRuns(job, claims, results, limit);
  }

  /** Closes the connection if this backend opened it. One that was passed in stays open. */
  async close(): Promise<void> {
    const state = this.state;
    this.state = undefined;
    if (!state || this.userConnection) return;
    try {
      await (await state).nc.close();
    } catch {
      // never connected
    }
  }

  // ---------------------------------------------------------------- internals

  private getState(): Promise<{ nc: NatsConnection; js: JetStreamClient; jsm: JetStreamManager }> {
    this.state ??= (async () => {
      let transport: typeof import('@nats-io/transport-node');
      let jetstreamModule: typeof import('@nats-io/jetstream');
      try {
        transport = await import('@nats-io/transport-node');
        jetstreamModule = await import('@nats-io/jetstream');
      } catch {
        throw new Error(
          'The NATS backend needs "@nats-io/transport-node" and "@nats-io/jetstream": run `npm install @nats-io/transport-node @nats-io/jetstream`.',
        );
      }
      const nc: NatsConnection =
        (this.userConnection as NatsConnection | undefined) ?? (await transport.connect({ servers: this.servers }));
      let jsm: JetStreamManager;
      try {
        jsm = await jetstreamModule.jetstreamManager(nc);
      } catch (error) {
        if (!this.userConnection) await nc.close().catch(() => {});
        throw new Error(`The NATS backend needs JetStream enabled on the server (nats-server -js): ${errorMessage(error)}`);
      }
      await this.ensureStream(jsm);
      return { nc, jsm, js: jetstreamModule.jetstream(nc) as JetStreamClient };
    })().catch((error: unknown) => {
      this.state = undefined;
      throw error;
    });
    return this.state;
  }

  /** Creates the stream, or updates the settings this backend relies on. */
  private async ensureStream(jsm: JetStreamManager): Promise<void> {
    const wanted = {
      subjects: [`${this.prefix}>`],
      duplicate_window: this.dedupeWindowMs * 1_000_000, // nanoseconds
      max_msgs_per_subject: this.historySize,
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { config } = await jsm.streams.info(this.stream);
        const same =
          config.duplicate_window === wanted.duplicate_window &&
          config.max_msgs_per_subject === wanted.max_msgs_per_subject &&
          wanted.subjects.every((s) => config.subjects?.includes(s));
        if (!same) {
          await jsm.streams.update(this.stream, {
            ...config,
            ...wanted,
            subjects: [...new Set([...(config.subjects ?? []), ...wanted.subjects])],
          });
        }
        this.streamHistorySize = wanted.max_msgs_per_subject;
        return;
      } catch (error) {
        if (!/not found/i.test(errorMessage(error))) throw error;
      }
      try {
        await jsm.streams.add({ name: this.stream, num_replicas: this.replicas, ...wanted } as never);
        this.streamHistorySize = wanted.max_msgs_per_subject;
        return;
      } catch (error) {
        // Another instance created it at the same moment: loop and check its settings.
        if (attempt === 2) throw error;
      }
    }
  }

  private subject(job: string, kind: 'claims' | 'results'): string {
    return `${this.prefix}${job}.${kind}`;
  }
}
