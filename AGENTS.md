# Repository Agent Instructions

These instructions apply to every agent/LLM making changes in this repository.

## What this repository is

anarchon, a published library: leaderless cron for Node.js clusters on Redis/Valkey,
PostgreSQL, SQLite, RabbitMQ and NATS. This file holds the rules, the commands and the working
procedures. `.claude/codebase-map.md` is the orientation map, and the `readable-code` skill in
`.claude/skills/readable-code/` holds the readability rules and the test conventions.

## Source of truth

The repository's current code and documentation are authoritative. Generic architecture,
scheduling or TypeScript guidance is secondary. If external advice conflicts with an
intentional repository decision, follow the repository and document any proposed
architectural change explicitly.

## Working discipline

These rules bias toward caution over speed. For trivial tasks, use judgment. Where they
touch library scope, "Library scope and review discipline" below governs.

### Think before coding

Don't assume. Don't hide confusion. Surface tradeoffs. Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them; don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop, name what is confusing, and ask.

### Simplicity first

Write the minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No flexibility or configurability that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask: would a senior engineer call this overcomplicated? If yes, simplify.

### Surgical changes

Touch only what you must. Clean up only your own mess. When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match the existing style, even if you would do it differently.
- If you notice unrelated dead code, mention it; don't delete it.

When your changes create orphans, remove the imports, variables, and functions that
*your* changes made unused. Don't remove pre-existing dead code unless asked.

Every changed line should trace directly to the request.

### Goal-driven execution

Define success criteria and loop until they are verified. Turn tasks into verifiable goals:

- "Add validation" → write tests for invalid inputs, then make them pass.
- "Fix the bug" → write a test that reproduces it, then make it pass.
- "Refactor X" → ensure tests pass before and after.

For multi-step tasks, state a brief plan with a check per step:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria allow independent iteration; weak ones ("make it work") need
constant clarification.

## Readable code

Code in `src/` and `examples/` follows the `readable-code` skill. Claude Code loads it as a
skill; every other agent reads its files directly before writing, refactoring or reviewing
code there:

- [.claude/skills/readable-code/SKILL.md](.claude/skills/readable-code/SKILL.md): the limits
  (functions up to 40 lines, nesting up to 3 levels, at most 4 positional parameters), the
  shape of a function (checks before any write; a decision that takes `now` and returns a
  `kind`-tagged outcome, apart from the writes it asks for; one input object destructured
  once; one step per line), the rules against needless interfaces, base classes and layers, the workflow and the
  self-review checklist.
- [.claude/skills/readable-code/references/conventions.md](.claude/skills/readable-code/references/conventions.md):
  naming forms, where code goes, error handling, examples and tests.
- [.claude/skills/readable-code/references/examples.md](.claude/skills/readable-code/references/examples.md):
  before and after rewrites of code from this repository.

Apply the limits to new and changed code. Report violations in code you did not change as
refactoring candidates, and change them only when asked.

## Repository context files

- `AGENTS.md` (this file): the rules, commands and procedures for every agent.
- `CLAUDE.md`: the short version that Claude Code loads every session. It stays under 40
  lines; `scripts/validate-claude-context.py` checks that it points to the map and to task
  files.
- `.claude/skills/readable-code/`: the readability rules (see Readable code).
- `.claude/codebase-map.md`: the compact orientation map: repository shape, stack, entry
  points, directory responsibilities, declared commands, critical modules and gotchas.
- A directory with local rules carries a nested `CLAUDE.md`. Multi-step work is tracked in a
  local task file under `.claude/tasks/`.

Before a large task, and again after compaction or when uncertain, read this file, the map,
the active task file if the task has one, and the nested `CLAUDE.md` of the directory you are
editing, if one exists.

### Using the codebase map

- It is a **compact orientation map, not a replacement for reading source**. Use it to find
  where to look, then open the actual files.
- **Verify before relying on it.** Confirm any claim that drives a change against the source
  file it names. When the map, a README or a summary disagrees with the code, the code wins;
  fix the map afterwards.
- Sections wrapped in `context:generated-*` markers are machine-written and rewritten on every
  regeneration. Sections wrapped in `context:manual-*` markers are human-owned and preserved;
  edit those by hand.

Explore in this order:

1. The map's Repository Shape, Directory Map and Critical Modules.
2. The nested `CLAUDE.md` files and the documentation of the area in scope.
3. Only the modules and symbols the task touches, plus their direct callers and tests.

