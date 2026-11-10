/* Copyright (C) 2026-present Aristotelis — see repository license. */

import { buildHistory, type ClaimRecord, toClaim } from '../../history';
import type {
  ClaimInput,
  JobLimits,
  RunRecord,
  StoredResult,
} from '../../types';
import { Lazy } from '../shared';
import type { KeyValueClient } from './client';
import { parseEntries, type StreamEntry, toResults } from './replies';
import { type ClaimStrategy, claimFields } from './strategies';

/**
 * What `RedisBackend` hands every call to: the streams of a claim-only strategy
 * ({@link StreamStore}), or the lease store.
 */
export interface RedisStore {
  /** How long a claimed run is remembered (ms). Infinity: forever. */
  readonly dedupeWindowMs: number;
  /** Throws for a job the store can't run safely. */
  checkJob(job: JobLimits): void;
  /** Refuses a server the store can't run on, before anything is written to it. */
  init(): Promise<void>;
  prepareJob(job: string): Promise<void>;
  claim(input: ClaimInput): Promise<boolean>;
  recordManualRun(input: ClaimInput): Promise<number | undefined>;
  saveResult(
    job: string,
    result: StoredResult,
    historySize: number,
    historyTtlMs?: number,
  ): Promise<void>;
  history(job: string, limit: number): Promise<RunRecord[]>;
  /** The connection was closed: what was learned about the server is checked again on the next one. */
  reset(): void;
}

/**
 * A job's newest claims from its streams, at most `limit` from each, and the results stored since
 * the oldest of those claims.
 */
export async function readHistory(
  redis: KeyValueClient,
  keys: { streams: string[]; results: string },
  limit: number,
  toClaimRecord: (entry: StreamEntry) => ClaimRecord | null | undefined,
): Promise<{ claims: ClaimRecord[]; results: StoredResult[] }> {
  const streams = await Promise.all(
    keys.streams.map((key) =>
      redis.send('XREVRANGE', [key, '+', '-', 'COUNT', limit]),
    ),
  );
  const claims = streams
    .flatMap((reply) => parseEntries(reply))
    .flatMap((entry) => toClaimRecord(entry) ?? []);
  if (claims.length === 0) return { claims, results: [] };

  const oldest = claims.reduce(
    (min, claim) => Math.min(min, claim.slot),
    Infinity,
  );
  const members = await redis.send('ZRANGEBYSCORE', [
    keys.results,
    oldest,
    '+inf',
  ]);

  return { claims, results: toResults(members) };
}

/**
 * The store of the claim-only strategies ('stream-id', 'idmp', 'script'). Per job: a stream
 * `<prefix><job>:runs` (one entry per claimed run; the strategy decides who adds it), a stream
 * `<prefix><job>:manual` (one entry per runNow() run) and a sorted set `<prefix><job>:results`.
 */
export class StreamStore implements RedisStore {
  readonly dedupeWindowMs: number;
  /** The strategy's check of the server, made once per connection. */
  private readonly ready = new Lazy(() => this.strategy.init());

  constructor(
    private readonly redis: () => Promise<KeyValueClient>,
    private readonly prefix: string,
    private readonly strategy: ClaimStrategy,
  ) {
    this.dedupeWindowMs = strategy.dedupeWindowMs;
  }

  checkJob(job: JobLimits): void {
    this.strategy.checkJob(job);
  }

  init(): Promise<void> {
    return this.ready.get();
  }

  /** 'idmp' configures the job's stream here; the other strategies need nothing. */
  async prepareJob(job: string): Promise<void> {
    await this.ready.get();
    await this.strategy.prepareStream(this.key(job, 'runs'));
  }

  /** The plain one-winner claim. */
  async claim(input: ClaimInput): Promise<boolean> {
    await this.ready.get();
    return this.strategy.claim({ ...input, key: this.key(input.job, 'runs') });
  }

  /** Appends an entry to the job's stream of manual runs, which claims never read. */
  async recordManualRun(input: ClaimInput): Promise<undefined> {
    const redis = await this.redis();
    // A server-clock ID in the claim stream would refuse 'stream-id' claims of a run already due.
    await redis.send('XADD', [
      this.key(input.job, 'manual'),
      'MAXLEN',
      '~',
      input.historySize,
      '*',
      ...claimFields(input, true),
    ]);
  }

  /** Adds the result to the job's sorted set and trims it by count and age. */
  async saveResult(
    job: string,
    result: StoredResult,
    historySize: number,
    historyTtlMs?: number,
  ): Promise<void> {
    const redis = await this.redis();
    const results = this.key(job, 'results');
    await redis.send('ZADD', [
      results,
      Math.max(result.slot, result.finishedAt),
      JSON.stringify(result),
    ]);
    await redis.send('ZREMRANGEBYRANK', [results, 0, -(historySize + 1)]);

    if (historyTtlMs) {
      await redis.send('ZREMRANGEBYSCORE', [
        results,
        '-inf',
        `(${result.finishedAt - historyTtlMs}`,
      ]);
      const oldestClaim =
        Math.min(result.slot, result.startedAt) - historyTtlMs;
      // XTRIM MINID needs Redis 6.2+; older servers keep the count limit only.
      for (const key of [this.key(job, 'runs'), this.key(job, 'manual')]) {
        await redis.send('XTRIM', [key, 'MINID', oldestClaim]).catch(() => {});
      }
    }
  }

  /** Joins the claims and manual runs in the streams with the results in the sorted set. */
  async history(job: string, limit: number): Promise<RunRecord[]> {
    const keys = {
      streams: [this.key(job, 'runs'), this.key(job, 'manual')],
      results: this.key(job, 'results'),
    };
    const { claims, results } = await readHistory(
      await this.redis(),
      keys,
      limit,
      (entry) => toClaim(entry.fields),
    );

    return buildHistory({ job, claims, results, limit });
  }

  reset(): void {
    this.ready.reset();
  }

  private key(job: string, part: 'runs' | 'manual' | 'results'): string {
    return `${this.prefix}${job}:${part}`;
  }
}
