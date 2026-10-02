import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

function load(path, imports = {}, globals = {}) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const context = { exports: {}, require: name => imports[name], ...globals };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context);
  return context.exports;
}

function room() {
  let now = 10000, sequence = 0;
  const clients = [], queue = [];
  class Clock extends Date { static now() { return now; } }
  const utils = load('src/utils/dawSync.ts', {}, { Date: Clock });
  const flush = () => {
    let remaining = 1000;
    while (queue.length) {
      assert.ok(remaining-- > 0, 'sync must not echo indefinitely');
      const { sender, message } = queue.shift();
      for (const client of clients) if (client !== sender && client.connection.open) client.listener?.(message);
    }
  };
  const add = () => {
    const client = { received: [], views: [], voices: [], sent: [], preview: { peaks: [], notes: [] } };
    clients.push(client);
    client.connection = {
      open: true,
      on(_event, fn) { client.listener = fn; },
      off() { client.listener = null; },
      send(message) { client.sent.push(message); queue.push({ sender: client, message }); },
    };
    const { useDawSync } = load('src/hooks/useDawSync.ts', {
      react: { useRef: value => ({ current: value }), useEffectEvent: fn => fn, useEffect: fn => { client.cleanup = fn(); } },
      '../utils/dawSync': utils,
    }, { Date: Clock, crypto: { randomUUID: () => `id-${String(++sequence).padStart(5, '0')}` },
      setInterval: fn => { client.tick = fn; return 1; }, clearInterval() {} });
    client.sync = useDawSync('daw', client.connection, activity => client.received.push(activity),
      () => client.preview, view => client.views.push(view), (owner, voices) => client.voices.push({ owner, voices }));
    return client;
  };
  const advance = ms => {
    for (let elapsed = 0; elapsed < ms; elapsed += 250) {
      now += 250;
      for (const client of clients) if (client.listener) client.tick();
      flush();
    }
  };
  return { add, flush, advance, clients };
}

test('three participants share play, pause/seek, recording previews and peer Stop', () => {
  const r = room(), a = r.add(), b = r.add(), c = r.add(); r.flush();
  a.sync.publish('playing', 12); r.flush();
  assert.equal(b.received.at(-1).mode, 'playing');
  assert.equal(c.received.at(-1).position, 12);
  b.sync.publish('stopped', 14); r.flush();
  assert.equal(a.received.at(-1).position, 14);
  assert.equal(c.received.at(-1).mode, 'stopped');
  c.sync.publish('playing', 22); r.flush();
  assert.equal(a.received.at(-1).position, 22);
  a.sync.publish('recording', 22, 'track'); r.flush();
  a.preview = { peaks: [{ at: 0.2, peak: 0.6 }], notes: [{ pitch: 60, start: 0, duration: 0.2, velocity: 0.8 }] };
  r.advance(250);
  assert.equal(b.received.at(-1).peaks[0].peak, 0.6);
  assert.equal(c.received.at(-1).notes[0].pitch, 60);
  b.sync.publish('stopped', 23); r.flush(); r.advance(1000);
  assert.equal(a.received.at(-1).mode, 'stopped');
  assert.equal(c.received.at(-1).mode, 'stopped');
});

test('late joiners catch up to transport, track/region selection and zoom', () => {
  const r = room(), a = r.add(); r.flush();
  a.sync.publishView({ selected: 'track', region: 'region', zoom: 45 });
  a.sync.publish('playing', 8); r.flush(); r.advance(2000);
  const b = r.add(); r.flush();
  assert.equal(b.received.at(-1).mode, 'playing');
  assert.equal(b.received.at(-1).position, 8);
  assert.equal(b.views.at(-1).selected, 'track');
  assert.equal(b.views.at(-1).region, 'region');
  assert.equal(b.views.at(-1).zoom, 45);
  b.sync.publishView({ zoom: 60 }); r.flush();
  assert.equal(a.views.at(-1).selected, 'track');
  assert.equal(a.views.at(-1).zoom, 60);
});

test('simultaneous controls converge and delayed old activity cannot restart transport', () => {
  const r = room(), a = r.add(), b = r.add(); r.flush();
  a.sync.publish('playing', 0); b.sync.publish('stopped', 4); r.flush();
  const playing = a.sent.find(message => message.type === 'daw-activity');
  assert.equal(a.received.at(-1).mode, 'stopped');
  const count = b.received.length;
  b.listener(playing);
  assert.equal(b.received.length, count);
  r.advance(1000);
  assert.equal(a.received.at(-1).mode, 'stopped');
});

test('held voices expire, are released on cleanup, and disconnected transport stops', () => {
  const r = room(), a = r.add(), b = r.add(); r.flush();
  a.sync.publishVoices([{ trackId: 'track', pitch: 60 }]); r.flush();
  assert.equal(b.voices.at(-1).voices[0].pitch, 60);
  b.cleanup();
  assert.equal(b.voices.at(-1).voices.length, 0);
  const c = r.add(); r.flush();
  a.sync.publish('recording', 0, 'track'); r.flush();
  a.sync.publishVoices([{ trackId: 'track', pitch: 64 }]); r.flush();
  a.cleanup(); a.connection.open = false;
  r.advance(2500);
  assert.equal(c.voices.at(-1).voices.length, 0);
  r.advance(6500);
  assert.equal(c.received.at(-1).mode, 'stopped');
});
