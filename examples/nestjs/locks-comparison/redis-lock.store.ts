// From the nestjs/locks repository, tests/fixtures/redis/redis-lock.store.ts (MIT License,
// Copyright (c) 2026 Kamil Mysliwiec). Only the imports differ. @nestjs/locks ships no Redis
// store: this is the code an application copies, owns and keeps working.
import { Inject, Injectable } from '@nestjs/common';
import {
  type LockAcquireResult,
  type LockStore,
  LocksStorage,
} from '@nestjs/locks';

import { REDIS } from './redis.module';

/** The one ioredis method this store needs. */
export interface RedisEval {
  eval(
    script: string,
    numKeys: number,
    ...args: (string | number)[]
  ): Promise<unknown>;
}

// Takes the lock if nobody holds it, expiring on Redis's clock, and draws a fencing token
// from a counter that never goes back. Returns the token, or 0.
const ACQUIRE = `
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then
  return redis.call('INCR', KEYS[2])
end
return 0
`;

// Renews the lock, if it is still ours.
const RENEW = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

// Deletes the lock, if it is still ours.
const RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/** Where the fencing counter lives; no lock key can be named like it. */
const FENCING_COUNTER = 'locks:fencing-token';

@Injectable()
export class RedisLockStore implements LockStore {
  constructor(
    @Inject(REDIS) private readonly redis: RedisEval,
    storage: LocksStorage,
  ) {
    storage.registerSource(this);
  }

  async acquire(
    key: string,
    owner: string,
    ttl: number,
  ): Promise<LockAcquireResult> {
    const token = Number(
      await this.redis.eval(
        ACQUIRE,
        2,
        this.key(key),
        FENCING_COUNTER,
        owner,
        ttl,
      ),
    );
    return token > 0
      ? { acquired: true, fencingToken: token }
      : { acquired: false };
  }

  async renew(key: string, owner: string, ttl: number): Promise<boolean> {
    return (await this.redis.eval(RENEW, 1, this.key(key), owner, ttl)) === 1;
  }

  async release(key: string, owner: string): Promise<boolean> {
    return (await this.redis.eval(RELEASE, 1, this.key(key), owner)) === 1;
  }

  private key(key: string) {
    return `locks:key:${key}`;
  }
}
