import { mergeRuns, parseJson, toResult } from '../../history';
import type { ClaimOutcome, RunClaim, RunRecord, RunStore, StoredResult } from '../../types';
import { errorMessage } from '../../util';
import type { RedisCommandClient } from './client';
import { parseEntries, toStr } from './replies';

/**
 * Lease strategy for Redis and Valkey (any version with Lua, so Redis 5+).
 *
 * **The algorithm.** Every decision about a run is one Lua script, and Redis runs a script to the
 * end before anything else, so two instances can never both act on the same state:
 *
 * 1. claim (`CLAIM`): read the run's state.
 *    - none: write `{attempt 1, token, lease end = now + leaseMs}` and answer 'won'. Any other
 *      instance asking after that reads this state, so exactly one wins.
 *    - running and the lease end is in the future: answer 'running'. The caller becomes a backup.
 *    - running and the lease end has passed (the runner died, froze, or released it): write
 *      `{attempt + 1, the caller's token, a new lease}` and answer 'won', unless `maxAttempts` is
 *      used up. Again only the first backup to ask sees the expired lease.
 *    - finished: answer 'done'.
 *    A new run is also refused ('overlap') while an older run of the job has a live lease.
 * 2. heartbeat (`HEARTBEAT`): the runner moves its lease end forward, but only if the stored token
 *    is still its own. If a backup took over, the token differs: the old runner is told it lost the
 *    run and its `ctx.signal` aborts.
 * 3. finish (`FINISH`): mark the run ended, again only with the matching token. A runner that lost
 *    the run can't mark it finished.
 *
 * The token is what fences an old runner out: after a takeover nothing it sends changes the run.
 *
 * Per job, all under one hash tag so it also works on Redis Cluster:
 *   {<prefix><job>}:state    hash   slot -> {a: attempt, m: max attempts, r: hand-overs, t: token, s: status, i: instance, l: lease end (server ms)}
 *   {<prefix><job>}:active   set    slots still marked running
 *   {<prefix><job>}:slots    zset   every slot in state, to trim the oldest
 *   {<prefix><job>}:runs     stream one entry per attempt (history)
 *   {<prefix><job>}:results  zset   one result per attempt (history)
 *
 * Every decision is one Lua script, so it is atomic. Lease ends use the Redis server clock, so
 * clock differences between instances don't matter.
 */

const NOW = `
if redis.replicate_commands then pcall(redis.replicate_commands) end
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
`;

/**
 * KEYS: state, active, slots, runs.
 * ARGV: slot, token, by, leaseMs, overlap, maxAttempts, keep, mode, reason, ttlMs, maxLateMs, keepMs.
 */
const CLAIM = `${NOW}
local state, active, slots, runs = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local slot, token, by = ARGV[1], ARGV[2], ARGV[3]
local leaseMs, overlap, maxAttempts = tonumber(ARGV[4]), ARGV[5], tonumber(ARGV[6])
local keep, mode, reason = tonumber(ARGV[7]), ARGV[8], ARGV[9]
local ttl, maxLate, keepMs = tonumber(ARGV[10]) or 0, tonumber(ARGV[11]) or 0, tonumber(ARGV[12]) or 0

local attempt, limit, released = 1, maxAttempts, 0
local raw = redis.call('HGET', state, slot)
if raw then
  local run = cjson.decode(raw)
  if run.t == token and run.s == 'running' then return {'won', run.a} end -- our own claim, sent again
  if run.s ~= 'running' then return {'done', run.a} end
  if run.l >= now then return {'running', run.a} end
  -- The runner stopped renewing its lease before finishing: it died, froze, or handed the run over.
  -- A run keeps the attempt limit it was started with (manual runs: 1); hand-overs don't count.
  limit, released = run.m or maxAttempts, run.r or 0
  if run.a - released >= limit then
    run.s = 'interrupted'
    redis.call('HSET', state, slot, cjson.encode(run))
    redis.call('SREM', active, slot)
    return {'done', run.a}
  end
  attempt = run.a + 1
elseif mode == 'takeover' then
  return {'none', 0}
else
  -- A claim that arrives too late (delayed, or queued while the server was unreachable) must not
  -- start a stale run, or one so old that it may have been trimmed already.
  local late = now - tonumber(slot)
  if maxLate > 0 and late > maxLate then return {'late', late} end
  for _, other in ipairs(redis.call('SMEMBERS', active)) do
    local o = redis.call('HGET', state, other)
    local run = o and cjson.decode(o)
    if not run or run.s ~= 'running' then
      redis.call('SREM', active, other)
    elseif run.l >= now then
      if overlap == 'skip' then return {'overlap', other} end
    elseif tonumber(other) < tonumber(slot) then
      -- An older run died and a newer one is starting: stop trying to finish the old one.
      run.s = 'interrupted'
      redis.call('HSET', state, other, cjson.encode(run))
      redis.call('SREM', active, other)
    end
  end
end

local run = { a = attempt, m = limit, t = token, s = 'running', i = by, l = now + leaseMs }
if released > 0 then run.r = released end
redis.call('HSET', state, slot, cjson.encode(run))
redis.call('SADD', active, slot)
redis.call('ZADD', slots, slot, slot)
-- Keep the newest runs only, but never forget a run that is still in progress, or one young
-- enough that a late claim could still ask for it.
local extra = redis.call('ZCARD', slots) - keep
if extra > 0 then
  for _, old in ipairs(redis.call('ZRANGE', slots, 0, extra - 1)) do
    if redis.call('SISMEMBER', active, old) == 0 and now - tonumber(old) > keepMs then
      redis.call('HDEL', state, old)
      redis.call('ZREM', slots, old)
    end
  end
end
redis.call('XADD', runs, 'MAXLEN', '~', keep, '*', 'slot', slot, 'attempt', attempt, 'by', by, 'token', token, 'at', now, 'reason', reason)
-- History older than ttl goes too (XTRIM MINID needs Redis 6.2+; older servers keep the count limit only).
if ttl > 0 then pcall(redis.call, 'XTRIM', runs, 'MINID', '~', now - ttl) end
return {'won', attempt}
`;

