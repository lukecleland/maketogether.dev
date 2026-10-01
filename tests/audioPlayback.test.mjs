import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

function load(path, imports = {}, globals = {}) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const context = { exports: {}, require: name => imports[name], Date, ...globals };
  vm.runInNewContext(js, context);
  return context.exports;
}
const { SharedAudioPlayback } = load('src/utils/sharedAudioPlayback.ts');
const flush = () => new Promise(resolve => setImmediate(resolve));
function media(readyState = 1) {
  return { readyState, duration: 120, currentTime: 0, paused: true, blocked: false,
    play() { if (this.blocked) return Promise.reject(new Error('Autoplay blocked')); this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; } };
}

test('play arriving before the file loads is retained and catches up when ready', async () => {
  const audio = media(0), blocked = [];
  const sync = new SharedAudioPlayback(() => audio, value => blocked.push(value));
  sync.set({ time: 12, playing: true, at: Date.now() - 2000 });
  assert.equal(audio.paused, true);
  audio.readyState = 1; sync.apply(); await flush();
  assert.equal(audio.paused, false); assert.ok(audio.currentTime >= 14 && audio.currentTime < 15);
  assert.equal(blocked.at(-1), false);
});

test('blocked playback has a local retry which catches up without changing shared intent', async () => {
  const audio = media(), blocked = [];
  audio.blocked = true;
  const sync = new SharedAudioPlayback(() => audio, value => blocked.push(value));
  sync.set({ time: 10, playing: true, at: Date.now() - 3000 }); await flush();
  assert.equal(blocked.at(-1), true);
  audio.blocked = false; sync.apply(); await flush();
  assert.equal(audio.paused, false); assert.ok(audio.currentTime >= 13);
  assert.equal(blocked.at(-1), false);
});

test('pause and stop replace queued or blocked play, including stale promise rejection', async () => {
  const audio = media(), blocked = []; let reject;
  audio.play = () => new Promise((_, fail) => { reject = fail; });
  const sync = new SharedAudioPlayback(() => audio, value => blocked.push(value));
  sync.set({ time: 20, playing: true });
  sync.set({ time: 0, playing: false }); reject(new Error('Old attempt')); await flush();
  sync.apply(); assert.equal(audio.currentTime, 0); assert.equal(audio.paused, true);
  assert.equal(blocked.at(-1), false);
  audio.readyState = 0; sync.set({ time: 30, playing: true }); sync.set({ time: 31, playing: false });
  audio.readyState = 1; sync.apply(); assert.equal(audio.currentTime, 31); assert.equal(audio.paused, true);
});

test('either participant can immediately override remote audio controls without echoing them', async () => {
  const clients = [];
  for (let i = 0; i < 2; i++) {
    const audio = media(), effects = [], refs = [], sent = [], states = [];
    let stateIndex = 0, refIndex = 0, rendered = false;
    const events = new Map();
    const start = audio.play.bind(audio), pause = audio.pause.bind(audio);
    audio.play = () => { const result = start(); events.get("play")?.(); return result; };
    audio.pause = () => { pause(); events.get("pause")?.(); };
    audio.src = 'blob:track'; audio.load = () => {}; audio.addEventListener = (name, fn) => events.set(name, fn); audio.removeEventListener = name => events.delete(name);
    const react = {
      useState: value => { const index = stateIndex++; if (!(index in states)) states[index] = value; return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next; }]; },
      useRef: value => { const index = refIndex++; return refs[index] ??= { current: value }; },
      useCallback: fn => fn, useEffect: fn => { if (!rendered) effects.push(fn); },
    };
    const jsx = (type, props) => { if (type === 'audio') props.ref.current = audio; return { type, props }; };
    const client = { audio, sent }; clients.push(client);
    const { AudioPlayer } = load('src/components/AudioPlayer.tsx', {
      react, 'react/jsx-runtime': { jsx, jsxs: jsx }, '../utils/sharedAudioPlayback': { SharedAudioPlayback }, './TapeDeck': {}, './Dock': {},
      '../hooks/useYouTubeSync': { useYouTubeSync: ({ onRemoteSync }) => {
        client.receive = onRemoteSync;
        return { sendSync: message => { sent.push(message); clients[1 - i]?.receive(message); } };
      } },
    }, { URL: { createObjectURL: () => 'blob:track', revokeObjectURL() {} } });
    const props = { id: 'shared', initialFile: { name: 'song.mp3' }, dataConnection: {} };
    client.render = () => { stateIndex = 0; refIndex = 0; client.tree = AudioPlayer(props); };
    client.render(); rendered = true; effects.forEach(fn => fn()); client.render();
    client.button = label => {
      let found;
      function walk(node) { if (!node || typeof node !== 'object') return; if (node.type === 'button' && node.props['aria-label'] === label) found = node; for (const child of [node.props?.children].flat(Infinity)) walk(child); }
      walk(client.tree); return found;
    };
  }
  for (const [index, client] of clients.entries()) {
    client.button('Play').props.onClick();
    await flush();
    assert.equal(client.audio.paused, false);
    assert.equal(clients[1 - index].audio.paused, false);
    client.render(); clients[1 - index].render();
    // Pause from the receiver immediately after Play, without a 500 ms wait.
    clients[1 - index].button('Pause').props.onClick();
    assert.equal(client.audio.paused, true);
    assert.equal(clients[1 - index].audio.paused, true);
    client.render(); clients[1 - index].render();
  }
  assert.deepEqual(clients.map(client => client.sent.map(message => message.type)), [
    ['audio-play', 'audio-pause'], ['audio-pause', 'audio-play'],
  ]);
});

