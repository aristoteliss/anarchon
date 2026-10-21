/* Copyright (C) 2026-present Aristotelis — see repository license. */

// The decorators are applied by hand here, so the file needs no decorator syntax; the syntax
// itself, in both styles, is covered by test/e2e/decorators.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'vitest';

import {
  At,
  type Backend,
  type ConfigureOptions,
  Cron,
  Every,
  type JobContext,
  type JobDecorator,
  NatsBackend,
  RabbitMQBackend,
  Scheduled,
  Scheduler,
  SqliteBackend,
} from '../../src';

const memoryBackend = (name = 'memory'): Backend => ({
  name,
  dedupeWindowMs: Infinity,
  init: async () => {},
  prepareJob: async () => {},
  claim: async () => true,
  recordManualRun: async () => undefined,
  saveResult: async () => {},
  history: async () => [],
  close: async () => {},
});

const newScheduler = () => new Scheduler({ backend: memoryBackend() });
const names = (scheduler: Scheduler) => scheduler.jobs().map((job) => job.name);
const summary = (scheduler: Scheduler) =>
  scheduler.jobs().map((job) => [job.name, job.type, job.schedule]);

type Initializer = (this: object) => void;
const initializers = new WeakMap<object, Initializer[]>();

/** Applies decorators to a method as standard decorators are applied: the one written last goes first. */
function decorate(
  target: { prototype: object },
  method: string,
  ...decorators: JobDecorator[]
): void {
  const added = initializers.get(target.prototype) ?? [];
  initializers.set(target.prototype, added);
  const context = {
    kind: 'method',
    name: method,
    static: false,
    private: false,
    addInitializer: (initializer: Initializer) => added.push(initializer),
  } as unknown as ClassMethodDecoratorContext;
  for (const decorator of decorators.reverse())
    decorator(Reflect.get(target.prototype, method), context);
}

/** Creates an object as a class with standard decorators does: what the decorators asked to run on a new object runs on it. */
function create<T extends object>(Class: new () => T): T {
  const object = new Class();
  for (
    let proto = Object.getPrototypeOf(object);
    proto;
    proto = Object.getPrototypeOf(proto)
  ) {
    for (const initializer of initializers.get(proto) ?? [])
      initializer.call(object);
  }
  return object;
}

/** Applies a decorator to a method as legacy decorators (experimentalDecorators) are applied. */
function decorateLegacy(
  target: { prototype: object },
  method: string,
  decorator: JobDecorator,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(target.prototype, method);
  assert.ok(descriptor);
  decorator(target.prototype, method, descriptor);
}

beforeEach(() => {
  Scheduler.reset();
});

test('register() adds the jobs declared on a class, named Class-method', () => {
  class Reports {
    digest() {}
    sync() {}
    launch() {}
    notAJob() {}
  }
  decorate(
    Reports,
    'digest',
    Cron('0 8 * * 1-5', { timezone: 'Europe/Athens' }),
  );
  decorate(Reports, 'sync', Every('10s'));
  decorate(Reports, 'launch', At('2030-01-01T00:00:00Z'));

  const scheduler = newScheduler().register(new Reports());
  assert.deepEqual(
    scheduler.jobs().map((job) => [job.name, job.type]),
    [
      ['Reports-digest', 'cron'],
      ['Reports-sync', 'every'],
      ['Reports-launch', 'once'],
    ],
  );
  assert.equal(
    scheduler.jobs()[0]?.schedule,
    'cron "0 8 * * 1-5" (Europe/Athens)',
  );
  assert.equal(
    scheduler.nextRun('Reports-launch')?.toISOString(),
    '2030-01-01T00:00:00.000Z',
  );
});

test('the default name is accepted by the backends that restrict names', () => {
  class Reports {
    digest() {}
  }
  decorate(Reports, 'digest', Every('10s'));

  for (const backend of [new RabbitMQBackend(), new NatsBackend()]) {
    assert.deepEqual(
      names(new Scheduler({ backend }).register(new Reports())),
      ['Reports-digest'],
    );
  }
});

