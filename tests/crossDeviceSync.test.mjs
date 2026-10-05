import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function load(path, imports = {}, globals = {}) {
  const scope = { exports: {}, Date, require: name => imports[name], ...globals };
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, scope);
  return scope.exports;
}
const coordinates = load('src/utils/drawingCoordinates.ts');
const { SharedMessageOrder } = load('src/utils/sharedMessageOrder.ts');

test('legacy drawings migrate once, retaining their world alignment with panels and tags', () => {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }, { width: 844, height: 390 }]) {
    const snapshot = { viewport, drawings: [
      { x0: .1, y0: .2, x1: .3, y1: .4, width: .01, color: 'white' },
      { kind: 'text', id: 'label', x: .3, y: .4, size: .02, text: 'Label', color: 'white', font: 'sans' },
      { kind: 'shape', id: 'box', shape: 'rectangle', x0: .1, y0: .2, x1: .3, y1: .4, width: .01, color: 'red' },
    ] };
    const migrated = coordinates.migrateDrawingCoordinates(snapshot);
    const [stroke, text, shape] = migrated.drawings;
    assert.ok(Math.abs(stroke.x0 * 1920 - .1 * viewport.width) < 1e-8);
    assert.ok(Math.abs(stroke.y0 * 1080 - .2 * viewport.height) < 1e-8);
    assert.ok(Math.abs(text.size * 1080 - .02 * Math.min(viewport.width, viewport.height)) < 1e-8);
    assert.equal(shape.x0, stroke.x0);
    assert.equal(coordinates.migrateDrawingCoordinates(migrated), migrated);
    assert.equal(snapshot.drawings[0].x0, .1);
  }
});

test('three devices converge on simultaneous edits, delayed controls and deletions', () => {
  for (const type of ['note-update', 'code-update', 'panel-update', 'audio-theme', 'pdf-page', 'browser-load', 'dock-rename', 'text-edit', 'text-move', 'audio-play', 'play', 'recording-play']) {
    const devices = ['desktop', 'iphone', 'tablet'].map(source => ({ source, order: new SharedMessageOrder(), value: source }));
    const messages = devices.map(device => device.order.stamp({ type, id: 'shared', value: device.source }, device.source));
    for (let index = 0; index < devices.length; index++) {
      const device = devices[index];
      const reordered = index % 2 ? [...messages].reverse() : messages;
      for (const message of [...reordered, ...reordered]) {
        if (device.order.accept(message, message.value)) device.value = message.value;
      }
      assert.equal(device.value, 'tablet', type);
    }
    const next = devices[0].order.stamp({ type, id: 'shared', value: 'next' }, 'desktop');
    for (const device of devices.slice(1)) assert.equal(device.order.accept(next, 'desktop'), true);
    const removal = devices[1].order.stamp({ type: 'remove-panel', id: 'shared' }, 'iphone');
    for (const device of devices) {
      device.order.accept(removal, 'iphone');
      assert.equal(device.order.accept(messages[0], 'desktop'), false);
      assert.equal(device.order.accept({ type: 'spawn-note', id: 'shared', __sharedClock: 99 }, 'desktop'), false);
    }
  }
});

test('an AV panel has the same revision key for its owner and remote editors', () => {
  const order = new SharedMessageOrder();
  order.accept({ type: 'panel-update', id: 'local', __sharedClock: 4 }, 'iphone');
  assert.equal(order.accept({ type: 'panel-update', id: 'remote-peer:iphone', __sharedClock: 3 }, 'desktop'), false);
  assert.equal(order.accept({ type: 'panel-update', id: 'remote-peer:iphone', __sharedClock: 5 }, 'desktop'), true);
});

test('autoplay-blocked owner snapshots preserve shared playing intent and transfer delay', async () => {
  let now = 10000;
  const { SharedAudioPlayback } = load('src/utils/sharedAudioPlayback.ts', {}, { Date: { now: () => now } });
  const media = { readyState: 1, duration: 120, currentTime: 0, paused: true, play: () => Promise.reject(new Error('blocked')), pause() {} };
  const owner = new SharedAudioPlayback(() => media, () => {});
  owner.set({ time: 20, playing: true, at: now });
  await Promise.resolve(); now += 5000;
  const snapshot = owner.snapshot();
  assert.equal(snapshot.playing, true); assert.equal(snapshot.time, 25); assert.equal(snapshot.at, now);
  now += 8000;
  const guestMedia = { ...media, play() { this.paused = false; return Promise.resolve(); } };
  const guest = new SharedAudioPlayback(() => guestMedia, () => {});
  guest.set(snapshot); await Promise.resolve();
  assert.equal(guestMedia.currentTime, 33); assert.equal(guestMedia.paused, false);
  owner.set({ time: 33, playing: false, at: now }); now += 9000;
  assert.equal(owner.snapshot().time, 33); assert.equal(owner.snapshot().playing, false);
});

