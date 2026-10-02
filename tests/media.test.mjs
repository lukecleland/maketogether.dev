import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import ts from 'typescript';

function load(path, globals = {}, imports = {}) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replaceAll('import.meta.env', '{}');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const context = { exports: {}, require: name => imports[name], ...globals };
  vm.runInNewContext(js, context);
  return context.exports;
}

function participant(id, media, host = false) {
  let now = 0, sequence = 0, peer;
  const timers = new Map(), state = [], effects = [];
  class Connection extends EventEmitter {
    constructor(target, metadata) {
      super(); this.peer = target; this.metadata = metadata; this.open = false; this.sent = [];
      const events = new EventEmitter();
      this.peerConnection = { connectionState: 'connecting', getSenders: () => [],
        addEventListener: (event, fn) => events.on(event, fn),
        removeEventListener: (event, fn) => events.off(event, fn) };
      this.transition = value => { this.peerConnection.connectionState = value; events.emit('connectionstatechange'); };
    }
    send(message) { this.sent.push(message); }
    close() { this.closed = true; this.open = false; this.emit('close'); }
  }
  class MockPeer extends EventEmitter {
    constructor() { super(); peer = this; this.id = id; this.open = true; this.calls = []; }
    connect(target, options) { this.data = new Connection(target, options.metadata); return this.data; }
    call(target) { const call = new Connection(target); this.calls.push(call); return call; }
    destroy() {} reconnect() {}
  }
  const react = { useState: value => [value, next => state.push(next)], useRef: value => ({ current: value }), useCallback: fn => fn, useEffect: fn => effects.push(fn) };
  const { usePeer } = load('src/hooks/usePeer.ts', {
    crypto: { randomUUID: () => 'nonce' }, document: { hidden: false },
    setTimeout: (fn, ms) => { timers.set(++sequence, { fn, at: now + ms }); return sequence; },
    clearTimeout: key => timers.delete(key), setInterval: () => ++sequence, clearInterval() {},
  }, { react, peerjs: MockPeer });
  const result = usePeer({ roomCode: 'MAKER', isHost: host, localStream: { getTracks: () => media ? [{ kind: 'audio', readyState: 'live' }] : [] } });
  const cleanup = effects[0](); peer.emit('open');
  if (host) { peer.data = new Connection('1-guest', { canSendMedia: true }); peer.emit('connection', peer.data); }
  peer.data.open = true; peer.data.emit('open');
  const advance = ms => {
    const end = now + ms;
    while (true) {
      const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [key, timer] = next; now = timer.at; timers.delete(key); timer.fn();
    }
    now = end;
  };
  return { peer, state, advance, cleanup, result,
    capability: value => peer.data.emit('data', { __watchTogether: 'media-capabilities', canSendMedia: value }) };
}

for (const [hostMedia, guestMedia] of [[false, true], [true, false], [true, true], [false, false]]) {
  test(`MAKER room negotiates with host media=${hostMedia}, guest media=${guestMedia}`, () => {
    const host = participant('maker', hostMedia, true), guest = participant('1-guest', guestMedia);
    host.capability(guestMedia); guest.capability(hostMedia);
    host.advance(120); guest.advance(120);
    assert.equal(host.peer.calls.length + guest.peer.calls.length, hostMedia || guestMedia ? 1 : 0);
    assert.ok(host.state.includes('connected') && guest.state.includes('connected'));
    host.cleanup(); guest.cleanup();
  });
}

test('stalled media retries five times, exposes failure, and supports manual retry', () => {
  const client = participant('maker', true, true); client.capability(true);
  client.advance(200_000);
  assert.equal(client.peer.calls.length, 5);
  assert.ok(client.peer.calls.every(call => call.closed));
  assert.ok(client.state.some(value => typeof value === 'string' && value.includes('could not connect')));
  client.result.retryMedia(); client.advance(120);
  assert.equal(client.peer.calls.length, 6);
  client.cleanup();
});

test('connected calls survive watchdog; disconnected calls recover after grace period', () => {
  const client = participant('maker', true, true); client.capability(true); client.advance(120);
  const call = client.peer.calls[0]; call.transition('connected'); client.advance(60_000);
  assert.equal(call.closed, undefined);
  call.transition('disconnected'); client.advance(5000); call.transition('connected'); client.advance(20_000);
  assert.equal(call.closed, undefined);
  call.transition('disconnected'); client.advance(14_000);
  assert.equal(call.closed, true); assert.equal(client.peer.calls.length, 2);
  client.cleanup(); client.advance(100_000); assert.equal(client.peer.calls.length, 2);
});

class Stream {
  constructor(tracks = []) { this.tracks = tracks; }
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
}
for (const available of ['audio', 'video', 'neither']) {
  test(`device fallback preserves ${available}`, async () => {
    const { acquireLocalMedia } = load('src/utils/localMedia.ts', { MediaStream: Stream,
      navigator: { mediaDevices: { async getUserMedia(constraints) {
        if (Object.keys(constraints).length === 1 && constraints[available]) return new Stream([{ kind: available }]);
        throw new Error('Device unavailable');
      } } } });
    const result = await acquireLocalMedia();
    assert.equal(result.stream.getTracks().length, available === 'neither' ? 0 : 1);
    if (available !== 'neither') assert.equal(result.stream.getTracks()[0].kind, available);
    assert.ok(result.stream.getTracks().every(track => track.enabled === false));
    assert.ok(result.error);
  });
}

