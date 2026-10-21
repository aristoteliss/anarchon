/* Copyright (C) 2026-present Aristotelis — see repository license. */

import { coded } from '../../errors';
import { buildHistory, type ClaimRecord } from '../../history';
import { checkStoreFormat, STORE_FORMAT } from '../../store-format';
import type {
  Backend,
  ClaimInput,
  ClaimOutcome,
  RunClaim,
  RunRecord,
  RunStatus,
  RunStore,
  StoredResult,
} from '../../types';

/** A statement parameter: the SQL backends only bind strings, numbers and null. */
export type SqlValue = string | number | null;
/**
 * One result row, by column name. Numbers may come back as strings or bigints, depending on the
 * driver; the backends convert what they read.
 */
export type SqlRow = Record<string, unknown>;

/**
 * Runs one statement and returns its rows. Statements come with the placeholders of the backend's
 * database (`$1` for Postgres, `?` for SQLite), ready for the driver.
 *
 * @example
 * ```ts
 * const query: SqlQuery = { all: async (sql, params) => (await pool.query(sql, [...params])).rows };
 * ```
 */
export interface SqlQuery {
  /** Runs one statement and resolves with its rows ([] for a statement that returns none). */
  all(sql: string, params: ReadonlyArray<SqlValue>): Promise<SqlRow[]>;
}

/**
 * What the SQL backends need from a driver: single statements, and a transaction (used to claim
 * runs). Postgres, SQLite and libSQL drivers are adapted to this automatically; pass your own
 * `{ all, transaction }` for anything else.
 *
 * @example A driver anarchon doesn't know (here a Kysely-like `db`)
 * ```ts
 * const client: SqlClient = {
 *   all: async (sql, params) => (await db.raw(sql, params)).rows,
 *   transaction: (fn) => db.transaction(async (trx) => fn({ all: async (sql, params) => (await trx.raw(sql, params)).rows })),
 * };
 * new PostgresBackend({ connection: client });
 * ```
 */
export interface SqlClient extends SqlQuery {
  /** Runs fn inside one transaction: commit when it resolves, roll back when it throws. */
  transaction<T>(fn: (tx: SqlQuery) => Promise<T>): Promise<T>;
  /** Called on stop() only when the backend opened the connection itself. */
  close?(): Promise<void>;
}

/**
 * What differs between SQL databases. A subclass of {@link SqlBackend} for another database
 * gives one, together with `connect()` and `checkServer()`; the tables, the claim transaction and
 * the history are shared.
 *
 * @example A dialect for an embedded SQLite-compatible database
 * ```ts
 * class EmbeddedSqlBackend extends SqlBackend {
 *   readonly name = 'embedded-sql';
 *   protected readonly dialect: SqlDialect = {
 *     bigint: 'INTEGER',
 *     nowMs: `CAST(ROUND((julianday('now') - 2440587.5) * 86400000.0) AS INTEGER)`,
 *     forUpdate: '',                 // one writer at a time already
 *     placeholders: (sql) => sql,    // the driver takes '?'
 *     extraTables: () => [],
 *     serialize: async () => {},
 *     isAlreadyCreated: () => false,
 *   };
 *   constructor() { super('embedded_runs'); }
 *   protected async connect() { return { client: fromSqliteDatabase(openDatabase()), owned: true }; }
 *   protected async checkServer() {}
 * }
 * ```
 */
export interface SqlDialect {
  /** Integer type for ms timestamps. */
  readonly bigint: string;
  /** Expression for the database server's clock in ms since epoch. */
  readonly nowMs: string;
  /** Appended to a SELECT inside a claim to lock the rows it reads until commit ('' if the database already serializes writers). */
  readonly forUpdate: string;
  /** Turns `?` placeholders into the driver's style. */
  placeholders(sql: string): string;
  /** Extra statements for createTables. */
  readonly extraTables: (table: string) => string[];
  /** Run first in every claim transaction, so claims of one job happen one after another. */
  serialize(tx: SqlQuery, table: string, job: string): Promise<void>;
  /** Errors from concurrent CREATE ... IF NOT EXISTS that are safe to ignore. */
  isAlreadyCreated(error: unknown): boolean;
}

export function isIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(name);
}

