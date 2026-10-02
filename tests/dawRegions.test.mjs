import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(path, imports = {}) {
  const scope = { exports: {}, require: name => imports[name], Blob };
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, scope);
  return scope.exports;
}
const daw = load('src/utils/daw.ts');
const plain = value => JSON.parse(JSON.stringify(value));
const region = patch => ({ id: 'r', sourceId: 'source', name: 'take', duration: 10, start: 3, trimStart: 2, trimEnd: 6, deleted: false, revision: 1, editId: 'first', ...patch });
const track = regions => ({ id: 'track', name: 'audio', kind: 'audio', volume: 0.5, pan: -0.5, muted: false, solo: false, deleted: false, revision: 1, editId: 'track', regions });
function buffer(samples, sampleRate = 1) {
  const channels = samples.map(samples => Float32Array.from(samples));
  return { numberOfChannels: channels.length, length: channels[0].length, sampleRate,
    duration: channels[0].length / sampleRate, getChannelData: index => channels[index] };
}
function audioContext() {
  const sources = [], gains = [], pans = [];
  const node = () => ({ connect(target) { return target; }, disconnect() { this.disconnected = true; } });
  return { sources, gains, pans, destination: {},
    createBufferSource() { const source = { ...node(), playbackRate: { value: 1 }, start(...args) { this.started = args; }, stop(at) { this.stopped = at; } }; sources.push(source); return source; },
    createGain() { const gain = { ...node(), gain: {} }; gains.push(gain); return gain; },
    createStereoPanner() { const pan = { ...node(), pan: {} }; pans.push(pan); return pan; },
    createBuffer(channels, length, sampleRate) { return buffer(Array.from({ length: channels }, () => Array(length).fill(0)), sampleRate); },
  };
}

test('loop playback seeks to the repeated source phase and stops at a partial last repeat', () => {
  const r = region({ loopDuration: 7, loopOffset: 1, speed: 2, gain: 1.5 });
  assert.equal(daw.isDawRegion(r), true);
  assert.equal(daw.dawEnd([track([r])]), 10);
  assert.deepEqual(plain(daw.clipSchedule(r, 5.5)), { delay: 0, offset: 4, duration: 4.5 });
  const ctx = audioContext();
  daw.scheduleDaw(ctx, [track([r])], new Map([['source', buffer([Array(10).fill(0)])]]), 5.5, 20);
  assert.equal(ctx.sources.length, 1, 'loops use one native source rather than one per repetition');
  const source = ctx.sources[0];
  assert.equal(source.loop, true);
  assert.deepEqual([source.loopStart, source.loopEnd, source.playbackRate.value], [2, 6, 2]);
  assert.deepEqual(source.started, [20, 4]); assert.equal(source.stopped, 24.5);
  assert.equal(ctx.gains[0].gain.value, 0.75); assert.equal(ctx.pans[0].pan.value, -0.5);
  source.onended(); assert.equal(source.disconnected, true);
  assert.equal(daw.clipSchedule(r, 10), null);
});

test('reverse preserves source files and remaps source bounds for playback and loops', () => {
  const sourceBuffer = buffer([[0,1,2,3,4,5,6,7,8,9], [9,8,7,6,5,4,3,2,1,0]]);
  const ctx = audioContext();
  const r = region({ reverse: true, speed: 2, loopDuration: 7, loopOffset: 1 });
  daw.scheduleDaw(ctx, [track([r])], new Map([['source', sourceBuffer]]), 5.5, 20);
  const source = ctx.sources[0];
  assert.deepEqual(Array.from(sourceBuffer.getChannelData(0)), [0,1,2,3,4,5,6,7,8,9]);
  assert.deepEqual(Array.from(source.buffer.getChannelData(0)), [9,8,7,6,5,4,3,2,1,0]);
  assert.deepEqual([source.loopStart, source.loopEnd, source.started[1]], [4, 8, 6]);
  assert.equal(daw.reversedDawBuffer(ctx, sourceBuffer), source.buffer, 'reuse the reversed source');
});

test('splitting inside a repeat retains phase and splitting reversed audio retains ordering', () => {
  const loop = region({ speed: 2, loopDuration: 7, loopOffset: 1 });
  const parts = daw.splitDawRegion(loop, 5.5, 'right');
  assert.deepEqual(Array.from(parts, daw.regionDuration), [2.5, 4.5]);
  assert.equal(parts[1].loopOffset, 2);
  assert.equal(daw.clipSchedule(parts[1], 5.5).offset, daw.clipSchedule(loop, 5.5).offset);
  assert.ok(parts.every(daw.isDawRegion));
  const reversed = daw.splitDawRegion(region({ reverse: true, speed: 2 }), 4, 'right');
  assert.deepEqual(plain(reversed.map(r => [r.start, r.trimStart, r.trimEnd])), [[3,4,6],[4,2,4]]);
  assert.ok(reversed.every(daw.isDawRegion));
});

