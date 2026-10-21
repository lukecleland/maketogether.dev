import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const peer = await readFile(new URL('./fixtures/peer.mjs', import.meta.url), 'utf8');

test('conflicting saved rooms survive joining and reload, and can be restored to everyone', async ({ browser }) => {
  const pages = [], contexts = [];
  async function device() {
    const context = await browser.newContext(); contexts.push(context);
    await context.route('**/node_modules/.vite/deps/peerjs.js*', route => route.fulfill({ contentType: 'application/javascript', body: peer }));
    await context.exposeBinding('sendTestPeerFrame', async ({ page: source }, frame) => {
      await Promise.all(pages.filter(page => page !== source && !page.isClosed()).map(page => page.evaluate(frame => window.receiveTestPeerFrame?.(frame), frame).catch(() => {})));
    });
    await context.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async () => { throw new Error('No devices'); };
    });
    const page = await context.newPage(); pages.push(page); return page;
  }
  try {
    const host = await device();
    await host.goto('/');
    await host.getByRole('button', { name: 'Start Session', exact: true }).click();
    await host.getByTitle('Add a sticky note', { exact: true }).click();
    await host.getByRole('textbox', { name: 'Note text', exact: true }).fill('Older host copy');
    await expect.poll(() => host.evaluate(() => Object.keys(localStorage).find(key => key.startsWith('watchtogether:room:')))).toBeTruthy();
    await expect.poll(() => host.evaluate(() => Object.values(localStorage).some(value => value.includes('Older host copy')))).toBe(true);
    const [key, snapshot] = await host.evaluate(() => {
      const key = Object.keys(localStorage).find(key => key.startsWith('watchtogether:room:'));
      return [key, JSON.parse(localStorage.getItem(key))];
    });
    const guest = await device();
    await guest.goto('/');
    await guest.evaluate(({ key, snapshot }) => {
      snapshot.panels[0].note.text = 'Newer saved work';
      localStorage.setItem(key, JSON.stringify(snapshot));
    }, { key, snapshot });
    await guest.goto(host.url());
    await expect(guest.getByRole('button', { name: 'Restore saved room for everyone' })).toBeVisible();
    await expect(guest.getByRole('textbox', { name: 'Note text', exact: true })).toHaveValue('Older host copy');
    await expect(guest.getByRole('button', { name: 'Start camera', exact: true })).toBeVisible();
    await expect(host.getByText('Camera unavailable', { exact: true })).toBeVisible();
    await guest.evaluate(() => { for (const peer of window.testPeers) peer.destroy(); });
    await guest.reload();
    await expect(guest.getByRole('button', { name: 'Restore saved room for everyone' })).toBeVisible();
    await expect(guest.getByText('Connected · 2/4', { exact: true })).toBeVisible();
    await guest.getByRole('button', { name: 'Restore saved room for everyone' }).click();
    await expect(host.getByRole('textbox', { name: 'Note text', exact: true })).toHaveValue('Newer saved work');
    await expect(guest.getByRole('textbox', { name: 'Note text', exact: true })).toHaveValue('Newer saved work');
    expect(await guest.evaluate(key => localStorage.getItem(`${key}:recovery`), key)).toBeNull();
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('pagehide flushes the last edit before the save debounce expires', async ({ page }) => {
  await page.addInitScript(() => { navigator.mediaDevices.getUserMedia = async () => { throw new Error('No devices'); }; });
  await page.route('**/node_modules/.vite/deps/peerjs.js*', route => route.fulfill({ contentType: 'application/javascript', body: peer }));
  await page.exposeFunction('sendTestPeerFrame', () => {});
  await page.goto('/');
  await page.getByRole('button', { name: 'Start Session', exact: true }).click();
  await page.getByTitle('Add a sticky note', { exact: true }).click();
  await page.getByRole('textbox', { name: 'Note text', exact: true }).fill('Last edit before leaving');
  const stored = await page.evaluate(() => {
    window.dispatchEvent(new Event('pagehide'));
    const key = Object.keys(localStorage).find(key => key.startsWith('watchtogether:room:'));
    return JSON.parse(localStorage.getItem(key));
  });
  expect(stored.panels[0].note.text).toBe('Last edit before leaving');
});

test('camera-only participants can restart after stopping their last track', async ({ page }) => {
  await page.route('**/node_modules/.vite/deps/peerjs.js*', route => route.fulfill({ contentType: 'application/javascript', body: peer }));
  await page.exposeFunction('sendTestPeerFrame', () => {});
  await page.goto('/');
  await page.evaluate(() => {
    Object.getPrototypeOf(navigator.mediaDevices).getUserMedia = async constraints => {
      if (constraints.audio) throw new Error('Microphone unavailable');
      const canvas = document.createElement('canvas');
      (window.cameraCanvases ??= []).push(canvas);
      canvas.width = canvas.height = 32;
      canvas.getContext('2d').fillRect(0, 0, 32, 32);
      return canvas.captureStream(1);
    };
  });
  await page.getByRole('button', { name: 'Start Session', exact: true }).click();
  await page.getByRole('button', { name: 'Start camera', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop camera', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop camera', exact: true }).click();
  await page.getByRole('button', { name: 'Start camera', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop camera', exact: true })).toBeVisible();
  expect(await page.locator('video').evaluate(video => video.srcObject.getVideoTracks()[0].readyState)).toBe('live');
});
