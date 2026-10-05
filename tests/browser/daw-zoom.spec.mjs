import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const peer = await readFile(new URL('./fixtures/peer.mjs', import.meta.url), 'utf8');

function longTrack() {
  const samples = 300 * 8000;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  return wav;
}

test('minimum DAW zoom fits a five-minute track and mobile expand matches dock size', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await context.route('**/node_modules/.vite/deps/peerjs.js*', route => route.fulfill({ contentType: 'application/javascript', body: peer }));
  await context.exposeBinding('sendTestPeerFrame', () => {});
  await context.addInitScript(() => {
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => Promise.reject(new Error('No test camera'));
  });
  const page = await context.newPage();
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Start Session', exact: true }).click();
    await page.getByRole('button', { name: 'Open menu', exact: true }).click();
    await page.locator('.widget-menu').getByRole('button', { name: 'DAW', exact: true }).click();
    const expand = page.getByRole('button', { name: 'Expand DAW', exact: true });
    await expect.poll(async () => Math.round((await expand.boundingBox()).width)).toBe(26);
    await expect.poll(async () => Math.round((await expand.boundingBox()).height)).toBe(26);
    await expand.click();
    const daw = page.locator('[data-daw-root]');
    await daw.locator('input[type="file"]').setInputFiles({ name: 'Five minutes.wav', mimeType: 'audio/wav', buffer: longTrack() });
    await expect(daw.locator('[data-track-row]')).toHaveCount(1);
    await expect(daw.getByText('1 tracks · 5:00.0', { exact: true })).toBeVisible();
    const timeline = daw.locator('[data-daw-timeline]');
    for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      if (await expand.isVisible()) {
        await page.getByRole('button', { name: 'Go to Make Music Together', exact: true }).click();
        await expand.click();
      }
      await daw.getByRole('slider', { name: 'Timeline zoom' }).fill('60');
      await expect.poll(() => timeline.evaluate(el => el.scrollWidth / el.clientWidth)).toBeGreaterThan(2);
      await timeline.evaluate(el => { el.scrollLeft = el.scrollWidth; });
      await daw.getByRole('slider', { name: 'Timeline zoom' }).fill('0');
      await expect.poll(() => timeline.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      await expect.poll(() => timeline.evaluate(el => el.scrollLeft)).toBe(0);
      await expect(daw.getByRole('slider', { name: 'Timeline zoom' })).toHaveAttribute('aria-valuetext', 'Fit entire project');
      await page.screenshot({ path: '/private/tmp/daw-fit-' + viewport.width + '.png' });
    }
    await page.getByRole('button', { name: 'Back to canvas', exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(() => timeline.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  } finally { await context.close(); }
});
