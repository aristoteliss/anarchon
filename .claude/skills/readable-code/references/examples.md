# Before and after

Rewrites of code from this repository, each for one or two rules. Each "before" is the shape to
avoid; each "after" keeps the behavior and the comments that state a constraint. The "after" of
examples 2, 4, 7 and 8 is the current code in `src/`, give or take naming; the others are
references for new code and for refactoring when a task asks for it.

Before applying a rewrite like these to `src/`, run the tests that cover the function: the order of
writes and events in the scheduler is part of its contract.

## 1. A nested ternary becomes guard clauses (rule 4)

`src/decorators.ts:305`. Five outcomes in one expression, nested inside a function call.

Before:

```ts
const AT: ScheduleKind = {
  decorator: 'At',
  isValue: (arg) => isTextOrNumber(arg) || arg instanceof Date,
  looksValid: (value) =>
    Number.isFinite(
      value instanceof Date
        ? value.getTime()
        : typeof value === 'number'
          ? value
          : typeof value === 'string'
            ? Date.parse(value)
            : Number.NaN,
    ),
  usage: "the job's name, a string, comes first and the time second: @At(name, when)",
};
```

After:

```ts
const AT: ScheduleKind = {
  decorator: 'At',
  isValue: (arg) => isTextOrNumber(arg) || arg instanceof Date,
  looksValid: (value) => Number.isFinite(toTime(value)),
  usage: "the job's name, a string, comes first and the time second: @At(name, when)",
};

/** Unix milliseconds of a Date, a number or a date string; NaN for anything else. */
function toTime(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Date.parse(value);
  return Number.NaN;
}
```

Why it reads better: each case is one line, and the name `toTime` says what the expression
computes. The helper stays in `src/decorators.ts`, its only caller file (rule 9).

## 2. Seven positional parameters become one object (rule 3)

`src/scheduler/lease-runner.ts:193`. One caller passes `undefined` to reach `signal`; a reader must
count commas to know which value is the attempt.

Before:

```ts
private async executeLeased(
  job: Job,
  slot: number,
  token: string,
  attempt: number,
  reason: RunReason,
  data?: unknown,
  signal = this.core.stopSignal(),
): Promise<RunRecord> {

// The two calls:
await this.executeLeased(job, slot, input.token, outcome.attempt, outcome.attempt > 1 ? 'takeover' : reason, undefined, signal);
if (outcome.kind === 'won') return this.executeLeased(job, slot, token, 1, 'manual', data, signal);
```

After:

```ts
/** A run this instance claimed and now executes. */
interface LeasedRun {
  job: Job;
  slot: number;
  /** The token of the winning claim; the store checks it on every heartbeat, finish and release. */
  token: string;
  attempt: number;
  reason: RunReason;
  /** The data given to runNow() for this one run. */
  data?: unknown;
  signal: AbortSignal;
}

private async executeLeased({ job, slot, token, attempt, reason, data, signal }: LeasedRun): Promise<RunRecord> {

// The two calls:
await this.executeLeased({
  job,
  slot,
  token: input.token,
  attempt: outcome.attempt,
  reason: outcome.attempt > 1 ? 'takeover' : reason,
  signal,
});
if (outcome.kind === 'won') return this.executeLeased({ job, slot, token, attempt: 1, reason: 'manual', data, signal });
```

Why it reads better: every argument is labelled at the call, and the optional `data` is simply left
out. Both callers already passed `signal`, so the default is no longer needed. In `src/`, the
heartbeat, finish and release that share a run's lease state live in a small `HeldLease` class, so
`executeLeased` stays within rule 1; `run` is split into `claim` and `follow` for the same reason.

## 3. Six levels of nesting become two named steps (rule 2)

`src/backends/nats.ts:232`. The innermost `push` sits inside `try`, `while`, `for`, and three `if`
statements.

Before:

