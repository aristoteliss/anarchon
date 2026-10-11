/* Copyright (C) 2026-present Aristotelis — see repository license. */
import { Scheduler, SqliteBackend } from '../src';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run() {
  console.log('\x1b[1;36m▶ Starting 3 anarchon instances on SQLite...\x1b[0m\n');

  const instances = ['node-1', 'node-2', 'node-3'].map(
    (id) =>
      new Scheduler({
        backend: new SqliteBackend({ database: './demo.db' }),
        instanceId: id,
        leaseMs: 3_000,
        heartbeatMs: 500,
      }),
  );

  let activeRunner = '';

  for (const s of instances) {
    s.every('runing_job', '6s', async (ctx) => {
      activeRunner = ctx.instanceId;
      for (let i = 0; i < 4; i++) {
        ctx.signal.throwIfAborted();
        await sleep(1000);
      }
    });

    s.on('start', (e) =>
      console.log(
        `  \x1b[32m✔\x1b[0m \x1b[1m${e.instanceId}\x1b[0m won lease (slot \x1b[33m${e.slot}\x1b[0m, attempt ${e.attempt}, ${e.reason})`,
      ),
    );
    s.on('skip', (e) => console.log(`  \x1b[90m- ${e.instanceId} skipped (run taken by another instance)\x1b[0m`));
    s.on('interrupted', (r) => console.log(`  \x1b[31m✖\x1b[0m \x1b[1m${r.instanceId}\x1b[0m killed mid-run \x1b[33m(handed over)\x1b[0m`));
    s.on('success', (r) => console.log(`  \x1b[32m✔\x1b[0m \x1b[1m${r.instanceId}\x1b[0m finished successfully in ${r.durationMs}ms\n`));
  }

  await Promise.all(instances.map((s) => s.start()));

  // Wait for first run to begin
  await sleep(1500);

  // Simulate killing the runner mid-run
  console.log(`\n\x1b[35m⚡ Simulating crash / deploy: stopping ${activeRunner}...\x1b[0m`);
  const killed = instances.find((s) => s.instanceId === activeRunner);
  await killed?.stop();

  // Wait for failover & completion
  await sleep(6000);
  await Promise.all(instances.map((s) => s.stop()));
  process.exit(0);
}

run();
