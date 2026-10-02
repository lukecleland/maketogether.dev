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

function dawClient({ microphone } = {}) {
  const refs = [], states = [], schedules = [], effects = [], published = [], notes = [];
  let stateIndex = 0, refIndex = 0, now = 0, receive, receiveView, receiveVoices, resume;
  const recorders = [], imported = [], trackUpdates = [];
  class Recorder {
    constructor() { this.state = 'inactive'; recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; }
  }
  class TakeFile {
    constructor(_chunks, name) { this.name = name; this.size = 100; }
    async arrayBuffer() { return new ArrayBuffer(1); }
  }
  const ctx = { state: 'suspended', currentTime: 0,
    createAnalyser: () => ({ fftSize: 0, disconnect() {} }),
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    decodeAudioData: async () => ({ duration: 2 }),
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
      scheduleDawNote: (_ctx, pitch, volume, pan) => { const node = { pitch, volume, pan, stop() { this.stopped = true; } }; notes.push(node); return node; },
    }, '../utils/dawSync': syncUtils,
    '../utils/dawShortcuts': {}, './Toast': {}, './DawCreateTrackDialog': {}, './DawWaveform': {}, './DawInstrument': {}, './DawPanDial': {}, './DawMenu': {}, './DawTransportIcon': {},
    '../hooks/useDawSync': { useDawSync: (_id, _connection, onReceive, _preview, onView, onVoices) => { receive = onReceive; receiveView = onView; receiveVoices = onVoices; return { publish: (...args) => published.push(args), publishView() {}, publishVoices() {} }; } },
  }, { AudioContext: function () { return ctx; }, performance: { now: () => now }, crypto: { randomUUID: () => 'edit' },
    navigator: { mediaDevices: { getUserMedia: microphone } }, MediaRecorder: Recorder, File: TakeFile,
    setTimeout: () => 1, clearTimeout() {} });
  const track = name => ({ id: 'track', name, kind: 'midi', volume: 1, pan: 0, muted: false, solo: false, revision: 1, editId: name,
    regions: [{ id: 'region', sourceId: 'midi', name, duration: 120, trimStart: 0, trimEnd: 120, start: 0, revision: 1, editId: name, notes: [{ pitch: 60, start: 0, duration: 120, velocity: 0.8 }] }] });
  let tree;
  const render = tracks => { stateIndex = 0; refIndex = 0; effects.length = 0; tree = DawWidget({ id: 'daw', title: 'Make Music Together', tracks, recordings: [], onTrack: track => trackUpdates.push(track), onFile: file => imported.push(file), onClose() {}, onMinimize() {}, onToggleDock() {} }); };
  const button = text => {
    let found;
    function walk(node) { if (!node || typeof node !== 'object') return; if (node.type === 'button' && (node.props.children === text || node.props['aria-label'] === text)) found = node; for (const child of [node.props?.children].flat(Infinity)) walk(child); }
    walk(tree); return found;
  };
  return { track, render, button, schedules, effects, published, notes, ctx, recorders, imported, trackUpdates,
    voices: (owner, voices) => receiveVoices(owner, voices),
    view: view => receiveView(view),
    receive: activity => receive(activity),
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

test('held peer MIDI notes follow shared gain/pan, mute, solo and track deletion', () => {
  const client = dawClient(), original = [client.track('Shared')];
  client.render(original);
  client.voices('peer', [{ trackId: 'track', pitch: 60 }]);
  const first = client.notes.at(-1);
  assert.equal(first.volume, 1);
  const update = tracks => {
    client.render(tracks);
    client.effects.find(effect => effect.deps?.[0] === tracks && effect.deps.length === 2).fn();
  };
  update([{ ...original[0], volume: 0.3, pan: -0.5 }]);
  assert.equal(first.stopped, true);
  assert.equal(client.notes.at(-1).volume, 0.3);
  assert.equal(client.notes.at(-1).pan, -0.5);
  const count = client.notes.length;
  update([{ ...original[0], muted: true }]);
  assert.equal(client.notes.at(-1).stopped, true);
  assert.equal(client.notes.length, count);
  update(original);
  assert.equal(client.notes.length, count + 1);
  update([original[0], { ...original[0], id: 'other', solo: true }]);
  assert.equal(client.notes.at(-1).stopped, true);
  update([{ ...original[0], deleted: true }]);
  client.voices('peer', [{ trackId: 'track', pitch: 60 }]);
  assert.equal(client.notes.length, count + 1);
});

test('DAW Pause overrides shared Play while local audio permission is pending', async () => {
  const client = dawClient(), tracks = [client.track('Shared')];
  client.render(tracks); client.play(); client.advance(4); client.render(tracks);
  client.button('Pause').props.onClick();
  assert.equal(client.published.length, 1);
  assert.equal(client.published[0][0], 'stopped');
  assert.ok(client.published[0][1] >= 14);
  client.resume(); await flush();
  assert.equal(client.schedules.length, 0);
});

test('DAW seeking preserves shared Play while local audio permission is pending', async () => {
  const client = dawClient(), tracks = [client.track('Shared')];
  client.render(tracks); client.play(); client.advance(4); client.render(tracks);
  client.button('Forward').props.onClick();
  assert.equal(client.published.length, 1);
  assert.equal(client.published[0][0], 'playing');
  assert.ok(client.published[0][1] >= 15);
  client.resume(); await flush();
  assert.equal(client.schedules.length, 1);
  assert.ok(client.schedules[0].position >= 15);
});

test('peer Stop cancels pending DAW playback without echoing a command', async () => {
  const client = dawClient(), tracks = [client.track('Shared')];
  client.render(tracks); client.play();
  client.receive({ revision: 2, id: 'stop', owner: 'peer', mode: 'stopped', position: 16, at: Date.now() });
  client.resume(); await flush();
  assert.equal(client.schedules.length, 0);
  assert.equal(client.published.length, 0);
});

test('peer Stop cancels a microphone permission request and releases the returned stream', async () => {
  let allow, stopped = false;
  const client = dawClient({ microphone: () => new Promise(resolve => { allow = resolve; }) });
  client.render([]);
  const pending = client.button('Record').props.onClick();
  client.receive({ revision: 2, id: 'stop', owner: 'peer', mode: 'stopped', position: 0, at: Date.now() });
  allow({ getTracks: () => [{ stop() { stopped = true; } }] });
  await pending; await flush();
  assert.equal(stopped, true);
  assert.equal(client.recorders.length, 0);
  assert.ok(client.published.every(([mode]) => mode !== 'recording'));
});

test('peer Stop finishes the real microphone recorder and retains the completed take', async () => {
  const stream = { getTracks: () => [{ stop() {} }] };
  const client = dawClient({ microphone: async () => stream });
  client.render([]); client.button('Record').props.onClick(); await flush();
  client.resume(); await flush();
  assert.equal(client.recorders[0].state, 'recording');
  assert.equal(client.published.at(-1)[0], 'recording');
  const count = client.published.length;
  client.receive({ revision: 3, id: 'stop', owner: 'peer', mode: 'stopped', position: 2, at: Date.now() });
  assert.equal(client.recorders[0].state, 'inactive');
  client.recorders[0].onstop(); await flush();
  assert.equal(client.imported.length, 1);
  assert.equal(client.published.length, count, 'finalizing must not echo or override the peer command');
});

test('a delayed recorder completion cannot clear a newer peer recording indicator', async () => {
  const client = dawClient({ microphone: async () => ({ getTracks: () => [{ stop() {} }] }) });
  client.render([]); client.button('Record').props.onClick(); await flush();
  client.resume(); await flush();
  client.receive({ revision: 3, id: 'new-take', owner: 'peer', mode: 'recording', position: 4, trackId: 'other', at: Date.now() });
  client.recorders[0].onstop(); await flush(); client.render(client.trackUpdates);
  assert.equal(client.button('Finish recording').props['aria-pressed'], true);
  assert.equal(client.imported.length, 1);
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

function canvasRecorderClient() {
  const refs = [], states = [], effects = [], sent = [];
  let stateIndex = 0, refIndex = 0, receive, tree, videoProps;
  const video = media(0);
  const play = video.play.bind(video), pause = video.pause.bind(video);
  video.play = () => { const result = play(); if (!video.blocked) videoProps.onPlay({ currentTarget: video }); return result; };
  video.pause = () => { pause(); videoProps.onPause({ currentTarget: video }); };
  video.load = () => { video.readyState = 0; }; video.src = ''; video.srcObject = null;
  const react = {
    useState: value => { const index = stateIndex++; if (!(index in states)) states[index] = value; return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next; }]; },
    useRef: value => refs[refIndex++] ??= { current: value },
    useCallback: fn => fn, useEffect: (fn, deps) => effects.push({ fn, deps }),
  };
  const jsx = (type, props) => { if (type === 'video') { props.ref.current = video; videoProps = props; } return { type, props }; };
  const { ScreenRecorderWidget } = load('src/components/ScreenRecorderWidget.tsx', {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx }, './Dock': {}, '../utils/sharedAudioPlayback': { SharedAudioPlayback },
    '../hooks/useYouTubeSync': { useYouTubeSync: ({ onRemoteSync }) => { receive = onRemoteSync; return { sendSync: message => sent.push(message) }; } },
  }, { URL: { createObjectURL: file => `blob:${file.name}`, revokeObjectURL() {} } });
  const render = (recordings = []) => {
    stateIndex = 0; refIndex = 0; effects.length = 0;
    tree = ScreenRecorderWidget({ id: 'canvas', recordings, dataConnection: {}, onRecordingComplete() {}, onStatusChange() {}, getCanvasElement() {} });
  };
  const arrive = clip => {
    const incoming = [clip]; render(incoming);
    effects.find(effect => effect.deps?.length === 1 && effect.deps[0] === incoming).fn();
    render(incoming); effects.find(effect => effect.deps?.length === 4).fn(); render(incoming);
    video.readyState = 1; videoProps.onLoadedMetadata();
  };
  const button = label => {
    let found;
    function walk(node) { if (!node || typeof node !== 'object') return; if (node.type === 'button' && node.props.children === label) found = node; for (const child of [node.props?.children].flat(Infinity)) walk(child); }
    walk(tree); return found;
  };
  render();
  return { video, sent, render, arrive, button,
    receive: message => receive({ id: 'canvas', recordingId: 'clip', ...message }),
    pauseByUser: () => { videoProps.onPointerDown(); video.pause(); },
  };
}

