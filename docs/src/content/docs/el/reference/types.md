---
title: Τύποι
description: Οι τύποι TypeScript που εξάγει το πακέτο.
---

Όλοι οι τύποι εξάγονται από τη ρίζα του πακέτου.

```ts
import type { JobContext, JobHandler, RunRecord, SchedulerOptions } from 'anarchon';
```

## Εργασίες

### `JobHandler`

```ts
type JobHandler<Data = unknown> = (ctx: JobContext<Data>) => unknown;
```

Η συνάρτηση που εκτελεί μια εργασία. Σύγχρονη ή ασύγχρονη. Η επιστροφή τιμής σημαίνει επιτυχία· η ρίψη σφάλματος σημαίνει αποτυχία, ή `interrupted` όταν το `ctx.signal` ακυρώθηκε προηγουμένως από το `stop()` ή από μια ανάληψη.

### `JobContext`

```ts
interface JobContext<Data = unknown> {
  name: string;
  slot: number;
  scheduledAt: Date;
  instanceId: string;
  manual: boolean;
  data: Data;
  signal: AbortSignal;
  attempt: number;
  reason: RunReason;
}
```

Οδηγός: [Συγγραφή handlers](../../guides/writing-handlers/#το-context-ctx).

### `JobData`, `JobDataProvider`

```ts
type JobData = object | string | number | boolean | null | JobDataProvider;
type JobDataProvider = (run: Omit<JobContext, 'data'>) => unknown; // μπορεί να επιστρέψει promise
```

Αυτό που δέχεται η επιλογή `data` ενός scheduler, μιας εργασίας και του `runNow()`: μια τιμή, ή μια συνάρτηση που καλείται όταν ξεκινά μια εκτέλεση. Οδηγός: [Δεδομένα εκτέλεσης](../../guides/run-data/).

### `RunReason`

```ts
type RunReason = 'scheduled' | 'manual' | 'catch-up' | 'takeover';
```

| Τιμή | Σημασία |
| --- | --- |
| `'scheduled'` | Η εκτέλεση ήταν προγραμματισμένη |
| `'manual'` | Κλήθηκε το `runNow()` |
| `'catch-up'` | Έπρεπε να εκτελεστεί ενώ όλα τα instances ήταν εκτός λειτουργίας |
| `'takeover'` | Ένα εφεδρικό instance ξεκίνησε την επόμενη προσπάθεια μιας εκτέλεσης της οποίας ο runner χάθηκε |

### `JobOptions`, `EveryJobOptions`, `CronJobOptions`

```ts
interface JobOptions {
  jitterMs?: number;
  maxLateMs?: number;
  historySize?: number;
  historyTtlMs?: number;
  overlap?: 'skip' | 'allow';
  timeoutMs?: number;
  maxAttempts?: number;
  catchUpMs?: number;
}

interface EveryJobOptions extends JobOptions {
  offsetMs?: number;
}

interface CronJobOptions extends JobOptions {
  timezone?: string;
}
```

Δείτε [Επιλογές](../options/#επιλογές-εργασιών).

### Τύποι των decorators

```ts
type DecoratedJobOptions<Options> = Options & {
  name?: string;                  // προεπιλογή: Class-method
  scheduler?: string | Scheduler; // προεπιλογή: ο προεπιλεγμένος scheduler
};

interface RegisterOptions {
  prefix?: string;
  defaults?: JobOptions & { timezone?: string };
}

interface ConfigureOptions extends Omit<SchedulerOptions, 'backend' | 'name'> {
  backend?: Backend | ((name: string) => Backend);
  autoStart?: boolean;
}
```

| Τύπος | Τι είναι |
| --- | --- |
| `DecoratedJobOptions` | Αυτό που δέχονται τα `@Every`, `@Cron` και `@At` όταν το όνομα δεν είναι το πρώτο όρισμα |
| `JobPlacement` | Το `{ scheduler? }`, το μέρος του που δέχεται και η μορφή με το όνομα πρώτο |
| `JobDecorator`, `ScheduledDecorator` | Αυτό που επιστρέφουν οι decorators μεθόδων και το `@Scheduled()`: decorators τόσο στο standard όσο και στο legacy στυλ |
| `RegisterOptions` | Οι επιλογές του `scheduler.register()` |
| `ConfigureOptions` | Οι ρυθμίσεις που δέχεται το `Scheduler.configure()` |

Δείτε [Decorators](../decorators/).

### `JobInfo`

Τι επιστρέφει το `jobs()` για κάθε εργασία.

```ts
interface JobInfo {
  name: string;
  type: 'cron' | 'every' | 'once';
  schedule: string;        // π.χ. 'every 10s', 'cron "0 8 * * 1-5" (Europe/Athens)'
  nextRunAt: Date | null;
  runningHere: number;     // εκτελέσεις αυτής της εργασίας που τρέχουν σε αυτό το instance τώρα
}
```

## Εκτελέσεις

### `RunRecord`

Μία προσπάθεια μίας εκτέλεσης. Επιστρέφεται από τα `history()`, `lastRun()` και `runNow()`, και αποτελεί το payload του `success`.

```ts
interface RunRecord {
  job: string;
  slot: number;
  scheduledAt: Date;
  instanceId: string;
  manual: boolean;
  attempt: number;
  reason?: RunReason;
  status: RunStatus;
  startedAt: Date;
  finishedAt?: Date;
  durationMs?: number;
  error?: string;
}
```

### `RunStatus`

```ts
type RunStatus = 'running' | 'success' | 'failed' | 'interrupted';
```

Οδηγός: [Ιστορικό](../../guides/history/#κατάσταση).

## Τύποι Scheduler

### `SchedulerOptions`

Δείτε [Επιλογές](../options/#επιλογές-scheduler).

### `Logger`

```ts
interface Logger {
  info?(message: string, ...meta: unknown[]): void;
  warn(message: string, ...meta: unknown[]): void;
  error(message: string, ...meta: unknown[]): void;
}
```

Τα `console`, pino και winston loggers ταιριάζουν όλα.

### `RedisStrategyName`

```ts
type RedisStrategyName = 'lease' | 'stream-id' | 'idmp' | 'script';
```

### `IdmpOptions`

```ts
interface IdmpOptions {
  durationSec?: number; // 1 έως 86400, προεπιλογή 300
  maxSize?: number;     // 1 έως 10000, προεπιλογή 1000
}
```

## Συμβάντα

Τα `SchedulerEvents`, `RunStartEvent`, `RunFailureEvent`, `RunInterruptedEvent`, `SkipEvent`, `LostEvent` και `SchedulerErrorEvent` περιγράφονται στα [Συμβάντα](../events/).

## Τύποι Backends

Αυτά έχουν σημασία όταν [γράφετε ένα backend](../../backends/custom/).

### `Backend`

```ts
interface Backend {
  readonly name: string;
  readonly dedupeWindowMs: number;
  checkJob?(job: JobLimits): void;
  init(): Promise<void>;
  prepareJob(job: string, historySize: number): Promise<void>;
  claim(input: ClaimInput): Promise<boolean>;
  recordClaim?(input: ClaimInput): Promise<void>;
  recordManualRun(input: ClaimInput): Promise<number | void>;
  saveResult(job: string, result: StoredResult, historySize: number, historyTtlMs?: number): Promise<void>;
  history(job: string, limit: number): Promise<RunRecord[]>;
  readonly runs?: RunStore;
  close(): Promise<void>;
}
```

### `ClaimInput`

```ts
interface ClaimInput {
  job: string;
  slot: number;
  token: string;
  instanceId: string;
  historySize: number;
  historyTtlMs?: number;
}
```

### `StoredResult`

Τι αποθηκεύει ο runner όταν ολοκληρώνεται μια προσπάθεια.

```ts
interface StoredResult {
  slot: number;
  by: string;
  attempt?: number;
  status: 'success' | 'failed' | 'interrupted';
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  error?: string;
}
```

### `JobLimits`

Τι λαμβάνει το `checkJob()`, ώστε ένα backend να μπορεί να απορρίψει μια εργασία που δεν μπορεί να εκτελέσει με ασφάλεια.

```ts
interface JobLimits {
  name: string;
  jitterMs: number;
  maxLateMs: number;
  minGapMs: number; // το μικρότερο διάστημα μεταξύ δύο εκτελέσεων
  historySize: number;
  historyTtlMs?: number;
}
```

### `RunStore`

Η προαιρετική δυνατότητα μίσθωσης ενός backend.

```ts
interface RunStore {
  claim(input: RunClaim): Promise<ClaimOutcome>;
  heartbeat(job: string, slot: number, token: string, leaseMs: number): Promise<boolean>;
  finish(job: string, slot: number, token: string, status: 'success' | 'failed' | 'interrupted'): Promise<boolean>;
  release(job: string, slot: number, token: string): Promise<boolean>;
  active(job: string): Promise<Array<{ slot: number; attempt: number; alive: boolean }>>;
}
```

### `RunClaim`

```ts
interface RunClaim extends ClaimInput {
  mode: 'new' | 'takeover';
  reason: RunReason;
  leaseMs: number;
  overlap: 'skip' | 'allow';
  maxAttempts: number;
  maxLateMs?: number;
  keepMs?: number;
}
```

### `ClaimOutcome`

```ts
type ClaimOutcome =
  | { kind: 'won'; attempt: number }
  | { kind: 'running'; attempt: number }
  | { kind: 'done' }
  | { kind: 'overlap'; slot: number }
  | { kind: 'none' }
  | { kind: 'late'; lateMs: number };
```

Κάθε αποτέλεσμα εξηγείται στον [Κύκλο ζωής εκτέλεσης](../../internals/run-lifecycle/#3-η-διεκδίκηση-claim).

## Μορφές client

Η ελάχιστη μορφή που χρειάζεται το anarchon από κάθε βιβλιοθήκη client. Περνάτε έναν πραγματικό client· αυτοί οι τύποι υπάρχουν ώστε το anarchon να μην εξαρτάται από τις ίδιες τις βιβλιοθήκες.

| Τύπος | Αντιστοιχεί σε |
| --- | --- |
| `RedisInput` | Οτιδήποτε γίνεται αποδεκτό ως `redis` |
| `RedisCommandClient` | `{ send(command, args) }` |
| `RedisConnectionOptions` | `{ host, port, username, password, db }` |
| `IORedisLike`, `NodeRedisLike`, `ValkeyGlideLike` | ioredis / iovalkey, node-redis, Valkey GLIDE |
| `PgPoolLike`, `PgClientLike`, `PostgresJsLike` | `pg` Pool, `pg` Client, postgres.js |
| `SqliteDatabaseLike`, `LibsqlClientLike` | `node:sqlite` / `better-sqlite3`, `@libsql/client` |
| `SqlClient`, `SqlQuery`, `SqlRow`, `SqlValue` | Ο προσαρμογέας `{ all, transaction }` των SQL backends |
| `RabbitMQConnectionLike`, `NatsConnectionLike` | Μια σύνδεση `amqplib`, μια σύνδεση NATS |

Τύποι επιλογών backend: `RedisBackendOptions`, `PostgresBackendOptions`, `SqliteBackendOptions`, `RabbitMQBackendOptions`, `NatsBackendOptions`. Δείτε [Επιλογές](../options/).
