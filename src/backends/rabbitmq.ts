/* Copyright (C) 2026-present Aristotelis — see repository license. */

import type { Channel, ChannelModel, ConfirmChannel, ConsumeMessage, Options } from 'amqplib';
import { coded } from '../errors';

import { buildHistory, type ClaimRecord, claimPayload, parseJson, toClaim, toResult } from '../history';
import { keysOf } from '../option-keys';
import type { Backend, ClaimInput, JobLimits, RunRecord, StoredResult } from '../types';
import { assertSimpleName, positiveInt, refuseHistoryTtl, refuseUnknown, versionAtLeast } from '../util';

/**
 * The parts of an amqplib connection this backend uses: what `amqplib.connect()` returns fits.
 *
 * @example
 * ```ts
 * import amqplib from 'amqplib';
 * const connection = await amqplib.connect(process.env.AMQP_URL);
 * new Scheduler({ backend: new RabbitMQBackend({ connection }) }); // stop() leaves it open
 * ```
 */
export interface RabbitMQConnectionLike {
  /** A channel for reading history. */
  createChannel(): Promise<unknown>;
  /** A channel in confirm mode: the broker acks or nacks every publish, which is how a claim learns whether it was first. */
  createConfirmChannel(): Promise<unknown>;
  /** Only called on connections anarchon opened. */
  close(): Promise<void>;
  /** Listens for 'error' and 'close', to reconnect on the next call. */
  on(event: string, listener: (...args: never[]) => void): unknown;
  /** Where amqplib keeps what the server said about itself. Used to check the version. */
  readonly connection: { readonly serverProperties: { version?: string; product?: string } };
}

/**
 * Options of {@link RabbitMQBackend}.
 *
 * @example
 * ```ts
 * new RabbitMQBackend({ url: process.env.AMQP_URL, prefix: 'billing.cron.', slotTtlMs: 10 * 60_000 });
 * ```
 */
export interface RabbitMQBackendOptions {
  /**
   * AMQP URL. Default 'amqp://localhost'.
   *
   * @example
   * ```ts
   * new RabbitMQBackend({ url: process.env.AMQP_URL }); // amqps:// for TLS; user, password and vhost go in the URL
   * ```
   */
  url?: string;
  /**
   * Your own amqplib connection (`await amqplib.connect(...)`). You keep ownership: stop() doesn't
   * close it. Takes precedence over `url`.
   *
   * @example
   * ```ts
   * const connection = await amqplib.connect(process.env.AMQP_URL);
   * new RabbitMQBackend({ connection });
   * ```
   */
  connection?: RabbitMQConnectionLike;
  /**
   * Prefix for queue names. Default 'cron.'. Gate queues are `<prefix><job>.slot.<slot>`, and
   * history is `<prefix><job>.history`.
   *
   * @example
   * ```ts
   * new RabbitMQBackend({ prefix: 'billing.cron.' });
   * ```
   */
  prefix?: string;
  /**
   * How long each run's gate queue lives after the last instance touched it (ms). This is how long
   * RabbitMQ remembers that a run was taken, so it must be longer than a job's jitterMs + maxLateMs.
   * Default 300000.
   *
   * @example
   * ```ts
   * new RabbitMQBackend({ slotTtlMs: 15 * 60_000 }); // allows maxLateMs up to about 14 minutes
   * ```
   */
  slotTtlMs?: number;
}

const RABBITMQ_OPTIONS = keysOf<RabbitMQBackendOptions>({ url: true, connection: true, prefix: true, slotTtlMs: true });

const BYTES_PER_RUN = 1_024; // claim + result records, with room to spare

