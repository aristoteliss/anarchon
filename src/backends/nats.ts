import type { JetStreamClient, JetStreamManager } from '@nats-io/jetstream';
import type { NatsConnection } from '@nats-io/transport-node';

import { type ClaimRecord, claimPayload, mergeRuns, parseJson, toClaim, toResult } from '../history';
import type { Backend, ClaimInput, JobLimits, RunRecord, StoredResult } from '../types';
import { assertSimpleName, errorMessage, positiveInt } from '../util';

/** The parts of a NATS connection this backend uses. */
export interface NatsConnectionLike {
  close(): Promise<void>;
}

export interface NatsBackendOptions {
  /** Server URL(s). Default 'nats://localhost:4222'. */
  servers?: string | string[];
  /** Your own connection (`await connect(...)` from @nats-io/transport-node). You keep ownership. */
  connection?: NatsConnectionLike;
  /** JetStream stream name. Default 'CRON'. */
  stream?: string;
  /** Subject prefix: subjects are `<prefix><job>.claims` and `<prefix><job>.results`. Default 'cron.'. */
  prefix?: string;
  /** How long JetStream remembers a claimed run (the stream's duplicate window, ms). Default 300000. */
  duplicateWindowMs?: number;
  /** Messages kept per subject, i.e. about how many runs per job (stream-wide). Default 1000. */
  historySize?: number;
  /** Stream replicas in a NATS cluster. Default 1. */
  replicas?: number;
}

/**
 * NATS JetStream. Every instance publishes its claim with the header `Nats-Msg-Id: <job>:<slot>`.
 * JetStream stores the first one and answers repeats with `duplicate: true` (within the stream's
 * duplicate window), so the publisher knows right away whether it won.
 */
export class NatsBackend implements Backend {
  readonly name = 'nats';
  readonly dedupeWindowMs: number;

  private readonly servers: string | string[];
  private readonly userConnection: NatsConnectionLike | undefined;
  private readonly stream: string;
  private readonly prefix: string;
  private readonly historySize: number;
  private readonly replicas: number;
  private state: Promise<{ nc: NatsConnection; js: JetStreamClient; jsm: JetStreamManager }> | undefined;

  constructor(options: NatsBackendOptions = {}) {
    this.servers = options.servers ?? 'nats://localhost:4222';
    this.userConnection = options.connection;
    this.stream = options.stream ?? 'CRON';
    this.prefix = options.prefix ?? 'cron.';
    this.dedupeWindowMs = positiveInt('duplicateWindowMs', options.duplicateWindowMs ?? 300_000);
    this.historySize = positiveInt('historySize', options.historySize ?? 1_000);
    this.replicas = positiveInt('replicas', options.replicas ?? 1);
  }

  checkJob(job: JobLimits): void {
    assertSimpleName('NATS', job.name);
  }

  async init(): Promise<void> {
    await this.getState();
  }

  async prepareJob(): Promise<void> {}

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

  async recordManualRun(input: ClaimInput): Promise<void> {
    const { js } = await this.getState();
    await js.publish(this.subject(input.job, 'claims'), JSON.stringify(claimPayload(input, true)));
  }

  async saveResult(job: string, result: StoredResult): Promise<void> {
    const { js } = await this.getState();
    await js.publish(this.subject(job, 'results'), JSON.stringify({ type: 'result', ...result }));
  }

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
    return mergeRuns(job, claims, results, limit);
  }

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
      let transport: any;
      let jetstreamModule: any;
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
        return;
      } catch (error) {
        if (!/not found/i.test(errorMessage(error))) throw error;
      }
      try {
        await jsm.streams.add({ name: this.stream, num_replicas: this.replicas, ...wanted } as never);
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
