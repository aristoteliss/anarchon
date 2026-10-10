/**
 * For every backend: starts three separate processes with the same jobs and checks that every
 * scheduled run happened exactly once, that the work was spread, and that history names the
 * instance that ran each run.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, test } from 'vitest';

import { Scheduler } from '../../../src';
import { availableSpecs, makeBackend, type Spec, uniqueId } from '../../support';

interface Event {
  type: string;
  job?: string;
  slot?: number;
  instanceId?: string;
  error?: string;
}

const FIXTURE = join(__dirname, 'instance.ts');
const RUN_MS = 8_000;
const JOBS = ['every2s', 'cron3s', 'failing'];

function startInstance(env: Record<string, string>): Promise<{ events: Event[]; code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', FIXTURE], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => {
      const events = out
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line) as Event);
      resolve({ events, code, stderr });
    });
  });
}

async function runCluster(spec: Spec) {
  const ids = ['A', 'B', 'C'];
  const runs = await Promise.all(ids.map((id) => startInstance({ SPEC: JSON.stringify(spec), INSTANCE_ID: id, RUN_MS: String(RUN_MS) })));
  for (const [i, r] of runs.entries()) assert.equal(r.code, 0, `instance ${ids[i]} exited with ${r.code}: ${r.stderr}`);
  const events = runs.flatMap((r, i) => r.events.map((e) => ({ ...e, instanceId: e.instanceId ?? ids[i] })));
  assert.deepEqual(
    events.filter((e) => e.type === 'error' || e.type === 'fatal'),
    [],
    'no backend errors',
  );

  const starts = events.filter((e) => e.type === 'start');
  for (const job of JOBS) {
    const bySlot = new Map<number, string[]>();
    for (const e of starts.filter((s) => s.job === job)) bySlot.set(e.slot!, [...(bySlot.get(e.slot!) ?? []), e.instanceId!]);
    for (const [slot, runners] of bySlot) {
      assert.equal(runners.length, 1, `${job} @ ${new Date(slot).toISOString()} ran ${runners.length} times: ${runners}`);
    }
    assert.ok(bySlot.size >= 2, `${job} should have run at least twice in ${RUN_MS} ms, ran ${bySlot.size}`);
    const period = job === 'cron3s' ? 3_000 : 2_000;
    for (const slot of bySlot.keys()) assert.equal(slot % period, 0, `${job} slot on its grid`);
  }
  const winners = new Set(starts.map((s) => s.instanceId));
  assert.ok(winners.size >= 2, `work should be spread, all ${starts.length} runs went to ${[...winners]}`);

  // History, read by a fourth "API" instance that has no jobs of its own.
  const reader = new Scheduler({ backend: makeBackend(spec) });
  try {
    for (const job of JOBS) {
      const history = await reader.history(job, 100);
      const ran = starts.filter((s) => s.job === job);
      assert.equal(history.length, ran.length, `${job}: one history record per run`);
      for (const record of history) {
        const start = ran.find((s) => s.slot === record.slot);
        assert.ok(start, `${job}: history slot ${record.slot} matches a run`);
        assert.equal(record.instanceId, start.instanceId, `${job}: history names the instance that ran it`);
        assert.equal(record.status, job === 'failing' ? 'failed' : 'success');
        assert.ok(record.finishedAt && record.finishedAt >= record.startedAt);
        if (job === 'failing') assert.equal(record.error, 'Error: boom');
      }
    }
  } finally {
    await reader.stop();
  }
  return { runs: starts.length, perInstance: Object.fromEntries(ids.map((id) => [id, starts.filter((s) => s.instanceId === id).length])) };
}

// Each backend's cluster has its own keys or tables, so the backends run side by side.
describe.concurrent('3 instances, same jobs, every backend', async () => {
  for (const { label, spec, skip } of await availableSpecs()) {
    test.skipIf(skip)(label, async (t) => {
      const summary = await runCluster({ ...spec, id: uniqueId('cl') });
      await t.annotate(`${summary.runs} runs, per instance ${JSON.stringify(summary.perInstance)}`);
    });
  }
});