/**
 * RabbitMQ 3.9+. Each run has a gate queue `<prefix><job>.slot.<slot>` that holds at most one message
 * (`x-max-length: 1`, `x-overflow: reject-publish`). Every instance publishes its claim there with
 * publisher confirms: RabbitMQ acks the first one and nacks the rest. The queue deletes itself
 * (`x-expires`) a while after the run. History is kept in a stream queue `<prefix><job>.history`.
 *
 * **How each run gets exactly one runner.** The feature used is a bounded queue that rejects
 * overflow, together with publisher confirms:
 *
 * 1. Each instance declares the run's gate queue (same arguments everywhere, so declaring is safe to
 *    repeat) and publishes one message to it on a confirm channel.
 * 2. The queue holds one message. RabbitMQ confirms (ack) the publish that filled it and rejects
 *    (nack) every later one. The broker decides the order, so exactly one instance gets the ack.
 * 3. Nobody consumes the gate queue: the message stays, so the run stays taken until the queue
 *    expires `slotTtlMs` after it was last used.
 *
 * Simple claim only: this decides who runs each time. There are no leases, so no backup runners,
 * no overlap protection and no catch-up; for those use Redis 'lease', Postgres or SQLite.
 * Job names may contain letters, digits, "_" and "-" only (they become queue names).
 *
 * @example
 * ```ts
 * new Scheduler({ backend: new RabbitMQBackend({ url: 'amqp://rabbit.internal' }) });
 * ```
 *
 * @example Your own amqplib connection, and a longer memory for slow or late instances
 * ```ts
 * const connection = await amqplib.connect(process.env.AMQP_URL);
 * new Scheduler({ backend: new RabbitMQBackend({ connection, prefix: 'billing.cron.', slotTtlMs: 15 * 60_000 }) });
 * ```
 */
export class RabbitMQBackend implements Backend {
  readonly name = 'rabbitmq';
  /** slotTtlMs: a gate queue, and with it the memory of a claimed run, expires this long after its last use. */
  readonly dedupeWindowMs: number;

  private readonly url: string;
  private readonly prefix: string;
  private readonly userConnection: RabbitMQConnectionLike | undefined;
  private connection: Promise<ChannelModel> | undefined;
  private confirm: Promise<ConfirmChannel> | undefined;
  /** Gate queue -> token of the claims this instance won recently. */
  private readonly won = new Map<string, string>();

  /** Validates the options. Nothing connects until init(). */
  constructor(options: RabbitMQBackendOptions = {}) {
    refuseUnknown('RabbitMQBackend', options, RABBITMQ_OPTIONS);
    this.url = options.url ?? 'amqp://localhost';
    this.prefix = options.prefix ?? 'cron.';
    this.userConnection = options.connection;
    this.dedupeWindowMs = positiveInt('slotTtlMs', options.slotTtlMs ?? 300_000);
  }

  /** Job names become queue names: letters, digits, '_' and '-' only. */
  checkJob(job: JobLimits): void {
    assertSimpleName('RabbitMQ', job.name);
    refuseHistoryTtl(this.name, job);
  }

  /** Connects and checks for RabbitMQ 3.9+, the first version with stream queues. */
  async init(): Promise<void> {
    const connection = await this.getConnection();
    const { product = 'RabbitMQ', version = '0' } = connection.connection.serverProperties ?? {};
    if (!versionAtLeast(String(version), 3, 9)) {
      throw coded(
        new Error(`The RabbitMQ backend needs RabbitMQ 3.9 or newer for stream queues (this server is ${product} ${version}).`),
        'ANARCHON_SERVER',
      );
    }
  }

  /** Declares the job's history stream queue, sized from historySize. */
  async prepareJob(job: string, historySize: number): Promise<void> {
    const bytes = Math.max(historySize * BYTES_PER_RUN, 100_000);
    await this.declare(this.historyQueue(job), {
      durable: true,
      arguments: {
        'x-queue-type': 'stream',
        'x-max-length-bytes': bytes,
        'x-stream-max-segment-size-bytes': Math.min(1_000_000, Math.max(50_000, Math.floor(bytes / 10))),
      },
    });
  }

