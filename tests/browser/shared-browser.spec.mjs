import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash, createHmac } from 'node:crypto';
import http from 'node:http';
import { startBrowserService } from '../../services/shared-browser/server.mjs';
const peer = await readFile(new URL('./fixtures/peer.mjs', import.meta.url), 'utf8');

test('desktop and iPhone control one browser, including mobile typing and reconnection', async ({ browser }) => {
  const secret = 'browser-integration-test-secret-over-thirty-two-characters';
  const website = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<button style="position:absolute;left:0;top:0;width:200px;height:100px" onclick="this.textContent=Number(this.textContent)+1">0</button><input style="position:absolute;left:0;top:120px;width:200px;height:100px" id="entry"><div style="height:3000px"></div>'); });
  await new Promise(resolve => website.listen(0, '127.0.0.1', resolve));
  const service = await startBrowserService({ port: 0, host: '127.0.0.1', secret, origins: ['http://127.0.0.1:5178'] });
  const contexts = [], pages = [];
  let session;
  async function device(mobile) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, hasTouch: mobile, isMobile: mobile }); contexts.push(context);
    await context.route('**/node_modules/.vite/deps/peerjs.js*', route => route.fulfill({ contentType: 'application/javascript', body: peer }));
    await context.exposeBinding('sendTestPeerFrame', async ({ page: source }, message) => {
      await Promise.all(pages.filter(page => page !== source && !page.isClosed()).map(page => page.evaluate(message => window.receiveTestPeerFrame?.(message), message).catch(() => {})));
    });
    await context.addInitScript(() => { if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => Promise.reject(new Error('No test camera')); });
    await context.route('**/.netlify/functions/browser-session', route => {
      const { room, panel } = route.request().postDataJSON(); session = createHash('sha256').update(`${room.toLowerCase()}:${panel}`).digest('hex');
      const expires = Math.floor(Date.now() / 1000) + 120;
      return route.fulfill({ json: { session, expires, signature: createHmac('sha256', secret).update(`${session}.${expires}`).digest('hex'), endpoint: `ws://127.0.0.1:${service.server.address().port}/browser` } });
    });
    const page = await context.newPage(); pages.push(page); return page;
  }
  try {
    const desktop = await device(false); await desktop.goto('/');
    await desktop.getByRole('button', { name: 'Start Session', exact: true }).click();
    await desktop.getByTitle('Add a mini browser', { exact: true }).click();
    const desktopPanel = desktop.locator('[data-browser-root]');
    await expect(desktopPanel.getByRole('status')).toHaveText('Shared browser · everyone can control');
    const url = `http://127.0.0.1:${website.address().port}/`;
    await desktopPanel.getByRole('textbox', { name: 'Browser URL', exact: true }).fill(url);
    await desktopPanel.getByRole('button', { name: 'Go', exact: true }).click();
    const phone = await device(true); await phone.goto(desktop.url());
    const phonePanel = phone.locator('[data-browser-root]');
    await expect(phonePanel.getByRole('status')).toHaveText('Shared browser · everyone can control');
    await phone.getByRole('button', { name: 'Expand Browser', exact: true }).click();
    await expect(phonePanel.getByRole('textbox', { name: 'Browser URL', exact: true })).toHaveValue(url);
    const remotePage = (await service.sessions.get(session).ready).page;
    const image = phonePanel.getByAltText('Shared browser page');
    await expect(image).toBeVisible();
    async function tap(x, y) { const r = await image.boundingBox(); await phone.touchscreen.tap(r.x + r.width * x / 1280, r.y + r.height * y / 800); }
    await tap(50, 50);
    await expect.poll(() => remotePage.locator('button').textContent()).toBe('1');
    await tap(50, 150);
    await phonePanel.getByRole('button', { name: 'Type in shared browser' }).click();
    await phonePanel.getByRole('textbox', { name: 'Text for shared browser' }).fill('Hello from iPhone');
    await phonePanel.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => remotePage.locator('input').inputValue()).toBe('Hello from iPhone');
    const desktopImage = desktopPanel.getByAltText('Shared browser page');
    const rect = await desktopImage.boundingBox();
    await desktopImage.click({ position: { x: rect.width * 50 / 1280, y: rect.height * 50 / 800 } });
    await expect.poll(() => remotePage.locator('button').textContent()).toBe('2');
    await phone.screenshot({ path: '/private/tmp/shared-browser-iphone.png' });
    for (const ws of service.sessions.get(session).clients) ws.close(1012, 'Test reconnect');
    await phonePanel.getByRole('button', { name: 'Reconnect browser', exact: true }).click();
    await expect(phonePanel.getByRole('status')).toHaveText('Shared browser · everyone can control');
    await expect.poll(() => remotePage.locator('button').textContent()).toBe('2');
    expect(service.sessions.size).toBe(1);
  } finally { await Promise.all(contexts.map(context => context.close())); await service.close(); await new Promise(resolve => website.close(resolve)); }
});
