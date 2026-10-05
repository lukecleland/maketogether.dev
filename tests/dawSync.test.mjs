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
      document: { visibilityState: 'visible', addEventListener(_event, fn) { client.recover = fn; }, removeEventListener() {} },
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


test('tempo, click, count-in settings and pending count-in reach late joiners; Stop supersedes countdown', () => {
  const r = room(), a = r.add(), b = r.add(); r.flush();
  a.sync.publishView({ tempo: 90, click: true, countIn: true });
  a.sync.publish('count-in', 150, undefined, 10000 + 4 * 60000 / 90); r.flush();
  assert.equal(b.views.at(-1).tempo, 90);
  const c = r.add(); r.flush();
  assert.equal(c.views.at(-1).click, true);
  assert.equal(c.views.at(-1).countIn, true);
  assert.equal(c.received.at(-1).mode, 'count-in');
  b.sync.publish('stopped', 150); r.flush();
  assert.equal(a.received.at(-1).mode, 'stopped');
  assert.equal(c.received.at(-1).mode, 'stopped');
  const count = c.views.length;
  c.listener({ type: 'daw-view', panelId: 'daw', view: { ...c.views.at(-1), revision: 999, tempo: 0 } });
  assert.equal(c.views.length, count);
});


test('count-in retains the chosen recording position and rejects unbounded countdowns', () => {
  const { validDawActivity, dawActivityPosition } = load('src/utils/dawSync.ts');
  const activity = { revision: 1, id: 'count', owner: 'a', mode: 'count-in', position: 150, at: 10000, countInEndsAt: 12000 };
  assert.equal(validDawActivity(activity), true);
  assert.equal(dawActivityPosition(activity, 11500), 150);
  for (const countInEndsAt of [undefined, NaN, 9999, 19000]) {
    assert.equal(validDawActivity({ ...activity, countInEndsAt }), false);
  }
});

test('click synthesis accents the first beat and cleans up without touching arrangement sources', () => {
  const { scheduleDawClick } = load('src/utils/dawClick.ts');
  const oscillators = [], gains = [];
  const ctx = {
    destination: {},
    createOscillator() { const node = { frequency: {}, connect(target) { this.target = target; }, start(at) { this.startAt = at; }, stop(at) { this.stopAt = at; }, disconnect() { this.disconnected = true; } }; oscillators.push(node); return node; },
    createGain() { const node = { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect(target) { this.target = target; }, disconnect() { this.disconnected = true; } }; gains.push(node); return node; },
  };
  scheduleDawClick(ctx, 10, 0); scheduleDawClick(ctx, 10.5, 1);
  assert.ok(oscillators[0].frequency.value > oscillators[1].frequency.value);
  assert.equal(oscillators[0].startAt, 10);
  assert.equal(oscillators[0].stopAt, 10.05);
  assert.equal(gains[0].target, ctx.destination);
  oscillators[0].onended();
  assert.equal(oscillators[0].disconnected, true);
  assert.equal(gains[0].disconnected, true);
});

test('returning to a DAW requests the latest transport and mixer view', () => {
  const r = room(), desktop = r.add(), phone = r.add(); r.flush();
  desktop.sync.publish('playing', 5); r.flush();
  phone.connection.open = false;
  desktop.sync.publish('stopped', 27);
  desktop.sync.publishView({ tempo: 88, selected: 'new-track' }); r.flush();
  phone.connection.open = true;
  phone.recover(); r.flush();
  assert.equal(phone.received.at(-1).mode, 'stopped');
  assert.equal(phone.received.at(-1).position, 27);
  assert.equal(phone.views.at(-1).tempo, 88);
  assert.equal(phone.views.at(-1).selected, 'new-track');
});
