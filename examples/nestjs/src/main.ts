/* Copyright (C) 2026-present Aristotelis — see repository license. */

/**
 * A very small NestJS app whose providers declare anarchon jobs with decorators. It runs unchanged
 * on NestJS 11 and 12, and uses nothing but the public API of anarchon. From the repository root:
 *
 *   pnpm --filter anarchon-example-nestjs start          the installed NestJS (12)
 *   pnpm --filter anarchon-example-nestjs start:nest11   the same source on NestJS 11
 *   pnpm --filter anarchon-example-nestjs test           checks both
 *
 * It needs no server: the jobs are coordinated through a SQLite file in the temp folder, so two
 * copies of the app started side by side still run each job once. Ctrl+C stops it cleanly.
 */
import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  app.enableShutdownHooks();

  // For the automated check: stop by itself after a while.
  const exitAfterMs = Number(process.env.EXIT_AFTER_MS);
  if (exitAfterMs > 0) setTimeout(() => void app.close(), exitAfterMs);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
