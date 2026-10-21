/* Copyright (C) 2026-present Aristotelis — see repository license. */

/**
 * What happens to a scheduled job when the instance that runs it is sick but still up, with
 * @nestjs/locks and with anarchon, side by side on the same Redis (`pnpm test:servers`):
 *
 *   pnpm --filter anarchon-example-nestjs locks:compare
 *
 * Each scenario starts instance A, waits until A runs the job, starts a healthy instance B, and
 * reports how each of the next 5 runs ended. A is healthy in the first scenario, the control, and
 * faulty in the others. anarchon runs twice: as configured by default, and with
 * `yieldAfterFailure: true`, which makes an instance whose last run failed let a healthy one claim
 * the next run first. It takes about a minute.
 */
import { type ChildProcess, fork } from 'node:child_process';
import { join } from 'node:path';

import {
  type Behaviour,
  INTERVAL_MS,
  type InstanceEvent,
  JOB_MS,
  type Library,
  sleep,
} from './shared';

const OBSERVED_RUNS = 5;
/** Extra wait after the last observed run should have ended. */
const SETTLE_MS = 500;

const SCENARIOS: { behaviour: Behaviour; title: string }[] = [
  {
    behaviour: 'healthy',
    title: 'Control: A and B are healthy, so both setups work',
  },
  {
    behaviour: 'fails',
    title:
      'A throws in every run (its database connection broke); B is healthy',
  },
  {
    behaviour: 'hangs',
    title: 'A never ends a run (a query without a timeout); B is healthy',
  },
];

type Waiter = {
  matches: (event: InstanceEvent) => boolean;
  resolve: (event: InstanceEvent) => void;
};

const children = new Set<ChildProcess>();
process.on('exit', () => {
  for (const child of children) child.kill('SIGKILL');
});

/** The instances of one library in one scenario, and everything they reported. */
class Cluster {
  readonly events: InstanceEvent[] = [];
  private readonly waiting: Waiter[] = [];
  private readonly instances: ChildProcess[] = [];

  constructor(
    private readonly library: Library,
    private readonly key: string,
  ) {}

  start(instance: string, behaviour: Behaviour): void {
    const args = [this.library, instance, this.key, behaviour];
    const child = fork(join(__dirname, 'instance.js'), args);

    child.on('message', (event: InstanceEvent) => this.receive(event));
    child.on('exit', (code) => {
      if (!code) return;
      console.error(`${this.library} ${instance} exited with code ${code}`);
      process.exit(1);
    });
    children.add(child);
    this.instances.push(child);
  }

  stop(): void {
    for (const child of this.instances) {
      child.kill('SIGKILL');
      children.delete(child);
    }
  }

  next(matches: (event: InstanceEvent) => boolean): Promise<InstanceEvent> {
    return new Promise((resolve) => this.waiting.push({ matches, resolve }));
  }

  private receive(event: InstanceEvent): void {
    this.events.push(event);
    const index = this.waiting.findIndex((waiter) => waiter.matches(event));
    if (index >= 0) this.waiting.splice(index, 1)[0]?.resolve(event);
  }
}

/** How the run due at `slot` ended: by whom, and whether it succeeded. */
function outcome(events: InstanceEvent[], slot: number): string {
  const run = events.filter((event) => 'slot' in event && event.slot === slot);
  const ended = run.find((event) => event.type !== 'start');
  if (ended?.type === 'success') return `${ended.instance} succeeded`;
  if (ended) return `${ended.instance} failed`;

  const [started] = run;
  if (started) return `${started.instance} hung`;
  return 'skipped';
}

/** Runs one scenario on one library; returns how each observed run ended. */
async function watch(library: Library, behaviour: Behaviour) {
  const key = `locks-comparison:${process.pid}:${library}:${behaviour}`;
  const cluster = new Cluster(library, key);

  cluster.start('A', behaviour);
  await cluster.next((event) => event.type === 'start');
  cluster.start('B', 'healthy');
  await cluster.next((event) => event.type === 'ready');

  const firstSlot = Math.ceil(Date.now() / INTERVAL_MS) * INTERVAL_MS;
  const slots = Array.from(
    { length: OBSERVED_RUNS },
    (_, index) => firstSlot + index * INTERVAL_MS,
  );
  const lastSlot = slots[slots.length - 1] ?? firstSlot;
  await sleep(lastSlot + JOB_MS + SETTLE_MS - Date.now());
  cluster.stop();

  return slots.map((slot) => outcome(cluster.events, slot));
}

const succeeded = (outcomes: string[]) =>
  outcomes.filter((text) => text.endsWith('succeeded')).length;

async function main(): Promise<void> {
  for (const { behaviour, title } of SCENARIOS) {
    const [anarchon, nestLocks, yielding] = await Promise.all([
      watch('anarchon', behaviour),
      watch('nestjs-locks', behaviour),
      watch('anarchon-yield', behaviour),
    ]);

    console.log(`\n${title}`);
    console.table(
      anarchon.map((text, index) => ({
        anarchon: text,
        '@nestjs/locks': nestLocks[index],
        'anarchon, yieldAfterFailure': yielding[index],
      })),
    );
    console.log(
      `Runs that succeeded: anarchon ${succeeded(anarchon)} of ${OBSERVED_RUNS}, ` +
        `@nestjs/locks ${succeeded(nestLocks)} of ${OBSERVED_RUNS}, ` +
        `anarchon with yieldAfterFailure ${succeeded(yielding)} of ${OBSERVED_RUNS}`,
    );
  }

  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
