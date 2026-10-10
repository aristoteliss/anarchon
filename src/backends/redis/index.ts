import { mergeRuns, parseJson, toClaim, toResult } from '../../history';
import type { Backend, ClaimInput, IdmpOptions, JobLimits, RedisStrategyName, RunRecord, RunStore, StoredResult } from '../../types';
import { intInRange, positiveInt, versionAtLeast } from '../../util';
import { type RedisCommandClient, type RedisInput, resolveRedis } from './client';
import { LeaseStore } from './lease';
import { parseEntries, toStr } from './replies';
import { type ClaimStrategy, claimFields, IdmpStrategy, ScriptStrategy, StreamIdStrategy } from './strategies';

/**
 * Options of {@link RedisBackend}.
 *
 * @example
 * ```ts
 * new RedisBackend(); // redis://localhost:6379, 'lease', keys under 'cron:'
 * new RedisBackend({ redis: 'rediss://user:secret@host:6380/2' });
 * new RedisBackend({ redis: { host: 'localhost', port: 6390 } }); // Valkey works the same
 * new RedisBackend({ redis: existingClient, prefix: 'orders:cron:' });
 * new RedisBackend({ strategy: 'idmp', idmp: { durationSec: 600 } }); // Redis 8.6+
 * ```
 */
export interface RedisBackendOptions {
  /**
   * Where Redis is: a URL (`redis://`, or `rediss://` for TLS), `{ host, port, ... }`, or a client
   * your app already has (ioredis, iovalkey, node-redis, Valkey GLIDE, or anything with
   * `send(command, args)`). A client you pass in is never closed by stop().
   * Default: localhost:6379 via ioredis.
   *
   * @example
   * ```ts
   * new RedisBackend({ redis: 'redis://cache.internal:6379' });
   * new RedisBackend({ redis: { host: 'cache', port: 6379, password: process.env.REDIS_PASSWORD, db: 1 } });
   * new RedisBackend({ redis: new Redis(process.env.REDIS_URL) });
   * ```
   */
  redis?: RedisInput;
  /**
   * How the single runner of each run is chosen (see the table on {@link RedisBackend}).
   * Default 'lease': also gives no overlapping runs, backup runners, catch-up and retries (Redis 5+,
   * Valkey). The simpler 'stream-id', 'idmp' (Redis 8.6+) and 'script' only decide who runs each time.
   *
   * @example
   * ```ts
   * new RedisBackend({ strategy: 'stream-id' });
   * ```
   */
  strategy?: RedisStrategyName;
  /**
   * Prefix for every key. Default 'cron:'. Give each app (or environment) sharing a Redis its own;
   * instances that should share jobs must use the same one.
   *
   * @example
   * ```ts
   * new RedisBackend({ prefix: 'billing:cron:' }); // keys such as {billing:cron:sync}:state
   * ```
   */
  prefix?: string;
  /**
   * Settings for the 'idmp' strategy.
   *
   * @example
   * ```ts
   * new RedisBackend({ strategy: 'idmp', idmp: { durationSec: 900 } });
   * ```
   */
  idmp?: IdmpOptions;
  /**
   * 'script' strategy: how long a claimed run is remembered (ms). Must be longer than a job's
   * jitterMs + maxLateMs, or a late instance could run it again. Default 300000 (5 min).
   *
   * @example
   * ```ts
   * new RedisBackend({ strategy: 'script', scriptWindowMs: 10 * 60_000 });
   * ```
   */
  scriptWindowMs?: number;
}

/**
 * Redis or Valkey.
 *
 * **How each run gets exactly one runner.** Redis executes commands and Lua scripts one at a time,
 * so a single command (or script) that both checks "is this run taken?" and takes it is atomic:
 * of all the instances that send it for the same run, exactly one sees "not taken". No lock, no
 * leader. The four strategies differ in which command that is:
 *
 * | strategy | the one atomic step | remembers a run |
 * | --- | --- | --- |
 * | `lease` (default) | a Lua script on a hash: no state for the run -> store `{token, lease end}` and win; state with a live lease -> 'running'; lease ran out -> the caller wins the next attempt | while the run can still be claimed (`keepMs`) |
 * | `stream-id` | `XADD <job stream> <run time>-0`: Redis refuses an entry ID that is not greater than the stream's last one, so the second XADD for a run fails | forever (IDs only grow) |
 * | `idmp` (Redis 8.6+) | `XADD ... IDMP <job> <run time>`: Redis keeps the first entry for an idempotency key and answers repeats with that entry's ID | `idmp.durationSec` |
 * | `script` | a Lua script: scan the stream's recent entries for this run time; append only if absent | `scriptWindowMs` |
 *
 * Every claim carries a random token. After the atomic step, an instance won if the stored token is
 * its own. That also makes a claim safe to send twice (a client retry after a dropped connection
 * still recognizes its own win).
 *
 * Only `lease` goes further than "who runs it": the winner renews its lease while the job runs, so
 * the others can tell a dead runner from a slow one and take over (see {@link LeaseStore}).
 *
 * Keys per job, with 'stream-id', 'idmp' and 'script': a stream `<prefix><job>:runs` (one entry per
 * claimed run) and a sorted set `<prefix><job>:results`. With 'lease', see {@link LeaseStore}.
 *
 * @example Usually you don't create it yourself: the Scheduler does, from its Redis shortcuts
 * ```ts
 * new Scheduler({ redis: 'redis://localhost:6379' }); // = new RedisBackend({ redis, strategy: 'lease' })
 * ```
 *
 * @example Created yourself, to set what the shortcuts don't cover
 * ```ts
 * const backend = new RedisBackend({
 *   redis: { host: 'cache.internal', port: 6379, password: process.env.REDIS_PASSWORD },
 *   strategy: 'script',
 *   scriptWindowMs: 10 * 60_000,
 *   prefix: 'billing:cron:',
 * });
 * new Scheduler({ backend });
 * ```
 *
 * @example Your own client (ioredis, node-redis or Valkey GLIDE); stop() leaves it open
 * ```ts
 * const redis = new Redis(process.env.REDIS_URL);
 * new Scheduler({ backend: new RedisBackend({ redis }) });
 * ```
 */