test('a job runs as a method of its object and gets the context', async () => {
  class Counter {
    count = 0;
    seen: JobContext | undefined;
    tick(ctx: JobContext) {
      this.count++;
      this.seen = ctx;
    }
  }
  decorate(Counter, 'tick', Every('1h'));

  const counter = new Counter();
  const scheduler = newScheduler().register(counter);
  await scheduler.start();
  try {
    const run = await scheduler.runNow('Counter-tick');
    assert.equal(run.status, 'success');
    assert.equal(counter.count, 1);
    assert.equal(counter.seen?.name, 'Counter-tick');
  } finally {
    await scheduler.stop();
  }
});

test('the name can be the first argument or an option, and one method can carry several jobs', () => {
  class Sync {
    run() {}
    once() {}
  }
  decorate(
    Sync,
    'run',
    Every('sync-fast', '10s'),
    Every('sync-slow', 60_000, { timeoutMs: 5_000 }),
    Every('1h', { name: 'sync-hourly' }),
    Cron('sync-nightly', '0 3 * * *', { timezone: 'Europe/Athens' }),
    Cron('0 4 * * *', { name: 'sync-early' }),
  );
  decorate(
    Sync,
    'once',
    At('launch', '2030-01-01T00:00:00Z'),
    At('relaunch', new Date('2031-01-01T00:00:00Z')),
    At(1_900_000_000_000, { name: 'later' }),
  );

  const scheduler = newScheduler().register(new Sync());
  assert.deepEqual(summary(scheduler).slice(0, 5), [
    ['sync-fast', 'every', 'every 10s'],
    ['sync-slow', 'every', 'every 1m'],
    ['sync-hourly', 'every', 'every 1h'],
    ['sync-nightly', 'cron', 'cron "0 3 * * *" (Europe/Athens)'],
    ['sync-early', 'cron', 'cron "0 4 * * *"'],
  ]);
  assert.deepEqual(names(scheduler).slice(5), ['launch', 'relaunch', 'later']);
  assert.equal(
    scheduler.nextRun('relaunch')?.toISOString(),
    '2031-01-01T00:00:00.000Z',
  );
  assert.equal(scheduler.nextRun('later')?.getTime(), 1_900_000_000_000);

  assert.throws(() => Every(5 as unknown as string, '10s'), TypeError);
});

test('job options reach the job', async () => {
  class Slow {
    async run(ctx: JobContext) {
      await new Promise((resolve) =>
        ctx.signal.addEventListener('abort', resolve),
      );
      ctx.signal.throwIfAborted();
    }
  }
  decorate(Slow, 'run', Every('1h', { timeoutMs: 20 }));

  const scheduler = newScheduler().register(new Slow());
  await scheduler.start();
  try {
    const run = await scheduler.runNow('Slow-run');
    assert.notEqual(run.status, 'success');
  } finally {
    await scheduler.stop();
  }
});

test('a subclass inherits declared jobs under its own name, and an override replaces them', () => {
  class Base {
    inherited() {}
    overridden() {}
  }
  decorate(Base, 'inherited', Every('10s'));
  decorate(Base, 'overridden', Every('20s'));
  class Child extends Base {
    override overridden() {}
    own() {}
  }
  decorate(Child, 'own', Every('30s'));

  assert.deepEqual(summary(newScheduler().register(new Child())), [
    ['Child-own', 'every', 'every 30s'],
    ['Child-inherited', 'every', 'every 10s'],
  ]);
});

test('register() refuses an object without declared jobs', () => {
  class Plain {
    run() {}
  }
  class Decorated {
    run() {}
  }
  decorate(Decorated, 'run', Every('10s'));

  assert.throws(() => newScheduler().register(new Plain()), TypeError);
  assert.throws(() => newScheduler().register(Decorated), TypeError);
});

test('register() adds nothing when one of the jobs is invalid or already registered', () => {
  class Mixed {
    good() {}
    tooOften() {}
  }
  decorate(Mixed, 'good', Every('10s'));
  decorate(Mixed, 'tooOften', Every('10ms'));
  const scheduler = newScheduler();
  assert.throws(() => scheduler.register(new Mixed()), RangeError);
  assert.deepEqual(scheduler.jobs(), []);

  class Fine {
    first() {}
    second() {}
  }
  decorate(Fine, 'first', Every('10s'));
  decorate(Fine, 'second', Every('taken', '10s'));
  scheduler.every('taken', '10s', () => {});
  assert.throws(() => scheduler.register(new Fine()), /already registered/);
  assert.deepEqual(names(scheduler), ['taken']);
});