/** In-process queue: one statement or transaction at a time on a single connection. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  /** Runs fn after everything queued before it, whether those succeeded or failed. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => {});
    return result;
  }
}

/** The JSON-free state row of a run. */
interface RunRow {
  attempt: number;
  maxAttempts: number;
  released: number;
  token: string;
  status: string;
  leaseUntil: number;
}

/**
 * Postgres and SQLite, with the same lease rules as the Redis 'lease' strategy (see LeaseStore):
 * a claim is one transaction that reads and writes the run's row, so exactly one instance wins each
 * attempt. Leases use the database's clock.
 *
 * **The algorithm.** A run is one row, with primary key (job, slot). A claim is one transaction:
 *
 * 1. Make claims of this job wait for each other (Postgres: write the job's row in `<table>_jobs`,
 *    which locks it until commit; SQLite: `BEGIN IMMEDIATE`, one writer at a time).
 * 2. Read the run's row.
 *    - no row: insert it with `attempt 1`, the caller's token and `lease_until = now + leaseMs`: 'won'.
 *      The second instance waits at step 1, then reads this row.
 *    - status 'running' and `lease_until` in the future: 'running'. The caller becomes a backup.
 *    - status 'running' and `lease_until` passed: update the row to `attempt + 1`, the caller's
 *      token and a new lease: 'won' (unless `max_attempts` is used up).
 *    - any other status: 'done'.
 * 3. Commit.
 *
 * Heartbeat, release and finish are single `UPDATE ... WHERE token = ?` statements: once a backup
 * has taken over, the token no longer matches, so the old runner changes nothing and learns it lost
 * the run. A backup checking on a live run only reads; it opens the transaction when the lease has
 * run out.
 *
 * Tables (created on start):
 *   <table>           one row per run: attempt, token, status, lease end
 *   <table>_attempts  one row per attempt: who, why, when, and how it ended (history)
 *
 * @example Read a job's unfinished runs straight from the backend, as in tests or tooling
 * ```ts
 * const backend = new PostgresBackend({ connection: process.env.DATABASE_URL });
 * await backend.init();
 * const open = await backend.active('nightly-export'); // [{ slot, attempt, alive }]
 * ```
 */
export abstract class SqlBackend implements Backend, RunStore {
  /** 'postgres' or 'sqlite'. */
  abstract readonly name: string;
  /** Runs are never forgotten while a late claim could still ask for them, so no time limit. */
  readonly dedupeWindowMs = Infinity;
  /** The backend is its own RunStore: leases are always available. */
  readonly runs: RunStore = this;

  protected readonly table: string;
  protected readonly attempts: string;
  private connection:
    | Promise<{ client: SqlClient; owned: boolean }>
    | undefined;
  private ready: Promise<SqlClient> | undefined;

  protected constructor(table: string) {
    if (!isIdentifier(table)) {
      throw coded(
        new TypeError(`Invalid table name "${table}"`),
        'ANARCHON_INVALID_ARGUMENT',
      );
    }
    this.table = table;
    this.attempts = `${table}_attempts`;
  }

  /** Opens the connection (or wraps the one the user passed). */
  protected abstract connect(): Promise<{ client: SqlClient; owned: boolean }>;
  protected abstract readonly dialect: SqlDialect;
  /** Throws if the server is too old. */
  protected abstract checkServer(client: SqlClient): Promise<void>;

  /** Connects, checks the server version and creates the tables. */
  init(): Promise<void> {
    return this.getReady().then(() => undefined);
  }

  /** Nothing per job: all jobs share the tables. */
  async prepareJob(): Promise<void> {}

  /** With a RunClaim: the lease state machine. With a plain ClaimInput (no scheduler): one winner, a long lease, no backups. */
  async claim(input: ClaimInput): Promise<boolean>;
  async claim(input: RunClaim): Promise<ClaimOutcome>;
  async claim(input: ClaimInput | RunClaim): Promise<boolean | ClaimOutcome> {
    if (!('mode' in input)) {
      // Plain Backend.claim (without the scheduler's lease handling): a long lease, no backups.
      const outcome = await this.claimRun({
        ...input,
        mode: 'new',
        reason: 'scheduled',
        leaseMs: 86_400_000,
        overlap: 'allow',
        maxAttempts: 1,
      });
      return outcome.kind === 'won';
    }

    return this.claimRun(input);
  }