const canvasClip = { id: 'clip', name: 'Take', file: { name: 'take.webm' } };

test('canvas recording playback catches up after a delayed file transfer and lets a peer pause immediately', async () => {
  const client = canvasRecorderClient();
  client.receive({ type: 'recording-play', time: 10, at: Date.now() - 2000 });
  assert.equal(client.video.paused, true);
  client.arrive(canvasClip); await flush();
  assert.equal(client.video.paused, false);
  assert.ok(client.video.currentTime >= 12);
  assert.equal(client.sent.length, 0, 'remote application must not echo Play');
  client.pauseByUser();
  assert.equal(client.sent.at(-1).type, 'recording-pause');
});

test('canvas recording seek applies shared playing state, and Pause replaces a queued Play', async () => {
  const client = canvasRecorderClient();
  client.receive({ type: 'recording-play', time: 10, at: Date.now() });
  client.receive({ type: 'recording-pause', time: 11 });
  client.arrive(canvasClip); await flush();
  assert.equal(client.video.paused, true);
  assert.equal(client.video.currentTime, 11);
  client.receive({ type: 'recording-seek', time: 20, playing: true }); await flush();
  assert.equal(client.video.paused, false);
  assert.equal(client.video.currentTime, 20);
  client.receive({ type: 'recording-seek', time: 25, playing: false });
  assert.equal(client.video.paused, true);
  assert.equal(client.video.currentTime, 25);
  assert.equal(client.sent.length, 0);
});

test('canvas recording autoplay retry preserves shared playback intent without broadcasting', async () => {
  const client = canvasRecorderClient(); client.video.blocked = true;
  client.receive({ type: 'recording-play', time: 10, at: Date.now() - 3000 });
  client.arrive(canvasClip); await flush(); client.render([canvasClip]);
  assert.ok(client.button('Enable audio'));
  client.video.blocked = false;
  client.button('Enable audio').props.onClick(); await flush();
  assert.equal(client.video.paused, false);
  assert.ok(client.video.currentTime >= 13);
  assert.equal(client.sent.length, 0);
});
