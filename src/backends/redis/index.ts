/* Copyright (C) 2026-present Aristotelis — see repository license. */

import { coded } from '../../errors';
import { buildHistory, parseJson, toClaim, toResult } from '../../history';
import { keysOf, STRATEGY_SETTINGS } from '../../option-keys';
import { checkStoreFormat, STORE_FORMAT } from '../../store-format';
import type {
  Backend,
  ClaimInput,
  IdmpOptions,
  JobLimits,
  KeyValueStrategy,
  KeyValueStrategyName,
  RunRecord,
  RunStore,
  StoredResult,
} from '../../types';
import { intInRange, positiveInt, refuseUnknown, versionAtLeast } from '../../util';
import { checkConnectionOptions, type KeyValueClient, type KeyValueConnection, resolveRedis } from './client';
import { LeaseStore } from './lease';
import { parseEntries, toStr } from './replies';
import { type ClaimStrategy, claimFields, IdmpStrategy, ScriptStrategy, StreamIdStrategy } from './strategies';

/**
 * Options of {@link RedisBackend}.
 *
 * @example
 * ```ts
 * new RedisBackend(); // redis://localhost:6379, 'lease', keys under 'cron:'
 * new RedisBackend({ redis: process.env.REDIS_URL }); // rediss:// for TLS; user, password and db go in the URL
 * new RedisBackend({ redis: existingClient, prefix: 'orders:cron:' });
 * new RedisBackend({ strategy: { name: 'idmp', durationSec: 600 } }); // Redis 8.6+
 * ```
 */
export interface RedisBackendOptions<S extends KeyValueStrategyName = KeyValueStrategyName> {
  /**
   * Where Redis is: a URL (`redis://`, or `rediss://` for TLS), `{ host, port, ... }`, or a client
   * your app already has (ioredis, iovalkey, node-redis, Valkey GLIDE, or anything with
   * `send(command, args)`). A client you pass in is never closed by stop().
   * Default: localhost:6379, opened with node-redis.
   *
   * @example
   * ```ts
   * new RedisBackend({ redis: 'redis://cache.internal:6379' });
   * new RedisBackend({ redis: { host: 'cache', port: 6379, password: process.env.REDIS_PASSWORD, db: 1 } });
   * new RedisBackend({ redis: new Redis(process.env.REDIS_URL) });
   * ```
   */
  redis?: KeyValueConnection;
  /**
   * How the single runner of each run is chosen (see the table on {@link RedisBackend}): a name, or
   * `{ name, ...settings }` for the settings of 'idmp' and 'script'.
   * Default 'lease': also gives no overlapping runs, backup runners, catch-up and retries (Redis 5+).
   * The simpler 'stream-id', 'idmp' (Redis 8.6+) and 'script' only decide who runs each time, so a
   * scheduler on them takes no lease options. On Valkey, use {@link ValkeyBackend}: it has no 'idmp'.
   *
   * @example
   * ```ts
   * new RedisBackend({ strategy: 'stream-id' });
   * new RedisBackend({ strategy: { name: 'script', windowMs: 10 * 60_000 } });
   * new RedisBackend({ strategy: { name: 'idmp', durationSec: 900, maxSize: 5_000 } });
   * ```
   */
  strategy?: S | KeyValueStrategy<S>;
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
}

const REDIS_OPTIONS = keysOf<RedisBackendOptions>({ redis: true, strategy: true, prefix: true });
/** A strategy's settings given beside it, as older versions took them. */
const STRATEGY_ALIASES = {
  idmp: 'strategy',
  scriptWindowMs: 'strategy',
  windowMs: 'strategy',
  durationSec: 'strategy',
  maxSize: 'strategy',
};
const STRATEGY_HINT = ": a strategy's settings go inside it, e.g. strategy: { name: 'script', windowMs: 600000 }";

