/* Copyright (C) 2026-present Aristotelis — see repository license. */

import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';

import {
  type Backend,
  NatsBackend,
  RabbitMQBackend,
  RedisBackend,
  type RunStore,
  Scheduler,
  type SchedulerOptions,
  ValkeyBackend,
} from '../../src';

const memoryBackend = (): Backend => ({
  name: 'memory',
  dedupeWindowMs: Infinity,
  init: async () => {},
  prepareJob: async () => {},
  claim: async () => true,
  recordManualRun: async () => undefined,
  saveResult: async () => {},
  history: async () => [],
  close: async () => {},
});

afterEach(() => {
  Scheduler.reset();
});

test('a scheduler needs a backend: none is assumed, and nothing connects to a store you did not name', () => {
  const without: Array<Partial<SchedulerOptions> | undefined> = [undefined, {}, { leaseMs: 10_000, timezone: 'UTC' }];
  for (const options of without) {
    assert.throws(
      () => new Scheduler(options as SchedulerOptions),
      (error: Error) => error instanceof TypeError && /backend/.test(error.message),
      `new Scheduler(${JSON.stringify(options)}) should need a backend`,
    );
  }

  assert.equal(new Scheduler({ backend: memoryBackend() }).backend.name, 'memory');
});

test('a one-off job takes no overlap', () => {
  const scheduler = new Scheduler({ backend: memoryBackend() });
  // @ts-expect-error a one-off job has no previous run to overlap
  assert.throws(() => scheduler.at('once', new Date(Date.now() + 60_000), () => {}, { overlap: 'allow' }), /one-off job takes no overlap/);
});

test('a backend without leases takes no lease options: they fail to compile and throw', () => {
  const noLeases = /needs a backend with leases.*rabbitmq has none/;
  // @ts-expect-error RabbitMQ has no leases
  assert.throws(() => new Scheduler({ backend: new RabbitMQBackend(), leaseMs: 10_000 }), noLeases);
  // @ts-expect-error RabbitMQ has no leases
  assert.throws(() => new Scheduler({ backend: new RabbitMQBackend(), heartbeatMs: 1_000 }), noLeases);

  const rabbit = new Scheduler({ backend: new RabbitMQBackend() });
  // @ts-expect-error no overlap without leases
  assert.throws(() => rabbit.every('a', '1m', () => {}, { overlap: 'allow' }), /Job "a": overlap needs a backend with leases/);
  // @ts-expect-error no retries without leases
  assert.throws(() => rabbit.cron('b', '0 * * * *', () => {}, { maxAttempts: 1 }), /Job "b": maxAttempts needs/);
  // @ts-expect-error no catch-up without leases
  assert.throws(() => rabbit.at('c', new Date(Date.now() + 60_000), () => {}, { catchUpMs: 0 }), /Job "c": catchUpMs needs/);
  rabbit.every('d', '1m', () => {}, { timeoutMs: 1_000 });

  const script = new Scheduler({ backend: new ValkeyBackend({ strategy: { name: 'script' } }) });
  // @ts-expect-error the 'script' strategy has no leases
  assert.throws(() => script.every('e', '1m', () => {}, { overlap: 'skip' }), /valkey:script has none/);
  // @ts-expect-error NATS has no leases
  assert.throws(() => new Scheduler({ backend: new NatsBackend(), leaseMs: 10_000 }), /nats has none/);
});

test('lease options stay available on a lease backend, and wherever the backend is not known', () => {
  const lease = new Scheduler({ backend: new RedisBackend(), leaseMs: 10_000, heartbeatMs: 1_000 });
  lease.every('a', '1m', () => {}, { overlap: 'allow', maxAttempts: 1, catchUpMs: 0 });
  new Scheduler({ backend: new ValkeyBackend({ strategy: 'lease' }), leaseMs: 10_000 }).every('b', '1m', () => {}, { overlap: 'allow' });

  const any: Backend = new RedisBackend();
  new Scheduler({ backend: any, leaseMs: 10_000 }).every('c', '1m', () => {}, { maxAttempts: 2 });
  const asDefault: Scheduler = new Scheduler({ backend: new RabbitMQBackend() });
  assert.equal(asDefault.backend.name, 'rabbitmq');
});

