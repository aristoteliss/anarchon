/* Copyright (C) 2026-present Aristotelis — see repository license. */

import assert from 'node:assert/strict';
import { test } from 'vitest';

import { fromLibsql, type LibsqlClientLike } from '../../src';
import { sleep } from '../support';

function held(protocol?: string): {
  client: LibsqlClientLike;
  open: () => void;
} {
  let open = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const client: LibsqlClientLike = {
    ...(protocol === undefined ? {} : { protocol }),
    execute: async () => {
      await gate;
      return { rows: [] };
    },
    transaction: () => Promise.reject(new Error('not used')),
  };
  return { client, open };
}

async function runsAlongside(
  first: string | undefined,
  second: string | undefined,
): Promise<boolean> {
  const slow = held(first);
  const fast = held(second);
  fast.open();
  const pending = fromLibsql(slow.client).all('SELECT 1', []);
  const next = fromLibsql(fast.client).all('SELECT 1', []);
  const ran = await Promise.race([
    next.then(() => true),
    sleep(100).then(() => false),
  ]);
  slow.open();
  await Promise.all([pending, next]);
  return ran;
}

test('a libSQL server client does not wait for statements of other clients in the process', async () => {
  assert.equal(await runsAlongside('http', 'ws'), true, 'two remote clients');
  assert.equal(
    await runsAlongside('file', 'http'),
    true,
    'a remote client next to a local file',
  );
  assert.equal(
    await runsAlongside('ws', 'file'),
    true,
    'a local file next to a remote client',
  );
});

test('libSQL clients on a local file, or of an unknown kind, take turns with every SQLite statement in the process', async () => {
  assert.equal(await runsAlongside('file', 'file'), false, 'two local files');
  assert.equal(
    await runsAlongside('file', undefined),
    false,
    'a client that does not say what it is',
  );
});