```ts
/** Reads the job's claims and results from the stream and joins them. */
async history(job: string, limit: number): Promise<RunRecord[]> {
  const { js, jsm } = await this.getState();
  const filter = `${this.prefix}${job}.*`;
  // How many messages this job has, so each fetch can ask for exactly what is there.
  const info = await jsm.streams.info(this.stream, { subjects_filter: filter });
  let remaining = Object.values(info.state.subjects ?? {}).reduce((sum, count) => sum + count, 0);
  if (remaining === 0) return []; // never ran

  const claims: ClaimRecord[] = [];
  const results: StoredResult[] = [];
  const consumer = await js.consumers.get(this.stream, { filter_subjects: [filter] });
  try {
    while (remaining > 0) {
      const batch = await consumer.fetch({ max_messages: Math.min(remaining, 1_000), expires: 5_000 });
      let received = 0;
      for await (const message of batch) {
        received++;
        const record = parseJson(message.string());
        if (record && typeof record === 'object') {
          const raw = record as Record<string, unknown>;
          if (raw.type === 'result') {
            const result = toResult(raw);
            if (result) results.push(result);
          } else {
            const claim = toClaim(raw);
            if (claim) claims.push(claim);
          }
        }
        if (message.info.pending === 0) remaining = received; // nothing newer to wait for
      }
      if (received === 0) break;
      remaining -= received;
    }
  } finally {
    // The server keeps an ordered consumer for minutes after its last use.
    await consumer.delete().catch(() => {});
  }
  return buildHistory({ job, claims, results, limit });
}
```

After:

```ts
/** Reads the job's claims and results from the stream and joins them. */
async history(job: string, limit: number): Promise<RunRecord[]> {
  const { js, jsm } = await this.getState();
  const filter = `${this.prefix}${job}.*`;
  // How many messages this job has, so each fetch can ask for exactly what is there.
  const info = await jsm.streams.info(this.stream, { subjects_filter: filter });
  const total = Object.values(info.state.subjects ?? {}).reduce((sum, count) => sum + count, 0);
  if (total === 0) return []; // never ran

  const consumer = await js.consumers.get(this.stream, { filter_subjects: [filter] });
  try {
    const { claims, results } = await readRecords(consumer, total);
    return buildHistory({ job, claims, results, limit });
  } finally {
    // The server keeps an ordered consumer for minutes after its last use.
    await consumer.delete().catch(() => {});
  }
}

/** The claims and results of one job, as read from the stream. */
interface JobRecords {
  claims: ClaimRecord[];
  results: StoredResult[];
}

/** Fetches the job's messages in batches until none are left. */
async function readRecords(consumer: Consumer, total: number): Promise<JobRecords> {
  const records: JobRecords = { claims: [], results: [] };
  let remaining = total;
  while (remaining > 0) {
    const batch = await consumer.fetch({ max_messages: Math.min(remaining, 1_000), expires: 5_000 });
    let received = 0;
    for await (const message of batch) {
      received++;
      addRecord(records, parseJson(message.string()));
      if (message.info.pending === 0) remaining = received; // nothing newer to wait for
    }
    if (received === 0) break;
    remaining -= received;
  }
  return records;
}

/** Adds a parsed message to the claims or the results; ignores anything else. */
function addRecord(records: JobRecords, value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const raw = value as Record<string, unknown>;
  if (raw.type === 'result') {
    const result = toResult(raw);
    if (result) records.results.push(result);
    return;
  }
  const claim = toClaim(raw);
  if (claim) records.claims.push(claim);
}
```

Why it reads better: `history` now shows the protocol in order (count, read, join, clean up), and
each helper nests at most 3 levels. `JobRecords` is earned: two functions use it (rule 8). The
numbers stay inline because `max_messages` and `expires` name them (rule 7). `Consumer` is a type
import from `@nats-io/jetstream`.

## 4. A 76-line function with four jobs becomes a sequence of named steps (rules 1 and 5)

`src/scheduler/executor.ts:68`. `execute` calls the handler, decides the status, hands the run over
or finishes it, stores the result, builds the record and emits events. The flags `failure` and
`interrupted` are read again more than 45 lines after they are set, and the hand-over condition
has 4 operands.

Before (abridged; the event payloads and the result object are as in the source):