Do not scan the whole repository. A repo-wide sweep needs an explicit reason (a rename, a
contract audit, a security review); say what it is before doing one.

### Task files

For any task that is large, multi-step, or likely to span sessions, create
`.claude/tasks/<task-id>.md` from [.claude/tasks/TEMPLATE.md](.claude/tasks/TEMPLATE.md).
Git ignores everything in `.claude/tasks/` except the template, so task files stay local.

- Use a short, stable, descriptive task id (`lease-renew-retry`, not `fix-1`).
- Update it after each meaningful milestone: status, decisions, modified files,
  verification results, next steps.
- Record what was *verified*, not what was intended. Name commands and their outcome.
- Never put secrets, credentials, tokens, customer data or personal information in a task
  id or a task file.
- A task file is for active work. When the task is done, move anything durable to the place
  that owns it (source, a documentation page or the README), then delete the file.

### Keeping the map current

Propose a map update, never silently skip it, when a change affects architecture, module
responsibilities, dependencies, entry points, commands, or repository conventions.

1. Run `python3 scripts/update-claude-snapshot.py` (regenerates the generated sections only).
2. Hand-edit the manual sections that the change invalidates (Architecture, Critical
   Modules, Conventions, Testing Strategy, Security and Operational Notes, Gotchas).
3. Run `python3 scripts/validate-claude-context.py`.
4. Mention the map change in your summary so the owner can review it.

## Commands

Use these scripts. Use pnpm only, never npm or yarn. The test layout and how the suites run
are described in the Tests section of
[.claude/skills/readable-code/references/conventions.md](.claude/skills/readable-code/references/conventions.md).

| Purpose | Command |
| --- | --- |
| Install | `pnpm install` |
| Start every test server (Docker) | `pnpm test:servers` (`COMPOSE_PROFILES=brokers` adds RabbitMQ and NATS) |
| Stop them and drop their data | `pnpm test:servers:down` |
| Tests, without the slow `test/e2e` files (about 2 min) | `pnpm test` |
| The `test/e2e` files only (cluster and failure scenarios) | `pnpm test:slow` |
| Every test | `pnpm test:all` |
| One test file | `pnpm test test/leases/rules.test.ts` |
| Tests in watch mode | `pnpm test:watch` |
| Coverage summary (text and `coverage/coverage-summary.json`) | `pnpm test:coverage` |
| Full run with coverage, saved to `test/test-run.log` | `pnpm test:all:full` |
| Summary of the last full run | `pnpm test:last:review` |
| Failures of the last full run | `pnpm test:last:fails` |
| Type checks (src, test, examples) | `pnpm lint` |
| Format and lint (Biome) | `pnpm check`, `pnpm format` |
| Build | `pnpm build` |
| Clean build (also before publishing) | `pnpm rebuild` |
| Remove build output (`clean:all` also node_modules) | `pnpm clean`, `pnpm clean:all` |
| Pack, install and load the published tarball; check the API snapshot | `pnpm test:release` |
| Record an intended change of the public API (`api/anarchon.api.txt`) | `pnpm api:update` |
| Everything before a release | `pnpm verify:all` |
| Failure scenarios, side by side | `pnpm scenarios` |
| Check the NestJS example on NestJS 11 and 12 | `pnpm --filter anarchon-example-nestjs test` |
| Documentation site (Astro Starlight, in `docs/`) | `pnpm docs:dev`, `pnpm docs:build` |
| Check that every docs diagram parses | `pnpm docs:check` |
| Regenerate the codebase map | `python3 scripts/update-claude-snapshot.py` |
| Check the map is current | `python3 scripts/update-claude-snapshot.py --check` |
| Validate all context files | `python3 scripts/validate-claude-context.py` |

## Library scope and review discipline

This is a reusable library for external applications and future use cases. Evaluate a
feature against its contract, extension purpose, correctness, maintenance cost and
compatibility, not only local call sites. The absence of a call site in this repository
does not make an export, backend or supported input type useless; conversely, future reuse
does not justify speculative abstractions.

Before removing an API, supported type, backend or layer, establish its consumer scope,
actual cost or defect and compatibility impact, and distinguish a published API or
documented extension point from truly redundant internal state. A local reference search
cannot establish that external consumers do not exist. An internal bug calls for a repair
within the abstraction, not deletion or relocation of the feature.

