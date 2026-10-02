import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

function load(path, imports = {}) {
  const js = ts.transpileModule(
    readFileSync(new URL(`../${path}`, import.meta.url), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  const context = { exports: {}, require: (name) => imports[name], Blob };
  vm.runInNewContext(js, context);
  return context.exports;
}
const daw = load("src/utils/daw.ts");
const legacyTrack = (id, patch = {}) => ({
  id,
  name: id,
  sourceId: id,
  duration: 10,
  start: 0,
  trimStart: 0,
  trimEnd: 10,
  volume: 0.8,
  pan: 0,
  muted: false,
  solo: false,
  deleted: false,
  revision: 1,
  editId: id,
  ...patch,
});
const track = (id, patch = {}) => {
  const old = legacyTrack(id, patch);
  const { sourceId, duration, start, trimStart, trimEnd, ...metadata } = old;
  return {
    ...metadata,
    regions: [
      {
        id: `region:${id}`,
        name: old.name,
        sourceId,
        duration,
        start,
        trimStart,
        trimEnd,
        deleted: old.deleted,
        revision: old.revision,
        editId: old.editId,
      },
    ],
  };
};
const plain = (value) => JSON.parse(JSON.stringify(value));

test("concurrent additions and edits on different tracks converge without dropping tracks", () => {
  const a = track("a"),
    b = track("b");
  const left = daw.mergeDawTrack(daw.mergeDawTrack([], a), b);
  const right = daw.mergeDawTrack(daw.mergeDawTrack([], b), a);
  assert.deepEqual(plain(left), plain(right));
  const editA = track("a", { volume: 0.3, revision: 2 });
  const editB = track("b", { start: 5, revision: 2 });
  assert.deepEqual(
    plain(daw.mergeDawTrack(daw.mergeDawTrack(left, editA), editB)),
    plain(daw.mergeDawTrack(daw.mergeDawTrack(right, editB), editA)),
  );
});

test("same-track concurrent updates use a deterministic tie-breaker; stale edits are ignored", () => {
  const a = track("a", { editId: "first", volume: 0.3 });
  const b = track("a", { editId: "second", volume: 0.9 });
  assert.equal(daw.mergeDawTrack([a], b)[0].volume, 0.9);
  assert.equal(daw.mergeDawTrack([b], a)[0].volume, 0.9);
  assert.equal(
    daw.mergeDawTrack([b], track("a", { revision: 0 }))[0].volume,
    0.9,
  );
});

test("deletion wins over delayed edits and concurrent deletes converge", () => {
  const deleted = track("a", { deleted: true, revision: 2 });
  const stale = track("a", { revision: 3, volume: 0.2 });
  assert.equal(daw.mergeDawTrack([deleted], stale)[0].deleted, true);
  assert.equal(daw.mergeDawTrack([stale], deleted)[0].deleted, true);
  const anotherDelete = { ...deleted, editId: "z" };
  assert.deepEqual(
    plain(daw.mergeDawTrack([deleted], anotherDelete)),
    plain(daw.mergeDawTrack([anotherDelete], deleted)),
  );
});

test("rejects invalid trim, timeline, gain and non-finite input", () => {
  for (const patch of [
    { trimEnd: 11 },
    { trimStart: 10 },
    { start: -1 },
    { volume: 5 },
    { pan: 2 },
    { duration: NaN },
    { revision: Infinity },
    { start: 1800 },
  ]) {
    assert.equal(daw.isDawTrack(track("a", patch)), false);
    assert.equal(daw.mergeDawTrack([], track("a", patch)).length, 0);
  }
});

test("schedules source offsets, delayed starts and seeking past finished clips", () => {
  const clip = track("a", { start: 5, trimStart: 2, trimEnd: 8 });
  assert.deepEqual(plain(daw.clipSchedule(clip.regions[0], 0)), {
    delay: 5,
    offset: 2,
    duration: 6,
  });
  assert.deepEqual(plain(daw.clipSchedule(clip.regions[0], 7)), {
    delay: 0,
    offset: 4,
    duration: 4,
  });
  assert.equal(daw.clipSchedule(clip.regions[0], 11), null);
  assert.equal(daw.dawEnd([clip]), 11);
});

test("mute, solo and deleted tracks determine the audible mix", () => {
  const tracks = [
    track("a"),
    track("b", { solo: true }),
    track("c", { solo: true, muted: true }),
    track("d", { deleted: true, solo: true }),
  ];
  assert.deepEqual(plain(daw.audibleTracks(tracks).map((t) => t.id)), ["b"]);
});

test("all scheduled sources share one audio clock and use track gain and pan", () => {
  const starts = [],
    gains = [],
    pans = [];
  const node = () => ({
    connect(next) {
      return next;
    },
    disconnect() {},
  });
  const ctx = {
    destination: node(),
    createBufferSource: () => ({
      ...node(),
      playbackRate: { value: 1 },
      start: (...args) => starts.push(args),
    }),
    createGain: () => {
      const g = { ...node(), gain: { value: 0 } };
      gains.push(g);
      return g;
    },
    createStereoPanner: () => {
      const p = { ...node(), pan: { value: 0 } };
      pans.push(p);
      return p;
    },
  };
  daw.scheduleDaw(
    ctx,
    [
      track("a", { start: 2, pan: -0.5 }),
      track("b", { start: 4, volume: 0.4 }),
      track("c", { muted: true }),
    ],
    new Map([
      ["a", {}],
      ["b", {}],
      ["c", {}],
    ]),
    1,
    100,
  );
  assert.deepEqual(starts, [
    [101, 0, 10],
    [103, 0, 10],
  ]);
  assert.deepEqual(
    gains.map((g) => g.gain.value),
    [0.8, 0.4],
  );
  assert.deepEqual(
    pans.map((p) => p.pan.value),
    [-0.5, 0],
  );
});

test("WAV export interleaves stereo PCM, clamps peaks and writes correct headers", async () => {
  const samples = [new Float32Array([-2, 0.5]), new Float32Array([2, -0.5])];
  const blob = daw.encodeWav({
    numberOfChannels: 2,
    length: 2,
    sampleRate: 44100,
    getChannelData: (c) => samples[c],
  });
  const bytes = Buffer.from(await blob.arrayBuffer());
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
  assert.equal(bytes.readUInt16LE(22), 2);
  assert.equal(bytes.readUInt32LE(24), 44100);
  assert.equal(bytes.readUInt32LE(40), 8);
  assert.deepEqual(
    [44, 46, 48, 50].map((offset) => bytes.readInt16LE(offset)),
    [-32768, 32767, 16384, -16384],
  );
});

test("portable bundles retain DAW edits and reject malformed track metadata", () => {
  const { serialiseRoomBundle, parseRoomBundle } = load(
    "src/utils/roomBundle.ts",
    { "./daw": daw, "./roomPersistence": { ROOM_STATE_VERSION: 2 } },
  );
  const state = { x: 0, y: 0, width: 900, height: 480, z: 1 };
  const snapshot = {
    version: 2,
    savedAt: 1,
    viewport: { width: 1440, height: 900 },
    panels: [
      {
        id: "daw",
        type: "daw",
        state,
        dawTracks: [track("a", { start: 3, trimStart: 1 })],
        recordings: [{ id: "a", name: "a.wav" }],
      },
    ],
    fixedPanels: { local: state, remote: state },
    drawings: [],
    positionTags: [],
    dockedIds: [],
    panelLabels: {},
    customLabels: {},
    canvas: { x: 0, y: 0, scale: 1 },
  };
  assert.deepEqual(
    plain(parseRoomBundle(serialiseRoomBundle(snapshot))),
    snapshot,
  );
  snapshot.panels[0].dawTracks[0].regions[0].trimEnd = 99;
  assert.throws(
    () => parseRoomBundle(serialiseRoomBundle(snapshot)),
    /damaged/,
  );
});

const { dawShortcut } = load("src/utils/dawShortcuts.ts");
const keyEvent = (key, patch = {}) => ({
  key,
  code: key === " " ? "Space" : "",
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  ...patch,
});

test("DAW typing and IME composition never activate transport or destructive shortcuts", () => {
  for (const key of [
    " ",
    "r",
    "Enter",
    "Delete",
    "Backspace",
    "m",
    "s",
    "ArrowDown",
    "d",
  ]) {
    assert.equal(dawShortcut(keyEvent(key), true), null);
    assert.equal(
      dawShortcut(keyEvent(key, { isComposing: true }), false),
      null,
    );
  }
  assert.equal(dawShortcut(keyEvent("d", { metaKey: true }), true), null);
});

test("DAW shortcuts handle transport, deletion and platform duplicate modifiers", () => {
  assert.equal(dawShortcut(keyEvent(" "), false), "play");
  assert.equal(dawShortcut(keyEvent("R"), false), "record");
  assert.equal(dawShortcut(keyEvent("Enter"), false), "restart");
  assert.equal(dawShortcut(keyEvent("Delete"), false), "delete");
  assert.equal(dawShortcut(keyEvent("Backspace"), false), "delete");
  assert.equal(
    dawShortcut(keyEvent("d", { metaKey: true }), false),
    "duplicate",
  );
  assert.equal(
    dawShortcut(keyEvent("d", { ctrlKey: true }), false),
    "duplicate",
  );
  assert.equal(dawShortcut(keyEvent("r", { metaKey: true }), false), null);
  assert.equal(
    dawShortcut(keyEvent("d", { ctrlKey: true, altKey: true }), false),
    null,
  );
});

test("holding toggles cannot rapidly start/stop recording or delete multiple tracks", () => {
  for (const key of [" ", "r", "Delete", "Backspace", "m", "s", "Enter"])
    assert.equal(dawShortcut(keyEvent(key, { repeat: true }), false), null);
  assert.equal(
    dawShortcut(keyEvent("ArrowRight", { repeat: true }), false),
    "seek-forward",
  );
  assert.equal(
    dawShortcut(
      keyEvent("ArrowLeft", { altKey: true, shiftKey: true, repeat: true }),
      false,
    ),
    "nudge-back",
  );
  assert.equal(dawShortcut(keyEvent("ArrowDown"), false), "next-track");
  assert.equal(dawShortcut(keyEvent("?"), false), "help");
});

test("legacy tracks migrate without losing source or edits", () => {
  const old = legacyTrack("saved", { start: 7, trimStart: 2, pan: -0.4 });
  const migrated = daw.normaliseDawTrack(old);
  assert.equal(migrated.pan, -0.4);
  assert.equal(migrated.regions[0].sourceId, "saved");
  assert.equal(migrated.regions[0].start, 7);
  assert.equal(migrated.regions[0].trimStart, 2);
  assert.equal(daw.isDawTrack(migrated), true);
});
test("region deletion retains the track and survives delayed updates", () => {
  const original = track("a");
  const deleted = {
    ...original,
    regions: [{ ...original.regions[0], deleted: true, revision: 2 }],
  };
  const merged = daw.mergeDawTrack(
    daw.mergeDawTrack([original], deleted),
    original,
  )[0];
  assert.equal(merged.deleted, false);
  assert.equal(daw.visibleRegions(merged).length, 0);
  assert.equal(daw.dawEnd([merged]), 0);
  assert.equal(daw.isDawTrack({ ...merged, regions: [] }), true);
});
test("concurrent region edits and mixer edits on one track converge", () => {
  const original = track("a");
  original.regions.push({ ...original.regions[0], id: "second", start: 10 });
  const first = {
    ...original,
    regions: [{ ...original.regions[0], start: 3, revision: 2, editId: "x" }],
  };
  const second = {
    ...original,
    regions: [{ ...original.regions[1], start: 15, revision: 2, editId: "y" }],
  };
  const mixer = { ...original, pan: 0.5, revision: 3 };
  const reduce = (updates) => updates.reduce(daw.mergeDawTrack, [original]);
  const left = reduce([first, second, mixer]);
  assert.deepEqual(plain(left), plain(reduce([mixer, second, first])));
  assert.deepEqual(plain(left[0].regions.map((r) => r.start)), [3, 15]);
  assert.equal(left[0].pan, 0.5);
});
test("split preserves source offsets and arrangement length", () => {
  const r = track("a", { start: 5, trimStart: 2, trimEnd: 8 }).regions[0];
  const [left, right] = daw.splitDawRegion(r, 8, "right");
  assert.deepEqual(plain(daw.clipSchedule(left, 0)), {
    delay: 5,
    offset: 2,
    duration: 3,
  });
  assert.deepEqual(plain(daw.clipSchedule(right, 0)), {
    delay: 8,
    offset: 5,
    duration: 3,
  });
  assert.equal(daw.splitDawRegion(r, 5, "no"), null);
  assert.equal(daw.splitDawRegion(r, 11, "no"), null);
});

test("track creation order survives edits and converges across participants", () => {
  const older = { ...track("z"), order: 1 };
  const newer = { ...track("a"), order: 2 };
  const left = daw.mergeDawTrack(daw.mergeDawTrack([], newer), older);
  const right = daw.mergeDawTrack(daw.mergeDawTrack([], older), newer);
  assert.deepEqual(plain(left), plain(right));
  assert.deepEqual(plain(left.map((t) => t.id)), ["z", "a"]);
  assert.deepEqual(
    plain(daw.mergeDawTrack(left, { ...older, revision: 9 }).map((t) => t.id)),
    ["z", "a"],
  );
  assert.equal(daw.isDawTrack({ ...older, order: -1 }), false);
  assert.equal(daw.isDawTrack({ ...older, kind: "invalid" }), false);
});

test("MIDI regions validate note limits and keep notes through splitting", () => {
  const region = {
    ...track("m").regions[0],
    notes: [{ pitch: 60, start: 1, duration: 3, velocity: 0.8 }],
  };
  assert.equal(daw.isDawRegion(region), true);
  const split = daw.splitDawRegion(region, 2, "right");
  assert.deepEqual(plain(split[0].notes), plain(split[1].notes));
  for (const patch of [
    { pitch: 128 },
    { start: -1 },
    { duration: 0 },
    { duration: 20 },
    { velocity: 2 },
  ])
    assert.equal(
      daw.isDawRegion({ ...region, notes: [{ ...region.notes[0], ...patch }] }),
      false,
    );
});

test("MIDI scheduling seeks into held notes without requiring an audio file", () => {
  const starts = [],
    stops = [],
    frequencies = [];
  const node = () => ({
    connect(next) {
      return next;
    },
    disconnect() {},
  });
  const context = {
    destination: node(),
    createOscillator: () => {
      const source = {
        ...node(),
        frequency: { value: 0 },
        start: (time) => {
          starts.push(time);
          frequencies.push(source.frequency.value);
        },
        stop: (time) => stops.push(time),
      };
      return source;
    },
    createGain: () => ({
      ...node(),
      gain: { setValueAtTime() {}, linearRampToValueAtTime() {} },
    }),
    createStereoPanner: () => ({ ...node(), pan: { value: 0 } }),
  };
  const t = track("m");
  t.kind = "midi";
  t.regions[0].notes = [{ pitch: 69, start: 1, duration: 3, velocity: 0.8 }];
  const sources = daw.scheduleDaw(context, [t], new Map(), 2, 100);
  assert.equal(sources.length, 1);
  assert.deepEqual(starts, [100]);
  assert.deepEqual(stops, [102]);
  assert.deepEqual(frequencies, [440]);
});

const { waveformEnvelope } = load("src/utils/dawWaveform.ts");
test("waveform envelopes include short transients in either stereo channel", () => {
  const left = new Float32Array(4096),
    right = new Float32Array(4096);
  left[173] = -0.9;
  right[1777] = 0.8;
  const buffer = {
    length: 4096,
    numberOfChannels: 2,
    sampleRate: 4096,
    getChannelData: (c) => (c === 0 ? left : right),
  };
  const envelope = waveformEnvelope(buffer, 0, 1, 512);
  assert.equal(envelope.length, 512);
  assert.ok(envelope.some((p) => p.min < -0.89));
  assert.ok(envelope.some((p) => p.max > 0.79));
  const trimmed = waveformEnvelope(buffer, 0.5, 1, 128);
  assert.ok(trimmed.every((p) => p.min === 0 && p.max === 0));
});

test("reordering tracks preserves regions and mixer settings and supports legacy order", () => {
  const original = [track("a"), track("b"), track("c")];
  const changes = daw.reorderDawTracks(original, "a", "c", false);
  const reordered = changes.reduce(
    (tracks, t) => daw.mergeDawTrack(tracks, { ...t, revision: 10 }),
    original,
  );
  assert.deepEqual(plain(reordered.map((t) => t.id)), ["b", "c", "a"]);
  for (const t of reordered) {
    assert.deepEqual(
      plain(t.regions),
      plain(original.find((o) => o.id === t.id).regions),
    );
    assert.equal(t.volume, 0.8);
  }
  assert.equal(daw.reorderDawTracks(reordered, "a", "a", true).length, 0);
  assert.equal(daw.reorderDawTracks(reordered, "missing", "b", true).length, 0);
  const back = daw
    .reorderDawTracks(reordered, "a", "b", true)
    .reduce(
      (tracks, t) => daw.mergeDawTrack(tracks, { ...t, revision: 11 }),
      reordered,
    );
  assert.deepEqual(plain(back.map((t) => t.id)), ["a", "b", "c"]);
});

const dawSync = load("src/utils/dawSync.ts");
const activity = {
  revision: 3,
  id: "b",
  owner: "peer",
  mode: "playing",
  position: 12,
  at: 10000,
};
test("DAW activity catches up in-flight playback but preserves paused position", () => {
  assert.equal(dawSync.dawActivityPosition(activity, 12500), 14.5);
  assert.equal(
    dawSync.dawActivityPosition({ ...activity, mode: "stopped" }, 12500),
    12,
  );
  assert.equal(dawSync.dawActivityPosition(activity, 9000), 12);
  assert.equal(dawSync.dawActivityPosition(activity, 9000000), 1800);
});
test("DAW control ordering rejects stale commands and breaks concurrent ties consistently", () => {
  assert.ok(
    dawSync.compareDawActivity(activity, { ...activity, revision: 2 }) > 0,
  );
  assert.ok(dawSync.compareDawActivity(activity, { ...activity, id: "c" }) < 0);
  assert.equal(
    dawSync.compareDawActivity(activity, { ...activity, peaks: [] }),
    0,
  );
});
test("DAW activity validates bounded remote recording previews", () => {
  assert.ok(dawSync.validDawActivity(activity));
  assert.ok(
    dawSync.validDawActivity({
      ...activity,
      mode: "recording",
      trackId: "track",
      peaks: [{ at: 1, peak: 0.5 }],
    }),
  );
  for (const patch of [
    { position: NaN },
    { position: -1 },
    { at: Infinity },
    { mode: "recording" },
    { peaks: Array(601).fill({ at: 0, peak: 0 }) },
    { peaks: [{ at: 0, peak: 2 }] },
    { notes: [{ pitch: 200, start: 0, duration: 1, velocity: 1 }] },
  ])
    assert.equal(dawSync.validDawActivity({ ...activity, ...patch }), false);
});