test('trim handles account for speed and reverse and remove looping without changing the source', () => {
  for (const reverse of [false, true]) {
    const r = region({ reverse, speed: 2, loopDuration: 10 });
    const left = daw.trimDawRegion(r, 'left', 0.5);
    assert.equal(left.start, 3.5); assert.equal(daw.regionDuration(left), 1.5);
    assert.equal(left.loopDuration, undefined); assert.equal(left.sourceId, r.sourceId);
    const right = daw.trimDawRegion(r, 'right', -0.5);
    assert.equal(daw.regionDuration(right), 1.5);
    assert.ok(daw.isDawRegion(left)); assert.ok(daw.isDawRegion(right));
  }
});

test('invalid settings and out-of-bounds loops are rejected; metadata survives room exports', () => {
  for (const patch of [{ loopDuration: Infinity }, { loopDuration: -1 }, { loopDuration: 1800 }, { loopOffset: 4, loopDuration: 8 }, { loopOffset: 1 }, { gain: 3 }, { speed: 0 }, { reverse: 'yes' }]) {
    assert.equal(daw.isDawRegion(region(patch)), false);
  }
  const r = region({ loopDuration: 8, loopOffset: 1, gain: 0.75, speed: 2, reverse: true });
  const { serialiseRoomBundle, parseRoomBundle } = load('src/utils/roomBundle.ts', { './daw': daw, './roomPersistence': { ROOM_STATE_VERSION: 2 } });
  const state = { x: 0, y: 0, width: 900, height: 480, z: 1 };
  const snapshot = { version: 2, savedAt: 1, viewport: { width: 1440, height: 900 }, panels: [{ id: 'daw', type: 'daw', state, dawTracks: [track([r])] }], fixedPanels: { local: state, remote: state }, drawings: [], positionTags: [], dockedIds: [], panelLabels: {}, customLabels: {}, canvas: { x: 0, y: 0, scale: 1 } };
  assert.deepEqual(plain(parseRoomBundle(serialiseRoomBundle(snapshot)).panels[0].dawTracks[0].regions[0]), r);
  const remote = { ...r, loopDuration: 12, revision: 2, editId: 'remote' };
  const merged = daw.mergeDawTrack([track([r])], track([remote]));
  assert.equal(merged[0].regions[0].loopDuration, 12);
});

test('waveform repeats at the original time scale and reverses inside each repeat', () => {
  const { regionWaveformEnvelope } = load('src/utils/dawWaveform.ts');
  const b = buffer([Array.from({ length: 512 }, (_, index) => (Math.floor(index / 128) + 1) / 10)], 128);
  const r = region({ duration: 4, start: 0, trimStart: 1, trimEnd: 3, loopDuration: 4 });
  const values = regionWaveformEnvelope(b, r, 0, 4, 4).map(p => Number(p.max.toFixed(1)));
  assert.deepEqual(Array.from(values), [0.2,0.3,0.2,0.3]);
  const reversed = regionWaveformEnvelope(b, { ...r, reverse: true }, 0, 4, 4).map(p => Number(p.max.toFixed(1)));
  assert.deepEqual(Array.from(reversed), [0.3,0.2,0.3,0.2]);
});

test('undo groups a drag, supports consecutive replay, and preserves a remote edit', () => {
  const { DawRegionHistory } = load('src/utils/dawRegionHistory.ts');
  const history = new DawRegionHistory(); let tracks = [track([region()])], revision = 1;
  const apply = (t, regions) => { const next = regions.map(r => ({ ...daw.restoreDawRegion(r, t.regions.find(current => current.id === r.id)), revision: ++revision, editId: `edit-${revision}` })); tracks = daw.mergeDawTrack(tracks, { ...t, regions: daw.mergeDawRegions(t.regions, next) }); return next; };
  const edit = (patch, gesture) => { const before = tracks[0].regions; const after = apply(tracks[0], [{ ...before[0], ...patch }]); history.record('track', before, after, gesture); };
  edit({ loopDuration: 8 }, 'drag'); edit({ loopDuration: 12 }, 'drag'); edit({ gain: 0.5 });
  assert.equal(history.replay('undo', tracks, apply), true); assert.equal(tracks[0].regions[0].gain, undefined);
  assert.equal(history.replay('undo', tracks, apply), true); assert.equal(tracks[0].regions[0].loopDuration, undefined);
  assert.equal(history.canUndo, false);
  assert.equal(history.replay('redo', tracks, apply), true); assert.equal(tracks[0].regions[0].loopDuration, 12);
  assert.equal(history.replay('redo', tracks, apply), true); assert.equal(tracks[0].regions[0].gain, 0.5);
  tracks[0].regions[0] = { ...tracks[0].regions[0], gain: 0.9, revision: 99, editId: 'peer' };
  assert.equal(history.replay('undo', tracks, apply), false); assert.equal(tracks[0].regions[0].gain, 0.9);
});