Label findings as a reproduced defect, a code-path inference, a contract risk or an
architectural proposal, and separate intended invariants from guarantees actually verified
by code and tests. Existing instructions express architecture intent; they are not proof
that an implementation is bug-free.

## Documentation and comment policy

Documentation describes the current repository contract: what exists, how to use it, what
callers can expect, and any current caveats. Do not document review history, refactor
history, removed behavior, or "before vs now" narratives.

- `AGENTS.md` contains generic repository instructions, not tutorials or change history.
- The README and the documentation site in `docs/` are current-state manuals covering
  purpose, installation, public API, configuration, expected behavior, caveats and
  practical examples. Prefer "use X when..." and "X behaves..." over migration narratives
  such as "previously", "used to", "now", "after the fix", or descriptions of removed
  implementations.
- Every exported function, and every public method of an exported class, has a JSDoc block
  that is genuinely useful: what it does beyond what its name says, each parameter (units,
  accepted values, required context), the return value, errors and caveats, and an
  `@example` of a real call. A block that only restates the name or signature does not
  meet this rule. Do not explain implementation mechanics. A method that implements a
  documented interface member is covered by that interface's doc.
- The public API (everything `src/index.ts` exports) is documented generously, for a user
  reading it in their editor:
  - Every exported class, interface and type has a JSDoc block with at least one `@example`
    of a real use case. Name the case in the example's title when there are several
    (`@example One object per tenant`).
  - Every option a user sets (scheduler, job, decorator, `register()`, `configure()` and
    backend options) says what it does, its default, when to change it, and has an
    `@example` with a realistic value.
  - Fields of event payloads, history records and the backend contract are each documented,
    and share the `@example` of their interface: show them in use there (a listener, a
    payload, an outline of an implementation) instead of one example per field.
  - Every overload signature has its own JSDoc, since editors show it per signature.
  - Examples compile against the current API (a `Scheduler` always gets a `backend`) and
    never contain secrets: read credentials from `process.env`.
- Internal types and functions get a doc comment for what their signature cannot say: units,
  the meaning of an absent or empty value, a concurrency, security or ordering constraint.
- Inline comments belong only inside difficult core mechanisms (lease handling, claiming,
  timers, backend protocols), where they state a non-obvious concurrency, security or
  protocol constraint. Keep them short and factual. Paragraph-sized comments or tutorial
  explanations belong in the documentation or an exported function's JSDoc.
- **No decorative banners in code**: never write divider lines, ASCII banners, or box
  borders (e.g. `// ── ... ──`, `// ===== ... =====`).
- **No ticket, review, or task identifiers in code or test titles**: never embed task IDs,
  issue numbers, or review finding tags in code comments, test file names,
  `describe`/`it` strings, function names, or variable names. Tests describe the *actual
  behavior, invariant, or contract*. Task IDs belong only in `.claude/tasks/`.