  /** Declares the run's gate queue and publishes to it. Won on ack (the queue was empty), lost on nack (it was full). */
  async claim(input: ClaimInput): Promise<boolean> {
    const queue = this.slotQueue(input.job, input.slot);
    // The same claim sent again (same token) is still ours. Remembered here, because the gate's
    // message can't be read without taking it off the queue for a moment, and while it's off, the
    // queue is empty and another instance's claim would be accepted.
    if (this.won.get(queue) === input.token) return true;
    await this.declare(queue, {
      durable: true,
      arguments: {
        'x-queue-type': 'classic',
        'x-max-length': 1,
        'x-overflow': 'reject-publish',
        'x-expires': this.dedupeWindowMs,
      },
    });
    // ack: we are first. nack: the gate is full, another instance won. If the connection drops
    // before the answer, this throws: the run is skipped here rather than risk running it twice.
    const won = await this.publish(await this.getConfirmChannel(), queue, claimPayload(input, false));
    if (won) {
      this.won.set(queue, input.token);
      const oldest = this.won.keys().next().value;
      if (this.won.size > 1_000 && oldest !== undefined) this.won.delete(oldest);
    }
    return won;
  }

  /** Appends the won claim to the history stream. (The gate queue only decides the winner.) */
  async recordClaim(input: ClaimInput): Promise<void> {
    await this.append(input.job, claimPayload(input, false));
  }

  /** Appends a runNow() run to the history stream. No gate: manual runs are not deduplicated. */
  async recordManualRun(input: ClaimInput): Promise<undefined> {
    await this.append(input.job, claimPayload(input, true));
  }

  /** Appends the result to the history stream. */
  async saveResult(job: string, result: StoredResult): Promise<void> {
    await this.append(job, { type: 'result', ...result });
  }

  /** Reads the newest entries of the job's history stream and joins claims with results. */
  async history(job: string, limit: number): Promise<RunRecord[]> {
    const connection = await this.getConnection();
    const channel = (await connection.createChannel()) as Channel;
    channel.on('error', () => {});
    try {
      await channel.prefetch(Math.min(2 * limit + 50, 2_000));
      const queue = this.historyQueue(job);
      const end = await this.lastOffset(channel, queue);
      if (end === null) return [];
      const records = await this.readFrom(channel, queue, Math.max(0, end - (2 * limit + 20)), end);
      const claims: ClaimRecord[] = [];
      const results: StoredResult[] = [];
      for (const record of records) {
        if (record.type === 'claim') {
          const claim = toClaim(record);
          if (claim) claims.push(claim);
        } else if (record.type === 'result') {
          const result = toResult(record);
          if (result) results.push(result);
        }
      }
      return buildHistory({ job, claims, results, limit });
    } catch (error) {
      if ((error as { code?: number }).code === 404) return []; // job never ran here
      throw error;
    } finally {
      await channel.close().catch(() => {});
    }
  }

  /** Closes the connection if this backend opened it. One that was passed in stays open. */
  async close(): Promise<void> {
    const confirm = this.confirm;
    const connection = this.connection;
    this.confirm = undefined;
    this.connection = undefined;
    await confirm?.then((c) => c.close()).catch(() => {});
    if (!this.userConnection) await connection?.then((c) => c.close()).catch(() => {});
  }

  private getConnection(): Promise<ChannelModel> {
    if (this.connection) return this.connection;
    const pending: Promise<ChannelModel> = (async () => {
      if (this.userConnection) return this.userConnection as unknown as ChannelModel;
      let amqp: typeof import('amqplib') & { default: { connect: typeof import('amqplib').connect } };
      try {
        amqp = (await import('amqplib')) as typeof amqp;
      } catch {
        throw coded(new Error('The RabbitMQ backend needs "amqplib": run `npm install amqplib`.'), 'ANARCHON_MISSING_DRIVER');
      }
      const connection: ChannelModel = await (amqp.connect ?? amqp.default.connect)(this.url);
      connection.on('error', () => {}); // also reported through 'close'
      connection.on('close', () => {
        if (this.connection === pending) {
          this.connection = undefined;
          this.confirm = undefined;
        }
      });
      return connection;
    })().catch((error: unknown) => {
      if (this.connection === pending) this.connection = undefined;
      throw error;
    });
    this.connection = pending;
    return pending;
  }

