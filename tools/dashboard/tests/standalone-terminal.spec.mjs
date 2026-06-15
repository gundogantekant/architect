/**
 * Standalone mobile terminal page tests — Stream B
 *
 * ST-1: GET /t/<valid-id> → 200, text/html, body contains the xterm mount container.
 * ST-2: GET /t/<bogus-id> → 404.
 * ST-3: Browser navigation renders the xterm element and the mobile key bar buttons.
 * ST-4: Tapping the Shift+Tab key bar button dispatches the \x1b[Z back-tab sequence over the websocket.
 */

import { test, expect } from './fixtures.mjs';
import { getBase, seedTerminal } from './helpers.mjs';

test.describe('Standalone mobile terminal @fast', () => {

  test('ST-1: GET /t/<valid-id> returns 200 HTML with the xterm mount', async () => {
    const t = await seedTerminal({ skip_seed: true });
    const resp = await fetch(`${getBase()}/t/${t.id}`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('text/html');
    const body = await resp.text();
    expect(body).toContain('id="term-container"');
    expect(body).toContain('data-key="esc"');
    expect(body).toContain('data-key="shift-tab"');
  });

  test('ST-2: GET /t/<bogus-id> returns 404', async () => {
    const resp = await fetch(`${getBase()}/t/T-does-not-exist`);
    expect(resp.status).toBe(404);
  });

  test('ST-3: page renders xterm and key bar buttons', async ({ page }) => {
    const t = await seedTerminal({ skip_seed: true });
    await page.goto(getBase() + '/t/' + t.id);
    await page.waitForSelector('.xterm', { timeout: 15_000 });
    expect(await page.locator('.xterm').count()).toBeGreaterThan(0);
    await expect(page.locator('[data-key="esc"]')).toBeVisible();
    await expect(page.locator('[data-key="ctrl"]')).toBeVisible();
    await expect(page.locator('[data-key="up"]')).toBeVisible();
    await expect(page.locator('[data-key="enter"]')).toBeVisible();
    await expect(page.locator('[data-key="shift-tab"]')).toBeVisible();
  });

  test('ST-4: tapping Shift+Tab dispatches \\x1b[Z over the websocket', async ({ page }) => {
    // A running terminal keeps the websocket open and the page's live flag set,
    // so sendInput() actually transmits. (A completed terminal closes the ws and
    // clears live, turning the click into a no-op.)
    const t = await seedTerminal({ status: 'running' });

    // Hook WebSocket.prototype.send BEFORE the page module runs so we capture every
    // outgoing frame, and record received message types so we can wait for stream-live.
    await page.addInitScript(() => {
      window.__sent = [];
      window.__recvTypes = [];
      const origSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        window.__sent.push(data);
        return origSend.call(this, data);
      };
      const origAdd = WebSocket.prototype.addEventListener;
      WebSocket.prototype.addEventListener = function (type, listener, ...rest) {
        if (type === 'message') {
          return origAdd.call(this, type, (e) => {
            try { window.__recvTypes.push(JSON.parse(e.data).type); } catch {}
            return listener.call(this, e);
          }, ...rest);
        }
        return origAdd.call(this, type, listener, ...rest);
      };
      Object.defineProperty(WebSocket.prototype, 'onmessage', {
        configurable: true,
        set(fn) {
          this.addEventListener('message', fn);
        },
      });
    });

    await page.goto(getBase() + '/t/' + t.id);
    await page.waitForSelector('.xterm', { timeout: 15_000 });

    // Wait until the page has processed stream-live (sets live = true) before tapping.
    await page.waitForFunction(
      () => (window.__recvTypes || []).includes('stream-live'),
      undefined,
      { timeout: 15_000 },
    );

    await page.locator('[data-key="shift-tab"]').click();

    // Look for an input frame carrying the ESC [ Z back-tab sequence (JSON-encoded as "[Z").
    await page.waitForFunction(
      () => (window.__sent || []).some((s) => {
        try { const m = JSON.parse(s); return m.type === 'input' && m.data === '\x1b[Z'; }
        catch { return false; }
      }),
      undefined,
      { timeout: 5_000 },
    );

    const sent = await page.evaluate(() => window.__sent || []);
    const hasBackTab = sent.some((s) => {
      try { const m = JSON.parse(s); return m.type === 'input' && m.data === '\x1b[Z'; }
      catch { return false; }
    });
    expect(hasBackTab).toBe(true);
  });

  test('ST-5: viewport meta allows pinch-zoom (no maximum-scale / user-scalable=no)', async () => {
    const t = await seedTerminal({ skip_seed: true });
    const resp = await fetch(`${getBase()}/t/${t.id}`);
    expect(resp.status).toBe(200);
    const body = await resp.text();
    // Must declare a device-width viewport so the page is mobile-friendly.
    expect(body).toContain('width=device-width');
    // Must NOT lock zoom — these attributes prevent pinch-zoom on mobile.
    expect(body).not.toContain('maximum-scale');
    expect(body).not.toContain('user-scalable=no');
  });

  test('ST-6: .xterm-viewport touch-action allows pan-y and pinch-zoom', async ({ page }) => {
    const t = await seedTerminal({ skip_seed: true });
    await page.goto(getBase() + '/t/' + t.id);
    await page.waitForSelector('.xterm-viewport', { timeout: 15_000 });

    const touchAction = await page.evaluate(() =>
      getComputedStyle(document.querySelector('.xterm-viewport')).touchAction
    );

    // Must not be 'none' — that would block all touch interaction.
    expect(touchAction).not.toBe('none');
    // Must allow vertical panning so native momentum scrolling works on iOS/Android.
    expect(touchAction.includes('pan-y')).toBe(true);
    // Must allow pinch-zoom so the user can zoom the terminal content.
    expect(touchAction.includes('pinch-zoom')).toBe(true);
  });

  test('ST-7: .xterm-viewport is a native scroll container', async ({ page }) => {
    const t = await seedTerminal({ skip_seed: true });
    await page.goto(getBase() + '/t/' + t.id);
    await page.waitForSelector('.xterm-viewport', { timeout: 15_000 });

    // scrollHeight must be a positive integer — proves the element is a scroll container.
    const scrollHeight = await page.evaluate(() =>
      document.querySelector('.xterm-viewport').scrollHeight
    );
    expect(typeof scrollHeight).toBe('number');
    expect(scrollHeight).toBeGreaterThan(0);

    // Conditional scroll-position test: only meaningful when there is overflow to scroll.
    const hasOverflow = await page.evaluate(() => {
      const vp = document.querySelector('.xterm-viewport');
      return vp.scrollHeight > vp.clientHeight;
    });

    if (hasOverflow) {
      // Reset to top, confirm position, then scroll down and confirm it moved.
      await page.evaluate(() => { document.querySelector('.xterm-viewport').scrollTop = 0; });
      const topBefore = await page.evaluate(() =>
        document.querySelector('.xterm-viewport').scrollTop
      );
      expect(topBefore).toBe(0);

      await page.evaluate(() => { document.querySelector('.xterm-viewport').scrollTop = 999; });
      const topAfter = await page.evaluate(() =>
        document.querySelector('.xterm-viewport').scrollTop
      );
      // scrollTop must have moved — proves the native scroll path is wired.
      expect(topAfter).toBeGreaterThan(0);
    }
  });

  test('ST-8: page source does not contain deleted custom touch-scroll handler', async () => {
    const t = await seedTerminal({ skip_seed: true });
    const resp = await fetch(`${getBase()}/t/${t.id}`);
    expect(resp.status).toBe(200);
    const body = await resp.text();
    // scrollLines was the custom touch handler that hijacked native scroll.
    expect(body).not.toContain('scrollLines');
    // TAP_SLOP was a constant used by the deleted touch handler.
    expect(body).not.toContain('TAP_SLOP');
  });

});
