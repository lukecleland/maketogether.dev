import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const peer = await readFile(new URL('./fixtures/peer.mjs', import.meta.url), 'utf8');

test('mobile controls remain within the visible viewport in portrait, landscape and above a keyboard', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true });
  await context.route('**/node_modules/.vite/deps/peerjs.js*', route => route.fulfill({ contentType: 'application/javascript', body: peer }));
  await context.exposeBinding('sendTestPeerFrame', () => {});
  await context.addInitScript(() => {
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => Promise.reject(new Error('No test camera'));
  });
  const page = await context.newPage();
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Start Session', exact: true }).click();
    await page.getByRole('button', { name: 'Add widget', exact: true }).click();
    await page.locator('.widget-menu').getByRole('button', { name: 'DAW', exact: true }).click();

    async function within(selector, bounds) {
      await expect.poll(async () => page.locator(selector).evaluateAll((nodes, b) => nodes.length > 0 && nodes.every(node => {
        const r = node.getBoundingClientRect();
        return r.left >= b.left - 1 && r.top >= b.top - 1 && r.right <= b.left + b.width + 1 && r.bottom <= b.top + b.height + 1;
      }), bounds), { message: selector + ' fits visible viewport' }).toBe(true);
    }
    for (const viewport of [{ width: 320, height: 568 }, { width: 568, height: 320 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      const bounds = { ...viewport, left: 0, top: 0 };
      for (const selector of ['.session-header', '.session-header button:visible', '.whiteboard-tools', '[data-dock]', '.canvas-system-controls']) await within(selector, bounds);
      await page.getByRole('button', { name: 'Show drawing tools' }).click();
      await within('.whiteboard-tools', bounds);
      await page.getByRole('button', { name: 'Hide drawing tools' }).click();
      await page.getByRole('button', { name: 'Add widget', exact: true }).click();
      await within('.widget-menu', bounds);
      await page.getByRole('button', { name: 'Add widget', exact: true }).click();
    }
    // WebKit automation has no software keyboard: emulate its visual viewport events,
    // keeping the layout viewport unchanged, including Safari's focus-induced pan.
    await page.setViewportSize({ width: 390, height: 844 });
    const bounds = { left: 0, top: 100, width: 390, height: 340 };
    await page.evaluate(bounds => {
      for (const [key, value] of Object.entries({ offsetLeft: bounds.left, offsetTop: bounds.top, width: bounds.width, height: bounds.height, scale: 1 })) {
        Object.defineProperty(window.visualViewport, key, { configurable: true, value });
      }
      window.visualViewport.dispatchEvent(new Event('resize'));
      window.visualViewport.dispatchEvent(new Event('scroll'));
    }, bounds);
    for (const selector of ['.session-header', '.whiteboard-tools', '[data-dock]', '.canvas-system-controls']) await within(selector, bounds);
    await page.getByRole('button', { name: 'Add widget', exact: true }).click();
    await within('.widget-menu', bounds);
    await page.getByRole('button', { name: 'Add widget', exact: true }).click();
    await page.getByRole('button', { name: 'Go to Make Music Together', exact: true }).click();
    await page.getByRole('button', { name: 'Expand DAW', exact: true }).click();
    await within('[data-panel-expanded]', bounds);
    await within('.landscape-expand', bounds);
    await page.locator('[aria-label="DAW menus"]').getByRole('button', { name: 'File', exact: true }).click();
    await within('[role="menu"]', bounds);
    await page.keyboard.press('Escape');
    await page.screenshot({ path: '/private/tmp/maketogether-mobile-bounds.png' });
  } finally { await context.close(); }
});
