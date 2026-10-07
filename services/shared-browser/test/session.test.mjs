import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { WebSocket } from 'ws';
import { startBrowserService } from '../server.mjs';
const secret = 'test-secret-that-is-at-least-thirty-two-characters';
const origin = 'http://127.0.0.1';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, description) { for (let i = 0; i < 100; i++) { if (await fn()) return; await delay(50); } assert.fail(description); }
function ticket(session) { const expires = Math.floor(Date.now() / 1000) + 120; return { type: 'join', session, expires, signature: createHmac('sha256', secret).update(`${session}.${expires}`).digest('hex') }; }

test('two clients share clicks, navigation and history; reconnect keeps session; other sessions stay isolated', { timeout: 30000 }, async () => {
  const website = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(req.url === '/next' ? '<h1>Next page</h1>' : '<button onclick="this.textContent=Number(this.textContent)+1" style="position:absolute;left:0;top:0;width:200px;height:100px">0</button><input id="field" style="position:absolute;left:0;top:120px;width:200px;height:100px"><a href="/next" style="position:absolute;left:0;top:240px">Next</a><div style="height:3000px"></div>'); });
  await new Promise(resolve => website.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${website.address().port}`;
  const service = await startBrowserService({ port: 0, host: '127.0.0.1', secret, origins: [origin], idleMs: 1000 });
  const clients = [];
  async function connect(id) {
    const ws = new WebSocket(`ws://127.0.0.1:${service.server.address().port}/browser`, { origin });
    const messages = []; ws.on('message', data => messages.push(JSON.parse(data)));
    clients.push(ws); await new Promise(resolve => ws.once('open', resolve)); ws.send(JSON.stringify({ ...ticket(id), url }));
    await until(() => messages.some(m => m.type === 'ready'), 'client ready');
    return { ws, messages, send: value => ws.send(JSON.stringify(value)) };
  }
  try {
    const id = 'a'.repeat(64), otherId = 'b'.repeat(64);
    const first = await connect(id), second = await connect(id), other = await connect(otherId);
    const { page } = await service.sessions.get(id).ready;
    const otherPage = (await service.sessions.get(otherId).ready).page;
    first.send({ type: 'click', x: 50 / 1280, y: 50 / 800 });
    await until(async () => await page.locator('button').textContent() === '1', 'shared click');
    second.send({ type: 'click', x: 50 / 1280, y: 150 / 800 }); second.send({ type: 'text', text: 'Typed by the second participant' });
    await until(async () => await page.locator('input').inputValue() === 'Typed by the second participant', 'shared typing');
    assert.equal(await otherPage.locator('button').textContent(), '0');
    second.send({ type: 'scroll', x: .5, y: .5, dx: 0, dy: 500 });
    await until(async () => await page.evaluate(() => scrollY) > 0, 'shared scrolling');
    first.send({ type: 'navigate', url: url + '/next' });
    await until(() => second.messages.some(m => m.type === 'state' && m.url.endsWith('/next')), 'remote navigation state');
    await until(() => first.messages.some(m => m.type === 'frame') && second.messages.some(m => m.type === 'frame'), 'stream reaches both clients');
    const rejoined = await connect(id);
    assert.ok(rejoined.messages.some(m => m.type === 'state' && m.url.endsWith('/next')), 'rejoin must not restore the stale initial URL');
    second.send({ type: 'back' });
    await until(async () => await page.locator('button').count() === 1, 'shared back');
    const rejected = new WebSocket(`ws://127.0.0.1:${service.server.address().port}/browser`, { origin }); clients.push(rejected);
    await new Promise(resolve => rejected.once('open', resolve));
    const closed = new Promise(resolve => rejected.once('close', code => resolve(code)));
    rejected.send(JSON.stringify({ ...ticket(id), signature: '0'.repeat(64) })); assert.equal(await closed, 1008);
    for (const client of [first, second, rejoined]) client.ws.close();
    await until(() => !service.sessions.has(id), 'idle cleanup');
    assert.ok(service.sessions.has(otherId)); other.ws.close();
  } finally { for (const client of clients) client.terminate(); await service.close(); await new Promise(resolve => website.close(resolve)); }
});