test('moving between tracks undoes as one operation', () => {
  const { DawRegionHistory } = load('src/utils/dawRegionHistory.ts');
  const history = new DawRegionHistory(); const original = region();
  let tracks = [track([original]), { ...track([]), id: 'other' }]; let revision = 1;
  const apply = (t, regions) => { const next = regions.map(r => ({ ...daw.restoreDawRegion(r, t.regions.find(current => current.id === r.id)), revision: ++revision, editId: `edit-${revision}` })); tracks = daw.mergeDawTrack(tracks, { ...t, regions: daw.mergeDawRegions(t.regions, next) }); return next; };
  const copied = { ...original, id: 'moved' };
  const moved = apply(tracks[1], [copied]); history.record('other', [], moved, 'move');
  const removed = apply(tracks.find(t => t.id === 'track'), [{ ...original, deleted: true }]); history.record('track', [original], removed, 'move');
  assert.equal(history.replay('undo', tracks, apply), true);
  assert.equal(tracks.find(t => t.id === 'track').regions[0].deleted, false); assert.equal(tracks.find(t => t.id === 'other').regions[0].deleted, true);
  assert.equal(history.canUndo, false);
  assert.equal(history.replay('redo', tracks, apply), true);
  assert.equal(tracks.find(t => t.id === 'track').regions[0].deleted, true); assert.equal(tracks.find(t => t.id === 'other').regions[0].deleted, false);
});


test('explicit undo supersedes its own deletion but newer deletions and stale edits still win', () => {
  const deleted = region({ deleted: true, revision: 2, editId: 'deleted' });
  const restored = { ...daw.restoreDawRegion(region(), deleted), revision: 3, editId: 'restored' };
  assert.equal(daw.mergeDawRegions([deleted], [restored])[0].deleted, false);
  assert.equal(daw.mergeDawRegions([restored], [deleted])[0].deleted, false);
  const newerDelete = { ...deleted, revision: 4, editId: 'new-delete' };
  assert.equal(daw.mergeDawRegions([restored], [newerDelete])[0].deleted, true);
  assert.equal(daw.mergeDawRegions([deleted], [region({ revision: 9, editId: 'ordinary-edit' })])[0].deleted, true);
});


test('removing a split loop retains its first audible portion and source phase', () => {
  for (const reverse of [false, true]) {
    const r = region({ loopDuration: 1, loopOffset: 2, speed: 2, reverse });
    const unlooped = daw.unloopDawRegion(r);
    assert.equal(daw.regionDuration(unlooped), 1);
    assert.equal(unlooped.loopDuration, undefined);
    assert.equal(daw.isDawRegion(unlooped), true);
    assert.deepEqual([unlooped.trimStart, unlooped.trimEnd], reverse ? [2, 4] : [4, 6]);
  }
});


test('loop sections show distinct full and partial repeats at the recorded time scale', () => {
  const { dawLoopSections } = load('src/utils/dawLoopSections.ts', { './daw': daw });
  const sections = dawLoopSections(region({ loopDuration: 8.5 }), 10, 0, 200);
  assert.deepEqual(plain(sections), [{ index: 0, left: 0, width: 40 }, { index: 1, left: 40, width: 40 }, { index: 2, left: 80, width: 5 }]);
  assert.deepEqual(plain(dawLoopSections(region(), 10, 0, 200)), []);
});

test('split phases and speed determine loop section boundaries; only visible repeats are rendered', () => {
  const { dawLoopSections } = load('src/utils/dawLoopSections.ts', { './daw': daw });
  assert.deepEqual(plain(dawLoopSections(region({ loopDuration: 5, loopOffset: 1, speed: 2 }), 10, 0, 200)), [
    { index: 0, left: 0, width: 15 }, { index: 1, left: 15, width: 20 }, { index: 2, left: 35, width: 15 },
  ]);
  const visible = dawLoopSections(region({ loopDuration: 1000 }), 10, 100, 50);
  assert.deepEqual(Array.from(visible, section => section.index), [2, 3]);
  assert.deepEqual(plain(dawLoopSections(region({ loopDuration: 8 }), 10, 100, 50)), []);
  assert.equal(dawLoopSections(region({ trimStart: 0, trimEnd: 0.001, loopDuration: 1000 }), 10, 0, 100), null);
});