```ts
async execute(job: Job, slot: number, run: Execution, claimed = true): Promise<RunRecord> {
  const { core } = this;
  const scheduledAt = new Date(slot);
  const startedAt = Date.now();
  const manual = run.reason === 'manual';
  const started = !run.controller.signal.aborted;
  let failure: { cause: unknown } | undefined;
  if (started) {
    job.runningHere++;
    core.emit('start', { /* 7 fields */ });
    failure = await this.callHandler(job, slot, scheduledAt, run);
  } else {
    failure = { cause: run.controller.signal.reason };
  }

  // A job that throws after stop() or a takeover aborted it didn't fail: it was interrupted.
  const interrupted = failure !== undefined && (run.abortedBy === 'stop' || run.abortedBy === 'lost');
  const status = interrupted ? 'interrupted' : failure ? 'failed' : 'success';
  // After stop() has returned, nothing is written any more (the lease runs out on its own).
  const stopped = !claimed || core.isIdle() || run.parent !== core.stopSignal();
  let handedOver = false;
  if (!stopped) {
    // Stopped mid-run: give the run to another instance now. Manual runs are never retried.
    if (interrupted && run.abortedBy === 'stop' && run.release && !manual) handedOver = await run.release();
    else await run.finish?.(status);
  }
  const finishedAt = Date.now();
  const result: StoredResult = { /* 7 fields */ };
  if (failure) result.error = describeError(failure.cause);

  if (!stopped) {
    try {
      await core.ensureReady();
      await core.backend.saveResult(job.name, result, job.historySize, job.historyTtlMs);
    } catch (error) {
      core.emit('error', { error, job: job.name, slot });
    }
  }

  const record: RunRecord = { /* 11 fields */ };
  if (result.error !== undefined) record.error = result.error;
  if (started) {
    if (interrupted && failure) core.emit('interrupted', { ...record, cause: failure.cause, handedOver });
    else if (failure) core.emit('failure', { ...record, cause: failure.cause });
    else core.emit('success', record);
  }
  return record;
}
```

After:

```ts
/** What a handler threw. */
interface Failure {
  cause: unknown;
}

async execute(job: Job, slot: number, run: Execution, claimed = true): Promise<RunRecord> {
  const { core } = this;
  const scheduledAt = new Date(slot);
  const startedAt = Date.now();
  const started = !run.controller.signal.aborted;
  const failure = started ? await this.start(job, slot, scheduledAt, run) : { cause: run.controller.signal.reason };
  const status = statusOf(run, failure);
  // After stop() has returned, nothing is written any more (the lease runs out on its own).
  const stopped = !claimed || core.isIdle() || run.parent !== core.stopSignal();
  const handedOver = stopped ? false : await this.end(run, status);
  const finishedAt = Date.now();
  const result: StoredResult = {
    slot,
    by: core.instanceId,
    attempt: run.attempt,
    status,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
  };
  if (failure) result.error = describeError(failure.cause);
  if (!stopped) await this.save(job, result);
  const record = this.toRecord(job, scheduledAt, run, result);
  if (started) this.report(record, failure, handedOver);
  return record;
}

/** Counts the run as running here, emits 'start' and calls the handler. Returns what it threw. */
private async start(job: Job, slot: number, scheduledAt: Date, run: Execution): Promise<Failure | undefined> {
  job.runningHere++;
  this.core.emit('start', { /* the same 7 fields */ });
  return this.callHandler(job, slot, scheduledAt, run);
}

/** A job that throws after stop() or a takeover aborted it didn't fail: it was interrupted. */
function statusOf(run: Execution, failure: Failure | undefined): StoredResult['status'] {
  if (!failure) return 'success';
  const interrupted = run.abortedBy === 'stop' || run.abortedBy === 'lost';
  return interrupted ? 'interrupted' : 'failed';
}

/** Marks the run ended in the store, or hands an interrupted run to a backup. True if it was handed over. */
private async end(run: Execution, status: StoredResult['status']): Promise<boolean> {
  // Stopped mid-run: give the run to another instance now. Manual runs are never retried.
  const handOver = status === 'interrupted' && run.abortedBy === 'stop' && run.reason !== 'manual';
  if (handOver && run.release) return run.release();
  await run.finish?.(status);
  return false;
}

/** Stores the result. A store that fails is reported as an 'error' event. */
private async save(job: Job, result: StoredResult): Promise<void> {
  try {
    await this.core.ensureReady();
    await this.core.backend.saveResult(job.name, result, job.historySize, job.historyTtlMs);
  } catch (error) {
    this.core.emit('error', { error, job: job.name, slot: result.slot });
  }
}

/** Emits how the run ended. */
private report(record: RunRecord, failure: Failure | undefined, handedOver: boolean): void {
  if (!failure) this.core.emit('success', record);
  else if (record.status === 'interrupted') this.core.emit('interrupted', { ...record, cause: failure.cause, handedOver });
  else this.core.emit('failure', { ...record, cause: failure.cause });
}
```

`toRecord` builds the `RunRecord` from the result as the original lines did, and is omitted here.

