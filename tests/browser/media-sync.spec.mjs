import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const peer = await readFile(new URL('./fixtures/peer.mjs', import.meta.url), 'utf8');

test('YouTube controls and DAW transport work across desktop and a blocked iPhone', async ({ browser }) => {
  const pages = [], contexts = [], errors = [];
  async function device(mobile = false) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, hasTouch: mobile, isMobile: mobile });
    contexts.push(context);
    await context.route('**/node_modules/.vite/deps/peerjs.js*', route => route.fulfill({ contentType: 'application/javascript', body: peer }));
    await context.exposeBinding('sendTestPeerFrame', async ({ page: source }, frame) => {
      await Promise.all(pages.filter(page => page !== source && !page.isClosed()).map(page => page.evaluate(frame => window.receiveTestPeerFrame?.(frame), frame).catch(() => {})));
    });
    await context.addInitScript(({ mobile }) => {
      if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => Promise.reject(new Error('No test devices'));
      window.blockPlayback = mobile;
      window.YT = { Player: class {
        constructor(_element, options) { this.options = options; this.state = -1; this.time = 0; this.at = Date.now(); window.testYoutube = this; setTimeout(() => options.events.onReady({ target: this }), 50); }
        emit(state) { setTimeout(() => this.options.events.onStateChange({ data: state, target: this }), 800); }
        getCurrentTime() { return this.time + (this.state === 1 ? (Date.now() - this.at) / 1000 : 0); }
        getDuration() { return 300; }
        getPlayerState() { return this.state; }
        getVideoData() { return { title: 'Test video' }; }
        loadVideoById(_id, time = 0) { this.time = time; this.state = 2; this.playVideo(); }
        cueVideoById(_id, time = 0) { this.time = time; this.state = 5; this.emit(5); }
        playVideo() { if (window.blockPlayback) { this.options.events.onAutoplayBlocked(); return; } this.time = this.getCurrentTime(); this.at = Date.now(); this.state = 1; this.emit(1); }
        pauseVideo() { this.time = this.getCurrentTime(); this.state = 2; this.emit(2); }
        seekTo(time) { this.time = time; this.at = Date.now(); }
        setVolume() {}
        destroy() {}
      } };
    }, { mobile });
    const page = await context.newPage(); pages.push(page); page.on('pageerror', error => errors.push(error.message)); return page;
  }
  try {
    const desktop = await device();
    await desktop.goto('http://127.0.0.1:5178');
    await desktop.getByRole('button', { name: 'Start Session', exact: true }).click();
    await desktop.getByTitle('Add a YouTube player', { exact: true }).click();
    await desktop.getByPlaceholder('Paste a YouTube URL…').fill('https://www.youtube.com/watch?v=M7lc1UVf-VE');
    await desktop.getByPlaceholder('Paste a YouTube URL…').press('Enter');
    const phone = await device(true); await phone.goto(desktop.url());
    await expect(phone.getByRole('button', { name: 'Enable playback on this device' })).toBeVisible();
    await phone.getByRole('button', { name: 'Pause YouTube for everyone' }).click();
    await expect(desktop.getByRole('button', { name: 'Play YouTube for everyone' })).toBeVisible();
    await phone.getByRole('slider', { name: 'YouTube playback position' }).fill('65');
    await expect.poll(() => desktop.evaluate(() => window.testYoutube.getCurrentTime())).toBe(65);
    await phone.getByRole('button', { name: 'Play YouTube for everyone' }).click();
    await expect(desktop.getByRole('button', { name: 'Pause YouTube for everyone' })).toBeVisible();
    await phone.evaluate(() => { window.blockPlayback = false; });
    await phone.getByRole('button', { name: 'Enable playback on this device' }).click();
    await expect.poll(() => phone.evaluate(() => window.testYoutube.getPlayerState())).toBe(1);
    await expect(phone.getByRole('button', { name: 'Enable playback on this device' })).toHaveCount(0);
    // Delayed API callbacks must not generate a pause or rewind on either device.
    await expect.poll(async () => (await phone.evaluate(() => window.testYoutube.getCurrentTime())) > 66).toBe(true);
    await expect(desktop.getByRole('button', { name: 'Pause YouTube for everyone' })).toBeVisible();
    await phone.getByRole('button', { name: 'Pause YouTube for everyone' }).click();
    await expect(desktop.getByRole('button', { name: 'Play YouTube for everyone' })).toBeVisible();
    const tablet = await device(); await tablet.goto(desktop.url());
    await expect(tablet.getByRole('button', { name: 'Play YouTube for everyone' })).toBeVisible();
    await expect.poll(() => tablet.evaluate(() => window.testYoutube.getCurrentTime())).toBeGreaterThan(65);

    await desktop.getByTitle('Add a shared multitrack DAW', { exact: true }).click();
    await phone.getByRole('button', { name: 'Go to Make Music Together', exact: true }).click();
    const daw = page => page.locator('[data-daw-root]');
    await daw(phone).getByRole('button', { name: 'Play', exact: true }).click();
    await expect(daw(desktop).getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    await expect(daw(tablet).getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    await daw(desktop).getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(daw(phone).getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    await daw(phone).getByRole('button', { name: 'Forward', exact: true }).click();
    await daw(phone).getByRole('spinbutton', { name: 'Tempo' }).fill('90');
    await expect(daw(desktop).getByRole('spinbutton', { name: 'Tempo' })).toHaveValue('90');
    await expect(daw(tablet).getByRole('spinbutton', { name: 'Tempo' })).toHaveValue('90');
    expect(errors).toEqual([]);
  } finally { await Promise.all(contexts.map(context => context.close().catch(() => {}))); }
});