  /** One UPDATE: sets lease_until to now + leaseMs where the token matches, the run is still running and its lease was not released. */
  async heartbeat(
    job: string,
    slot: number,
    token: string,
    leaseMs: number,
  ): Promise<boolean> {
    // A released lease (lease_until = 0) stays released: a heartbeat sent before the release can arrive after it.
    const rows = await this.run(
      `UPDATE ${this.table}
       SET lease_until = ${this.dialect.nowMs} + ?
       WHERE job = ? AND slot = ? AND token = ?
         AND status = 'running' AND lease_until > 0
       RETURNING slot`,
      [leaseMs, job, slot, token],
    );

    return rows.length > 0;
  }

  /** One UPDATE: sets the status where the token matches. */
  async finish(
    job: string,
    slot: number,
    token: string,
    status: 'success' | 'failed' | 'interrupted',
  ): Promise<boolean> {
    const rows = await this.run(
      `UPDATE ${this.table}
       SET status = ?, lease_until = 0
       WHERE job = ? AND slot = ? AND token = ?
       RETURNING slot`,
      [status, job, slot, token],
    );

    return rows.length > 0;
  }

  /** One UPDATE: ends a live lease now and counts a hand-over, where the token matches. */
  async release(job: string, slot: number, token: string): Promise<boolean> {
    // Only a live lease can be released; a runner whose lease already ran out counts as having died.
    const rows = await this.run(
      `UPDATE ${this.table}
       SET lease_until = 0, released = released + 1
       WHERE job = ? AND slot = ? AND token = ? AND status = 'running'
         AND lease_until >= ${this.dialect.nowMs}
       RETURNING slot`,
      [job, slot, token],
    );

    return rows.length > 0;
  }

  /** The job's rows with status 'running', each with whether lease_until is still ahead of the database's clock. */
  async active(
    job: string,
  ): Promise<Array<{ slot: number; attempt: number; alive: boolean }>> {
    const { nowMs } = this.dialect;
    const rows = await this.run(
      `SELECT slot, attempt,
              CASE WHEN lease_until >= ${nowMs} THEN 1 ELSE 0 END AS alive
       FROM ${this.table}
       WHERE job = ? AND status = 'running'
       ORDER BY slot`,
      [job],
    );

    return rows.map((row) => ({
      slot: Number(row.slot),
      attempt: Number(row.attempt),
      alive: Number(row.alive) === 1,
    }));
  }

  /** Claims a run of its own for runNow(), at the first free millisecond from input.slot. Returns the slot it used. */
  async recordManualRun(input: ClaimInput): Promise<number> {
    for (let slot = input.slot; slot < input.slot + 10; slot++) {
      const outcome = await this.claimRun({
        ...input,
        slot,
        mode: 'new',
        reason: 'manual',
        leaseMs: 86_400_000,
        overlap: 'allow',
        maxAttempts: 1,
      });
      if (outcome.kind === 'won') return slot;
    }

    throw coded(
      new Error(`Could not record a manual run of "${input.job}"`),
      'ANARCHON_STORE',
    );
  }

  /** Writes how the attempt ended on its row in <table>_attempts. */
  async saveResult(
    job: string,
    result: StoredResult,
    _historySize: number,
    historyTtlMs?: number,
  ): Promise<void> {
    await this.run(
      `UPDATE ${this.attempts}
       SET status = ?, started_at = ?, finished_at = ?,
           duration_ms = ?, error = ?
       WHERE job = ? AND slot = ? AND attempt = ? AND instance_id = ?`,
      [
        result.status,
        result.startedAt,
        result.finishedAt,
        result.durationMs,
        result.error ?? null,
        job,
        result.slot,
        result.attempt ?? 1,
        result.by,
      ],
    );

    if (historyTtlMs) {
      await this.run(
        `DELETE FROM ${this.attempts}
         WHERE job = ? AND COALESCE(finished_at, claimed_at) < ?`,
        [job, result.finishedAt - historyTtlMs],
      );
    }
  }

