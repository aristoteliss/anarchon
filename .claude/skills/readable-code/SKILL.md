---
name: readable-code
description: Readability and architecture rules for anarchon's TypeScript library code in src/ and its runnable examples in examples/, with measurable limits (functions up to 40 lines, nesting up to 3 levels, at most 4 positional parameters) and rules against needless interfaces, base classes and layers. Use when writing new code, implementing a feature, adding a backend, an option, an error code or an example, fixing a bug, refactoring, or reviewing a diff, a pull request or a file in src/ or examples/. Also use when asked whether code is readable, too complex or over-engineered. Not for changes confined to test/, scripts/, docs/ or the agent context files.
---

# Readable code in anarchon

anarchon is a published library. Maintainers, authors of custom backends and users reading JSDoc
in their editors all read this code, so it is written for the reader first. This skill turns that
goal into rules that a reviewer can answer with yes or no.

- **Scope:** `src/` and `examples/`, including the NestJS package in `examples/nestjs/`.
- **Authority:** [AGENTS.md](../../../AGENTS.md) wins over this skill. This skill adds limits and
  does not repeat the Naming, Documentation and Compatibility sections there.
- **References:** [references/conventions.md](references/conventions.md) covers naming, placement,
  error handling and tests. [references/examples.md](references/examples.md) holds before and after
  rewrites of code from this repository.

## Core principles

1. **Write for the reader.** The code is read in reviews, stack traces and editor hovers far more
   often than it is written.
2. **The repository wins over generic advice.** AGENTS.md and the existing modules record
   decisions that general best practice cannot see.
3. **Make the smallest readable change.** Every extra line, option or layer is something a reviewer
   must check and a user may come to depend on.
4. **One function, one job.** A function that validates, decides, writes and reports at once hides
   the decision that matters.
5. **Name the idea.** A named step, constant or condition says why; an inline expression only says
   how.
6. **Earn every abstraction.** An interface with one implementation adds indirection without
   benefit; the published backend contract is the deliberate exception.
7. **Keep failures visible and coded.** Users branch on `ANARCHON_*` codes and `'error'` events, so
   an uncoded throw or a swallowed error breaks their contract.
8. **Refuse, decide, then act.** A call checks its input first, works out what should happen
   second, and writes last. Each part reads and tests more easily on its own than mixed together.

## Rules