/** A backend that, like the real ones, opens its connection on first use and reopens after close(). */
function lazyBackend() {
  const state = { open: false };
  const use = async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    state.open = true;
  };
  const backend: Backend = {
    ...memoryBackend(),
    init: use,
    prepareJob: use,
    history: async () => {
      await use();
      return [];
    },
    close: async () => {
      state.open = false;
    },
  };
  return { backend, state };
}

test('a read after stop() opens the connection for itself and closes it again', async () => {
  const { backend, state } = lazyBackend();
  const scheduler = new Scheduler({ backend });
  scheduler.every('a', '1h', () => {});
  await scheduler.start();
  await scheduler.stop();
  assert.equal(state.open, false);

  await Promise.all([scheduler.history('a'), scheduler.lastRun('a'), scheduler.history('a', 5)]);
  assert.equal(state.open, false, 'nothing left open, so the process can exit');
});

test('reads before start() keep the connection open until stop(), for processes that only read', async () => {
  const { backend, state } = lazyBackend();
  const reader = new Scheduler({ backend });
  await reader.history('a');
  assert.equal(state.open, true);
  await reader.stop();
  assert.equal(state.open, false);
});

test('stop() while start() is still connecting leaves no connection open', async () => {
  const { backend, state } = lazyBackend();
  const scheduler = new Scheduler({ backend });
  scheduler.every('a', '1h', () => {});
  const starting = scheduler.start();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await scheduler.stop();
  await starting;
  assert.equal(state.open, false);
});

