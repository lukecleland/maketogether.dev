import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const peer = await readFile(new URL('./fixtures/peer.mjs', import.meta.url), 'utf8');

test('captions use dock names, resize, expire, and stop on mute', async ({ page, context }) => {
  await context.route('**/node_modules/.vite/deps/peerjs.js*', route => route.fulfill({ contentType: 'application/javascript', body: peer }));
  await context.exposeBinding('sendTestPeerFrame', () => {});
  await context.addInitScript(() => {
    Object.defineProperty(MediaDevices.prototype, 'getUserMedia', { configurable: true, value: async () => {
      const stream = new MediaStream();
      const track = { kind: 'audio', enabled: false, readyState: 'live', stop() {}, addEventListener() {}, removeEventListener() {} };
      stream.getTracks = () => [track];
      stream.getAudioTracks = () => [track];
      return stream;
    } });
    window.SpeechRecognition = class {
      constructor() { window.recognition = this; }
      start() { this.running = true; }
      abort() { this.running = false; }
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start Session', exact: true }).click();
  await page.getByRole('button', { name: 'Subtitle settings', exact: true }).click();
  await page.getByRole('button', { name: 'Share my speech as captions', exact: true }).click();
  await expect(page.getByText('Captions paused — unmute your microphone to continue.')).toBeVisible();
  await page.getByRole('button', { name: 'Unmute microphone', exact: true }).click({ timeout: 5000 });
  await expect.poll(() => page.evaluate(() => window.recognition?.running)).toBe(true);
  const speak = text => page.evaluate(text => window.recognition.onresult({ resultIndex: 0, results: [{ 0: { transcript: text }, isFinal: false }] }), text);
  await speak('Hello together');
  const subtitles = page.getByRole('region', { name: 'Live subtitles', exact: true });
  await expect(subtitles).toHaveText('You: Hello together');
  await page.getByRole('button', { name: 'Rename You', exact: true }).click();
  await page.getByRole('textbox', { name: 'Rename dock item' }).fill('Alex');
  await page.getByRole('textbox', { name: 'Rename dock item' }).press('Enter');
  await expect(subtitles).toHaveText('Alex: Hello together');
  await page.getByRole('slider', { name: 'Subtitle text size' }).fill('32');
  await expect(subtitles).toHaveCSS('font-size', '32px');
  await expect(subtitles.locator('span')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
  await expect(subtitles).toHaveCSS('color', 'rgb(255, 255, 255)');
  await page.getByRole('checkbox', { name: 'Show subtitles' }).uncheck();
  await expect(subtitles).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Show subtitles' }).check();
  await page.getByRole('button', { name: 'Close subtitle settings', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Subtitle settings', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Subtitle settings', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Subtitle settings', exact: true }).click();
  await expect(page.getByRole('slider', { name: 'Subtitle text size' })).toHaveValue('32');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: 'Subtitle settings', exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await speak('Subtitles on a small screen');
  await page.screenshot({ path: '/private/tmp/maketogether-subtitles.png' });
  const bounds = await subtitles.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  await expect(subtitles).toHaveText('', { timeout: 9000 });
  await speak('Stop when muted');
  await page.getByRole('button', { name: 'Mute microphone', exact: true }).click();
  await expect(subtitles).toHaveText('');
  await expect.poll(() => page.evaluate(() => window.recognition.running)).toBe(false);
});

test('shared captions arrive on another device with the edited speaker name', async ({ browser }) => {
  const pages = [];
  const contexts = [];
  try {
    for (let i = 0; i < 2; i++) {
      const context = await browser.newContext(); contexts.push(context);
      await context.route('**/node_modules/.vite/deps/peerjs.js*', route => route.fulfill({ contentType: 'application/javascript', body: peer }));
      await context.exposeBinding('sendTestPeerFrame', async ({ page: source }, frame) => {
        await Promise.all(pages.filter(page => page !== source).map(page => page.evaluate(frame => window.receiveTestPeerFrame?.(frame), frame).catch(() => {})));
      });
      await context.addInitScript(() => { navigator.mediaDevices.getUserMedia = async () => { throw new Error('No media'); }; });
      pages.push(await context.newPage());
    }
    await pages[0].goto('/');
    await pages[0].getByRole('button', { name: 'Start Session', exact: true }).click();
    await pages[1].goto(pages[0].url());
    await expect(pages[1].getByText('Connected · 2/4', { exact: true })).toBeVisible();
    await pages[0].evaluate(() => {
      const peer = [...window.testPeers][0];
      for (const connection of peer.connections.values()) {
        for (const data of [{ type: 'participant-name', label: 'Sam' }, { type: 'subtitle', text: 'Shared speech' }]) {
          connection.send({ ...data, __meshSourcePeerId: peer.id, __meshMessageId: crypto.randomUUID() });
        }
      }
    });
    await expect(pages[1].getByRole('region', { name: 'Live subtitles' })).toHaveText('Sam: Shared speech');
  } finally { await Promise.all(contexts.map(context => context.close())); }
});
