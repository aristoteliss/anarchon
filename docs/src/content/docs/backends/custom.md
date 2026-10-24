---
title: Writing your own backend
description: The Backend interface, a complete in-memory example, and what a lease backend adds.
---

A backend is a class that implements the `Backend` interface. If your instances share a store that can do one atomic "write unless it exists", you can write one.

## The contract

One rule matters more than everything else:

> For one job and one slot, `claim()` returns `true` for **exactly one** instance.

The scheduler does the rest: it computes the slots, waits the jitter, calls `claim()`, runs the handler on the winner, and saves the result.

```ts
interface Backend {
  /** Shown as scheduler.backend.name, e.g. 'memory'. */
  readonly name: string;
  /** How long the store remembers a claimed run (ms). Infinity if forever. */
  readonly dedupeWindowMs: number;

  /** Connect and check the server. Called by start() and before reads. */
  init(): Promise<void>;
  /** One-time setup for a job: create its table, stream or queue. */
  prepareJob(job: string, historySize: number): Promise<void>;
  /** True for exactly one instance per slot. Must be safe to repeat with the same token. */
  claim(input: ClaimInput): Promise<boolean>;
  /** Record a runNow() run. Not deduplicated. */
  recordManualRun(input: ClaimInput): Promise<number | void>;
  /** Store how a run ended. */
  saveResult(job: string, result: StoredResult, historySize: number, historyTtlMs?: number): Promise<void>;
  /** Latest runs from all instances, newest first. */
  history(job: string, limit: number): Promise<RunRecord[]>;
  /** Close what the backend opened itself. */
  close(): Promise<void>;

  /** Optional: refuse a job this backend can't run safely. Throw to refuse. */
  checkJob?(job: JobLimits): void;
  /** Optional: called after a won claim, if claim() isn't already a history record. */
  recordClaim?(input: ClaimInput): Promise<void>;
  /** Optional: present on backends with leases. */
  readonly runs?: RunStore;
}
```

`ClaimInput` is what an instance sends:

| Field | Meaning |
| --- | --- |
| `job` | The job's name |
| `slot` | The scheduled time in ms: with `job`, the identity of the run |
| `token` | A random value unique to this attempt |
| `instanceId` | Who is asking |
| `historySize`, `historyTtlMs` | How much history to keep |

## A complete example

This backend keeps everything in memory. It only coordinates schedulers in the **same process**, which makes it useful for unit tests and for seeing the contract in the smallest form.

```ts
import { type Backend, buildHistory, type ClaimInput, type ClaimRecord, type RunRecord, type StoredResult } from 'anarchon';

export class MemoryBackend implements Backend {
  readonly name = 'memory';
  /** Claims are never forgotten here, so there is no limit on how late an instance may be. */
  readonly dedupeWindowMs = Infinity;

  private readonly claims = new Map<string, ClaimRecord & { job: string; token: string }>();
  private readonly results = new Map<string, StoredResult[]>();

  async init(): Promise<void> {}
  async prepareJob(): Promise<void> {}
  async close(): Promise<void> {}

  /** The one step that must be atomic. Here it is, because JavaScript runs it without interruption. */
  async claim(input: ClaimInput): Promise<boolean> {
    const key = `${input.job}|${input.slot}`;
    const existing = this.claims.get(key);
    if (existing) return existing.token === input.token; // the same claim sent again is still ours
    this.claims.set(key, { job: input.job, token: input.token, slot: input.slot, by: input.instanceId, at: Date.now(), manual: false });
    return true;
  }

  async recordManualRun(input: ClaimInput): Promise<undefined> {
    const claim = { job: input.job, token: input.token, slot: input.slot, by: input.instanceId, at: Date.now(), manual: true };
    this.claims.set(`${input.job}|${input.slot}|manual`, claim);
    return undefined; // the slot asked for is the one used
  }

  async saveResult(job: string, result: StoredResult): Promise<void> {
    this.results.set(job, [...(this.results.get(job) ?? []), result]);
  }

  async history(job: string, limit: number): Promise<RunRecord[]> {
    const claims = [...this.claims.values()].filter((claim) => claim.job === job);
    return buildHistory({ job, claims, results: this.results.get(job) ?? [], limit });
  }
}
```

Three schedulers sharing one instance of it run each slot once:

```ts
const backend = new MemoryBackend();
const instances = ['A', 'B', 'C'].map((instanceId) => new Scheduler({ backend, instanceId }));

for (const scheduler of instances) scheduler.every('tick', '1s', (ctx) => console.log(ctx.slot, ctx.instanceId));
await Promise.all(instances.map((s) => s.start()));
```

## The atomic step in a real store

In memory, `claim()` is atomic for free. In a shared store, the check and the write must be **one operation on the server**. Checking first and writing second, as two calls, is the classic mistake:

```mermaid
sequenceDiagram
  participant A as Instance A
  participant B as Instance B
  participant S as Store
  Note over A,S: Wrong: two separate calls
  A->>S: is run 12:00:10 taken?
  S-->>A: no
  B->>S: is run 12:00:10 taken?
  S-->>B: no
  A->>S: mark it taken
  B->>S: mark it taken
  Note over A,B: both run the job
```

Use whatever your store offers to do it in one step:

| Store feature | Example |
| --- | --- |
| Insert with a unique key | `INSERT ... ON CONFLICT DO NOTHING`, then check whether a row was inserted |
| Conditional write | "put if absent", compare-and-set |
| A server-side script or transaction | Redis Lua, SQL transactions |
| De-duplicated publish | NATS message IDs, a bounded queue with rejection |

## Make `claim()` safe to repeat

Network clients retry. If a claim is sent, the connection drops, and the client sends it again, the second call must still answer `true` for the instance that already won. That is what the `token` is for: store it with the claim, and when a claim for a taken slot arrives, compare tokens.

## `dedupeWindowMs`

How long your store remembers a claimed run. If it remembers forever, return `Infinity`.

If it forgets after a while (a TTL, a bounded stream), return that time. The scheduler then refuses any job whose `jitterMs + maxLateMs` is not shorter, because an instance arriving later than the store's memory could run the job again.

## Adding leases

A backend that also provides `runs`, a `RunStore`, gets backups, overlap protection, catch-up and hand-over. It has five methods:

| Method | Must do, atomically |
| --- | --- |
| `claim(input)` | Decide between `won`, `running`, `done`, `overlap`, `none` and `late` from the run's stored state |
| `heartbeat(job, slot, token, leaseMs)` | Move the lease end forward **only if** the stored token matches |
| `finish(job, slot, token, status)` | Mark the run ended, only with the matching token |
| `release(job, slot, token)` | End a live lease now so a backup can take over (graceful stop) |
| `active(job)` | List unfinished runs and whether each lease is alive |

The rules are the same on every lease backend, and [Leases](../../internals/leases/) states them precisely. If your store speaks SQL, you don't have to write them: `PostgresBackend` and `SqliteBackend` accept an adapter with two functions, and implement the leases on top of it.

```ts
import { SqliteBackend } from 'anarchon';

// Any client with all() and transaction() works with the SQL backends
const backend = new SqliteBackend({
  database: {
    all: (sql, params) => myDriver.query(sql, params),
    transaction: (fn) => myDriver.transaction((tx) => fn({ all: (sql, params) => tx.query(sql, params) })),
  },
});
```

## Another SQL database

For a SQL database, extend `SqlBackend` instead of writing the contract yourself: it brings the tables, the claim transaction, leases and history. You give the connection, a check of the server, and a `SqlDialect`: what differs between databases (the integer type, the server's clock, row locking, placeholders).

```ts
import { fromSqliteDatabase, SqlBackend, type SqlClient, type SqlDialect } from 'anarchon';

class EmbeddedSqlBackend extends SqlBackend {
  readonly name = 'embedded-sql';
  protected readonly dialect: SqlDialect = {
    bigint: 'INTEGER',
    nowMs: `CAST(ROUND((julianday('now') - 2440587.5) * 86400000.0) AS INTEGER)`,
    forUpdate: '',
    placeholders: (sql) => sql,
    extraTables: () => [],
    serialize: async () => {},
    isAlreadyCreated: () => false,
  };

  constructor() {
    super('embedded_runs');
  }

  protected async connect(): Promise<{ client: SqlClient; owned: boolean }> {
    return { client: fromSqliteDatabase(openDatabase()), owned: true };
  }

  protected async checkServer(): Promise<void> {}
}
```

`nowMs` must read the database server's clock, so all instances agree on lease times; `forUpdate` and `serialize` must make two claims of one job take turns. The PostgreSQL and SQLite backends are the reference.

## Testing a backend

Whatever the store, test the contract directly:

1. **The race.** Send the same claim from several clients at once, many times. Exactly one must win each time.
2. **Repeat safety.** The winning claim sent again, with the same token, still answers `true`. A different token answers `false`.
3. **History.** A claim plus a saved result comes back from `history()` as one record with the right instance and status.

`backendContract()` from `anarchon/testing` runs these three checks against your backend, in any test runner. Give it a function that creates one instance's backend for a namespace: backends created with the same namespace must share one store, as instances of one service do. anarchon's own suite runs the same checks against every built-in backend.

```ts
import { backendContract } from 'anarchon/testing';
import { test } from 'vitest';

const cases = backendContract((namespace) => new MyBackend({ url: process.env.STORE_URL, prefix: `${namespace}:` }));
for (const { name, run } of cases) test(name, run, 30_000);
```

Run them against the real store, where calls really overlap: a race on a mock proves nothing. A check that fails rejects with an `ANARCHON_CONTRACT` error saying what was expected and what came back. A lease backend's `RunStore` (takeover, heartbeats, hand-over) needs tests of its own.

## Compatibility

A backend you write keeps working across minor releases of anarchon:

- **New members of `Backend` and `RunStore` are optional.** The scheduler has a fallback for a backend without them, so your class compiles and runs unchanged. A required member is only added in a major release.
- **New fields of what you receive are optional to read.** `ClaimInput`, `RunClaim` and `JobLimits` may gain fields; a backend that ignores them keeps working.
- **New fields of what you return are optional.** Build `history()` with `buildHistory()`, and the records gain new fields without changes on your side.
- **`ClaimOutcome` may gain kinds.** Return the kinds you know; the scheduler handles a kind it doesn't know like `'done'`.
- **Errors you throw** reach the user as they are. Give them a `code` of your own if callers should tell them apart.

What your backend stores is yours to keep compatible: during a rolling deploy, two versions of your backend may share the store.

## Next

- [Claim algorithms](../../internals/claim-algorithms/): how the built-in backends do it
- [Leases](../../internals/leases/)