test('whiteboard strokes, shapes and text retain identical world geometry after rotation and across DPRs', () => {
  const item = { x0: 300 / 1920, y0: 220 / 1080, x1: 400 / 1920, y1: 320 / 1080, color: 'white', width: 4 / 1080 };
  for (const dimensions of [{ innerWidth: 1440, innerHeight: 900, devicePixelRatio: 1 }, { innerWidth: 390, innerHeight: 844, devicePixelRatio: 3 }]) {
    const calls = [], effects = [], listeners = new Map(), handle = {};
    const context = new Proxy({ measureText: () => ({ width: 40 }) }, { get(target, key) { return target[key] ?? ((...args) => calls.push([key, ...args])); } });
    const canvas = { style: {}, getContext: () => context };
    const browser = { ...dimensions, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener() {} };
    const jsx = (type, props) => { if (type === 'canvas') props.ref.current = canvas; return { type, props }; };
    const react = { useRef: value => ({ current: value }), useState: value => [value, () => {}], useCallback: fn => fn, useEffect: fn => effects.push(fn), forwardRef: fn => fn, useImperativeHandle: (ref, fn) => Object.assign(ref, fn()) };
    const { Whiteboard } = load('src/components/Whiteboard.tsx', { react, 'react/jsx-runtime': { jsx, jsxs: jsx }, '../utils/drawingCoordinates': coordinates, '../utils/brush': { FONT_STACKS: { sans: 'sans-serif' }, metalFor: () => null } }, { window: browser });
    Whiteboard({ tool: 'pen', color: 'white', width: 4, nib: 'ballpoint', font: 'sans', textSize: 20, canvasTransform: { x: 0, y: 0, scale: 1 } }, handle);
    effects.forEach(fn => fn());
    handle.drawStroke(item);
    const dpr = dimensions.devicePixelRatio;
    assert.ok(calls.some(([name,x,y]) => name === 'moveTo' && x === 300 * dpr && y === 220 * dpr));
    handle.drawShape({ ...item, kind: 'shape', id: 'box', shape: 'rectangle' });
    handle.drawText({ kind: 'text', id: 'label', x: item.x0, y: item.y0, size: 20 / 1080, text: 'Label', color: 'white', font: 'sans' });
    assert.ok(calls.some(([name,text,x,y]) => name === 'fillText' && text === 'Label' && x === 300 * dpr && y === 220 * dpr));
    calls.length = 0;
    [browser.innerWidth, browser.innerHeight] = [browser.innerHeight, browser.innerWidth];
    listeners.get('resize')();
    assert.ok(calls.some(([name,x,y]) => name === 'moveTo' && x === 300 * dpr && y === 220 * dpr));
    assert.equal(canvas.width, browser.innerWidth * dpr);
    assert.equal(handle.getItems().length, 3);
  }
});

test('YouTube retains the final remote transport and volume while the iframe loads', async () => {
  const effects = [], calls = []; let options; let now = 10000;
  const player = { loadVideoById: id => calls.push(['load', id]), seekTo: time => calls.push(['seek', time]), playVideo: () => calls.push(['play']), pauseVideo: () => calls.push(['pause']), setVolume: value => calls.push(['volume', value]) };
  const react = { useRef: current => ({ current }), useCallback: fn => fn, useEffect: fn => effects.push(fn) };
  const { useYouTubePlayer } = load('src/hooks/useYouTubePlayer.ts', { react }, { Date: { now: () => now }, window: { location: { origin: 'https://maketogether.dev' }, YT: { Player: class { constructor(_element, input) { options = input; } } } }, document: { createElement: () => ({}) } });
  const controls = useYouTubePlayer({ current: { appendChild() {} } });
  effects.forEach(fn => fn()); await Promise.resolve();
  controls.loadVideo('shared-video'); controls.seekTo(40); controls.playVideo(); controls.pauseVideo(); controls.setVolume(25);
  now += 5000; options.events.onReady({ target: player });
  assert.ok(calls.some(([name,value]) => name === 'seek' && value === 40));
  assert.equal(calls.at(-1)[0], 'pause');
  assert.ok(calls.some(([name,value]) => name === 'volume' && value === 25));
  controls.restorePlayback('shared-video', 40, true, 10000);
  assert.equal(calls.at(-2)[1], 45);
});


test('restoring a room permits its deleted IDs again but rejects pre-import edits', () => {
  const order = new SharedMessageOrder();
  order.accept({ type: 'remove-panel', id: 'note', __sharedClock: 4 }, 'desktop');
  order.accept({ type: 'room-state-import', __sharedClock: 6 }, 'iphone');
  assert.equal(order.accept({ type: 'remove-panel', id: 'note', __sharedClock: 4 }, 'desktop'), false);
  assert.equal(order.accept({ type: 'note-update', id: 'note', __sharedClock: 7 }, 'desktop'), true);
});