test('only a public instance method can be a job', () => {
  class Statics {
    static run() {}
    other() {}
  }
  const context = {
    kind: 'method',
    name: 'run',
    static: true,
    private: false,
    addInitializer: () => {},
  };
  assert.throws(
    () =>
      Every('10s')(
        Statics.run,
        context as unknown as ClassMethodDecoratorContext,
      ),
    TypeError,
  );

  const descriptor = Object.getOwnPropertyDescriptor(Statics, 'run');
  assert.ok(descriptor);
  assert.throws(() => Every('10s')(Statics, 'run', descriptor), TypeError);
});

test('an object adds its jobs to the default scheduler when it is created, with no register()', async () => {
  class Counter {
    count = 0;
    tick() {
      this.count++;
    }
  }
  decorate(Counter, 'tick', Every('tick', '1h'));

  const scheduler = newScheduler();
  const other = newScheduler();
  const counter = create(Counter);
  assert.deepEqual(names(scheduler), ['tick']);
  assert.deepEqual(names(other), []);

  await scheduler.start();
  try {
    await scheduler.runNow('tick');
    assert.equal(counter.count, 1);
  } finally {
    await scheduler.stop();
  }
});

test('an object created before the scheduler adds its jobs when the scheduler starts', async () => {
  class Early {
    run() {}
  }
  decorate(Early, 'run', Every('early', '1h'));
  create(Early);
  const newest = create(Early);

  const scheduler = newScheduler();
  assert.deepEqual(names(scheduler), []);
  await scheduler.start();
  try {
    assert.deepEqual(names(scheduler), ['early']);
    assert.throws(() => create(Early), /already registered/);
    assert.equal(scheduler.register(newest), scheduler);
    assert.deepEqual(names(scheduler), ['early']);
  } finally {
    await scheduler.stop();
  }
});

test('start() fails, and the scheduler stays stopped, when a waiting object cannot add its jobs', async () => {
  class Broken {
    run() {}
  }
  decorate(Broken, 'run', Every('broken', '10ms'));
  create(Broken);

  const scheduler = newScheduler();
  await assert.rejects(scheduler.start(), RangeError);
  assert.deepEqual(names(scheduler), []);
  await assert.rejects(scheduler.runNow('broken'));

  Scheduler.setDefault(undefined);
  await scheduler.start();
  assert.deepEqual(names(scheduler), []);
  await scheduler.stop();
});

test('a stopped default scheduler hands the role to the next one, and setDefault() chooses one', async () => {
  class First {
    run() {}
  }
  class Second {
    run() {}
  }
  class Third {
    run() {}
  }
  decorate(First, 'run', Every('first', '1h'));
  decorate(Second, 'run', Every('second', '1h'));
  decorate(Third, 'run', Every('third', '1h'));

  const a = newScheduler();
  const b = newScheduler();
  create(First);
  await a.stop();
  const c = newScheduler();
  create(Second);
  Scheduler.setDefault(b);
  create(Third);

  assert.deepEqual(
    [names(a), names(b), names(c)],
    [['first'], ['third'], ['second']],
  );
});

test('register() moves an object to another scheduler, and repeating it changes nothing', () => {
  class Movable {
    run() {}
  }
  decorate(Movable, 'run', Every('movable', '1h'));

  const a = newScheduler();
  const b = newScheduler();
  const movable = create(Movable);
  assert.deepEqual([names(a), names(b)], [['movable'], []]);

  b.register(movable).register(movable);
  assert.deepEqual([names(a), names(b)], [[], ['movable']]);

  b.remove('movable');
  b.register(movable);
  assert.deepEqual(names(b), ['movable']);
});

test('with legacy decorators, @Scheduled() makes the objects of a class add their jobs', () => {
  class Legacy {
    calls = 0;
    constructor(readonly label = 'default') {}
    run() {
      this.calls++;
    }
  }
  decorateLegacy(Legacy, 'run', Every('30s'));
  const scheduler = newScheduler();

  new Legacy();
  assert.deepEqual(names(scheduler), []);

  const Wrapped = Scheduled()(Legacy);
  const legacy = new Wrapped('given');
  assert.equal(Wrapped.name, 'Legacy');
  assert.ok(legacy instanceof Legacy);
  assert.equal(legacy.label, 'given');
  assert.deepEqual(summary(scheduler), [['Legacy-run', 'every', 'every 30s']]);
});

