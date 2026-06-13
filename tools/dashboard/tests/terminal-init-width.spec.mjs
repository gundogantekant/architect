import { test, expect } from './fixtures.mjs';
import { seedTerminal } from './helpers.mjs';

test.describe('Terminal init width @fast', () => {
  test('TIW-1: terminal-fit-stable cols match terminal-ready cols (no re-fit flash)', async ({ page }) => {
    await page.goto('/');

    const colsPromise = page.evaluate(() => new Promise((resolve) => {
      const results = {};
      const check = () => {
        if (results.ready !== undefined && results.stable !== undefined) {
          resolve(results);
        }
      };
      window.addEventListener('terminal-ready', (e) => {
        results.ready = e.detail.cols;
        check();
      }, { once: true });
      window.addEventListener('terminal-fit-stable', (e) => {
        results.stable = e.detail.cols;
        check();
      }, { once: true });
    }));

    await seedTerminal({ skip_seed: true });

    const cols = await colsPromise;
    expect(typeof cols.ready).toBe('number');
    expect(typeof cols.stable).toBe('number');
    expect(cols.ready).toBe(cols.stable);
  });
});
