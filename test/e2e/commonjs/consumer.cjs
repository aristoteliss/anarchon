/* Copyright (C) 2026-present Aristotelis — see repository license. */

// A CommonJS app. It loads the NATS client with require() and gives its own connection to
// anarchon, built as CommonJS. anarchon loads @nats-io/jetstream and @nats-io/kv with import(), so
// when the NATS packages ship an ES module build too, the app and anarchon can use two copies of
// the client. This file runs the backend contract and one job on both NATS strategies, and prints
// one line of JSON with the result.
//
//   node test/e2e/commonjs/consumer.cjs <anarchon build folder> <NATS url>
'use strict';

const { resolve } = require('node:path');
const { connect } = require('@nats-io/transport-node');

const [build, servers] = process.argv.slice(2);
if (!build || !servers) {
  throw new Error(
    'usage: node consumer.cjs <anarchon build folder> <NATS url>',
  );
}
const { NatsBackend, Scheduler } = require(resolve(build, 'index.js'));
const { backendContract } = require(resolve(build, 'testing.js'));

/** A backend on the app's connection, with its own subjects and stream. */
const backend = (nc, strategy, namespace) =>
  new NatsBackend({
    connection: nc,
    prefix: `${namespace}.`,
    stream: namespace.toUpperCase(),
    strategy,
  });

/** Runs one job with runNow() and reads its history. */
async function runJob(nc, strategy) {
  const namespace = `cjs${strategy.replace('-', '')}${Date.now()}`;
  const scheduler = new Scheduler({
    backend: backend(nc, strategy, namespace),
  });
  let ran = 0;
  scheduler.every('job', '1h', () => {
    ran++;
  });
  await scheduler.start();
  try {
    const record = await scheduler.runNow('job');
    const history = await scheduler.history('job', 10);
    return { status: record.status, ran, history: history.length };
  } finally {
    await scheduler.stop();
  }
}

async function main() {
  const nc = await connect({ servers, name: 'anarchon-commonjs-consumer' });
  const report = { contract: {}, failures: [], jobs: {} };
  try {
    for (const strategy of ['msg-id', 'lease']) {
      const cases = backendContract((namespace) =>
        backend(nc, strategy, namespace),
      );
      report.contract[strategy] = cases.length;
      for (const { name, run } of cases) {
        try {
          await run();
        } catch (error) {
          report.failures.push(
            `${strategy}: ${name}: ${error?.message ?? error}`,
          );
        }
      }
      report.jobs[strategy] = await runJob(nc, strategy);
    }
    report.connectionOpen = !nc.isClosed();
  } finally {
    await nc.close();
  }
  console.log(JSON.stringify(report));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