test('with standard decorators, @Scheduled() leaves the class as it is', () => {
  class Standard {
    run() {}
  }
  const decorateClass = Scheduled() as unknown as (
    target: unknown,
    context: unknown,
  ) => unknown;
  assert.equal(
    decorateClass(Standard, { kind: 'class', name: 'Standard' }),
    undefined,
  );
});

test('two arguments in the wrong order are refused when the class is defined, with the right form in the message', () => {
  assert.throws(
    () => Cron('0 8 * * *', 'Europe/Athens'),
    (error: Error) =>
      error instanceof TypeError && /timezone/.test(error.message),
  );
  assert.throws(
    () => Cron('0 8 * * *', 'digest'),
    (error: Error) => error instanceof TypeError && /name/.test(error.message),
  );
  assert.throws(
    () => Every('1h', 'sync'),
    (error: Error) =>
      error instanceof TypeError &&
      /@Every\(name, interval\)/.test(error.message),
  );
  assert.throws(() => Every(60_000 as unknown as string, 'sync'), TypeError);
  assert.throws(
    () => At('2030-01-01T00:00:00Z', 'launch'),
    (error: Error) =>
      error instanceof TypeError && /@At\(name, when\)/.test(error.message),
  );

  Cron('digest', '0 8 * * 1-5');
  Cron('digest', '*/10 * * * * *');
  Cron('digest', '@daily');
  Every('10s', '20s');
  Every('sync', 5_000);
  At('launch', '2030-01-01T00:00:00Z');
  At('launch', 1_900_000_000_000);
});

const collectingLogger = () => {
  const warnings: string[] = [];
  return {
    warnings,
    logger: {
      warn: (message: string) => void warnings.push(message),
      error: () => {},
    },
  };
};

