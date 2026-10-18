/* Copyright (C) 2026-present Aristotelis — see repository license. */

export type { NatsBackendOptions, NatsConnectionLike } from './backends/nats';
export { NatsBackend } from './backends/nats';
export type { RabbitMQBackendOptions, RabbitMQConnectionLike } from './backends/rabbitmq';
export { RabbitMQBackend } from './backends/rabbitmq';
export type {
  IORedisLike,
  KeyValueClient,
  KeyValueConnection,
  KeyValueConnectionOptions,
  NodeRedisLike,
  RedisBackendOptions,
  ValkeyBackendOptions,
  ValkeyGlideLike,
} from './backends/redis';
export { fromIORedis, fromNodeRedis, fromValkeyGlide, LeaseStore, RedisBackend, ValkeyBackend } from './backends/redis';
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
  AtJobOptions,
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
  KeyValueStrategies,
  KeyValueStrategy,
  KeyValueStrategyName,
  Logger,
  LostEvent,
  RunClaim,
  RunEvent,
  RunFailureEvent,
  RunInterruptedEvent,
  RunKey,
  RunReason,
  RunRecord,
  RunStartEvent,
  RunStatus,
  RunStore,
  SchedulerErrorEvent,
  SchedulerEvents,
  SchedulerOptions,
  ScriptOptions,
  SkipEvent,
  StoredResult,
} from './types';