test('sync and async listeners that throw are logged without unhandled rejections or blocking later listeners', async () => {
  const errors: string[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  let saveThrows = false;
  const backend: Backend = {
    ...memoryBackend(),
    saveResult: async () => {
      if (saveThrows) throw new Error('store down');
    },
  };
  const scheduler = new Scheduler({
    backend,
    logger: { warn: () => {}, error: (m) => errors.push(m) },
  });
  const calls: string[] = [];
  const removed = () => calls.push('removed');
  scheduler
    .every('a', '1h', () => {})
    .on('success', () => {
      throw new Error('sync boom');
    })
    .on('success', async () => {
      throw new Error('async boom');
    })
    .on('success', () => {
      calls.push('after');
    })
    .once('success', async () => {
      calls.push('once');
      throw new Error('once boom');
    })
    .on('success', removed)
    .off('success', removed)
    .on('error', async () => {
      throw new Error('error listener boom');
    });

  await scheduler.start();
  try {
    await scheduler.runNow('a');
    saveThrows = true;
    await scheduler.runNow('a');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(unhandled, []);
    assert.deepEqual(calls, ['after', 'once', 'after']);
    assert.ok(errors.some((m) => m.includes('sync boom')));
    assert.ok(errors.some((m) => m.includes('async boom')));
    assert.ok(errors.some((m) => m.includes('once boom')));
    assert.ok(errors.some((m) => m.includes('error listener boom')));
  } finally {
    process.off('unhandledRejection', onUnhandled);
    await scheduler.stop();
  }
});

test('stop() tracks a manual run while its claim is pending and never starts its handler after stopping or restarting', async () => {
  for (const withLeases of [false, true]) {
    let releaseClaim = () => {};
    let claimStarted = () => {};
    const claimPending = new Promise<void>((resolve) => {
      claimStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    let closed = false;
    let closeBeforeClaimFinished = false;
    const runs: RunStore = {
      claim: async () => {
        claimStarted();
        await gate;
        closeBeforeClaimFinished = closed;
        return { kind: 'won', attempt: 1 };
      },
      heartbeat: async () => true,
      finish: async () => true,
      release: async () => true,
      active: async () => [],
    };
    const backend: Backend = {
      ...memoryBackend(),
      ...(withLeases ? { runs } : {}),
      recordManualRun: async () => {
        claimStarted();
        await gate;
        closeBeforeClaimFinished = closed;
        return undefined;
      },
      close: async () => {
        closed = true;
      },
    };
    let handlerCalls = 0;
    const scheduler = new Scheduler({ backend });
    scheduler.every('job', '1h', () => {
      handlerCalls++;
    });
    await scheduler.start();

    const manual = scheduler.runNow('job');
    await claimPending;
    let stopResolved = false;
    const stopping = scheduler.stop().then(() => {
      stopResolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(stopResolved, false, `withLeases=${withLeases}: stop() waits for pending manual claim`);

    releaseClaim();
    await stopping;
    const record = await manual;
    assert.equal(closeBeforeClaimFinished, false, `withLeases=${withLeases}: backend stayed open while claim was pending`);
    assert.equal(handlerCalls, 0, `withLeases=${withLeases}: handler must not run after stop()`);
    assert.equal(record.status, 'interrupted');
  }
});

test('a pending manual or scheduled operation from an earlier lifecycle does not run its handler after stop() times out and start() runs again', async () => {
  for (const withLeases of [false, true]) {
    for (const stage of ['prepare', 'manual-claim'] as const) {
      let releaseFirst = () => {};
      let firstStarted = () => {};
      const firstPending = new Promise<void>((resolve) => {
        firstStarted = resolve;
      });
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let calls = 0;
      const pauseFirst = async () => {
        if (calls++ === 0) {
          firstStarted();
          await firstGate;
        }
      };
      const runs: RunStore = {
        claim: async () => {
          if (stage === 'manual-claim') await pauseFirst();
          return { kind: 'won', attempt: 1 };
        },
        heartbeat: async () => true,
        finish: async () => true,
        release: async () => true,
        active: async () => [],
      };
      const backend: Backend = {
        ...memoryBackend(),
        ...(withLeases ? { runs } : {}),
        prepareJob: async (name) => {
          if (stage === 'prepare' && name === 'late-added') await pauseFirst();
        },
        recordManualRun: async () => {
          if (stage === 'manual-claim') await pauseFirst();
          return undefined;
        },
      };
      const executed: string[] = [];
      const scheduler = new Scheduler({ backend });
      scheduler.every(
        'job',
        '1h',
        (ctx) => {
          executed.push(String((ctx.data as { run?: string } | undefined)?.run ?? 'none'));
        },
        withLeases ? { catchUpMs: 0 } : {},
      );
      await scheduler.start();
      if (stage === 'prepare') {
        scheduler.every(
          'late-added',
          '1h',
          (ctx) => {
            executed.push(String((ctx.data as { run?: string } | undefined)?.run ?? 'none'));
          },
          withLeases ? { catchUpMs: 0 } : {},
        );
      }
      const target = stage === 'prepare' ? 'late-added' : 'job';
      const first = scheduler.runNow(target, { data: { run: 'stale' } });
      await firstPending;
      await scheduler.stop({ timeoutMs: 10 });
      await scheduler.start();

      releaseFirst();
      const staleRecord = await first;
      assert.equal(staleRecord.status, 'interrupted', `withLeases=${withLeases}, stage=${stage}`);
      assert.deepEqual(executed, []);

      const freshRecord = await scheduler.runNow(target, { data: { run: 'fresh' } });
      assert.equal(freshRecord.status, 'success');
      assert.deepEqual(executed, ['fresh']);
      await scheduler.stop();
    }
  }
});

test('a scheduled claim won while stop() waits records the run as interrupted without starting it', async () => {
  let releaseClaim = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseClaim = resolve;
  });
  let claimStarted = () => {};
  const claimPending = new Promise<void>((resolve) => {
    claimStarted = resolve;
  });
  const saved: string[] = [];
  const backend: Backend = {
    ...memoryBackend(),
    claim: async () => {
      claimStarted();
      await gate;
      return true;
    },
    saveResult: async (_job, result) => {
      saved.push(result.status);
    },
  };
  let handlerCalls = 0;
  const scheduler = new Scheduler({ backend, jitterMs: 0 });
  scheduler.at('once', new Date(Date.now() + 50), () => {
    handlerCalls++;
  });
  await scheduler.start();
  await claimPending;
  const stopping = scheduler.stop();
  releaseClaim();
  await stopping;
  assert.equal(handlerCalls, 0);
  assert.deepEqual(saved, ['interrupted']);
});