Why it reads better: `execute` now reads as the run's life in order: start, decide, end, save,
record, report. Each step has a name and a JSDoc line, and the 4-operand condition became the
named `handOver`. The order of writes and events is unchanged. `Failure` is earned: `start`,
`statusOf` and `report` all use it (rule 8).

## 5. A callback state machine gets named waits (rule 7)

`src/backends/rabbitmq.ts:333`. The waits `60` and `300` do not say what they wait for, and the
name `wait` hides that the timer ends the read. The nesting is 3 levels, within rule 2, so the
callbacks stay as they are.

Before:

```ts
/** Offset of the newest record in a stream queue, or null if it is empty. */
private lastOffset(channel: Channel, queue: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let max: number | null = null;
    let tag: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (tag) channel.cancel(tag).catch(() => {});
      resolve(max);
    };
    // 'last' delivers the newest chunk; wait until it has fully arrived.
    const wait = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(finish, ms);
    };
    channel
      .consume(
        queue,
        (msg) => {
          if (!msg || done) return;
          channel.ack(msg);
          max = Math.max(max ?? -1, offsetOf(msg));
          wait(60);
        },
        { noAck: false, arguments: { 'x-stream-offset': 'last' } },
      )
      .then(({ consumerTag }) => {
        tag = consumerTag;
        if (done) channel.cancel(consumerTag).catch(() => {});
        else if (max === null) wait(300);
      }, reject);
  });
}
```

After:

```ts
/** Quiet time after a delivery before the newest chunk counts as fully read. */
const CHUNK_SETTLE_MS = 60;
/** How long a stream queue gets to deliver its first record before it counts as empty. */
const FIRST_RECORD_WAIT_MS = 300;

/** Offset of the newest record in a stream queue, or null if it is empty. */
private lastOffset(channel: Channel, queue: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let max: number | null = null;
    let tag: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (tag) channel.cancel(tag).catch(() => {});
      resolve(max);
    };
    // 'last' delivers the newest chunk; wait until it has fully arrived.
    const finishAfter = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(finish, ms);
    };
    channel
      .consume(
        queue,
        (msg) => {
          if (!msg || done) return;
          channel.ack(msg);
          max = Math.max(max ?? -1, offsetOf(msg));
          finishAfter(CHUNK_SETTLE_MS);
        },
        { noAck: false, arguments: { 'x-stream-offset': 'last' } },
      )
      .then(({ consumerTag }) => {
        tag = consumerTag;
        if (done) channel.cancel(consumerTag).catch(() => {});
        else if (max === null) finishAfter(FIRST_RECORD_WAIT_MS);
      }, reject);
  });
}
```

Why it reads better: the two waits name what they wait for, and `finishAfter` says what happens
when the timer fires. Nothing else changes: the smallest readable change is two constants and one
name. The 5-second limit in `readFrom` needs no constant, because it initializes a variable named
`safety` (rule 7).

## 6. A design to avoid: structure added for one use (rule 8)

This "before" is not from the repository. It shows the structure that rule 8 and "When not to add
structure" exist to prevent, applied to the checking of backend options.

Before (to avoid):

```ts
interface OptionValidator<T> {
  validate(options: T): void;
}

abstract class BaseOptionValidator<T extends object> implements OptionValidator<T> {
  protected abstract readonly known: ReadonlyArray<string>;
  validate(options: T): void {
    for (const key of Object.keys(options)) {
      if (!this.known.includes(key)) throw new TypeError(`Unknown option ${key}`);
    }
  }
}

class RabbitMQOptionValidator extends BaseOptionValidator<RabbitMQBackendOptions> {
  protected readonly known = ['url', 'connection', 'prefix', 'slotTtlMs'];
}

class OptionValidatorFactory {
  static create(backend: 'rabbitmq' | 'nats'): OptionValidator<object> {
    return backend === 'rabbitmq' ? new RabbitMQOptionValidator() : new NatsOptionValidator();
  }
}

// In the constructor:
OptionValidatorFactory.create('rabbitmq').validate(options);
```

After (the code in `src/backends/rabbitmq.ts`):

```ts
const RABBITMQ_OPTIONS = keysOf<RabbitMQBackendOptions>({ url: true, connection: true, prefix: true, slotTtlMs: true });

/** Validates the options. Nothing connects until init(). */
constructor(options: RabbitMQBackendOptions = {}) {
  refuseUnknown('RabbitMQBackend', options, RABBITMQ_OPTIONS);
  this.url = options.url ?? 'amqp://localhost';
  this.prefix = options.prefix ?? 'cron.';
  this.userConnection = options.connection;
  this.dedupeWindowMs = positiveInt('slotTtlMs', options.slotTtlMs ?? 300_000);
}
```