  /**
   * Reads <table>_attempts, newest first. An attempt without an end is 'running' only while it is the
   * current attempt with a live lease.
   */
  async history(job: string, limit: number): Promise<RunRecord[]> {
    const rows = await this.run(
      `SELECT a.slot, a.attempt, a.instance_id, a.reason, a.manual,
              a.claimed_at, a.status, a.started_at, a.finished_at,
              a.duration_ms, a.error, r.attempt AS current_attempt,
              r.status AS current_status, r.lease_until,
              ${this.dialect.nowMs} AS now
       FROM ${this.attempts} a
       LEFT JOIN ${this.table} r ON r.job = a.job AND r.slot = a.slot
       WHERE a.job = ?
       ORDER BY a.slot DESC, a.attempt DESC
       LIMIT ?`,
      [job, limit],
    );

    const claims: ClaimRecord[] = [];
    const results: StoredResult[] = [];
    const pending = new Map<string, RunStatus>();
    for (const row of rows) {
      const claim = toClaimRecord(row);
      claims.push(claim);
      const result = toStoredResult(row, claim);
      if (result) results.push(result);
      else pending.set(`${claim.slot}|${claim.attempt}`, pendingStatusOf(row));
    }

    return buildHistory({
      job,
      claims,
      results,
      limit,
      pendingStatus: (claim) =>
        pending.get(`${claim.slot}|${claim.attempt}`) ?? 'interrupted',
    });
  }

  /** Closes the connection if this backend opened it. A client that was passed in stays open. */
  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    this.ready = undefined;
    if (!connection) return;

