/* Copyright (C) 2026-present Aristotelis — see repository license. */

import { type ClaimRecord, mergeRuns } from '../../history';
import type { Backend, ClaimInput, ClaimOutcome, RunClaim, RunRecord, RunStatus, RunStore, StoredResult } from '../../types';

export type SqlValue = string | number | null;
export type SqlRow = Record<string, unknown>;

/** Runs one statement and returns its rows. Statements are written with `?` placeholders. */
export interface SqlQuery {
  /** Runs one statement and resolves with its rows ([] for a statement that returns none). */
  all(sql: string, params: ReadonlyArray<SqlValue>): Promise<SqlRow[]>;
}

/**
 * What the SQL backends need from a driver: single statements, and a transaction (used to claim
 * runs). Postgres, SQLite and libSQL drivers are adapted to this automatically; pass your own
 * `{ all, transaction }` for anything else.
 */
export interface SqlClient extends SqlQuery {
  /** Runs fn inside one transaction: commit when it resolves, roll back when it throws. */
  transaction<T>(fn: (tx: SqlQuery) => Promise<T>): Promise<T>;
  /** Called on stop() only when the backend opened the connection itself. */
  close?(): Promise<void>;
}

/** What differs between Postgres and SQLite. */
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
  private connection: Promise<{ client: SqlClient; owned: boolean }> | undefined;
  private ready: Promise<SqlClient> | undefined;

  protected constructor(table: string) {
    if (!isIdentifier(table)) throw new TypeError(`Invalid table name "${table}"`);
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

  // ---------------------------------------------------------------- RunStore (leases)

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
  async heartbeat(job: string, slot: number, token: string, leaseMs: number): Promise<boolean> {
    // A released lease (lease_until = 0) stays released: a heartbeat sent before the release can arrive after it.
    const rows = await this.run(
      `UPDATE ${this.table} SET lease_until = ${this.dialect.nowMs} + ? WHERE job = ? AND slot = ? AND token = ? AND status = 'running' AND lease_until > 0 RETURNING slot`,
      [leaseMs, job, slot, token],
    );
    return rows.length > 0;
  }

  /** One UPDATE: sets the status where the token matches. */
  async finish(job: string, slot: number, token: string, status: 'success' | 'failed' | 'interrupted'): Promise<boolean> {
    const rows = await this.run(
      `UPDATE ${this.table} SET status = ?, lease_until = 0 WHERE job = ? AND slot = ? AND token = ? RETURNING slot`,
      [status, job, slot, token],
    );
    return rows.length > 0;
  }

  /** One UPDATE: ends a live lease now and counts a hand-over, where the token matches. */
  async release(job: string, slot: number, token: string): Promise<boolean> {
    // Only a live lease can be released; a runner whose lease already ran out counts as having died.
    const rows = await this.run(
      `UPDATE ${this.table} SET lease_until = 0, released = released + 1
       WHERE job = ? AND slot = ? AND token = ? AND status = 'running' AND lease_until >= ${this.dialect.nowMs} RETURNING slot`,
      [job, slot, token],
    );
    return rows.length > 0;
  }

  /** The job's rows with status 'running', each with whether lease_until is still ahead of the database's clock. */
  async active(job: string): Promise<Array<{ slot: number; attempt: number; alive: boolean }>> {
    const rows = await this.run(
      `SELECT slot, attempt, CASE WHEN lease_until >= ${this.dialect.nowMs} THEN 1 ELSE 0 END AS alive
       FROM ${this.table} WHERE job = ? AND status = 'running' ORDER BY slot`,
      [job],
    );
    return rows.map((row) => ({ slot: Number(row.slot), attempt: Number(row.attempt), alive: Number(row.alive) === 1 }));
  }

  // ---------------------------------------------------------------- Backend

  /** Claims a run of its own for runNow(), at the first free millisecond from input.slot. Returns the slot it used. */
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
    throw new Error(`Could not record a manual run of "${input.job}"`);
  }

  /** Writes how the attempt ended on its row in <table>_attempts. */
  async saveResult(job: string, result: StoredResult, _historySize: number, historyTtlMs?: number): Promise<void> {
    await this.run(
      `UPDATE ${this.attempts} SET status = ?, started_at = ?, finished_at = ?, duration_ms = ?, error = ?
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
    if (historyTtlMs)
      await this.run(`DELETE FROM ${this.attempts} WHERE job = ? AND claimed_at < ?`, [job, result.finishedAt - historyTtlMs]);
  }

  /**
   * Reads <table>_attempts, newest first. An attempt without an end is 'running' only while it is the
   * current attempt with a live lease.
   */
  async history(job: string, limit: number): Promise<RunRecord[]> {
    const rows = await this.run(
      `SELECT a.slot, a.attempt, a.instance_id, a.reason, a.manual, a.claimed_at, a.status, a.started_at, a.finished_at,
              a.duration_ms, a.error, r.attempt AS current_attempt, r.status AS current_status, r.lease_until,
              ${this.dialect.nowMs} AS now
       FROM ${this.attempts} a LEFT JOIN ${this.table} r ON r.job = a.job AND r.slot = a.slot
       WHERE a.job = ? ORDER BY a.slot DESC, a.attempt DESC LIMIT ?`,
      [job, limit],
    );
    const claims: ClaimRecord[] = [];
    const results: StoredResult[] = [];
    const pending = new Map<string, RunStatus>();
    for (const row of rows) {
      const slot = Number(row.slot);
      const attempt = Number(row.attempt);
      const by = String(row.instance_id);
      claims.push({
        slot,
        by,
        attempt,
        at: Number(row.claimed_at),
        manual: Number(row.manual) === 1,
        reason: row.reason as RunRecord['reason'],
      });
      if (row.status !== null && row.status !== undefined) {
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
        results.push(result);
        continue;
      }
      // No result yet: still running, or its runner stopped before finishing.
      const current = Number(row.current_attempt) === attempt;
      let status: RunStatus = 'interrupted';
      if (current && row.current_status === 'running' && Number(row.lease_until) >= Number(row.now)) status = 'running';
      else if (current && (row.current_status === 'success' || row.current_status === 'failed')) status = row.current_status;
      pending.set(`${slot}|${attempt}`, status);
    }
    return mergeRuns(job, claims, results, limit, (claim) => pending.get(`${claim.slot}|${claim.attempt}`) ?? 'interrupted');
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

  // ---------------------------------------------------------------- internals

  /**
   * The lease state machine, the same as the Redis CLAIM script: one transaction per claim, and the
   * rows it reads are locked until it commits (SQLite: one writer at a time anyway).
   */
  private async claimRun(input: RunClaim): Promise<ClaimOutcome> {
    const client = await this.getReady();
    const t = this.table;
    const lock = this.dialect.forUpdate;
    if (input.mode === 'takeover') {
      // Backups ask every 1 to 2 heartbeats, and nearly always the run is still alive: a plain read
      // answers that. Only a claim that can win opens the transaction, which holds the write lock
      // (on a libSQL server for seconds, if this process dies inside it).
      const [row] = await this.run(
        `SELECT attempt, token, status, lease_until, ${this.dialect.nowMs} AS now FROM ${t} WHERE job = ? AND slot = ?`,
        [input.job, input.slot],
      );
      if (!row) return { kind: 'none' };
      if (row.token !== input.token) {
        if (row.status !== 'running') return { kind: 'done' };
        if (Number(row.lease_until) >= Number(row.now)) return { kind: 'running', attempt: Number(row.attempt) };
      }
    }
    return client.transaction(async (raw) => {
      const tx: SqlQuery = { all: (sql, params) => raw.all(this.dialect.placeholders(sql), params) };
      await this.dialect.serialize(tx, t, input.job);
      const now = Number((await tx.all(`SELECT ${this.dialect.nowMs} AS now`, []))[0]?.now);
      const [found] = await tx.all(
        `SELECT attempt, max_attempts, released, token, status, lease_until FROM ${t} WHERE job = ? AND slot = ?${lock}`,
        [input.job, input.slot],
      );
      let attempt = 1;
      let limit = input.maxAttempts;
      let released = 0;
      if (found) {
        const run = toRunRow(found);
        if (run.token === input.token && run.status === 'running') return { kind: 'won', attempt: run.attempt }; // our own claim, sent again
        if (run.status !== 'running') return { kind: 'done' };
        if (run.leaseUntil >= now) return { kind: 'running', attempt: run.attempt };
        // The runner stopped renewing its lease: it died, froze, or handed the run over.
        limit = run.maxAttempts;
        released = run.released;
        if (run.attempt - released >= limit) {
          await tx.all(`UPDATE ${t} SET status = 'interrupted' WHERE job = ? AND slot = ?`, [input.job, input.slot]);
          return { kind: 'done' };
        }
        attempt = run.attempt + 1;
        await tx.all(`UPDATE ${t} SET attempt = ?, token = ?, instance_id = ?, lease_until = ? WHERE job = ? AND slot = ?`, [
          attempt,
          input.token,
          input.instanceId,
          now + input.leaseMs,
          input.job,
          input.slot,
        ]);
      } else if (input.mode === 'takeover') {
        return { kind: 'none' };
      } else {
        // Too late (delayed or queued claim): don't start a stale run.
        const late = now - input.slot;
        if (input.maxLateMs && late > input.maxLateMs) return { kind: 'late', lateMs: late };
        const others = await tx.all(`SELECT slot, lease_until FROM ${t} WHERE job = ? AND status = 'running'${lock}`, [input.job]);
        for (const other of others) {
          const otherSlot = Number(other.slot);
          if (Number(other.lease_until) >= now) {
            if (input.overlap === 'skip') return { kind: 'overlap', slot: otherSlot };
          } else if (otherSlot < input.slot) {
            // An older run died and a newer one is starting: stop trying to finish the old one.
            await tx.all(`UPDATE ${t} SET status = 'interrupted' WHERE job = ? AND slot = ?`, [input.job, otherSlot]);
          }
        }
        await tx.all(
          `INSERT INTO ${t} (job, slot, attempt, max_attempts, released, token, status, instance_id, lease_until)
           VALUES (?, ?, 1, ?, 0, ?, 'running', ?, ?)`,
          [input.job, input.slot, limit, input.token, input.instanceId, now + input.leaseMs],
        );
      }
      await tx.all(
        `INSERT INTO ${this.attempts} (job, slot, attempt, instance_id, token, reason, manual, claimed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.job, input.slot, attempt, input.instanceId, input.token, input.reason, input.reason === 'manual' ? 1 : 0, now],
      );
      // Keep the newest runs only, but never a run still in progress, or one young enough that a
      // late claim could still ask for it.
      await tx.all(
        `DELETE FROM ${t} WHERE job = ? AND status <> 'running' AND slot < ?
         AND slot <= (SELECT slot FROM ${t} WHERE job = ? ORDER BY slot DESC LIMIT 1 OFFSET ?)`,
        [input.job, now - (input.keepMs ?? 0), input.job, input.historySize],
      );
      await tx.all(
        `DELETE FROM ${this.attempts} WHERE job = ?
         AND slot < (SELECT slot FROM ${this.attempts} WHERE job = ? ORDER BY slot DESC, attempt DESC LIMIT 1 OFFSET ?)`,
        [input.job, input.job, input.historySize],
      );
      if (input.historyTtlMs)
        await tx.all(`DELETE FROM ${this.attempts} WHERE job = ? AND claimed_at < ?`, [input.job, now - input.historyTtlMs]);
      return { kind: 'won', attempt };
    });
  }

  private async run(sql: string, params: ReadonlyArray<SqlValue>): Promise<SqlRow[]> {
    const client = await this.getReady();
    return client.all(this.dialect.placeholders(sql), params);
  }

  private getReady(): Promise<SqlClient> {
    this.ready ??= (async () => {
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
      return client;
    })().catch(async (error: unknown) => {
      const connection = this.connection;
      this.ready = undefined;
      this.connection = undefined;
      const opened = await connection?.catch(() => undefined);
      if (opened?.owned) await opened.client.close?.().catch(() => {});
      throw error;
    });
    return this.ready;
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
    ];
  }
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