export class RedisBackend implements Backend {
  /** 'redis:' and the strategy, e.g. 'redis:lease'. */
  readonly name: string;
  /** How one winner is picked. See the table above. */
  readonly strategy: RedisStrategyName;
  /**
   * How long a claimed run is remembered: Infinity for 'lease' and 'stream-id', idmp.durationSec for
   * 'idmp', scriptWindowMs for 'script'.
   */
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

  /** Validates the options. Nothing connects until init(). */
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

  /** 'idmp' and 'script' remember a limited number of runs: refuses a job whose late claims could outlive that memory. */
  checkJob(job: JobLimits): void {
    const needed = job.jitterMs + job.maxLateMs;
    // The server must still remember a run while late instances may try to claim it.
    if (this.strategy === 'idmp' && this.idmp.maxSize * job.minGapMs <= needed) {
      throw new RangeError(
        `Job "${job.name}": idmp.maxSize (${this.idmp.maxSize}) runs × ${job.minGapMs} ms between runs must cover jitterMs + maxLateMs (${needed} ms)`,
      );
    }
    if (this.strategy === 'script' && job.historyTtlMs !== undefined && job.historyTtlMs <= this.scriptWindowMs) {
      throw new RangeError(
        `Job "${job.name}": historyTtlMs must be longer than scriptWindowMs (${this.scriptWindowMs} ms) for the "script" strategy`,
      );
    }
    // ('lease' needs no such check: it never forgets a run that a late claim could still ask for.)
    if (this.strategy === 'script' && job.historySize * job.minGapMs <= needed) {
      throw new RangeError(
        `Job "${job.name}": historySize (${job.historySize}) runs × ${job.minGapMs} ms between runs must cover jitterMs + maxLateMs (${needed} ms) for the "script" strategy`,
      );
    }
  }

  /** Connects and checks the server version against the strategy. */
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

  /** 'idmp' configures the job's stream here; the other strategies need nothing. */
  async prepareJob(job: string): Promise<void> {
    if (this.lease) return;
    await (await this.getStrategy()).prepareStream(this.streamKey(job));
  }

  /** The plain one-winner claim. (With 'lease' the scheduler claims through `runs` instead.) */
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
    return (await this.getStrategy()).claim({ ...input, key: this.streamKey(input.job) });
  }

  /**
   * Records a runNow() run. 'lease': claims a run of its own at the first free millisecond and returns
   * that slot. Other strategies: appends an entry marked manual, so it never counts as a scheduled claim.
   */
  async recordManualRun(input: ClaimInput): Promise<number | void> {
    // (lease strategy: the scheduler claims manual runs itself, through runs.claim)
    if (this.lease) {
      for (let slot = input.slot; slot < input.slot + 10; slot++) {
        const outcome = await this.lease.claim({
          ...input,
          slot,
          mode: 'new',
          reason: 'manual',
          leaseMs: 86_400_000,
          overlap: 'allow',
          maxAttempts: 1,
        });
        if (outcome.kind === 'won') return slot;
      }
      throw new Error(`Could not record a manual run of "${input.job}"`);
    }
    const { client } = await this.getConnection();
    await client.send('XADD', [this.streamKey(input.job), 'MAXLEN', '~', input.historySize, '*', ...claimFields(input, true)]);
  }

  /** Adds the result to the job's sorted set and trims it by count and age. */
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

  /** Joins the claims in the stream with the results in the sorted set. */
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

  /** Closes the connection if this backend opened it. A client that was passed in stays open. */
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
