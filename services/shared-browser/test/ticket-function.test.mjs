import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../../../netlify/functions/browser-session.mjs';
import { validTicket } from '../protocol.mjs';
test('Netlify issues compatible short-lived session tickets without exposing its signing key', async () => {
  const oldKey = process.env.BROWSER_SIGNING_KEY, oldUrl = process.env.BROWSER_SERVICE_URL;
  try {
    delete process.env.BROWSER_SIGNING_KEY; delete process.env.BROWSER_SERVICE_URL;
    const request = body => new Request('https://maketogether.dev/.netlify/functions/browser-session', { method: 'POST', body: JSON.stringify(body) });
    assert.equal((await handler(request({}))).status, 503);
    process.env.BROWSER_SIGNING_KEY = 'replace-with-a-random-secret-at-least-32-characters-long';
    process.env.BROWSER_SERVICE_URL = 'wss://browser.example.com/browser';
    assert.equal((await handler(request({}))).status, 503);
    const secret = process.env.BROWSER_SIGNING_KEY = 'test-key-that-is-at-least-thirty-two-characters';
    process.env.BROWSER_SERVICE_URL = 'wss://browser.example.com/browser';
    const panel = '39c3c999-6cba-4f5e-b852-aeb398e7b880';
    const response = await handler(request({ room: 'TESTROOM', panel }));
    const ticket = await response.json();
    assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(validTicket({ ...ticket, type: 'join' }, secret), true);
    assert.equal(JSON.stringify(ticket).includes(secret), false);
    const same = await (await handler(request({ room: 'testroom', panel }))).json();
    const other = await (await handler(request({ room: 'OTHERROOM', panel }))).json();
    assert.equal(ticket.session, same.session); assert.notEqual(ticket.session, other.session);
    assert.equal((await handler(request({ room: 'TEST', panel: 'guessable' }))).status, 400);
  } finally {
    if (oldKey === undefined) delete process.env.BROWSER_SIGNING_KEY; else process.env.BROWSER_SIGNING_KEY = oldKey;
    if (oldUrl === undefined) delete process.env.BROWSER_SERVICE_URL; else process.env.BROWSER_SERVICE_URL = oldUrl;
  }
});
