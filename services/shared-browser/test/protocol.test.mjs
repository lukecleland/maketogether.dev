import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { validTicket, validAction, publicUrl } from '../protocol.mjs';
import { publicAddress, resolvePublic } from '../egress.mjs';
const secret = 'test-secret-that-is-at-least-thirty-two-characters';
test('session tickets reject forgery, expiry and excessive lifetimes', () => {
  const session = 'a'.repeat(64), expires = 120;
  const signature = createHmac('sha256', secret).update(`${session}.${expires}`).digest('hex');
  const ticket = { type: 'join', session, expires, signature };
  assert.equal(validTicket(ticket, secret, 1000), true);
  assert.equal(validTicket({ ...ticket, session: 'b'.repeat(64) }, secret, 1000), false);
  assert.equal(validTicket(ticket, secret, 121000), false);
  assert.equal(validTicket(ticket, secret, -100000), false);
  assert.equal(validTicket({ ...ticket, signature: 'short' }, secret, 1000), false);
});
test('browser commands constrain text, keys, coordinates and navigation schemes', () => {
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'https://user:password@example.com']) assert.equal(publicUrl(url), null);
  assert.equal(publicUrl('https://example.com'), 'https://example.com/');
  assert.equal(validAction({ type: 'click', x: .5, y: .5 }), true);
  assert.equal(validAction({ type: 'click', x: Infinity, y: .5 }), false);
  assert.equal(validAction({ type: 'key', key: 'F12' }), false);
  assert.equal(validAction({ type: 'text', text: 'a'.repeat(4097) }), false);
  assert.equal(validAction({ type: 'scroll', x: 0, y: 0, dx: 0, dy: 1601 }), false);
});
test('egress rejects local, private, metadata and mixed DNS destinations', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1']) assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress('1.1.1.1'), true);
  assert.equal(await resolvePublic('example.com', async () => [{ address: '1.1.1.1' }]), '1.1.1.1');
  await assert.rejects(resolvePublic('example.com', async () => [{ address: '1.1.1.1' }, { address: '127.0.0.1' }]));
});