/** KEYS: state. ARGV: slot, token, leaseMs. */
const HEARTBEAT = `${NOW}
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return 0 end
local run = cjson.decode(raw)
if run.t ~= ARGV[2] or run.s ~= 'running' then return 0 end
run.l = now + tonumber(ARGV[3])
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(run))
return 1
`;

/**
 * KEYS: state. ARGV: slot, token. Ends a live lease now, so a backup can take the run over. (A lease
 * that already ran out can't be released: that runner counts as having died.)
 */
const RELEASE = `${NOW}
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return 0 end
local run = cjson.decode(raw)
if run.t ~= ARGV[2] or run.s ~= 'running' or run.l < now then return 0 end
run.l = 0
run.r = (run.r or 0) + 1
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(run))
return 1
`;

/** KEYS: state, active. ARGV: slot, token, status. */
const FINISH = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return 0 end
local run = cjson.decode(raw)
if run.t ~= ARGV[2] then return 0 end
run.s = ARGV[3]
run.l = 0
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(run))
redis.call('SREM', KEYS[2], ARGV[1])
return 1
`;

/** KEYS: state, active. Returns {slot, attempt, alive} for every unfinished run. */
const ACTIVE = `${NOW}
local out = {}
for _, slot in ipairs(redis.call('SMEMBERS', KEYS[2])) do
  local raw = redis.call('HGET', KEYS[1], slot)
  if raw then
    local run = cjson.decode(raw)
    if run.s == 'running' then table.insert(out, { slot, run.a, run.l >= now and 1 or 0 }) end
  end