/**
 * Redis. Valkey works too, but {@link ValkeyBackend} offers only the strategies Valkey supports.
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
 * | `idmp` (Redis 8.6+) | `XADD ... IDMP <job> <run time>`: Redis keeps the first entry for an idempotency key and answers repeats with that entry's ID | `durationSec` |
 * | `script` | a Lua script: scan the stream's recent entries for this run time; append only if absent | `windowMs` |
 *
 * Every claim carries a random token. After the atomic step, an instance won if the stored token is
 * its own. That also makes a claim safe to send twice (a client retry after a dropped connection
 * still recognizes its own win).
 *
 * Only `lease` goes further than "who runs it": the winner renews its lease while the job runs, so
 * the others can tell a dead runner from a slow one and take over (see {@link LeaseStore}).
 *
 * Keys per job, with 'stream-id', 'idmp' and 'script': a stream `<prefix><job>:runs` (one entry per
 * claimed run), a stream `<prefix><job>:manual` (one entry per runNow() run) and a sorted set
 * `<prefix><job>:results`. With 'lease', see {@link LeaseStore}.
 *
 * @example The 'lease' strategy, keys under 'cron:'
 * ```ts
 * new Scheduler({ backend: new RedisBackend({ redis: 'redis://localhost:6379' }) });
 * ```
 *
 * @example Every setting
 * ```ts
 * const backend = new RedisBackend({
 *   redis: { host: 'cache.internal', port: 6379, password: process.env.REDIS_PASSWORD },
 *   strategy: { name: 'script', windowMs: 10 * 60_000 },
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
export class RedisBackend<S extends KeyValueStrategyName = KeyValueStrategyName> implements Backend {
  /** 'redis:' and the strategy, e.g. 'redis:lease'. */
  readonly name: string;
  /**
   * The strategy's name, also when it was given as `{ name, ...settings }`. See the table above.
   *
   * @example
   * ```ts
   * new RedisBackend({ strategy: { name: 'script', windowMs: 600_000 } }).strategy; // 'script'
   * ```
   */
  readonly strategy: S;
  /**
   * How long a claimed run is remembered: Infinity for 'lease' and 'stream-id', durationSec for
   * 'idmp', windowMs for 'script'.
   */
  readonly dedupeWindowMs: number;
  /** Set with the 'lease' strategy only: lets the scheduler use leases, backups and catch-up. */
  readonly runs: S extends 'lease' ? RunStore : undefined;
  private readonly lease?: LeaseStore;

  private readonly prefix: string;
  private readonly input: KeyValueConnection | undefined;
  private readonly idmp: Required<IdmpOptions>;
  private readonly scriptWindowMs: number;
  private connection: Promise<{ client: KeyValueClient; owned: boolean }> | undefined;
  private ready: Promise<ClaimStrategy> | undefined;

  /** Validates the options. Nothing connects until init(). */
  constructor(options: RedisBackendOptions<S> = {}) {
    refuseUnknown('RedisBackend', options, REDIS_OPTIONS, STRATEGY_ALIASES, STRATEGY_HINT);
    checkConnectionOptions('redis', options.redis);
    const { name = 'lease', ...settings } = (typeof options.strategy === 'object' ? options.strategy : { name: options.strategy }) as {
      name?: KeyValueStrategyName;
    } & IdmpOptions & { windowMs?: number };
    if (!Object.hasOwn(STRATEGY_SETTINGS, name)) {
      throw coded(
        new TypeError(`Unknown strategy "${String(name)}" (use "lease", "stream-id", "idmp" or "script")`),
        'ANARCHON_INVALID_ARGUMENT',
      );
    }
    for (const key of Object.keys(settings)) {
      if (!STRATEGY_SETTINGS[name].includes(key))
        throw coded(new TypeError(`The "${name}" strategy has no setting "${key}"`), 'ANARCHON_UNKNOWN_OPTION');
    }
    this.strategy = name as S;
    this.name = `redis:${this.strategy}`;
    this.prefix = options.prefix ?? 'cron:';
    this.input = options.redis;
    this.idmp = {
      durationSec: intInRange('strategy.durationSec', settings.durationSec ?? 300, 1, 86_400),
      maxSize: intInRange('strategy.maxSize', settings.maxSize ?? 1_000, 1, 10_000),
    };
    this.scriptWindowMs = positiveInt('strategy.windowMs', settings.windowMs ?? 300_000);
    this.dedupeWindowMs = name === 'idmp' ? this.idmp.durationSec * 1_000 : name === 'script' ? this.scriptWindowMs : Infinity;
    if (name === 'lease') this.lease = new LeaseStore(async () => (await this.getConnection()).client, this.prefix);
    this.runs = this.lease as this['runs'];
  }

  /** 'idmp' and 'script' remember a limited number of runs: refuses a job whose late claims could outlive that memory. */
  checkJob(job: JobLimits): void {
    const needed = job.jitterMs + job.maxLateMs;
    // The server must still remember a run while late instances may try to claim it.
    if (this.strategy === 'idmp' && this.idmp.maxSize * job.minGapMs <= needed) {
      throw coded(
        new RangeError(
          `Job "${job.name}": the idmp strategy's maxSize (${this.idmp.maxSize}) runs × ${job.minGapMs} ms between runs must cover jitterMs + maxLateMs (${needed} ms)`,
        ),
        'ANARCHON_UNSAFE_JOB',
      );
    }
    if (this.strategy === 'script' && job.historyTtlMs !== undefined && job.historyTtlMs <= this.scriptWindowMs) {
      throw coded(
        new RangeError(`Job "${job.name}": historyTtlMs must be longer than the script strategy's windowMs (${this.scriptWindowMs} ms)`),
        'ANARCHON_UNSAFE_JOB',
      );
    }
    // ('lease' needs no such check: it never forgets a run that a late claim could still ask for.)
    if (this.strategy === 'script' && job.historySize * job.minGapMs <= needed) {
      throw coded(
        new RangeError(
          `Job "${job.name}": historySize (${job.historySize}) runs × ${job.minGapMs} ms between runs must cover jitterMs + maxLateMs (${needed} ms) for the "script" strategy`,
        ),
        'ANARCHON_UNSAFE_JOB',
      );
    }
  }

  /** Connects and checks the server version against the strategy. */
  async init(): Promise<void> {
    const { client } = await this.getConnection();
    const marker = `${this.prefix}format`;
    await client.send('SET', [marker, STORE_FORMAT, 'NX']);
    checkStoreFormat(toStr(await client.send('GET', [marker])), `The keys under "${this.prefix}"`);
    if (this.lease) {
      // Streams (XADD) arrived in Redis 5; Valkey reports redis_version 7.2.4.
      const info = toStr(await (await this.getConnection()).client.send('INFO', ['server']));
      const version = /redis_version:([\d.]+)/.exec(info)?.[1] ?? '0';
      if (!versionAtLeast(version, 5, 0))
        throw coded(new Error(`The "lease" strategy needs Redis 5 or newer (this server is ${version}).`), 'ANARCHON_SERVER');
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
   * that slot. Other strategies: appends an entry to the job's stream of manual runs, which claims never read.
   */
  async recordManualRun(input: ClaimInput): Promise<number | undefined> {
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
      throw coded(new Error(`Could not record a manual run of "${input.job}"`), 'ANARCHON_STORE');
    }
    const { client } = await this.getConnection();
    // A server-clock ID in the claim stream would refuse 'stream-id' claims of a run already due.
    await client.send('XADD', [this.manualKey(input.job), 'MAXLEN', '~', input.historySize, '*', ...claimFields(input, true)]);
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
      for (const key of [this.streamKey(job), this.manualKey(job)]) await client.send('XTRIM', [key, 'MINID', '~', oldest]).catch(() => {});
    }
  }

  /** Joins the claims and manual runs in the streams with the results in the sorted set. */
  async history(job: string, limit: number): Promise<RunRecord[]> {
    if (this.lease) return this.lease.history(job, limit);
    const { client } = await this.getConnection();
    const streams = await Promise.all(
      [this.streamKey(job), this.manualKey(job)].map((key) => client.send('XREVRANGE', [key, '+', '-', 'COUNT', limit])),
    );
    const claims = streams.flatMap((reply) => parseEntries(reply)).flatMap((entry) => toClaim(entry.fields) ?? []);
    if (claims.length === 0) return [];
    let min = Infinity;
    let max = -Infinity;
    for (const { slot } of claims) {
      min = Math.min(min, slot);
      max = Math.max(max, slot);
    }
    const members = await client.send('ZRANGEBYSCORE', [this.resultsKey(job), min, max]);
    const results = (Array.isArray(members) ? members : []).flatMap((m) => toResult(parseJson(toStr(m))) ?? []);
    return buildHistory({ job, claims, results, limit });
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

  private getConnection(): Promise<{ client: KeyValueClient; owned: boolean }> {
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

  private manualKey(job: string): string {
    return `${this.prefix}${job}:manual`;
  }

  private resultsKey(job: string): string {
    return `${this.prefix}${job}:results`;
  }
}

/**
 * Options of {@link ValkeyBackend}: those of {@link RedisBackendOptions}, with `valkey` in place of
 * `redis`, and a strategy Valkey supports (no 'idmp').
 *
 * @example
 * ```ts
 * new ValkeyBackend({ valkey: 'redis://valkey.internal:6379', strategy: 'stream-id' });
 * new ValkeyBackend({ valkey: new GlideClient(...), strategy: { name: 'script', windowMs: 10 * 60_000 } });
 * ```
 */
export interface ValkeyBackendOptions<S extends KeyValueStrategyName<'valkey'> = KeyValueStrategyName<'valkey'>>
  extends Omit<RedisBackendOptions<S>, 'redis'> {
  /**
   * Where Valkey is: a URL, `{ host, port, ... }`, or your iovalkey, Valkey GLIDE or node-redis
   * client. A client you pass in is never closed by stop(). Default: localhost:6379, opened with
   * node-redis.
   *
   * @example
   * ```ts
   * new ValkeyBackend({ valkey: 'redis://valkey.internal:6379' });
   * new ValkeyBackend({ valkey: new Valkey(process.env.VALKEY_URL) }); // iovalkey
   * ```
   */
  valkey?: KeyValueConnection;
}

const VALKEY_OPTIONS = keysOf<ValkeyBackendOptions>({ valkey: true, strategy: true, prefix: true });

/**
 * Valkey: a {@link RedisBackend} whose `strategy` can only be one Valkey supports, so 'idmp' is a
 * type error rather than an error from `start()`.
 *
 * @example
 * ```ts
 * new Scheduler({ backend: new ValkeyBackend({ valkey: 'redis://localhost:6379' }) });
 * ```
 */
export class ValkeyBackend<S extends KeyValueStrategyName<'valkey'> = KeyValueStrategyName<'valkey'>> extends RedisBackend<S> {
  /** 'valkey:' and the strategy, e.g. 'valkey:lease'. */
  override readonly name: string;

  /** Validates the options. Nothing connects until init(). */
  constructor(options: ValkeyBackendOptions<S> = {}) {
    refuseUnknown('ValkeyBackend', options, VALKEY_OPTIONS, { ...STRATEGY_ALIASES, redis: 'valkey' });
    checkConnectionOptions('valkey', options.valkey);
    const { valkey, ...rest } = options;
    const name = typeof rest.strategy === 'object' ? rest.strategy.name : rest.strategy;
    if ((name as string) === 'idmp') {
      throw coded(
        new TypeError(
          'The "idmp" strategy needs Redis 8.6 or newer, and Valkey has no idempotent XADD. Use strategy "stream-id" or "script".',
        ),
        'ANARCHON_UNSUPPORTED',
      );
    }
    super({ ...rest, redis: valkey });
    this.name = `valkey:${this.strategy}`;
  }
}

export * from './client';
export { LeaseStore } from './lease';
