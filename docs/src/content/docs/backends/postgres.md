---
title: PostgreSQL
description: The full feature set on the database you already have.
---

`PostgresBackend` gives you everything the Redis `lease` strategy does: one winner per run, backups, no overlapping runs, catch-up and hand-over on `stop()`. It needs PostgreSQL 9.5 or newer.

```ts
import { PostgresBackend, Scheduler } from 'anarchon';

const scheduler = new Scheduler({
  backend: new PostgresBackend({ connection: process.env.DATABASE_URL }),
});
```

## Connecting

`connection` accepts a connection string or a client you already have.

```ts
// A connection string. anarchon opens a small pool with `pg` and closes it on stop().
new PostgresBackend({ connection: 'postgres://user:secret@db.internal:5432/app' });

// Nothing: postgres://localhost:5432/postgres, with the PG* environment variables filling the gaps
new PostgresBackend();
```

### Your own pool or client

```ts
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
new PostgresBackend({ connection: pool }); // stop() does not end the pool
```

| You pass | Library |
| --- | --- |
| A `Pool` | `pg` (node-postgres) |
| A connected `Client` | `pg` |
| A `sql` instance | `postgres` (postgres.js) |
| `{ all, transaction }` | Anything else: your own adapter |

```ts
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL);
new PostgresBackend({ connection: sql });
```

A pool is the better choice in a service. A single `Client` can only run one statement at a time, so anarchon queues its own statements on it.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `connection` | `postgres://localhost:5432/postgres` | Connection string, or your own client |
| `table` | `'anarchon_runs'` | Table name. May include a schema: `'jobs.cron_runs'` |

## Tables

They are created on `start()` if they don't exist. Two instances starting together is fine.

| Table | One row per | Holds |
| --- | --- | --- |
| `<table>` | run | attempt, token, status, runner, lease end |
| `<table>_attempts` | attempt | who, why, when it was claimed, how it ended (the history) |
| `<table>_jobs` | job | the row that makes claims of one job take turns |

If your application's database user can't create tables, create them once with a privileged user by running `start()` in a migration step, then grant `SELECT, INSERT, UPDATE, DELETE` on the three tables.

To keep them out of your main schema:

```ts
new PostgresBackend({ connection: pool, table: 'jobs.cron_runs' }); // the schema must exist
```

## How one instance wins

A run is a row with the primary key `(job, slot)`. A claim is one short transaction:

```mermaid
sequenceDiagram
  participant A as Instance A
  participant B as Instance B
  participant P as PostgreSQL
  A->>P: BEGIN
  A->>P: upsert the job's row in runs_jobs (locks it)
  B->>P: BEGIN
  B->>P: upsert the job's row in runs_jobs
  Note over B,P: B waits: A holds the row lock
  A->>P: SELECT the run (job, slot): no row
  A->>P: INSERT the run: attempt 1, token a1, lease end
  A->>P: COMMIT
  P-->>A: won
  Note over B,P: the lock is free, B continues
  B->>P: SELECT the run (job, slot): running, lease alive
  B->>P: COMMIT
  P-->>B: running, so B becomes a backup
```

The first statement of every claim writes the job's row in `<table>_jobs`. PostgreSQL locks that row until the transaction commits, so claims of one job happen one after another. The second instance reads the run only after the first has committed, so it always sees the winner's row.

Claims of **different** jobs don't wait for each other.

## Reads and writes

- A **claim that can win** is a transaction (a few statements).
- A **heartbeat**, a hand-over and "finished" are single `UPDATE ... WHERE token = ?` statements.
- A **backup checking on a live run** is a single `SELECT`. It opens a transaction only when the lease has run out.

With three instances and the default 5-second heartbeat, a running job costs about one small `UPDATE` every 5 seconds and one `SELECT` per backup every 5 to 10 seconds.

## The database's clock

Lease ends are computed with the database's clock (`clock_timestamp()`), not the instances' clocks. A clock difference between two instances can't make a live lease look expired.

## Connection poolers

Each claim is a single transaction, and anarchon keeps no session state between statements: no advisory locks, no `LISTEN`, no session variables. That is what **transaction-mode** poolers such as PgBouncer require. anarchon's own tests run against a direct connection, so try it in your setup before relying on it.

## History

History lives in `<table>_attempts`, trimmed to about `historySize` attempts per job and to `historyTtlMs` if you set it. Because it is an ordinary table, you can query it yourself:

```sql
SELECT job, slot, attempt, instance_id, reason, claimed_at
FROM anarchon_runs_attempts
WHERE job = 'sync'
ORDER BY slot DESC, attempt DESC
LIMIT 20;
```

Treat the table layout as internal: it can change between versions. `scheduler.history()` is the stable way to read it.

## Next

- [Claim algorithms](../../internals/claim-algorithms/#postgresql)
- [Leases](../../internals/leases/)