Why the repository's version is better:

- One shared function (`refuseUnknown`, used by every backend) replaces an interface, a base class,
  one subclass per backend and a factory. Nothing varies between backends except the key list.
- `keysOf<RabbitMQBackendOptions>` makes the compiler reject a list that drifts from the options
  type; the string array in the "before" drifts silently.
- The error is coded (`ANARCHON_UNKNOWN_OPTION`) and suggests the closest known key; the "before"
  throws an uncoded error (rule 10).

## 7. A state machine mixed with its writes becomes a decision and its writes (rules 1 and 13)

`src/backends/sql/base.ts:361`. `claimRun` is 51 lines. Inside one transaction callback it reads
the run's row, decides among six outcomes from the row and the database's clock, and writes. The
order of the checks is the lease protocol, but a reader has to trace the `let` variables `attempt`,
`limit` and `released` through the branches to see it.

Before:

```ts
/**
 * The lease state machine, the same as the Redis CLAIM script: one transaction per claim, and the
 * rows it reads are locked until it commits (SQLite: one writer at a time anyway).
 */
private async claimRun(input: RunClaim): Promise<ClaimOutcome> {
  const client = await this.getReady();
  const t = this.table;
  const lock = this.dialect.forUpdate;
  if (input.mode === 'takeover') {
    const answer = await this.takeoverWithoutWriting(input);
    if (answer) return answer;
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
      const refused = await this.startRun(tx, input, limit, now);
      if (refused) return refused;
    }
    await this.recordAttempt(tx, input, attempt, now);
    return { kind: 'won', attempt };
  });
}
```

After:

```ts
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

/** The lease state machine's rules; the checks run in the order of the Redis CLAIM script. */
function decideClaim(run: RunRow | undefined, input: RunClaim, now: number): ClaimDecision {
  if (!run) return input.mode === 'takeover' ? { kind: 'answer', outcome: { kind: 'none' } } : { kind: 'start' };
  // Our own claim, sent again.
  if (run.token === input.token && run.status === 'running') return { kind: 'answer', outcome: { kind: 'won', attempt: run.attempt } };
  if (run.status !== 'running') return { kind: 'answer', outcome: { kind: 'done' } };
  if (run.leaseUntil >= now) return { kind: 'answer', outcome: { kind: 'running', attempt: run.attempt } };
  if (run.attempt - run.released >= run.maxAttempts) return { kind: 'give-up' };
  return { kind: 'take-over', attempt: run.attempt + 1 };
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
    const tx: SqlQuery = { all: (sql, params) => raw.all(this.dialect.placeholders(sql), params) };
    await this.dialect.serialize(tx, this.table, input.job);
    const now = Number((await tx.all(`SELECT ${this.dialect.nowMs} AS now`, []))[0]?.now);
    const [found] = await tx.all(
      `SELECT attempt, max_attempts, released, token, status, lease_until FROM ${this.table} WHERE job = ? AND slot = ?${this.dialect.forUpdate}`,
      [input.job, input.slot],
    );
    const decision = decideClaim(found ? toRunRow(found) : undefined, input, now);
    if (decision.kind === 'answer') return decision.outcome;
    if (decision.kind === 'give-up') {
      await this.interrupt(tx, input.job, input.slot);
      return { kind: 'done' };
    }
    if (decision.kind === 'start') {
      const refused = await this.startRun(tx, input, now);
      if (refused) return refused;
    } else {
      await this.takeOver(tx, input, decision.attempt, now);
    }
    const attempt = decision.kind === 'take-over' ? decision.attempt : 1;
    await this.recordAttempt(tx, input, attempt, now);
    return { kind: 'won', attempt };
  });
}

/** Gives the run's next attempt to this claim, inside the claim's transaction. */
private async takeOver(tx: SqlQuery, input: RunClaim, attempt: number, now: number): Promise<void> {
  await tx.all(`UPDATE ${this.table} SET attempt = ?, token = ?, instance_id = ?, lease_until = ? WHERE job = ? AND slot = ?`, [
    attempt,
    input.token,
    input.instanceId,
    now + input.leaseMs,
    input.job,
    input.slot,
  ]);
}

/** Ends a run that no instance will retry. */
private async interrupt(tx: SqlQuery, job: string, slot: number): Promise<void> {
  await tx.all(`UPDATE ${this.table} SET status = 'interrupted' WHERE job = ? AND slot = ?`, [job, slot]);
}
```

