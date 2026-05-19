import { test, expect } from './fixtures.mjs';
import { getBase } from './helpers.mjs';

test.describe('Cost anomaly alerts @fast', () => {
  test('CA-1: GET /api/dispatch/active includes session_log field', async () => {
    const base = getBase();
    const res = await fetch(`${base}/api/dispatch/active`);
    expect(res.ok).toBeTruthy();
    const dispatches = await res.json();
    // session_log is present on each dispatch (may be empty array)
    dispatches.forEach(d => {
      expect(Array.isArray(d.session_log)).toBeTruthy();
    });
  });
});
