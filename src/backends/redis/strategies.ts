import type { ClaimInput, IdmpOptions, RedisStrategyName } from '../../types';
import { errorMessage } from '../../util';
import type { RedisCommandClient } from './client';
import { parseEntries, toRecord, toStr } from './replies';

export interface StreamClaim extends ClaimInput {
  /** Stream key of the job. */
  key: string;
}

export interface ClaimStrategy {
  readonly name: RedisStrategyName;
  /** Checks once that the server supports this strategy. */
  init(): Promise<void>;
  /** Runs once per job stream before its first claim. */
  prepareStream(key: string): Promise<void>;
  /** True for exactly one instance per slot. Safe to repeat with the same token. */
  claim(input: StreamClaim): Promise<boolean>;
}

export function claimFields(input: ClaimInput, manual: boolean): Array<string | number> {
  const fields: Array<string | number> = ['slot', input.slot, 'by', input.instanceId, 'token', input.token, 'at', Date.now()];
  if (manual) fields.push('manual', 1);
  return fields;
}

async function tokenAt(redis: RedisCommandClient, key: string, id: string): Promise<string | undefined> {
  const [entry] = parseEntries(await redis.send('XRANGE', [key, id, id]));
  return entry?.fields.token;
}

async function serverInfo(redis: RedisCommandClient): Promise<{ product: string; version: string }> {
  const info = toStr(await redis.send('INFO', ['server']));
  const valkey = /valkey_version:([\d.]+)/.exec(info);
  if (valkey) return { product: 'Valkey', version: valkey[1]! };
  return { product: 'Redis', version: /redis_version:([\d.]+)/.exec(info)?.[1] ?? 'unknown' };
}

/**
 * Redis 5+ and Valkey. The entry ID is `<slot>-0`; the server refuses an ID that is not bigger than the
 * stream's last ID, so the first XADD for a slot wins and the others get an error.
 */
export class StreamIdStrategy implements ClaimStrategy {
  readonly name = 'stream-id';

  constructor(private readonly redis: RedisCommandClient) {}

  async init(): Promise<void> {}

  async prepareStream(): Promise<void> {}

  async claim(input: StreamClaim): Promise<boolean> {
    const id = `${input.slot}-0`;
    try {
      await this.redis.send('XADD', [input.key, 'MAXLEN', '~', input.historySize, id, ...claimFields(input, false)]);
      return true;
    } catch (error) {
      if (!/equal or smaller than the target stream top item/i.test(errorMessage(error))) throw error;
      // Someone already holds this slot (or a later one). It can be us, if the client resent the XADD
      // after a dropped connection: the token tells us.
      return (await tokenAt(this.redis, input.key, id)) === input.token;
    }
  }
}

/**
 * Redis 8.6+ only. `XADD key IDMP <job> <slot> * ...`: Redis stores the first one and answers the
 * duplicates with the first entry's ID, so each instance reads that entry and compares tokens.
 * All instances use the job name as producer ID: for this job they act as one logical producer.
 */
export class IdmpStrategy implements ClaimStrategy {
  readonly name = 'idmp';

  constructor(
    private readonly redis: RedisCommandClient,
    private readonly options: Required<IdmpOptions>,
  ) {}

  async init(): Promise<void> {
    const { product, version } = await serverInfo(this.redis);
    const match = /^(\d+)\.(\d+)/.exec(version);
    const ok = product === 'Redis' && !!match && (Number(match[1]) > 8 || (Number(match[1]) === 8 && Number(match[2]) >= 6));
    if (!ok) {
      throw new Error(
        `The "idmp" strategy needs Redis 8.6 or newer (this server is ${product} ${version}). ` +
          'Use strategy "stream-id" or "script" instead; both work on any Redis 5+ and on Valkey.',
      );
    }
  }

  async prepareStream(key: string): Promise<void> {
    let info = await this.streamInfo(key);
    if (!info) {
      // XCFGSET needs an existing stream: create an empty one.
      await this.redis.send('XADD', [key, 'MAXLEN', 0, '*', 'init', 1]);
      info = (await this.streamInfo(key)) ?? {};
    }
    // Only set when different: XCFGSET with new values clears the stream's memory of seen IDs.
    if (Number(info['idmp-duration']) !== this.options.durationSec || Number(info['idmp-maxsize']) !== this.options.maxSize) {
      await this.redis.send('XCFGSET', [key, 'IDMP-DURATION', this.options.durationSec, 'IDMP-MAXSIZE', this.options.maxSize]);
    }
  }

  async claim(input: StreamClaim): Promise<boolean> {
    const reply = await this.redis.send('XADD', [
      input.key,
      'IDMP',
      input.job,
      String(input.slot),
      'MAXLEN',
      '~',
      input.historySize,
      '*',
      ...claimFields(input, false),
    ]);
    // A duplicate returns the ID of the entry that was stored first, so compare tokens.
    return (await tokenAt(this.redis, input.key, toStr(reply))) === input.token;
  }

  private async streamInfo(key: string): Promise<Record<string, unknown> | null> {
    try {
      return toRecord(await this.redis.send('XINFO', ['STREAM', key]));
    } catch (error) {
      if (/no such key/i.test(errorMessage(error))) return null;
      throw error;
    }
  }
}

/**
 * Same behavior as IDMP for servers without it (Valkey, Redis < 8.6). One atomic script: look at the
 * entries of the last `windowMs`; if this slot is already there return that entry's token, otherwise
 * append the claim and return our token.
 */
const CLAIM_SCRIPT = `
local entries = redis.call('XRANGE', KEYS[1], ARGV[2], '+')
for i = 1, #entries do
  local fields = entries[i][2]
  local slot, token, manual = nil, nil, nil
  for j = 1, #fields, 2 do
    local name = fields[j]
    if name == 'slot' then slot = fields[j + 1]
    elseif name == 'token' then token = fields[j + 1]
    elseif name == 'manual' then manual = fields[j + 1] end
  end
  if slot == ARGV[1] and manual == nil then return token end
end
redis.call('XADD', KEYS[1], 'MAXLEN', '~', ARGV[3], '*', unpack(ARGV, 5))
return ARGV[4]
`;

export class ScriptStrategy implements ClaimStrategy {
  readonly name = 'script';
  private sha: string | undefined;

  constructor(
    private readonly redis: RedisCommandClient,
    private readonly windowMs: number,
  ) {}

  async init(): Promise<void> {
    this.sha = toStr(await this.redis.send('SCRIPT', ['LOAD', CLAIM_SCRIPT]));
  }

  async prepareStream(): Promise<void> {}

  async claim(input: StreamClaim): Promise<boolean> {
    const args = [
      1,
      input.key,
      String(input.slot),
      String(Math.max(0, input.slot - this.windowMs)),
      input.historySize,
      input.token,
      ...claimFields(input, false),
    ];
    let stored: unknown;
    try {
      stored = await this.redis.send('EVALSHA', [this.sha ?? '', ...args]);
    } catch (error) {
      if (!/NOSCRIPT/i.test(errorMessage(error))) throw error;
      stored = await this.redis.send('EVAL', [CLAIM_SCRIPT, ...args]); // script cache was flushed
    }
    return toStr(stored) === input.token;
  }
}
