import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS } from '../../shared/settings.ts';
import { nextDailyTick, nextTickAfter } from '../schedule.ts';

const BERLIN = 'Europe/Berlin';

test('20:00 Berlin is 19:00 UTC in winter', () => {
  assert.equal(nextDailyTick(Date.UTC(2026, 0, 10, 12, 0), '20:00', BERLIN), Date.UTC(2026, 0, 10, 19, 0));
});

test('20:00 Berlin is 18:00 UTC in summer (CEST)', () => {
  assert.equal(nextDailyTick(Date.UTC(2026, 6, 10, 12, 0), '20:00', BERLIN), Date.UTC(2026, 6, 10, 18, 0));
});

test('after today\'s tick the next one is tomorrow; exactly at the tick also means tomorrow', () => {
  assert.equal(nextDailyTick(Date.UTC(2026, 0, 10, 19, 30), '20:00', BERLIN), Date.UTC(2026, 0, 11, 19, 0));
  assert.equal(nextDailyTick(Date.UTC(2026, 0, 10, 19, 0), '20:00', BERLIN), Date.UTC(2026, 0, 11, 19, 0));
});

test('DST switch days', () => {
  // Summer time starts 2026-03-29, ends 2026-10-25.
  assert.equal(nextDailyTick(Date.UTC(2026, 2, 29, 0, 30), '20:00', BERLIN), Date.UTC(2026, 2, 29, 18, 0));
  assert.equal(nextDailyTick(Date.UTC(2026, 2, 28, 19, 30), '20:00', BERLIN), Date.UTC(2026, 2, 29, 18, 0));
  assert.equal(nextDailyTick(Date.UTC(2026, 9, 25, 0, 30), '20:00', BERLIN), Date.UTC(2026, 9, 25, 19, 0));
  assert.equal(nextDailyTick(Date.UTC(2026, 9, 24, 18, 30), '20:00', BERLIN), Date.UTC(2026, 9, 25, 19, 0));
});

test('other zones and times', () => {
  assert.equal(nextDailyTick(Date.UTC(2026, 0, 10, 12, 0), '09:30', 'UTC'), Date.UTC(2026, 0, 11, 9, 30));
  assert.equal(nextDailyTick(Date.UTC(2026, 0, 10, 12, 0), '00:00', 'America/New_York'), Date.UTC(2026, 0, 11, 5, 0));
});

test('interval mode', () => {
  const s = { ...DEFAULT_SETTINGS, tickMode: 'interval' as const, tickIntervalSec: 30 };
  assert.equal(nextTickAfter(s, 1000), 31000);
});