    try {
      const { client, owned } = await connection;
      if (owned) await client.close?.();
    } catch {
      // never connected
    }
  }

  /**
   * One transaction per claim, and the rows it reads are locked until it commits (SQLite: one
   * writer at a time anyway).
   */
  private async claimRun(input: RunClaim): Promise<ClaimOutcome> {
    const client = await this.getReady();
    if (input.mode === 'takeover') {
      const answer = await this.takeoverWithoutWriting(input);
      if (answer) return answer;
    }

    return client.transaction(async (raw) => {
      const tx = this.withPlaceholders(raw);
      await this.dialect.serialize(tx, this.table, input.job);
      const now = await this.clock(tx);
      const run = await this.readRun(tx, input);

      const decision = decideClaim(run, input, now);
      return this.act(tx, input, decision, now);
    });
  }

  /** The transaction, with the dialect's placeholders applied to every statement. */
  private withPlaceholders(raw: SqlQuery): SqlQuery {
    return {
      all: (sql, params) => raw.all(this.dialect.placeholders(sql), params),
    };
  }

  /** The database's clock, in Unix ms: every claim decides by it, never by the instance's. */
  private async clock(tx: SqlQuery): Promise<number> {
    const [row] = await tx.all(`SELECT ${this.dialect.nowMs} AS now`, []);
    return Number(row?.now);
  }

  /** The run's row, locked until the transaction commits; undefined when nobody claimed it. */
  private async readRun(
    tx: SqlQuery,
    { job, slot }: RunClaim,
  ): Promise<RunRow | undefined> {
    const [row] = await tx.all(
      `SELECT attempt, max_attempts, released, token, status, lease_until
       FROM ${this.table}
       WHERE job = ? AND slot = ?${this.dialect.forUpdate}`,
      [job, slot],
    );
    return row ? toRunRow(row) : undefined;
  }

  /** Performs the writes the decision asks for, and answers the claim. */
  private async act(
    tx: SqlQuery,
    input: RunClaim,
    decision: ClaimDecision,
    now: number,
  ): Promise<ClaimOutcome> {
    switch (decision.kind) {
      case 'answer':
        return decision.outcome;

      case 'give-up':
        await this.interrupt(tx, input.job, input.slot);
        return { kind: 'done' };

      case 'start': {
        const refused = await this.startRun(tx, input, now);
        if (refused) return refused;

        return this.win(tx, input, 1, now);
      }

      case 'take-over':
        await this.takeOver(tx, input, decision.attempt, now);
        return this.win(tx, input, decision.attempt, now);
    }
  }

  /** Records the won attempt and answers the claim with it. */
  private async win(
    tx: SqlQuery,
    input: RunClaim,
    attempt: number,
    now: number,
  ): Promise<ClaimOutcome> {
    await this.recordAttempt(tx, input, attempt, now);
    return { kind: 'won', attempt };
  }

  /**
   * A takeover answered by a plain read when it can't win. Backups ask every 1 to 2 heartbeats, and
   * nearly always the run is still alive; only a claim that can win opens the transaction, which
   * holds the write lock (on a libSQL server for seconds, if this process dies inside it).
   */
  private async takeoverWithoutWriting(
    input: RunClaim,
  ): Promise<ClaimOutcome | undefined> {
    const [row] = await this.run(
      `SELECT attempt, token, status, lease_until, ${this.dialect.nowMs} AS now
       FROM ${this.table}
       WHERE job = ? AND slot = ?`,
      [input.job, input.slot],
    );

    if (!row) return { kind: 'none' };
    if (row.token === input.token) return undefined;
    if (row.status !== 'running') return { kind: 'done' };
    if (Number(row.lease_until) >= Number(row.now)) {
      return { kind: 'running', attempt: Number(row.attempt) };
    }
    return undefined;
  }

  /** Inserts a new run inside the claim's transaction, or says why it must not start. */
  private async startRun(
    tx: SqlQuery,
    input: RunClaim,
    now: number,
  ): Promise<ClaimOutcome | undefined> {
    // Too late (delayed or queued claim): don't start a stale run.
    const late = now - input.slot;
    if (input.maxLateMs && late > input.maxLateMs) {
      return { kind: 'late', lateMs: late };
    }

    const refused = await this.settleOtherRuns(tx, input, now);
    if (refused) return refused;

    await this.insertRun(tx, input, now);
    return undefined;
  }

  /** Refuses to overlap a live run of the job, and ends older runs whose runner died. */
  private async settleOtherRuns(
    tx: SqlQuery,
    input: RunClaim,
    now: number,
  ): Promise<ClaimOutcome | undefined> {
    const others = await tx.all(
      `SELECT slot, lease_until
       FROM ${this.table}
       WHERE job = ? AND status = 'running'${this.dialect.forUpdate}`,
      [input.job],
    );

    for (const other of others) {
      const otherSlot = Number(other.slot);
      if (Number(other.lease_until) >= now) {
        if (input.overlap === 'skip') {
          return { kind: 'overlap', slot: otherSlot };
        }
      } else if (otherSlot < input.slot) {
        // An older run died and a newer one is starting: stop trying to finish the old one.
        await this.interrupt(tx, input.job, otherSlot);
      }
    }

    return undefined;
  }

  /** Inserts the run's row with its first attempt and a lease from now. */
  private async insertRun(
    tx: SqlQuery,
    input: RunClaim,
    now: number,
  ): Promise<void> {
    const { job, slot, maxAttempts, token, instanceId, leaseMs } = input;
    await tx.all(
      `INSERT INTO ${this.table}
         (job, slot, attempt, max_attempts, released, token, status,
          instance_id, lease_until)
       VALUES (?, ?, 1, ?, 0, ?, 'running', ?, ?)`,
      [job, slot, maxAttempts, token, instanceId, now + leaseMs],
    );
  }

  /** Records the won attempt in history, inside the claim's transaction, and trims the job's rows. */
  private async recordAttempt(
    tx: SqlQuery,
    input: RunClaim,
    attempt: number,
    now: number,
  ): Promise<void> {
    const { job, slot, instanceId, token, reason } = input;
    const manual = reason === 'manual' ? 1 : 0;
    await tx.all(
      `INSERT INTO ${this.attempts}
         (job, slot, attempt, instance_id, token, reason, manual, claimed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [job, slot, attempt, instanceId, token, reason, manual, now],
    );

    await this.trimRuns(tx, input, now);
    await this.trimAttempts(tx, input, now);
  }

  /** Deletes the job's finished runs beyond the newest historySize. */
  private async trimRuns(
    tx: SqlQuery,
    { job, historySize, keepMs }: RunClaim,
    now: number,
  ): Promise<void> {
    const t = this.table;
    // Keep the newest runs only, but never a run still in progress, or one young enough that a
    // late claim could still ask for it.
    const youngFrom = now - (keepMs ?? 0);

    await tx.all(
      `DELETE FROM ${t}
       WHERE job = ? AND status <> 'running' AND slot < ?
         AND slot <= (SELECT slot
                      FROM ${t}
                      WHERE job = ?
                      ORDER BY slot DESC
                      LIMIT 1 OFFSET ?)`,
      [job, youngFrom, job, historySize],
    );
  }

  /** Deletes the job's attempts beyond the newest historySize, and those older than historyTtlMs. */
  private async trimAttempts(
    tx: SqlQuery,
    { job, historySize, historyTtlMs }: RunClaim,
    now: number,
  ): Promise<void> {
    await tx.all(
      `DELETE FROM ${this.attempts}
       WHERE job = ?
         AND slot < (SELECT slot
                     FROM ${this.attempts}
                     WHERE job = ?
                     ORDER BY slot DESC, attempt DESC
                     LIMIT 1 OFFSET ?)`,
      [job, job, historySize],
    );

    if (historyTtlMs) {
      await tx.all(
        `DELETE FROM ${this.attempts}
         WHERE job = ? AND COALESCE(finished_at, claimed_at) < ?`,
        [job, now - historyTtlMs],
      );
    }
  }

  /** Gives the run's next attempt to this claim, inside the claim's transaction. */
  private async takeOver(
    tx: SqlQuery,
    input: RunClaim,
    attempt: number,
    now: number,
  ): Promise<void> {
    const { token, instanceId, leaseMs, job, slot } = input;
    await tx.all(
      `UPDATE ${this.table}
       SET attempt = ?, token = ?, instance_id = ?, lease_until = ?
       WHERE job = ? AND slot = ?`,
      [attempt, token, instanceId, now + leaseMs, job, slot],
    );
  }

  /** Ends a run that no instance will retry. */
  private async interrupt(
    tx: SqlQuery,
    job: string,
    slot: number,
  ): Promise<void> {
    await tx.all(
      `UPDATE ${this.table} SET status = 'interrupted' WHERE job = ? AND slot = ?`,
      [job, slot],
    );
  }

  private async run(
    sql: string,
    params: ReadonlyArray<SqlValue>,
  ): Promise<SqlRow[]> {
    const client = await this.getReady();
    return client.all(this.dialect.placeholders(sql), params);
  }

  private getReady(): Promise<SqlClient> {
    this.ready ??= this.prepare().catch((error: unknown) =>
      this.forgetFailedStart(error),
    );
    return this.ready;
  }

  /** Connects, checks the server, creates the tables and checks their store format. */
  private async prepare(): Promise<SqlClient> {
    this.connection ??= this.connect();
    const { client } = await this.connection;
    await this.checkServer(client);

    for (const statement of this.createTables()) {
      try {
        await client.all(statement, []);
      } catch (error) {
        if (!this.dialect.isAlreadyCreated(error)) throw error; // another instance created it at the same moment
      }
    }

    const [format] = await client.all(
      this.dialect.placeholders(
        `SELECT value FROM ${this.table}_meta WHERE name = ?`,
      ),
      ['format'],
    );
    checkStoreFormat(format?.value, `The table "${this.table}"`);
    return client;
  }

  /** Lets the next call start again, closes a connection this backend opened, and rethrows. */
  private async forgetFailedStart(error: unknown): Promise<never> {
    const connection = this.connection;
    this.ready = undefined;
    this.connection = undefined;
    const opened = await connection?.catch(() => undefined);
    if (opened?.owned) await opened.client.close?.().catch(() => {});
    throw error;
  }

  private createTables(): string[] {
    const { bigint } = this.dialect;
    const index = this.table.replace('.', '_');

    return [
      `CREATE TABLE IF NOT EXISTS ${this.table} (
        job          TEXT    NOT NULL,
        slot         ${bigint} NOT NULL,
        attempt      INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        released     INTEGER NOT NULL DEFAULT 0,
        token        TEXT    NOT NULL,
        status       TEXT    NOT NULL,
        instance_id  TEXT    NOT NULL,
        lease_until  ${bigint} NOT NULL,
        PRIMARY KEY (job, slot)
      )`,
      `CREATE INDEX IF NOT EXISTS ${index}_status ON ${this.table} (job, status)`,
      `CREATE TABLE IF NOT EXISTS ${this.attempts} (
        job         TEXT     NOT NULL,
        slot        ${bigint} NOT NULL,
        attempt     INTEGER  NOT NULL,
        instance_id TEXT     NOT NULL,
        token       TEXT     NOT NULL,
        reason      TEXT     NOT NULL,
        manual      SMALLINT NOT NULL,
        claimed_at  ${bigint} NOT NULL,
        status      TEXT,
        started_at  ${bigint},
        finished_at ${bigint},
        duration_ms ${bigint},
        error       TEXT,
        PRIMARY KEY (job, slot, attempt)
      )`,
      ...this.dialect.extraTables(this.table),
      ...this.metaTable(),
    ];
  }

  /** The table that records the store format, and its one row. */
  private metaTable(): string[] {
    const meta = `${this.table}_meta`;

    return [
      `CREATE TABLE IF NOT EXISTS ${meta} (
        name  TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
      `INSERT INTO ${meta} (name, value)
       VALUES ('format', '${STORE_FORMAT}')
       ON CONFLICT (name) DO NOTHING`,
    ];
  }
}