test('camera and microphone start disabled after a combined device request', async () => {
  const tracks = [{ kind: 'audio', enabled: true }, { kind: 'video', enabled: true }];
  const { acquireLocalMedia } = load('src/utils/localMedia.ts', { MediaStream: Stream,
    navigator: { mediaDevices: { async getUserMedia() { return new Stream(tracks); } } } });
  const result = await acquireLocalMedia();
  assert.equal(result.error, null);
  assert.equal(result.stream.getTracks().length, 2);
  assert.ok(tracks.every(track => track.enabled === false));
});

test('playback tries audio first and keeps retry visible on rejected user playback', async () => {
  const effects = [], state = [], refs = [];
  let blocked = true;
  const video = { muted: false, pause() {}, play: () => blocked ? Promise.reject(new Error('Blocked')) : Promise.resolve() };
  const react = { useEffect: fn => effects.push(fn), useRef: () => { const ref = { current: video }; refs.push(ref); return ref; }, useState: value => [value, next => state.push(next)] };
  const jsx = (type, props) => ({ type, props });
  const { VideoPanel } = load('src/components/VideoPanel.tsx', {}, { react, 'react/jsx-runtime': { jsx, jsxs: jsx }, './Dock': {} });
  VideoPanel({ stream: new Stream([{ kind: 'audio' }]), label: 'Guest' });
  const cleanup = effects[0]();
  assert.equal(video.muted, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.at(-1), true); assert.equal(video.muted, true);
  // Re-render with the blocked state to access the actual retry control.
  react.useState = () => [true, next => state.push(next)];
  const tree = VideoPanel({ stream: new Stream(), label: 'Guest' });
  const buttons = [];
  function walk(node) { if (!node || typeof node !== 'object') return; if (node.type === 'button' && node.props.onClick) buttons.push(node); for (const child of [node.props?.children].flat(Infinity)) walk(child); }
  walk(tree); const retry = buttons.at(-1);
  retry.props.onClick(); await new Promise(resolve => setImmediate(resolve)); assert.equal(state.at(-1), true);
  blocked = false; retry.props.onClick(); await new Promise(resolve => setImmediate(resolve)); assert.equal(state.at(-1), false);
  cleanup();
});

test('remote retry replaces a stale media call without dropping the data connection', () => {
  const client = participant('maker', true, true); client.capability(false); client.advance(120);
  const first = client.peer.calls[0]; first.transition('connected');
  client.peer.data.emit('data', { __watchTogether: 'media-retry' }); client.advance(120);
  assert.equal(first.closed, true); assert.equal(client.peer.calls.length, 2);
  assert.equal(client.peer.data.open, true);
  client.cleanup();
});

test('targeted room snapshots reach only the joining peer and current owner is the lead', () => {
  const host = participant('maker', true, true);
  const guest = participant('1-guest', true);
  const mesh = host.state.find(value => value && typeof value.send === 'function');
  const guestMesh = guest.state.find(value => value && typeof value.send === 'function');
  assert.equal(mesh.isLead, true);
  assert.equal(guestMesh.isLead, false);
  const received = [];
  mesh.on('data', message => received.push(message));
  const packet = { type: 'room-state-snapshot', __meshSourcePeerId: '1-guest', __meshMessageId: 'snapshot-1', __meshTargetPeerId: 'other-guest' };
  host.peer.data.emit('data', packet);
  assert.equal(received.length, 0);
  host.peer.data.emit('data', { ...packet, __meshMessageId: 'snapshot-2', __meshTargetPeerId: 'maker' });
  assert.equal(received.length, 1);
  host.cleanup(); guest.cleanup();
});

test('participant dock names retain identity for live updates and joining snapshots', () => {
  const guest = participant('1-guest', true);
  const mesh = guest.state.find(value => value && typeof value.send === 'function');
  const received = [];
  mesh.on('data', message => received.push(message));
  let sequence = 0;
  const deliver = message => guest.peer.data.emit('data', { ...message, __meshSourcePeerId: 'maker', __meshMessageId: `names-${++sequence}` });
  deliver({ type: 'dock-rename', id: 'local', label: 'Luke' });
  deliver({ type: 'dock-rename', id: 'remote-peer:1-guest', label: 'Alex' });
  deliver({ type: 'dock-rename', id: 'remote-peer:third', label: 'Sam' });
  deliver({ type: 'dock-rename', id: 'local', label: '' });
  assert.deepEqual(received.map(({ id, label }) => [id, label]), [['remote-peer:maker', 'Luke'], ['local', 'Alex'], ['remote-peer:third', 'Sam'], ['remote-peer:maker', '']]);
  deliver({ type: 'room-state-snapshot', snapshot: { dockedIds: ['local', 'remote-peer:1-guest', 'remote-peer:third', 'note-1'], customLabels: { local: 'Luke', 'remote-peer:1-guest': 'Alex', 'remote-peer:third': 'Sam', 'note-1': 'Ideas' } } });
  const snapshot = JSON.parse(JSON.stringify(received.at(-1).snapshot));
  assert.deepEqual(snapshot.dockedIds, ['remote-peer:maker', 'local', 'remote-peer:third', 'note-1']);
  assert.deepEqual(snapshot.customLabels, { 'remote-peer:maker': 'Luke', local: 'Alex', 'remote-peer:third': 'Sam', 'note-1': 'Ideas' });
  guest.cleanup();
});
