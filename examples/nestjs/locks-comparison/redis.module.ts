// From the nestjs/locks repository, tests/fixtures/redis/redis.module.ts (MIT License,
// Copyright (c) 2026 Kamil Mysliwiec), with ioredis in place of its test-only RESP client, as its
// own comment suggests.
import {
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Redis } from 'ioredis';

import { REDIS_URL } from './shared';

export const REDIS = Symbol('REDIS');

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      useFactory: () => new Redis(REDIS_URL),
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  // After onModuleDestroy(), where running jobs finish and hand their locks back.
  async onApplicationShutdown() {
    await this.redis.quit();
  }
}