  private getConfirmChannel(): Promise<ConfirmChannel> {
    if (this.confirm) return this.confirm;
    const pending: Promise<ConfirmChannel> = (async () => {
      const channel = (await (await this.getConnection()).createConfirmChannel()) as ConfirmChannel;
      channel.on('error', () => {}); // also reported through 'close'
      channel.on('close', () => {
        if (this.confirm === pending) this.confirm = undefined;
      });
      return channel;
    })().catch((error: unknown) => {
      if (this.confirm === pending) this.confirm = undefined;
      throw error;
    });
    this.confirm = pending;
    return pending;
  }

  /** Declares a queue on a channel of its own: a refused declaration closes the channel it was sent on. */
  private async declare(queue: string, options: Options.AssertQueue): Promise<void> {
    const channel = (await (await this.getConnection()).createChannel()) as Channel;
    channel.on('error', () => {});
    try {
      await channel.assertQueue(queue, options);
    } catch (error) {
      // The queue exists with other arguments (another instance's slotTtlMs or historySize): use it as it is.
      if ((error as { code?: number }).code !== 406) throw error;
    } finally {
      await channel.close().catch(() => {});
    }
  }

  private publish(channel: ConfirmChannel, queue: string, body: unknown): Promise<boolean> {
    return new Promise((resolve, reject) => {
      channel.sendToQueue(queue, Buffer.from(JSON.stringify(body)), { persistent: true, contentType: 'application/json' }, (err) => {
        if (!err) resolve(true);
        else if (/nacked/.test(String((err as Error).message))) resolve(false);
        else reject(err);
      });
    });
  }

  private async append(job: string, record: unknown): Promise<void> {
    const channel = await this.getConfirmChannel();
    if (!(await this.publish(channel, this.historyQueue(job), record))) {
      throw coded(new Error(`RabbitMQ refused a history record for job "${job}"`), 'ANARCHON_STORE');
    }
  }

  /** Offset of the newest record in a stream queue, or null if it is empty. */
  private lastOffset(channel: Channel, queue: string): Promise<number | null> {
    return new Promise((resolve, reject) => {
      let max: number | null = null;
      let tag: string | undefined;
      let timer: NodeJS.Timeout | undefined;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (tag) channel.cancel(tag).catch(() => {});
        resolve(max);
      };
      // 'last' delivers the newest chunk; wait until it has fully arrived.
      const wait = (ms: number) => {
        clearTimeout(timer);
        timer = setTimeout(finish, ms);
      };
      channel
        .consume(
          queue,
          (msg) => {
            if (!msg || done) return;
            channel.ack(msg);
            max = Math.max(max ?? -1, offsetOf(msg));
            wait(60);
          },
          { noAck: false, arguments: { 'x-stream-offset': 'last' } },
        )
        .then(({ consumerTag }) => {
          tag = consumerTag;
          if (done) channel.cancel(consumerTag).catch(() => {});
          else if (max === null) wait(300);
        }, reject);
    });
  }

  /** Reads records from `from` up to and including offset `end`. */
  private readFrom(channel: Channel, queue: string, from: number, end: number): Promise<Array<Record<string, unknown>>> {
    return new Promise((resolve, reject) => {
      const records: Array<Record<string, unknown>> = [];
      let tag: string | undefined;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(safety);
        if (tag) channel.cancel(tag).catch(() => {});
        resolve(records);
      };
      const safety = setTimeout(finish, 5_000);
      channel
        .consume(
          queue,
          (msg) => {
            if (!msg || done) return;
            channel.ack(msg);
            const record = parseJson(msg.content.toString());
            if (record && typeof record === 'object') records.push(record as Record<string, unknown>);
            if (offsetOf(msg) >= end) finish();
          },
          { noAck: false, arguments: { 'x-stream-offset': from } },
        )
        .then(({ consumerTag }) => {
          tag = consumerTag;
          if (done) channel.cancel(consumerTag).catch(() => {});
        }, reject);
    });
  }

  private slotQueue(job: string, slot: number): string {
    return `${this.prefix}${job}.slot.${slot}`;
  }

  private historyQueue(job: string): string {
    return `${this.prefix}${job}.history`;
  }
}

function offsetOf(msg: ConsumeMessage): number {
  return Number(msg.properties.headers?.['x-stream-offset'] ?? -1);
}
