import { mergeRuns, parseJson, toClaim, toResult } from '../../history';
import type {
  Backend,
  ClaimInput,
  IdmpOptions,
  JobLimits,
  RedisStrategyName,
  RunRecord,
  RunStore,
  StoredResult,
} from '../../types';
import { intInRange, positiveInt, versionAtLeast } from '../../util';
import { resolveRedis, type RedisCommandClient, type RedisInput } from './client';
import { parseEntries, toStr } from './replies';
import { LeaseStore } from './lease';
import { IdmpStrategy, ScriptStrategy, StreamIdStrategy, claimFields, type ClaimStrategy } from './strategies';

export interface RedisBackendOptions {
  /** Connection or client. Default: localhost:6379 via ioredis. Works with Redis and Valkey. */
  redis?: RedisInput;
  /**
   * Default 'lease': no overlapping runs, backup runners, catch-up and retries (Redis 5+, Valkey).
   * The simpler 'stream-id', 'idmp' (Redis 8.6+) and 'script' only decide who runs each time.
   */
  strategy?: RedisStrategyName;
  /** Prefix for every key. Default 'cron:'. */
  prefix?: string;
  /** Settings for the 'idmp' strategy. */
  idmp?: IdmpOptions;
  /** 'script' strategy: how long a claimed run is remembered (ms). Default 300000. */
  scriptWindowMs?: number;
}

/**
 * Redis or Valkey. With 'stream-id', 'idmp' and 'script', per job: a stream `<prefix><job>:runs` (one
 * entry per claimed run) and a sorted set `<prefix><job>:results`. With 'lease', see LeaseStore.
 */
export class RedisBackend implements Backend {
  readonly name: string;
  readonly strategy: RedisStrategyName;
  readonly dedupeWindowMs: number;
  /** Set with the 'lease' strategy: lets the scheduler use leases, backups and catch-up. */
  readonly runs?: RunStore;
  private readonly lease?: LeaseStore;

  private readonly prefix: string;
  private readonly input: RedisInput | undefined;
  private readonly idmp: Required<IdmpOptions>;
  private readonly scriptWindowMs: number;
  private connection: Promise<{ client: RedisCommandClient; owned: boolean }> | undefined;
  private ready: Promise<ClaimStrategy> | undefined;

  constructor(options: RedisBackendOptions = {}) {
    this.strategy = options.strategy ?? 'lease';
    if (!['lease', 'stream-id', 'idmp', 'script'].includes(this.strategy)) {
      throw new TypeError(`Unknown strategy "${String(this.strategy)}" (use "lease", "stream-id", "idmp" or "script")`);
    }
    this.name = `redis:${this.strategy}`;
    this.prefix = options.prefix ?? 'cron:';
    this.input = options.redis;
    this.idmp = {
      durationSec: intInRange('idmp.durationSec', options.idmp?.durationSec ?? 300, 1, 86_400),
      maxSize: intInRange('idmp.maxSize', options.idmp?.maxSize ?? 1_000, 1, 10_000),
    };
    this.scriptWindowMs = positiveInt('scriptWindowMs', options.scriptWindowMs ?? 300_000);
    this.dedupeWindowMs =
      this.strategy === 'idmp' ? this.idmp.durationSec * 1_000 : this.strategy === 'script' ? this.scriptWindowMs : Infinity;
    if (this.strategy === 'lease') {
      this.lease = new LeaseStore(async () => (await this.getConnection()).client, this.prefix);
      this.runs = this.lease;
    }
  }

  checkJob(job: JobLimits): void {
    const needed = job.jitterMs + job.maxLateMs;
    // The server must still remember a run while late instances may try to claim it.
    if (this.strategy === 'idmp' && this.idmp.maxSize * job.minGapMs <= needed) {
      throw new RangeError(
        `Job "${job.name}": idmp.maxSize (${this.idmp.maxSize}) runs × ${job.minGapMs} ms between runs must cover jitterMs + maxLateMs (${needed} ms)`,
      );
    }
    if (this.strategy === 'script' && job.historyTtlMs !== undefined && job.historyTtlMs <= this.scriptWindowMs) {
      throw new RangeError(`Job "${job.name}": historyTtlMs must be longer than scriptWindowMs (${this.scriptWindowMs} ms) for the "script" strategy`);
    }
    // ('lease' needs no such check: it never forgets a run that a late claim could still ask for.)
    if (this.strategy === 'script' && job.historySize * job.minGapMs <= needed) {
      throw new RangeError(
        `Job "${job.name}": historySize (${job.historySize}) runs × ${job.minGapMs} ms between runs must cover jitterMs + maxLateMs (${needed} ms) for the "script" strategy`,
      );
    }
  }