Why it reads better:

- `decideClaim` is the whole state machine in seven lines. It takes `now` as a parameter, reads no
  clock and writes nothing, so it can be compared line by line with the Redis CLAIM script
  (rule 13).
- `claimRun` drops to 31 lines and reads as load, decide, act (rule 1). The three `let` variables
  are gone: `limit` was only ever `input.maxAttempts` for a new run, so `startRun` reads it from `input`, and `released` was read once.
- `ClaimDecision` has one producer and one consumer, which "When not to add structure" normally
  refuses; a `kind`-tagged outcome of a decision function is the exception rule 13 asks for.
- `interrupt` also replaces the same `UPDATE` in `startRun`, which ends an older dead run.
- `SqlBackend` is exported, so its private method names appear in `api/anarchon.api.txt`: run
  `pnpm api:update`. Adding or renaming a private member is not a breaking change.

## 8. A six-parameter builder becomes one input, its refusals, then the build (rules 1, 3, 12 and 14)

`src/scheduler/job.ts:86`. `createJob` is 75 lines and takes 6 positional parameters. It checks
every option before it builds the job, which is right (rule 12), but the timing checks, the plain
option reads and the 22-line object it returns run together, so the point where checking ends is
hard to see.

Before (abridged; the timing checks and the returned object are as in the source):

```ts
/** Checks a job's name, handler and options against its schedule and the backend, and builds it. */
export function createJob(
  name: string,
  schedule: Schedule,
  handler: JobHandler<never>,
  options: JobOptions,
  defaults: JobDefaults,
  backend: Backend,
): Job {
  if (typeof name !== 'string' || name.trim() === '')
    throw coded(new TypeError('Job name must be a non-empty string'), 'ANARCHON_INVALID_ARGUMENT');
  if (typeof handler !== 'function') throw coded(new TypeError(`Job "${name}": handler must be a function`), 'ANARCHON_INVALID_ARGUMENT');
  refuseWithoutLeases(backend, options, LEASE_JOB_OPTIONS, `Job "${name}": `);

  const jitterMs = /* the option, or a quarter of the gap between runs, capped by the default */;
  if (jitterMs * 2 >= schedule.minGapMs) throw /* ANARCHON_INVALID_ARGUMENT */;
  const maxLateMs = /* the option, or the default raised to jitterMs + 1 s */;
  if (maxLateMs <= jitterMs) throw /* ANARCHON_INVALID_ARGUMENT */;
  if (jitterMs + maxLateMs >= backend.dedupeWindowMs) throw /* ANARCHON_UNSAFE_JOB */;
  const historySize = options.historySize !== undefined ? positiveInt('historySize', options.historySize) : defaults.historySize;
  const historyTtlMs = options.historyTtlMs !== undefined ? positiveInt('historyTtlMs', options.historyTtlMs) : defaults.historyTtlMs;
  if (options.overlap !== undefined && options.overlap !== 'skip' && options.overlap !== 'allow') {
    throw coded(new TypeError(`Job "${name}": overlap must be "skip" or "allow"`), 'ANARCHON_INVALID_ARGUMENT');
  }
  const timeoutMs = options.timeoutMs !== undefined ? positiveInt('timeoutMs', options.timeoutMs) : undefined;
  const maxAttempts = intInRange('maxAttempts', options.maxAttempts ?? 3, 1, 100);
  const catchUpMs = nonNegativeInt('catchUpMs', options.catchUpMs ?? 300_000);
  backend.checkJob?.({ name, jitterMs, maxLateMs, minGapMs: schedule.minGapMs, historySize, historyTtlMs });

  return { /* 20 fields */ };
}

// The caller, in Scheduler.add:
const job = createJob(name, schedule, handler, options, this.defaults, this.backend);
```

After:

```ts
/** What a job is built from: its declaration, the scheduler's defaults and the backend that runs it. */
interface JobInput {
  name: string;
  schedule: Schedule;
  handler: JobHandler<never>;
  options: JobOptions;
  defaults: JobDefaults;
  backend: Backend;
}

/** Checks a job's name, handler and options against its schedule and the backend, and builds it. */
export function createJob(input: JobInput): Job {
  const { name, schedule, handler, options, defaults, backend } = input;
  refuseInvalidJob(name, handler);
  refuseWithoutLeases(backend, options, LEASE_JOB_OPTIONS, `Job "${name}": `);
  const { jitterMs, maxLateMs } = readTiming(input);
  const historySize = options.historySize !== undefined ? positiveInt('historySize', options.historySize) : defaults.historySize;
  const historyTtlMs = options.historyTtlMs !== undefined ? positiveInt('historyTtlMs', options.historyTtlMs) : defaults.historyTtlMs;
  if (options.overlap !== undefined && options.overlap !== 'skip' && options.overlap !== 'allow') {
    throw coded(new TypeError(`Job "${name}": overlap must be "skip" or "allow"`), 'ANARCHON_INVALID_ARGUMENT');
  }
  const timeoutMs = options.timeoutMs !== undefined ? positiveInt('timeoutMs', options.timeoutMs) : undefined;
  const maxAttempts = intInRange('maxAttempts', options.maxAttempts ?? 3, 1, 100);
  const catchUpMs = nonNegativeInt('catchUpMs', options.catchUpMs ?? 300_000);
  backend.checkJob?.({ name, jitterMs, maxLateMs, minGapMs: schedule.minGapMs, historySize, historyTtlMs });

  return { /* the same 20 fields */ };
}

/** Throws when the job's name is empty or its handler is not a function. */
function refuseInvalidJob(name: string, handler: unknown): void {
  if (typeof name !== 'string' || name.trim() === '')
    throw coded(new TypeError('Job name must be a non-empty string'), 'ANARCHON_INVALID_ARGUMENT');
  if (typeof handler !== 'function') throw coded(new TypeError(`Job "${name}": handler must be a function`), 'ANARCHON_INVALID_ARGUMENT');
}

/** Reads jitterMs and maxLateMs, and refuses timings the schedule or the backend can't keep. */
function readTiming({ name, schedule, options, defaults, backend }: JobInput): Pick<Job, 'jitterMs' | 'maxLateMs'> {
  const jitterMs = /* as before */;
  if (jitterMs * 2 >= schedule.minGapMs) throw /* as before */;
  const maxLateMs = /* as before */;
  if (maxLateMs <= jitterMs) throw /* as before */;
  if (jitterMs + maxLateMs >= backend.dedupeWindowMs) throw /* as before */;
  return { jitterMs, maxLateMs };
}

// The caller, in Scheduler.add:
const job = createJob({ name, schedule, handler, options, defaults: this.defaults, backend: this.backend });
```

Why it reads better:

- Everything above the blank line refuses or reads; everything below builds (rules 12 and 14).
  The checks run in the same order, so the same input still fails with the same error first.
- `createJob` drops from 75 to 38 lines (rule 1), and its call labels every argument (rule 3).
- `JobInput` is earned: `createJob` and `readTiming` both take it (rule 8). `readTiming` returns
  `Pick<Job, ...>` rather than a new type, because only `createJob` reads its result.
- `refuseInvalidJob` follows the `refuse...` naming for checks that throw
  ([conventions.md](conventions.md), Naming).

## 9. A dense block becomes one step per line (rule 15)

`src/backends/redis/lease.ts`, `LeaseStore.history`. Each line held several steps: a loop body on
the loop's line, three calls nested in one argument, and a script reply read as `reply[0]` (the
server's clock) and `reply[i + 1]` (a run), with two fallbacks and a cast on one line.

Before:

```ts
let min = Infinity;
for (const { slot } of claims) min = Math.min(min, slot);
const members = await redis.send('ZRANGEBYSCORE', [this.key(job, 'results'), min, '+inf']);
const results = (Array.isArray(members) ? members : []).flatMap((m) => toResult(parseJson(toStr(m))) ?? []);
const slots = [...new Set(claims.map((c) => c.slot))];
const reply = (await this.scripts.run(STATES, [this.key(job, 'state')], slots)) as unknown[];
const now = Number(toStr(reply[0]));
const states = new Map(slots.map((slot, i) => [slot, (parseJson(toStr(reply[i + 1]) || 'null') as StoredRun | null) ?? null] as const));
```

After:

```ts
const oldest = claims.reduce((min, claim) => Math.min(min, claim.slot), Infinity);
const members = await redis.send('ZRANGEBYSCORE', [this.key(job, 'results'), oldest, '+inf']);
const results = toResults(members);
const { now, states } = await this.readStates(job, claims);

/** The stored state of each claimed slot, read in one script call, with the server's clock. */
private async readStates(job: string, claims: ClaimRecord[]): Promise<{ now: number; states: Map<number, StoredRun | null> }> {
  const slots = [...new Set(claims.map((claim) => claim.slot))];
  const [clock, ...runs] = (await this.scripts.run(STATES, [this.key(job, 'state')], slots)) as unknown[];
  const states = new Map(slots.map((slot, i) => [slot, toStoredRun(runs[i])] as const));
  return { now: Number(toStr(clock)), states };
}

/** One run's state as the STATES script returns it; null when the run has none. */
function toStoredRun(raw: unknown): StoredRun | null {
  const text = toStr(raw);
  return text ? (parseJson(text) as StoredRun | null) : null;
}
```

Why it reads better:

- The reply's layout is named once, `[clock, ...runs]`, and nothing below it counts positions.
- `toResults` and `toStoredRun` each hold one conversion, so no line nests more than two calls.
- `toResults` lives in `src/backends/redis/replies.ts` because the `RedisBackend` history uses it too
  (rule 9).

## 10. A transaction body becomes load, decide, act (rule 15)

`src/backends/sql/base.ts`, `SqlBackend.claimRun`, after example 7. The decision was already apart,
but the transaction body still read as one block: an arrow function inside an object literal on
one line, an `await` indexed with `[0]` inside `Number(...)`, a ternary inside an argument, a
150-character SQL line, an `if` chain on `decision.kind` followed by a second test of the same
value, and no blank line between the steps.

Before:

```ts
return client.transaction(async (raw) => {
  const tx: SqlQuery = { all: (sql, params) => raw.all(this.dialect.placeholders(sql), params) };
  await this.dialect.serialize(tx, this.table, input.job);
  const now = Number((await tx.all(`SELECT ${this.dialect.nowMs} AS now`, []))[0]?.now);
  const [found] = await tx.all(
    `SELECT attempt, max_attempts, released, token, status, lease_until FROM ${this.table} WHERE job = ? AND slot = ?${this.dialect.forUpdate}`,
    [input.job, input.slot],
  );
  const decision = decideClaim(found ? toRunRow(found) : undefined, input, now);
  if (decision.kind === 'answer') return decision.outcome;
  if (decision.kind === 'give-up') {
    await this.interrupt(tx, input.job, input.slot);
    return { kind: 'done' };
  }
  if (decision.kind === 'start') {
    const refused = await this.startRun(tx, input, now);
    if (refused) return refused;
  } else {
    await this.takeOver(tx, input, decision.attempt, now);
  }
  const attempt = decision.kind === 'take-over' ? decision.attempt : 1;
  await this.recordAttempt(tx, input, attempt, now);
  return { kind: 'won', attempt };
});
```

After:

```ts
return client.transaction(async (raw) => {
  const tx = this.withPlaceholders(raw);
  await this.dialect.serialize(tx, this.table, input.job);
  const now = await this.clock(tx);
  const run = await this.readRun(tx, input);

  const decision = decideClaim(run, input, now);
  return this.act(tx, input, decision, now);
});

/** The database's clock, in Unix ms: every claim decides by it, never by the instance's. */
private async clock(tx: SqlQuery): Promise<number> {
  const [row] = await tx.all(`SELECT ${this.dialect.nowMs} AS now`, []);
  return Number(row?.now);
}

/** The run's row, locked until the transaction commits; undefined when nobody claimed it. */
private async readRun(tx: SqlQuery, { job, slot }: RunClaim): Promise<RunRow | undefined> {
  const [row] = await tx.all(
    `SELECT attempt, max_attempts, released, token, status, lease_until
     FROM ${this.table}
     WHERE job = ? AND slot = ?${this.dialect.forUpdate}`,
    [job, slot],
  );
  return row ? toRunRow(row) : undefined;
}

/** Performs the writes the decision asks for, and answers the claim. */
private async act(tx: SqlQuery, input: RunClaim, decision: ClaimDecision, now: number): Promise<ClaimOutcome> {
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
```

Why it reads better:

- The transaction body is two steps, separated by a blank line: load (`clock`, `readRun`), then
  decide and act. Each load step names what it reads.
- `act` dispatches on `decision.kind` once; each case ends in its own answer, so no second test of
  the same value is needed.
- The SQL shows one clause per line, as the other statements in the file do.