Each rule has a limit and a way to check it. Apply the rules to new and changed code. In code you
read but did not change, report violations as refactoring candidates (see "Reporting existing
violations") and change them only when asked.

### 1. A function is at most 40 lines

- **Count** from the signature line to the closing brace, including comments and embedded SQL or
  Lua text.
- **Exception:** the entry function of an example (`main()`) may reach 80 lines when it reads top to
  bottom as a script.
- **Fix:** split by step: validate, decide, write, report. Inside a transaction, extract steps as
  functions that take the transaction, as `startRun(tx, ...)` and `recordAttempt(tx, ...)` in
  `src/backends/sql/base.ts` do.

### 2. Nesting is at most 3 levels

- **Count** one level for each `if`, loop, `try`, `switch` and inline callback (a function passed
  as an argument whose body holds statements; an empty `() => {}` does not count). An `else if`
  stays at the level of its `if`.
- A named function, declared or assigned to a `const`, starts its own count at 0.
- **Fix:** return early, extract the body of the inner loop into a function, or name the callback
  (`const onMessage = (msg) => { ... }`).

### 3. At most 4 positional parameters

- **Count** each parameter; a destructured object counts as one.
- No call passes `undefined` or `{}` only to reach a later argument.
- **Fix:** one object parameter whose interface sits next to the function. AGENTS.md sets the same
  rule for new backend methods.
- **Exception:** a method that implements an existing positional member of the backend contract
  keeps its parameters until a major release (AGENTS.md, Compatibility).

### 4. A conditional expression has at most three outcomes

- One ternary may nest in the last branch of another:
  `interrupted ? 'interrupted' : failure ? 'failed' : 'success'`. A ternary never nests in the
  condition or the first branch.
- **Fix:** a small function made of `if (...) return ...;` lines, or a `switch`.

### 5. A condition has at most 3 operands

- **Count** the operands joined by `&&` and `||` in one `if`, `while` or ternary condition.
- **Fix:** move the expression into a named boolean `const`, as `same` in
  `NatsBackend.updateStream` does.

### 6. No `else` after an exit

- When a branch ends in `return`, `throw`, `continue` or `break`, the code after it is not wrapped
  in `else`.

### 7. Every number explains itself

- A number other than 0 and 1 states its meaning on its own line: through the option or property
  it sets (`expires: 5_000`, `options.catchUpMs ?? 300_000`), the variable it initializes, or a
  short comment.
- Otherwise, and whenever the same tuning value appears twice, it becomes a module-level
  `UPPER_SNAKE` constant with a unit suffix, like `CLOCK_TOLERANCE_MS` and `BYTES_PER_RUN`.
- Unit conversions (`1_000`, `86_400_000`) and protocol codes that a comment names need no
  constant.

### 8. Abstractions are earned

- A new interface, abstract class or generic type parameter needs at least two implementations or
  callers today, or must belong to the published extension contract (`Backend`, `RunStore`,
  `SqlBackend`, `SqlDialect`, `SqlClient`).
- A class holds state that its methods share (a connection, timers, a client). Logic without state
  is a function, as `createJob`, `readOptions` and `buildHistory` are.

### 9. Code lives where it is used

- A helper with one caller file stays in that file. `src/util.ts` takes only code that two or more
  modules use.
- A new module needs a responsibility that no existing module holds. The placement table in
  [references/conventions.md](references/conventions.md) says where each kind of code goes.
- No new top-level folder under `src/`.

### 10. Errors are coded and visible (`src/` only)

- Every `throw` uses `coded(new TypeError | RangeError | Error(message), 'ANARCHON_*')`.
- The message names the job, option or object, the value received and what is accepted:
  `` `Job "${name}": maxLateMs (${maxLateMs}) must be bigger than jitterMs (${jitterMs})` ``.
- A failure in background work (timers, heartbeats, saving a result) goes to
  `core.emit('error', { error, job: job.name, slot })`; it is never thrown inside a timer.
- `.catch(() => {})` appears only on cleanup whose failure changes nothing, such as closing a
  channel or cancelling a consumer.

### 11. Names and comments follow AGENTS.md

- A duration held in a number has a unit suffix (`ttlMs`, `durationSec`); a number named `...At` is
  Unix milliseconds.
- Booleans read as yes or no (`started`, `lost`, `isRunning()`); functions are verbs; no `Manager`,
  `Helper`, `Util` or `Impl` suffix.
- Comments state only non-obvious concurrency or protocol constraints. Every new export has a JSDoc
  block with an `@example`.

### 12. Refusals come before work

- Every check of the arguments and of the scheduler's state (a `throw`, `refuseUnknown`, a
  `return` that refuses) runs before the first write, timer, event or backend call of that call.
- A function that validates and builds checks every input first, then builds. A throw never
  leaves a half-built job, a half-registered object or a half-written row behind; inside a
  transaction, the rollback covers it.
- **Reference shape:** `Scheduler.remove` and `Scheduler.runNow` (guard, load, act, return).
- **Fix:** move the check up, or into a `refuse...` function called on the first lines.

### 13. A decision takes `now` and returns a named outcome

- When a function works out from stored state and time what happens to a run (claim, take over,
  skip, give up) and also writes, split it: a function that takes the state and `now` and returns
  a `kind`-tagged union, and a caller that performs the writes the outcome asks for. See example 7
  in [references/examples.md](references/examples.md).
- `now` is read once per operation, from the clock that owns the decision (the database's clock
  inside a SQL claim, `Date.now()` in the scheduler), and passed down as a parameter.
- A result with more than two cases is a `kind`-tagged union like `ClaimOutcome`, not a boolean
  with a value on the side.
- **Check:** a function that writes to a store has at most one branch on stored state or time
  before its writes; more branches belong in a decision function.

### 14. One input object, destructured once

