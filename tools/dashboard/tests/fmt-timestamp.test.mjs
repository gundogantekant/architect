/**
 * Unit tests for fmtTimestampParts (W-1193)
 *
 * Run with: TZ=UTC node --test tests/fmt-timestamp.test.mjs
 *
 * fmtTimestampParts has no DOM dependencies and is safe to test in Node.js.
 * fmtTimestamp is NOT tested here (it calls esc() which needs a DOM).
 */

// Set timezone before any Date operations. Dynamic import below ensures
// fmtTimestampParts is evaluated after TZ is applied.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { fmtTimestampParts } = await import(join(ROOT, 'tools/dashboard/js/utils.mjs'));

// FT-1: 24-hour formatting — must not produce AM/PM output
test('FT-1: fmtTimestampParts formats time in 24-hour (no AM/PM)', () => {
  const { time } = fmtTimestampParts('2026-05-21T00:30:00Z');
  assert.ok(!time.includes('AM') && !time.includes('PM'), `Expected 24h format, got: ${time}`);
});

// FT-2: Midnight boundary — must produce 00:30, not 12:30
test('FT-2: fmtTimestampParts("2026-05-21T00:30:00Z").time equals "00:30" in UTC', () => {
  const { time } = fmtTimestampParts('2026-05-21T00:30:00Z');
  assert.strictEqual(time, '00:30');
});

// FT-3: Returns { date, time } object with string values
test('FT-3: fmtTimestampParts returns object with date and time strings', () => {
  const result = fmtTimestampParts('2026-05-20T08:05:00Z');
  assert.strictEqual(typeof result, 'object');
  assert.strictEqual(typeof result.date, 'string');
  assert.strictEqual(typeof result.time, 'string');
  assert.ok(result.date.length > 0, 'date must be non-empty');
  assert.ok(result.time.length > 0, 'time must be non-empty');
});

// FT-4: No HTML in output — pure string values only
test('FT-4: fmtTimestampParts returns no HTML markup', () => {
  const { date, time } = fmtTimestampParts('2026-05-21T12:00:00Z');
  assert.ok(!date.includes('<') && !date.includes('>'), `date must have no HTML, got: ${date}`);
  assert.ok(!time.includes('<') && !time.includes('>'), `time must have no HTML, got: ${time}`);
});

// FT-5: Noon boundary — 12:00 in 24h format
test('FT-5: noon is "12:00" in 24-hour format', () => {
  const { time } = fmtTimestampParts('2026-05-21T12:00:00Z');
  assert.strictEqual(time, '12:00');
});

// FT-6: Late evening — 22:45
test('FT-6: late evening "2026-05-20T22:45:00Z" produces time "22:45" in UTC', () => {
  const { time } = fmtTimestampParts('2026-05-20T22:45:00Z');
  assert.strictEqual(time, '22:45');
});

// FT-7: DST boundary — US spring-forward 2026-03-08T07:00:00Z
// In UTC this is 07:00 regardless of any DST transitions
test('FT-7: DST boundary — UTC time is always 07:00 regardless of DST', () => {
  const { time } = fmtTimestampParts('2026-03-08T07:00:00Z');
  assert.strictEqual(time, '07:00');
});

// FT-8: UTC date for "2026-05-21T00:30:00Z" must be 2026 (not tomorrow)
test('FT-8: UTC date for 2026-05-21T00:30:00Z includes year 2026', () => {
  const { date } = fmtTimestampParts('2026-05-21T00:30:00Z');
  assert.ok(date.includes('2026'), `Expected date to include 2026, got: ${date}`);
});