test('start() warns about a job declared with a legacy decorator that no object added', async () => {
  class Forgotten {
    run() {}
  }
  decorateLegacy(Forgotten, 'run', Every('forgotten-job', '1h'));
  class Marked {
    run() {}
  }
  decorateLegacy(Marked, 'run', Every('marked-job', '1h'));
  const MarkedClass = Scheduled()(Marked);
  class Registered {
    run() {}
  }
  decorateLegacy(Registered, 'run', Every('registered-job', '1h'));

  const { warnings, logger } = collectingLogger();
  const scheduler = new Scheduler({ backend: memoryBackend(), logger });
  new MarkedClass();
  scheduler.register(new Registered());
  new Forgotten();

  await scheduler.start();
  try {
    assert.equal(warnings.length, 1, warnings.join('\n'));
    assert.match(warnings[0] ?? '', /forgotten-job/);
    assert.match(warnings[0] ?? '', /Forgotten\.run/);
    assert.match(warnings[0] ?? '', /@Scheduled\(\)/);
    assert.match(warnings[0] ?? '', /register\(/);
  } finally {
    await scheduler.stop();
  }

  await scheduler.start();
  assert.equal(warnings.length, 1, 'a job is reported once');
  await scheduler.stop();
});

test('start() warns about a declared job whose class never got an object, and not once it has one', async () => {
  class NeverCreated {
    run() {}
  }
  decorate(NeverCreated, 'run', Cron('0 3 * * *'));
  class Created {
    run() {}
  }
  decorate(Created, 'run', Every('created-job', '1h'));

  const { warnings, logger } = collectingLogger();
  const scheduler = new Scheduler({ backend: memoryBackend(), logger });
  create(Created);

  await scheduler.start();
  try {
    assert.equal(warnings.length, 1, warnings.join('\n'));
    assert.match(warnings[0] ?? '', /@Cron/);
    assert.match(warnings[0] ?? '', /0 3 \* \* \*/);
    assert.match(warnings[0] ?? '', /"run"/);
    assert.doesNotMatch(warnings[0] ?? '', /created-job/);
  } finally {
    await scheduler.stop();
  }
});

test('a scheduler that is not the default one gives no such warning', async () => {
  class Elsewhere {
    run() {}
  }
  decorate(Elsewhere, 'run', Every('elsewhere-job', '1h'));

  newScheduler();
  const { warnings, logger } = collectingLogger();
  const other = new Scheduler({ backend: memoryBackend(), logger });
  await other.start();
  await other.stop();
  assert.deepEqual(warnings, []);
});

test('register() with a prefix lets several objects of one class coexist, each job on its own object', async () => {
  class Tenant {
    runs = 0;
    sync() {
      this.runs++;
    }
  }
  decorate(Tenant, 'sync', Every('sync', '1h'));
  const a = new Tenant();
  const b = new Tenant();

  const scheduler = newScheduler()
    .register(a, { prefix: 'tenant-a:' })
    .register(b, { prefix: 'tenant-b:' });
  assert.deepEqual(names(scheduler), ['tenant-a:sync', 'tenant-b:sync']);

  await scheduler.start();
  try {
    await scheduler.runNow('tenant-b:sync');
    assert.deepEqual([a.runs, b.runs], [0, 1]);
  } finally {
    await scheduler.stop();
  }
});

test('an object that added its jobs when it was created gets its prefix from register()', () => {
  class Tenant {
    sync() {}
    report() {}
  }
  decorate(Tenant, 'sync', Every('sync', '1h'));
  decorate(Tenant, 'report', Every('1d'));

  const scheduler = newScheduler();
  const a = create(Tenant);
  assert.deepEqual(names(scheduler), ['sync', 'Tenant-report']);
  scheduler.register(a, { prefix: 'a:' });
  scheduler.register(create(Tenant), { prefix: 'b:' });
  assert.deepEqual(names(scheduler), [
    'a:sync',
    'a:Tenant-report',
    'b:sync',
    'b:Tenant-report',
  ]);
});

test('a second object without a prefix is refused, and the error says how to have several', () => {
  class Tenant {
    sync() {}
  }
  decorate(Tenant, 'sync', Every('sync', '1h'));

  const scheduler = newScheduler();
  create(Tenant);
  assert.throws(
    () => create(Tenant),
    (error: Error) =>
      /already registered/.test(error.message) && /prefix/.test(error.message),
  );
  assert.deepEqual(names(scheduler), ['sync']);
});

test("register() defaults apply to every job of the object, and a job's own options win", async () => {
  class Reports {
    nightly() {}
    early() {}
    async slow(ctx: JobContext) {
      await new Promise((resolve) =>
        ctx.signal.addEventListener('abort', resolve),
      );
      ctx.signal.throwIfAborted();
    }
  }
  decorate(Reports, 'nightly', Cron('nightly', '0 3 * * *'));
  decorate(Reports, 'early', Cron('early', '0 4 * * *', { timezone: 'UTC' }));
  decorate(Reports, 'slow', Every('slow', '1h'));

  const scheduler = newScheduler().register(new Reports(), {
    defaults: { timezone: 'Europe/Athens', timeoutMs: 20 },
  });
  assert.deepEqual(summary(scheduler), [
    ['nightly', 'cron', 'cron "0 3 * * *" (Europe/Athens)'],
    ['early', 'cron', 'cron "0 4 * * *" (UTC)'],
    ['slow', 'every', 'every 1h'],
  ]);

  await scheduler.start();
  try {
    const run = await scheduler.runNow('slow');
    assert.notEqual(run.status, 'success');
  } finally {
    await scheduler.stop();
  }
});

test('register() defaults with overlap still add a one-off job, which has nothing to overlap', () => {
  class Launch {
    run() {}
  }
  decorate(Launch, 'run', At('launch', new Date(Date.now() + 60_000)));
  const scheduler = newScheduler().register(new Launch(), {
    defaults: { overlap: 'allow' },
  });
  assert.deepEqual(names(scheduler), ['launch']);
});

test('registering an object again with other options replaces its jobs, and a refused change keeps them', () => {
  class Tenant {
    sync() {}
  }
  decorate(Tenant, 'sync', Every('sync', '1h'));
  const tenant = new Tenant();

  const scheduler = newScheduler().register(tenant, { prefix: 'x:' });
  scheduler.register(tenant, { prefix: 'y:' });
  assert.deepEqual(names(scheduler), ['y:sync']);

  scheduler.register(tenant);
  assert.deepEqual(
    names(scheduler),
    ['y:sync'],
    'without options, the registration stays as it is',
  );

  scheduler.every('z:sync', '1h', () => {});
  assert.throws(
    () => scheduler.register(tenant, { prefix: 'z:' }),
    /already registered/,
  );
  assert.deepEqual(names(scheduler).sort(), ['y:sync', 'z:sync']);

  assert.throws(
    () => scheduler.register(tenant, { prefix: 5 as unknown as string }),
    TypeError,
  );
});

test('on a running scheduler with leases, the name an object had before its prefix never runs', async () => {
  class Tenant {
    runs = 0;
    sync() {
      this.runs++;
    }
  }
  decorate(Tenant, 'sync', Every('sync', '1s'));

  const folder = mkdtempSync(join(tmpdir(), 'anarchon-prefix-'));
  const errors: unknown[] = [];
  const scheduler = new Scheduler({
    backend: new SqliteBackend({ database: join(folder, 'jobs.db') }),
    jitterMs: 0,
  });
  scheduler.on('error', (event) => errors.push(event.error));
  await scheduler.start();
  try {
    // With standard decorators each object adds 'sync' when it is created, and register() renames it.
    const a = create(Tenant);
    scheduler.register(a, { prefix: 'a:' });
    const b = create(Tenant);
    scheduler.register(b, { prefix: 'b:' });
    assert.deepEqual(names(scheduler), ['a:sync', 'b:sync']);

    await new Promise((resolve) => setTimeout(resolve, 2_500));
    assert.deepEqual(await scheduler.history('sync'), []);
    assert.ok(
      a.runs >= 1 && b.runs >= 1,
      `each object runs its own job (a: ${a.runs}, b: ${b.runs})`,
    );
    assert.ok((await scheduler.history('a:sync')).length >= 1);
    assert.deepEqual(errors, []);
  } finally {
    await scheduler.stop();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('Scheduler.configure() refuses settings without a backend', () => {
  assert.throws(
    () => Scheduler.configure({} as ConfigureOptions),
    (error: Error) =>
      error instanceof TypeError && /backend/.test(error.message),
  );
  assert.throws(
    () =>
      Scheduler.configure({
        timezone: 'UTC',
        autoStart: true,
      } as ConfigureOptions),
    TypeError,
  );
  assert.throws(
    () =>
      Scheduler.configure('billing', { leaseMs: 10_000 } as ConfigureOptions),
    TypeError,
  );
  assert.throws(() => Scheduler.get(), /no default scheduler/);
  assert.throws(() => Scheduler.get('billing'), /no scheduler named "billing"/);

  Scheduler.configure({ backend: memoryBackend() });
  Scheduler.configure('billing', { backend: memoryBackend() });
});

test('with settings, a decorated class is all it takes: the scheduler is created when an object is', async () => {
  class Jobs {
    runs = 0;
    one() {
      this.runs++;
    }
  }
  decorate(Jobs, 'one', Cron('job-1', '*/10 * * * * *'));

  Scheduler.configure({ backend: memoryBackend(), timezone: 'Europe/Athens' });
  assert.deepEqual(Scheduler.all(), []);

  const jobs = create(Jobs);
  const scheduler = Scheduler.get();
  assert.deepEqual(Scheduler.all(), [scheduler]);
  assert.deepEqual(summary(scheduler), [
    ['job-1', 'cron', 'cron "*/10 * * * * *" (Europe/Athens)'],
  ]);

  // Not started: that is the caller's decision unless the settings say autoStart.
  await assert.rejects(scheduler.runNow('job-1'), /start\(\)/);
  await scheduler.start();
  try {
    await scheduler.runNow('job-1');
    assert.equal(jobs.runs, 1);
  } finally {
    await scheduler.stop();
  }
});

test('autoStart starts a scheduler when it is created, and reports a failure to start as an error', async () => {
  class Jobs {
    runs = 0;
    one() {
      this.runs++;
    }
    two() {}
  }
  decorate(Jobs, 'one', Every('job-1', '1h'));
  decorate(Jobs, 'two', Every('job-2', '1h', { scheduler: 'broken' }));

  const errors: string[] = [];
  const broken = {
    ...memoryBackend(),
    init: () => Promise.reject(new Error('no such server')),
  };
  Scheduler.configure({ backend: memoryBackend(), autoStart: true });
  Scheduler.configure('broken', {
    backend: broken,
    autoStart: true,
    logger: { warn: () => {}, error: (message) => void errors.push(message) },
  });

  const jobs = create(Jobs);
  await new Promise((resolve) => setTimeout(resolve, 20));
  try {
    await Scheduler.get().runNow('job-1');
    assert.equal(jobs.runs, 1);
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? '', /no such server/);
    await assert.rejects(Scheduler.get('broken').runNow('job-2'), /start\(\)/);
  } finally {
    await Scheduler.stopAll();
  }
});

test('a job chooses its scheduler by name; jobs with one name share a scheduler, created from its settings', () => {
  class Jobs {
    one() {}
    two() {}
    three() {}
    four() {}
  }
  decorate(Jobs, 'one', Cron('job-1', '*/10 * * * * *'));
  decorate(
    Jobs,
    'two',
    Cron('job-2', '*/10 * * * * *', { scheduler: 'billing' }),
  );
  decorate(Jobs, 'three', Every('5s', { name: 'job-3', scheduler: 'billing' }));
  decorate(
    Jobs,
    'four',
    At('job-4', '2030-01-01T00:00:00Z', { scheduler: 'reports' }),
  );

  // 'reports' has no settings of its own: it is created from the default ones, by the function.
  Scheduler.configure({ backend: (name) => memoryBackend(`memory:${name}`) });
  Scheduler.configure('billing', {
    backend: memoryBackend('billing-store'),
    timezone: 'UTC',
  });
  create(Jobs);

  assert.deepEqual(names(Scheduler.get()), ['job-1']);
  assert.deepEqual(summary(Scheduler.get('billing')), [
    ['job-2', 'cron', 'cron "*/10 * * * * *" (UTC)'],
    ['job-3', 'every', 'every 5s'],
  ]);
  assert.deepEqual(names(Scheduler.get('reports')), ['job-4']);
  assert.deepEqual(
    Scheduler.all().map((scheduler) => [
      scheduler.name,
      scheduler.backend.name,
    ]),
    [
      [undefined, 'memory:default'],
      ['billing', 'billing-store'],
      ['reports', 'memory:reports'],
    ],
  );
});

test('a named scheduler without settings of its own cannot share the default backend object', () => {
  Scheduler.configure({ backend: memoryBackend() });
  assert.throws(
    () => Scheduler.get('reports'),
    (error: Error) =>
      /configure\("reports"/.test(error.message) &&
      /function/.test(error.message),
  );
});

test('a job can name a scheduler object, or a scheduler created by hand with a name', () => {
  const billing = new Scheduler({ name: 'billing', backend: memoryBackend() });
  const first = newScheduler();
  const audit = new Scheduler({ backend: memoryBackend() });
  assert.throws(
    () => new Scheduler({ name: 'billing', backend: memoryBackend() }),
    /already exists/,
  );
  assert.throws(
    () => new Scheduler({ name: '', backend: memoryBackend() }),
    TypeError,
  );

  class Jobs {
    one() {}
    two() {}
    three() {}
  }
  decorate(Jobs, 'one', Every('job-1', '1h'));
  decorate(Jobs, 'two', Every('job-2', '1h', { scheduler: 'billing' }));
  decorate(Jobs, 'three', Every('job-3', '1h', { scheduler: audit }));
  create(Jobs);

  assert.deepEqual(
    [names(audit), names(billing), names(first)],
    [['job-3'], ['job-2'], ['job-1']],
  );
  assert.throws(
    () => Every('job-4', '1h', { scheduler: 5 as unknown as string }),
    TypeError,
  );
  assert.throws(() => Every('1h', { scheduler: '' }), TypeError);
});

test('an object waits until every scheduler its jobs name exists, and adds its jobs when one of them starts', async () => {
  class Jobs {
    one() {}
    two() {}
  }
  decorate(Jobs, 'one', Every('job-1', '1h'));
  decorate(Jobs, 'two', Every('job-2', '1h', { scheduler: 'later' }));

  const first = newScheduler();
  create(Jobs);
  assert.deepEqual(names(first), []);

  const later = new Scheduler({ name: 'later', backend: memoryBackend() });
  assert.deepEqual([names(first), names(later)], [[], []]);
  await later.start();
  try {
    assert.deepEqual([names(first), names(later)], [['job-1'], ['job-2']]);
  } finally {
    await later.stop();
  }
});

test('register() puts every job of an object on one scheduler, whatever scheduler each job names', () => {
  class Jobs {
    one() {}
    two() {}
  }
  decorate(Jobs, 'one', Every('job-1', '1h'));
  decorate(Jobs, 'two', Every('job-2', '1h', { scheduler: 'billing' }));

  Scheduler.configure({ backend: (name) => memoryBackend(name) });
  const jobs = create(Jobs);
  assert.deepEqual(
    [names(Scheduler.get()), names(Scheduler.get('billing'))],
    [['job-1'], ['job-2']],
  );

  const own = new Scheduler({ name: 'own', backend: memoryBackend() }).register(
    jobs,
    { prefix: 'x:' },
  );
  assert.deepEqual(
    [names(Scheduler.get()), names(Scheduler.get('billing')), names(own)],
    [[], [], ['x:job-1', 'x:job-2']],
  );
});

test('startAll() and stopAll() act on the default and the named schedulers; a stopped one gives up its name', async () => {
  Scheduler.configure({ backend: (name) => memoryBackend(name) });
  const main = Scheduler.get();
  const billing = Scheduler.get('billing');
  const unnamed = newScheduler();
  assert.deepEqual(Scheduler.all(), [main, billing]);

  await Scheduler.startAll();
  await assert.rejects(unnamed.runNow('nothing'));
  class Probe {
    run() {}
  }
  decorate(Probe, 'run', Every('probe', '1h', { scheduler: 'billing' }));
  create(Probe);
  await billing.runNow('probe');

  await Scheduler.stopAll();
  assert.deepEqual(Scheduler.all(), []);
  assert.notEqual(
    Scheduler.get('billing'),
    billing,
    'after a stop, the name goes to a new scheduler',
  );

  await Scheduler.stopAll();
  Scheduler.reset();
  assert.throws(() => Scheduler.get(), /no default scheduler/);
});

test('a decorator gives its job data, on top of what register() gives the object and the scheduler has', async () => {
  class Reports {
    seen: unknown[] = [];
    exportData(
      ctx: JobContext<{ db: string; tenant: string; permission: string }>,
    ) {
      this.seen.push(ctx.data);
    }
    cleanup(ctx: JobContext) {
      this.seen.push(ctx.data);
    }
  }
  decorate(
    Reports,
    'exportData',
    Every('export', '1h', { data: { permission: 'reports:export' } }),
  );
  decorate(Reports, 'cleanup', Every('cleanup', '1h'));

  const scheduler = new Scheduler({
    backend: memoryBackend(),
    data: { db: 'main' },
  });
  const acme = new Reports();
  const globex = new Reports();
  scheduler.register(acme, {
    prefix: 'acme:',
    defaults: { data: { tenant: 'acme' } },
  });
  scheduler.register(globex, {
    prefix: 'globex:',
    defaults: { data: () => ({ tenant: 'globex' }) },
  });

  await scheduler.start();
  try {
    await scheduler.runNow('acme:export');
    await scheduler.runNow('acme:cleanup');
    await scheduler.runNow('globex:export');
  } finally {
    await scheduler.stop();
  }
  assert.deepEqual(acme.seen, [
    { db: 'main', tenant: 'acme', permission: 'reports:export' },
    { db: 'main', tenant: 'acme' },
  ]);
  assert.deepEqual(globex.seen, [
    { db: 'main', tenant: 'globex', permission: 'reports:export' },
  ]);
});

test('autoStart gives no warning about the jobs of the object that caused the scheduler to be created', async () => {
  class Jobs {
    one() {}
    two() {}
  }
  decorate(Jobs, 'one', Every('job-1', '1h'));
  decorate(Jobs, 'two', Every('job-2', '1h', { scheduler: 'reports' }));

  const { warnings, logger } = collectingLogger();
  Scheduler.configure({
    backend: (name) => memoryBackend(name),
    autoStart: true,
    logger,
  });
  create(Jobs);
  await new Promise((resolve) => setTimeout(resolve, 20));
  try {
    assert.deepEqual(warnings, []);
    assert.deepEqual(
      [names(Scheduler.get()), names(Scheduler.get('reports'))],
      [['job-1'], ['job-2']],
    );
    await Scheduler.get('reports').runNow('job-2');
  } finally {
    await Scheduler.stopAll();
  }
});
