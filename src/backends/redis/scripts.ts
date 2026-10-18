/* Copyright (C) 2026-present Aristotelis — see repository license. */

import { errorMessage } from '../../util';
import type { KeyValueClient } from './client';
import { toStr } from './replies';

/**
 * Runs Lua scripts by their hash: each script is loaded once, then sent as EVALSHA. When the server
 * no longer knows a hash (SCRIPT FLUSH, a restart, a failover to a replica that never loaded it),
 * the script is sent in full instead.
 */
export class ScriptRunner {
  private readonly hashes = new Map<string, string>();

  constructor(private readonly redis: () => Promise<KeyValueClient>) {}

  /** Loads a script ahead of its first run; also checks that the server runs scripts at all. */
  async load(script: string): Promise<void> {
    const redis = await this.redis();
    this.hashes.set(script, toStr(await redis.send('SCRIPT', ['LOAD', script])));
  }

  /** Runs a script with these keys and arguments, and resolves with its reply. */
  async run(script: string, keys: ReadonlyArray<string>, args: ReadonlyArray<string | number>): Promise<unknown> {
    if (!this.hashes.has(script)) await this.load(script);
    const redis = await this.redis();
    try {
      return await redis.send('EVALSHA', [this.hashes.get(script) ?? '', keys.length, ...keys, ...args]);
    } catch (error) {
      if (!/NOSCRIPT/i.test(errorMessage(error))) throw error;
      return redis.send('EVAL', [script, keys.length, ...keys, ...args]);
    }
  }
}