- **No narrative signposting**: avoid self-referential commentary ("This block
  validates...", "Here we handle...", "Helper method to...").
- Comments never describe a past code state or justify a completed change. Git history
  owns history.
- License headers, deprecation notices, generated-code markers, lint suppressions with a
  real reason, and externally required protocol notes are exempt from the brevity rule.

## Naming

Good names are short and declarative. A long name is a code smell: it usually repeats its
context, or the thing it names does too much.

- Use the shortest name that is unambiguous in its scope. The enclosing module, class,
  type or function is part of the name: `scheduler.stop()`, not `stopScheduler`;
  `lease.expiresAt`, not `lease.leaseExpiresAt`. Qualify only when two values in one scope
  would otherwise collide.
- No prefix or suffix the declaration or its context already states: no type or layer
  words (`jobObj`, `dataList`, `…Impl`, `…Manager`, `…Helper`, `…Util`), no history or
  status words (`legacy`, `old`, `new`, `v2`, `temp`). Role suffixes that name a role
  (`…Backend`, `…Options`, `…Event`, `…Error`) stay.
- A name states what the thing is or does, and stays true to its behavior.
- Booleans read as yes/no statements (`isRunning`, `hasLease`), never as a bare noun
  phrase and never negated (`notEnabled`).
- Functions and methods are verbs (`claim`, `renew`, `release`); values and types are
  nouns; converters are `to…`/`from…`.
- One concept, one name, everywhere; one name never means two things.
- A unit is the one suffix that earns its length: a duration held in a bare `number` names
  its unit (`ttlMs`, `graceSeconds`); a number named `…At` is Unix milliseconds unless the
  name says otherwise.
- Abbreviate only what every reader knows (`id`, `url`, `ttl`) or the repository already
  uses (`ctx`).
- Do not lengthen a name to carry what its JSDoc should say. Renaming a published export
  is a breaking change.
- Files are kebab-case (`lease-runner.ts`, `claim-only-runner.ts`).

## Compatibility

anarchon is extended without breaking the apps and the custom backends built on it. A change that
breaks one of these rules is a breaking change: it waits for a major release and goes under
"Breaking" in the changelog.

- **Public API.** Every intended change to what `src/index.ts` exports is recorded with
  `pnpm api:update`, and the diff of `api/anarchon.api.txt` is reviewed. `pnpm test:release` fails
  on an unrecorded change. Removing or renaming an export, a member or an option is breaking.
- **The backend contract** (`Backend`, `RunStore`, `SqlDialect`) is implemented outside this
  repository. A new member is optional, with a fallback in the scheduler for backends without it.
  A new method takes one object parameter, so it can grow; the positional parameters of the
  existing methods stay until a major release.
- **Types that backends produce and users read** (`RunRecord`, `StoredResult`, `ClaimOutcome`):
  a new field is optional. Backends build history with `buildHistory()`, so new fields reach them
  without changes.
- **Unions may grow:** `RunReason`, `RunStatus`, the `SkipEvent` reasons, `JobInfo.type`,
  `ClaimOutcome` kinds and `ErrorCode` may gain members in a minor release; their JSDoc says so.
  The scheduler handles a claim outcome it doesn't know like `'done'`.
- **Stored data.** Two versions of one major run side by side on one store during a rolling deploy.
  Add fields, never rename or remove them; read them with a default (`run.m or maxAttempts`);
  scripts update a stored object instead of rebuilding it, so fields a newer version wrote survive.
  A new SQL column comes with a migration in `init()` that checks for the column first (PostgreSQL
  9.5 has no `ADD COLUMN IF NOT EXISTS`). Raise `STORE_FORMAT` (`src/store-format.ts`) only for a
  change older versions can't read or would damage; that needs every instance stopped, and the
  changelog says so.
- **Options.** A new option goes in its `keysOf` list (`src/option-keys.ts` or next to its
  interface), or it is refused at runtime. An option a backend can't honour is refused, never
  ignored: absent from the types where the backend is known, and a `TypeError` elsewhere.
- **Errors.** Every thrown error has an `ErrorCode`; codes are stable, messages may be reworded.
  A new kind of failure gets a new code.
- **Dependencies.** `croner` decides run times, and every instance of a service must compute the
  same ones: a change of its major version, or of how anarchon calls it, is a breaking change.

## Non-negotiable repository rules

1. **No production code for tests.** No export, parameter, option, branch, or piece of
   retained state may be added or widened because a test needs to reach it. Test the
   behavior through the surface real callers use; where a module boundary must be crossed,
   mock the module in the test (`vi.mock`) rather than threading a seam through the
   signature.
2. **No slop.** Production and test code stay free of AI slop, decorative ASCII banners,
   step-by-step narration, and task or ticket references. Tests describe behaviors and
   contracts.
3. **Names.** Follow the Naming section above.
4. **Bugs start with a test.** Fix a bug by first writing a test that reproduces it.
5. **No secrets.** Never place passwords, tokens, private keys or connection strings with
   credentials in code, tests, documentation, context files or task files. Environment
   variable names are fine; values come from the environment. `.env*` files are never read
   into context files.
6. **No configuration from the environment in the library.** `src/` takes configuration
   through options and constructor arguments; only tests, examples and scripts read the
   environment.
7. **Commits.** Commit only after asking, never directly on `main`, and with no AI
   attribution in commit messages or pull requests.

## Before finishing

- Run the narrowest relevant test file first, then `pnpm lint`, `pnpm check` and the full
  `pnpm test`. A change that touches only documentation needs the docs checks only.
- Read the skip count: a backend whose server is not running is skipped, not passed.
- For a change in `src/` or `examples/`, answer the self-review checklist of the
  `readable-code` skill for the diff.
- Update the documentation when a deliberate repository decision changes.
- Propose a codebase map update when the change affects structure, commands or
  conventions (see Keeping the map current).