- A function that takes one object parameter destructures the fields it uses in its signature or
  on its first line (`const { name, schedule, options } = input;`), and uses those names after.
- The object's interface sits next to the function (rule 3) and is named for what it describes
  (`LeasedRun`, `JobInput`), not for the function (`ExecuteLeasedParams`).

### 15. One step per line

- A loop body is a block on its own lines, never on the line of its `for` or `while`.
- An `if` or `else` body without braces fits whole on the line of its `if` or `else`
  (`if (!run) return undefined;`); a body that the formatter moves to the next line, or that spans
  lines, gets braces.
- One expression nests at most two calls inside each other's arguments: `toStr(await
  redis.send(...))` is two. A third becomes a named `const` or a `to...` converter. A call inside
  an array or object argument counts; a callback body starts again at 0.
- An expression awaits once: `await (await this.getConnection()).client.send(...)` becomes
  `const { client } = await this.getConnection();` and a second line.
- A reply read by position is destructured into named parts (`const [clock, ...runs] = reply;`),
  or each position is named once (`const key = reply[i];`). No `reply[i + 1]` inside a larger
  expression.
- An argument holds no `await` and no ternary, and an awaited value is never indexed:
  `Number((await tx.all(sql))[0]?.now)` becomes `const [row] = await tx.all(sql);` and a second
  line.
- A function over 10 lines separates its steps (refuse, load, decide, act, return) with single
  blank lines; a step has no blank line inside it. A function that is one step (a single literal,
  as `claimArgs` in `src/backends/redis/lease.ts`) needs none.
- A `switch` dispatches on a `kind` once; no second `x.kind === ...` test follows it or an `if`
  chain on the same value.
- SQL or Lua text longer than the line width puts each clause on its own line (`SELECT`, `FROM`,
  `WHERE`, `SET`).
- **Fix:** name the intermediate value, extract a converter (`toStoredRun(raw)`) or a reading step
  (`clock(tx)`, `readRun(tx, input)`), or give the loop braces. See examples 9 and 10.

## When not to add structure

The repository is deliberately flat. Do not add:

- An interface or type alias for a shape with one producer and one consumer. Write the type inline
  or reuse an existing one (`Job`, `Execution`, `RunClaim`). The exception is the `kind`-tagged
  outcome of a decision function (rule 13): its cases are the vocabulary of the decision.
- An abstract base class for fewer than two subclasses. `SqlBackend` exists because the PostgreSQL
  and SQLite backends share one lease state machine.
- A layer between the existing ones: no service, manager, repository or adapter folder between
  `Scheduler`, its parts in `src/scheduler/` and the backends.
- Application architecture: no port interface, command or query handler class, repository,
  aggregate base class or decorator pipeline. anarchon is one layer of functions and stateful
  classes. The shape of a good handler (guard, load, decide, act, return) applies to a function
  here (rules 12 and 13), not to a class hierarchy.
- A pattern by name: no new factory, builder, registry or observer. The Redis claim strategies
  share an interface because three implementations are chosen by an option; that is the bar.
- An option, parameter or flag the task did not ask for. A new option is a public API change: its
  `keysOf` list, its JSDoc and `pnpm api:update`.
- A wrapper around a dependency used in one place. Drivers are adapted only to the existing adapter
  shapes (`SqlClient`, the Redis client adapters in `src/backends/redis/client.ts`).
- A generic type parameter that only one call site uses.
- Error handling for states that cannot occur, or a `try` that only rethrows.

When a design needs one of these, give the reason in the design bullets before writing it.

## Workflow

1. **Orient.** Read the Architecture and Critical Modules sections of `.claude/codebase-map.md`,
   then only the modules the task touches, their direct callers and their tests.
2. **State the design in 3 to 6 bullets** before editing:
   - what changes, and in which function or module;
   - why that place owns it (rule 9);
   - whether the public API, the backend contract or stored data changes (AGENTS.md,
     Compatibility);
   - which test proves it. For a bug, the test that reproduces it comes first.
3. **Implement the smallest readable solution.** Extend an existing function or module before
   creating a new one. When a function crosses a limit, split it by step.
4. **Run the repository's checks**, narrowest first. `pnpm test` needs the servers from
   `pnpm test:servers`.

   ```sh
   pnpm test test/<area>/<file>.test.ts        # the narrowest relevant test file
   pnpm lint                                   # tsc over src, test and examples/*.ts
   pnpm check                                  # Biome lint and format check; pnpm format fixes
   pnpm test                                   # every test except test/e2e; read the skip count
   pnpm --filter anarchon-example-nestjs test  # when examples/nestjs changed
   pnpm api:update && pnpm test:release        # when what src/index.ts exports changed
   pnpm test:slow                              # when claiming, leases or timers changed
   ```

5. **Self-review the diff** (`git diff`) with the checklist below. Fix every "no", or state why it
   stays.
6. **Report** the commands you ran and their results, the skip count, and any refactoring
   candidates.

## Reviewing a diff or a file

- Apply the checklist to the changed lines. Report each "no" as
  `path:line, rule N, measured value (limit), suggested fix`.
- List violations in unchanged code separately, under "Refactoring candidates".
- Do not rewrite code during a review unless asked.

## Reporting existing violations

Measure, do not estimate, and keep each entry to one line:

```text
Refactoring candidates (not changed):
- src/backends/nats.ts:232 history: rule 2, nesting 6 (limit 3). Extract the record sorting into a function.
- src/scheduler/lease-runner.ts:193 executeLeased: rule 3, 7 positional parameters (limit 4). Take one object parameter.
```

## Self-review checklist

Answer each question with yes or no for every new or changed function.

1. Is it 40 lines or shorter (80 for the linear `main()` of an example)?
2. Does it nest 3 levels or fewer, counting `if`, loops, `try`, `switch` and inline callbacks?
3. Does it take 4 positional parameters or fewer, with no call passing `undefined` or `{}` to reach
   a later argument?
4. Does every ternary have three outcomes or fewer, nesting only in the last branch?
5. Does every condition with more than 3 `&&` or `||` operands live in a named boolean `const`?
6. Is the code free of `else` after a branch that ends in `return`, `throw`, `continue` or `break`?
7. Does every number other than 0 and 1 state its meaning on its line, or come from a named
   `UPPER_SNAKE` constant?
8. Does every new interface, abstract class or type parameter have two implementations or callers
   today, or belong to the published extension contract?
9. Does every new class hold state that its methods share?
10. Does every new helper live in the file of its only caller, or in `src/util.ts` only when two
    modules use it?
11. Does every new `throw` in `src/` use `coded(...)` with an `ANARCHON_*` code and a message that
    names the subject, the value and what is accepted?
12. Do names and comments follow the Naming and Documentation sections of AGENTS.md?
13. Does every check of the arguments and of the state run before the first write, timer, event or
    backend call?
14. Does a function that writes to a store branch at most once on stored state or time before its
    writes, with `now` read once and passed down?
15. Does a function with one object parameter destructure the fields it uses once, at the top?
16. Does every loop body sit in a block, every multi-line `if` body have braces, every expression
    nest at most two calls with no `await` or ternary inside an argument, every function over 10
    lines separate its steps with blank lines, and every positional reply read go through a named
    part?
17. Did the narrowest test file, `pnpm lint`, `pnpm check` and `pnpm test` pass, with the skip
    count read?
18. Does every changed line trace to the request, with existing violations reported instead of
    fixed?

## When not to use this skill

- Changes confined to `test/`, `scripts/`, `docs/`, `api/`, `CHANGELOG.md`, the README or the agent
  context files. The test conventions in [references/conventions.md](references/conventions.md)
  still apply to tests.
- Generated output: `dist/`, `coverage/`, `api/anarchon.api.txt` and the generated sections of the
  codebase map.
- Mechanical changes with no design content: dependency bumps, `pnpm format`, a rename that `tsc`
  checks.
- Investigations and debugging that change no code and review none.
- The text of a Lua script or SQL statement. Do not rewrite protocol text to satisfy these rules;
  its lines still count toward the function that holds it.
