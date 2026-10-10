import assert from 'node:assert/strict';
import { test } from 'vitest';

import { cronSchedule, everySchedule, formatDuration, parseDuration } from '../../src/schedule';

const at = (h: number, m: number, s = 0, ms = 0) => Date.UTC(2026, 9, 9, h, m, s, ms);

test('parseDuration accepts ms and duration strings', () => {
  assert.equal(parseDuration(10_000), 10_000);
  assert.equal(parseDuration('10000'), 10_000);
  assert.equal(parseDuration('10s'), 10_000);
  assert.equal(parseDuration('10m'), 600_000);
  assert.equal(parseDuration('35m'), 2_100_000);
  assert.equal(parseDuration('1h30m'), 5_400_000);
  assert.equal(parseDuration('1h 30m'), 5_400_000);
  assert.equal(parseDuration('1.5h'), 5_400_000);
  assert.equal(parseDuration('2d'), 172_800_000);
  assert.equal(parseDuration('500ms'), 500);
  for (const bad of ['', 'abc', '10x', '-5s', '10 s m', 0, -1, 1.5]) {
    assert.throws(() => parseDuration(bad), RangeError, `should reject ${JSON.stringify(bad)}`);
  }
});

test('formatDuration', () => {
  assert.equal(formatDuration(5_400_000), '1h30m');
  assert.equal(formatDuration(10_000), '10s');
  assert.equal(formatDuration(1_500), '1s500ms');
});

test('every(): every instance computes the same next run, whenever it started', () => {
  const tenSeconds = everySchedule(10_000);
  assert.equal(tenSeconds.next(at(6, 0, 3)), at(6, 0, 10));
  assert.equal(tenSeconds.next(at(6, 0, 7)), at(6, 0, 10));
  assert.equal(tenSeconds.next(at(6, 0, 9, 999)), at(6, 0, 10));
  assert.equal(tenSeconds.next(at(6, 0, 10)), at(6, 0, 20), 'strictly after');

  const thirtyFive = everySchedule(35 * 60_000);
  const next = thirtyFive.next(Date.now())!;
  assert.equal(next % (35 * 60_000), 0, 'on the shared grid');
  assert.ok(next > Date.now());

  const withOffset = everySchedule(60_000, 15_000);
  assert.equal(withOffset.next(at(6, 0, 0)), at(6, 0, 15));
  assert.equal(withOffset.next(at(6, 0, 15)), at(6, 1, 15));
});

test('cron(): next run is strictly after, with seconds and time zones', () => {
  const everyTenSeconds = cronSchedule('*/10 * * * * *');
  assert.equal(everyTenSeconds.next(at(6, 0, 0)), at(6, 0, 10));
  assert.equal(everyTenSeconds.next(at(6, 0, 0) - 1), at(6, 0, 0));
  assert.equal(everyTenSeconds.minGapMs, 10_000);

  // 06:18 in Athens (UTC+3 in October) -> next even hour in Athens is 08:00 = 05:00 UTC
  const twoHoursAthens = cronSchedule('0 */2 * * *', 'Europe/Athens');
  assert.equal(new Date(twoHoursAthens.next(at(3, 18))!).toISOString(), '2026-10-09T05:00:00.000Z');

  assert.throws(() => cronSchedule('not a cron'));
  assert.throws(() => cronSchedule('0 * * * *', 'Not/AZone'));
});
