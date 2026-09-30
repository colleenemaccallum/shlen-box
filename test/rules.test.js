import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maxPauseEnd, resolvePauseEnd, nextAt } from '../server/rules.js';

const R = { morning_time: '09:00', tonight_time: '20:00' };
const at = (d, h, m = 0) => { const x = new Date(2026, 9, d, h, m, 0, 0); return x; };

test('pause started in the evening can last until 9 AM next day', () => {
  assert.deepEqual(maxPauseEnd(at(1, 21), '09:00'), at(2, 9));
});

test('pause started at 1 AM can last until 9 AM the same morning', () => {
  assert.deepEqual(maxPauseEnd(at(2, 1), '09:00'), at(2, 9));
});

test('pause started at 6 AM must allow at least 4 hours, so it can run to 9 AM tomorrow', () => {
  assert.deepEqual(maxPauseEnd(at(2, 6), '09:00'), at(3, 9));
});

test('pause started at exactly 5 AM can end at 9 AM today (exactly 4 hours)', () => {
  assert.deepEqual(maxPauseEnd(at(2, 5), '09:00'), at(2, 9));
});

test('a pause longer than the maximum is refused', () => {
  const r = resolvePauseEnd({ at: at(3, 10).toISOString() }, at(1, 21), R);
  assert.ok(r.error);
});

test('minutes, tonight and morning resolve correctly', () => {
  assert.deepEqual(resolvePauseEnd({ minutes: 30 }, at(1, 18), R).end, at(1, 18, 30));
  assert.deepEqual(resolvePauseEnd({ until: 'tonight' }, at(1, 18), R).end, at(1, 20));
  assert.deepEqual(resolvePauseEnd({ until: 'morning' }, at(1, 18), R).end, at(2, 9));
});

test('"until tonight" after 8 PM means tomorrow night, which is past the maximum, so it is refused', () => {
  assert.deepEqual(nextAt(at(1, 21), '20:00'), at(2, 20));
  assert.ok(resolvePauseEnd({ until: 'tonight' }, at(1, 21), R).error);
});

test('a pause must end in the future and needs a duration', () => {
  assert.ok(resolvePauseEnd({ minutes: 0 }, at(1, 18), R).error);
  assert.ok(resolvePauseEnd({}, at(1, 18), R).error);
});