end
return out
`;

/** KEYS: state. ARGV: slots... Returns the server time, then each slot's state (or false). */
const STATES = `${NOW}
local out = { now }
for i = 1, #ARGV do out[i + 1] = redis.call('HGET', KEYS[1], ARGV[i]) or '' end
return out
`;

interface StoredRun {
  a: number;
  m?: number;
  r?: number;
  t: string;
  s: 'running' | 'success' | 'failed' | 'interrupted';
  i: string;
  l: number;
}

export class LeaseStore implements RunStore {
  private readonly shas = new Map<string, string>();

  constructor(
    private readonly redis: () => Promise<RedisCommandClient>,
    private readonly prefix: string,
  ) {}

  key(job: string, part: 'state' | 'active' | 'slots' | 'runs' | 'results'): string {
    return `{${this.prefix}${job}}:${part}`;
  }

  async claim(input: RunClaim): Promise<ClaimOutcome> {
    const reply = (await this.eval(
      CLAIM,
      [this.key(input.job, 'state'), this.key(input.job, 'active'), this.key(input.job, 'slots'), this.key(input.job, 'runs')],
      [
        input.slot,
        input.token,
        input.instanceId,
        input.leaseMs,
        input.overlap,
        input.maxAttempts,
        input.historySize,
        input.mode,
        input.reason,
        input.historyTtlMs ?? 0,
        input.maxLateMs ?? 0,
        input.keepMs ?? 0,
      ],
    )) as [unknown, unknown];
    const kind = toStr(reply[0]);
    const value = Number(toStr(reply[1]));
    switch (kind) {
      case 'won':
        return { kind: 'won', attempt: value };
      case 'running':
        return { kind: 'running', attempt: value };
      case 'overlap':
        return { kind: 'overlap', slot: value };
      case 'none':
        return { kind: 'none' };
      case 'late':
        return { kind: 'late', lateMs: value };
      default:
        return { kind: 'done' };
    }
  }

  async heartbeat(job: string, slot: number, token: string, leaseMs: number): Promise<boolean> {
    return Number(await this.eval(HEARTBEAT, [this.key(job, 'state')], [slot, token, leaseMs])) === 1;
  }

  async finish(job: string, slot: number, token: string, status: 'success' | 'failed' | 'interrupted'): Promise<boolean> {
    return Number(await this.eval(FINISH, [this.key(job, 'state'), this.key(job, 'active')], [slot, token, status])) === 1;
  }

  async release(job: string, slot: number, token: string): Promise<boolean> {
    return Number(await this.eval(RELEASE, [this.key(job, 'state')], [slot, token])) === 1;
  }

  async active(job: string): Promise<Array<{ slot: number; attempt: number; alive: boolean }>> {
    const reply = await this.eval(ACTIVE, [this.key(job, 'state'), this.key(job, 'active')], []);
    return (Array.isArray(reply) ? reply : []).map((row) => {
      const [slot, attempt, alive] = row as [unknown, unknown, unknown];
      return { slot: Number(toStr(slot)), attempt: Number(toStr(attempt)), alive: Number(toStr(alive)) === 1 };
    });
  }

  async saveResult(job: string, result: StoredResult, historySize: number, historyTtlMs?: number): Promise<void> {
    const redis = await this.redis();
    const key = this.key(job, 'results');
    // Score: slot plus a fraction per attempt, so attempts of one slot stay together and in order.
    await redis.send('ZADD', [key, result.slot + (result.attempt ?? 1) / 100, JSON.stringify(result)]);
    await redis.send('ZREMRANGEBYRANK', [key, 0, -(historySize * 2 + 1)]);
    if (historyTtlMs) await redis.send('ZREMRANGEBYSCORE', [key, '-inf', `(${result.finishedAt - historyTtlMs}`]);
  }

  async history(job: string, limit: number): Promise<RunRecord[]> {
    const redis = await this.redis();
    const entries = parseEntries(await redis.send('XREVRANGE', [this.key(job, 'runs'), '+', '-', 'COUNT', limit]));
    const claims = entries.flatMap((entry) => {
      const slot = Number(entry.fields.slot);
      if (!Number.isFinite(slot) || !entry.fields.by) return [];
      return [
        {
          slot,
          by: entry.fields.by,
          at: Number(entry.fields.at),
          attempt: Number(entry.fields.attempt) || 1,
          reason: entry.fields.reason as RunRecord['reason'],
          manual: entry.fields.reason === 'manual',
        },
      ];
    });
    if (claims.length === 0) return [];
    let min = Infinity;
    let max = -Infinity;
    for (const { slot } of claims) {
      min = Math.min(min, slot);
      max = Math.max(max, slot);
    }
    const members = await redis.send('ZRANGEBYSCORE', [this.key(job, 'results'), min, max + 1]);
    const results = (Array.isArray(members) ? members : []).flatMap((m) => toResult(parseJson(toStr(m))) ?? []);
    const slots = [...new Set(claims.map((c) => c.slot))];
    const reply = (await this.eval(STATES, [this.key(job, 'state')], slots)) as unknown[];
    const now = Number(toStr(reply[0]));
    const states = new Map(slots.map((slot, i) => [slot, (parseJson(toStr(reply[i + 1]) || 'null') as StoredRun | null) ?? null] as const));

    const records = mergeRuns(job, claims, results, limit, (claim) => {
      const run = states.get(claim.slot);
      const current = run && run.a === claim.attempt;
      return current && run.s === 'running' && run.l >= now ? 'running' : 'interrupted';
    });
    return records;
  }

  private async eval(script: string, keys: string[], args: Array<string | number>): Promise<unknown> {
    const redis = await this.redis();
    let sha = this.shas.get(script);
    if (!sha) {
      sha = toStr(await redis.send('SCRIPT', ['LOAD', script]));
      this.shas.set(script, sha);
    }
    try {
      return await redis.send('EVALSHA', [sha, keys.length, ...keys, ...args]);
    } catch (error) {
      if (!/NOSCRIPT/i.test(errorMessage(error))) throw error;
      return redis.send('EVAL', [script, keys.length, ...keys, ...args]); // script cache was flushed
    }
  }
}