  async init(): Promise<void> {
    if (this.lease) {
      // Streams (XADD) arrived in Redis 5; Valkey reports redis_version 7.2.4.
      const info = toStr(await (await this.getConnection()).client.send('INFO', ['server']));
      const version = /redis_version:([\d.]+)/.exec(info)?.[1] ?? '0';
      if (!versionAtLeast(version, 5, 0)) throw new Error(`The "lease" strategy needs Redis 5 or newer (this server is ${version}).`);
      return;
    }
    await this.getStrategy();
  }

  async prepareJob(job: string): Promise<void> {
    if (this.lease) return;
    await (await this.getStrategy()).prepareStream(this.streamKey(job));
  }

  async claim(input: ClaimInput): Promise<boolean> {
    if (this.lease) {
      // Used only without the scheduler's lease handling: a long lease, no backups.
      const outcome = await this.lease.claim({ ...input, mode: 'new', reason: 'scheduled', leaseMs: 86_400_000, overlap: 'allow', maxAttempts: 1 });
      return outcome.kind === 'won';
    }
    return (await this.getStrategy()).claim({ ...input, key: this.streamKey(input.job) });
  }

  async recordManualRun(input: ClaimInput): Promise<number | void> {
    // (lease strategy: the scheduler claims manual runs itself, through runs.claim)
    if (this.lease) {
      for (let slot = input.slot; slot < input.slot + 10; slot++) {
        const outcome = await this.lease.claim({ ...input, slot, mode: 'new', reason: 'manual', leaseMs: 86_400_000, overlap: 'allow', maxAttempts: 1 });
        if (outcome.kind === 'won') return slot;
      }
      throw new Error(`Could not record a manual run of "${input.job}"`);
    }
    const { client } = await this.getConnection();
    await client.send('XADD', [this.streamKey(input.job), 'MAXLEN', '~', input.historySize, '*', ...claimFields(input, true)]);
  }

  async saveResult(job: string, result: StoredResult, historySize: number, historyTtlMs?: number): Promise<void> {
    if (this.lease) return this.lease.saveResult(job, result, historySize, historyTtlMs);
    const { client } = await this.getConnection();
    await client.send('ZADD', [this.resultsKey(job), result.slot, JSON.stringify(result)]);
    await client.send('ZREMRANGEBYRANK', [this.resultsKey(job), 0, -(historySize + 1)]);
    if (historyTtlMs) {
      const oldest = result.finishedAt - historyTtlMs;
      await client.send('ZREMRANGEBYSCORE', [this.resultsKey(job), '-inf', `(${oldest}`]);
      // XTRIM MINID needs Redis 6.2+; older servers keep the count limit only.
      await client.send('XTRIM', [this.streamKey(job), 'MINID', '~', oldest]).catch(() => {});
    }
  }

  async history(job: string, limit: number): Promise<RunRecord[]> {
    if (this.lease) return this.lease.history(job, limit);
    const { client } = await this.getConnection();
    const entries = parseEntries(await client.send('XREVRANGE', [this.streamKey(job), '+', '-', 'COUNT', limit]));
    const claims = entries.flatMap((entry) => toClaim(entry.fields) ?? []);
    if (claims.length === 0) return [];
    let min = Infinity;
    let max = -Infinity;
    for (const { slot } of claims) {
      min = Math.min(min, slot);
      max = Math.max(max, slot);
    }
    const members = await client.send('ZRANGEBYSCORE', [this.resultsKey(job), min, max]);
    const results = (Array.isArray(members) ? members : []).flatMap((m) => toResult(parseJson(toStr(m))) ?? []);
    return mergeRuns(job, claims, results, limit);
  }

  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    this.ready = undefined;
    if (!connection) return;
    try {
      const { client, owned } = await connection;
      if (owned) await client.close?.();
    } catch {
      // never connected
    }
  }

  private getConnection(): Promise<{ client: RedisCommandClient; owned: boolean }> {
    this.connection ??= resolveRedis(this.input).catch((error: unknown) => {
      this.connection = undefined;
      throw error;
    });
    return this.connection;
  }

  private getStrategy(): Promise<ClaimStrategy> {
    this.ready ??= (async () => {
      const { client } = await this.getConnection();
      const strategy: ClaimStrategy =
        this.strategy === 'idmp'
          ? new IdmpStrategy(client, this.idmp)
          : this.strategy === 'script'
            ? new ScriptStrategy(client, this.scriptWindowMs)
            : new StreamIdStrategy(client);
      await strategy.init();
      return strategy;
    })().catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  private streamKey(job: string): string {
    return `${this.prefix}${job}:runs`;
  }

  private resultsKey(job: string): string {
    return `${this.prefix}${job}:results`;
  }
}

export * from './client';
export { LeaseStore } from './lease';