/** What a claim does with the run's row, decided on the database's clock. */
type ClaimDecision =
  /** Answer without writing. */
  | { kind: 'answer'; outcome: ClaimOutcome }
  /** The run has used up its attempts: end it. */
  | { kind: 'give-up' }
  /** The runner stopped renewing its lease: it died, froze, or handed the run over. */
  | { kind: 'take-over'; attempt: number }
  /** Nobody has claimed this run: start it. */
  | { kind: 'start' };

/** The lease state machine, the same as the Redis CLAIM script, and in its order. */
function decideClaim(
  run: RunRow | undefined,
  input: RunClaim,
  now: number,
): ClaimDecision {
  if (!run) {
    return input.mode === 'takeover'
      ? { kind: 'answer', outcome: { kind: 'none' } }
      : { kind: 'start' };
  }

  // Our own claim, sent again.
  if (run.token === input.token && run.status === 'running') {
    return { kind: 'answer', outcome: { kind: 'won', attempt: run.attempt } };
  }
  if (run.status !== 'running') {
    return { kind: 'answer', outcome: { kind: 'done' } };
  }
  if (run.leaseUntil >= now) {
    return {
      kind: 'answer',
      outcome: { kind: 'running', attempt: run.attempt },
    };
  }

  if (run.attempt - run.released >= run.maxAttempts) return { kind: 'give-up' };
  return { kind: 'take-over', attempt: run.attempt + 1 };
}

