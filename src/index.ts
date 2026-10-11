/* Copyright (C) 2026-present Aristotelis — see repository license. */

export type { NatsBackendOptions, NatsConnectionLike } from './backends/nats';
export { NatsBackend } from './backends/nats';
export type { RabbitMQBackendOptions, RabbitMQConnectionLike } from './backends/rabbitmq';
export { RabbitMQBackend } from './backends/rabbitmq';
export type {
  IORedisLike,
  NodeRedisLike,
  RedisBackendOptions,
  RedisCommandClient,
  RedisConnectionOptions,
  RedisInput,
  ValkeyGlideLike,
} from './backends/redis';
export { fromIORedis, fromNodeRedis, fromValkeyGlide, LeaseStore, RedisBackend } from './backends/redis';
export type { SqlClient, SqlQuery, SqlRow, SqlValue } from './backends/sql/base';
export { SqlBackend } from './backends/sql/base';
export type { PgClientLike, PgPoolLike, PostgresBackendOptions, PostgresJsLike } from './backends/sql/postgres';
export { fromPgClient, fromPgPool, fromPostgresJs, PostgresBackend } from './backends/sql/postgres';
export type { LibsqlClientLike, SqliteBackendOptions, SqliteDatabaseLike } from './backends/sql/sqlite';
export { fromLibsql, fromSqliteDatabase, SqliteBackend } from './backends/sql/sqlite';
export type { DecoratedJobOptions, JobDecorator, JobPlacement, RegisterOptions, ScheduledDecorator } from './decorators';
export { At, Cron, Every, Scheduled } from './decorators';
export type { ConfigureOptions } from './registry';
export { formatDuration, parseDuration } from './schedule';
export { Scheduler } from './scheduler';
export type {
  Backend,
  ClaimInput,
  ClaimOutcome,
  CronJobOptions,
  EveryJobOptions,
  IdmpOptions,
  JobContext,
  JobData,
  JobDataProvider,
  JobHandler,
  JobInfo,
  JobLimits,
  JobOptions,
  Logger,
  LostEvent,
  RedisStrategyName,
  RunClaim,
  RunFailureEvent,
  RunInterruptedEvent,
  RunReason,
  RunRecord,
  RunStartEvent,
  RunStatus,
  RunStore,
  SchedulerErrorEvent,
  SchedulerEvents,
  SchedulerOptions,
  SkipEvent,
  StoredResult,
} from './types';