function dawClient() {
  const refs = [], states = [], schedules = [], effects = [], published = [];
  let stateIndex = 0, refIndex = 0, now = 0, receive, resume;
  const ctx = { state: 'suspended', currentTime: 0,
    resume: () => new Promise(resolve => { resume = () => { ctx.state = 'running'; ctx.onstatechange?.(); resolve(); }; }) };
  const react = {
    useState: value => { const index = stateIndex++; if (!(index in states)) states[index] = value; return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next; }]; },
    useRef: value => refs[refIndex++] ??= { current: value },
    useCallback: fn => fn, useEffectEvent: fn => fn,
    useEffect: (fn, deps) => effects.push({ fn, deps }),
  };
  const utils = load('src/utils/daw.ts');
  const syncUtils = load('src/utils/dawSync.ts');
  const jsx = (type, props) => ({ type, props });
  const { DawWidget } = load('src/components/DawWidget.tsx', {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx }, '../utils/daw': {
      ...utils, scheduleDaw: (_ctx, tracks, _buffers, position) => { schedules.push({ tracks, position }); return []; },
    }, '../utils/dawSync': syncUtils,
    '../utils/dawShortcuts': {}, './Toast': {}, './DawCreateTrackDialog': {}, './DawWaveform': {}, './DawInstrument': {}, './DawPanDial': {}, './DawMenu': {}, './DawTransportIcon': {},
    '../hooks/useDawSync': { useDawSync: (_id, _connection, onReceive) => { receive = onReceive; return { publish: (...args) => published.push(args), publishView() {}, publishVoices() {} }; } },
  }, { AudioContext: function () { return ctx; }, performance: { now: () => now }, crypto: { randomUUID: () => 'edit' } });
  const track = name => ({ id: 'track', name, kind: 'midi', volume: 1, pan: 0, muted: false, solo: false, revision: 1, editId: name,
    regions: [{ id: 'region', sourceId: 'midi', name, duration: 120, trimStart: 0, trimEnd: 120, start: 0, revision: 1, editId: name, notes: [{ pitch: 60, start: 0, duration: 120, velocity: 0.8 }] }] });
  let tree;
  const render = tracks => { stateIndex = 0; refIndex = 0; effects.length = 0; tree = DawWidget({ id: 'daw', title: 'Make Music Together', tracks, recordings: [], onTrack() {}, onFile() {}, onClose() {}, onMinimize() {}, onToggleDock() {} }); };
  const button = text => {
    let found;
    function walk(node) { if (!node || typeof node !== 'object') return; if (node.type === 'button' && node.props.children === text) found = node; for (const child of [node.props?.children].flat(Infinity)) walk(child); }
    walk(tree); return found;
  };
  return { track, render, button, schedules, effects, published, ctx,
    play: () => receive({ revision: 1, id: 'command', owner: 'peer', mode: 'playing', position: 10, at: Date.now() }),
    advance: seconds => { now += seconds * 1000; }, resume: () => resume(),
  };
}

test('DAW waiting for audio permission uses the latest shared tracks and playhead when resumed', async () => {
  const client = dawClient(), original = [client.track('Original')], updated = [client.track('Updated')];
  client.render(original); client.play(); client.advance(5); client.render(updated);
  client.resume(); await flush();
  assert.equal(client.schedules.length, 1);
  assert.equal(client.schedules[0].tracks, updated);
  assert.ok(client.schedules[0].position >= 15);
  assert.equal(client.published.length, 0);
  client.advance(2); client.render(updated);
  // A newly decoded buffer/shared edit also rebuilds from the network clock.
  client.effects.find(effect => effect.deps?.[0] === updated && effect.deps.length === 3).fn();
  assert.ok(client.schedules.at(-1).position >= 17);
});

test('DAW Enable audio restarts shared playback at the current position without broadcasting Play', async () => {
  const client = dawClient(), tracks = [client.track('Shared')];
  client.render(tracks); client.play(); client.render(tracks);
  client.advance(4); client.button('Enable audio').props.onClick();
  client.resume(); await flush(); // Unlock resolves; playFrom asks to resume again.
  client.resume(); await flush();
  assert.equal(client.schedules.length, 1);
  assert.ok(client.schedules[0].position >= 14);
  assert.equal(client.published.length, 0);
});