/** The claim of one row of <table>_attempts. */
function toClaimRecord(row: SqlRow): ClaimRecord {
  return {
    slot: Number(row.slot),
    by: String(row.instance_id),
    attempt: Number(row.attempt),
    at: Number(row.claimed_at),
    manual: Number(row.manual) === 1,
    reason: row.reason as RunRecord['reason'],
  };
}

/** The result of one row of <table>_attempts; undefined while the attempt has none. */
function toStoredResult(
  row: SqlRow,
  { slot, by, attempt }: ClaimRecord,
): StoredResult | undefined {
  if (row.status === null || row.status === undefined) return undefined;

  const result: StoredResult = {
    slot,
    by,
    attempt,
    status: row.status as StoredResult['status'],
    startedAt: Number(row.started_at),
    finishedAt: Number(row.finished_at),
    durationMs: Number(row.duration_ms),
  };
  if (typeof row.error === 'string') result.error = row.error;

  return result;
}

/**
 * The status of an attempt without a result: still running, or its runner stopped before finishing.
 * Decided on the database's clock (`row.now`).
 */
function pendingStatusOf(row: SqlRow): RunStatus {
  const current = Number(row.current_attempt) === Number(row.attempt);
  if (!current) return 'interrupted';

  if (
    row.current_status === 'running' &&
    Number(row.lease_until) >= Number(row.now)
  ) {
    return 'running';
  }
  if (row.current_status === 'success' || row.current_status === 'failed') {
    return row.current_status;
  }
  return 'interrupted';
}

function toRunRow(row: SqlRow): RunRow {
  return {
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    released: Number(row.released),
    token: String(row.token),
    status: String(row.status),
    leaseUntil: Number(row.lease_until),
  };
}
