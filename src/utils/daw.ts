/** Track mixer state and independently editable audio regions. */
interface DawRevision {
  id: string;
  deleted: boolean;
  revision: number;
  editId: string;
}
export interface DawMidiNote {
  pitch: number;
  start: number;
  duration: number;
  velocity: number;
}
export interface DawRegion extends DawRevision {
  name: string;
  sourceId: string;
  notes?: DawMidiNote[];
  duration: number;
  start: number;
  trimStart: number;
  trimEnd: number;
  /** Total repeated timeline length; source trims remain unchanged. */
  loopDuration?: number;
  /** Source phase retained when splitting a repeated region. */
  loopOffset?: number;
  gain?: number;
  speed?: number;
  reverse?: boolean;
  restoredFrom?: { revision: number; editId: string };
}
export interface DawTrack extends DawRevision {
  name: string;
  volume: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  regions: DawRegion[];
  order?: number;
  kind?: "audio" | "midi";
}
export const MAX_DAW_SECONDS = 1800;
export const MAX_DAW_FILE_BYTES = 50 * 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const revision = (v: Record<string, unknown>) =>
  typeof v.id === "string" &&
  !!v.id &&
  typeof v.editId === "string" &&
  !!v.editId &&
  Number.isSafeInteger(v.revision) &&
  (v.revision as number) >= 0 &&
  typeof v.deleted === "boolean";
const named = (v: Record<string, unknown>) =>
  typeof v.name === "string" && v.name.length <= 200;
export function isDawRegion(value: unknown): value is DawRegion {
  if (!object(value) || !revision(value) || !named(value)) return false;
  const r = value as unknown as DawRegion;
  return (
    (r.notes === undefined ||
      (Array.isArray(r.notes) &&
        r.notes.length <= 10000 &&
        r.notes.every(
          (n) =>
            Number.isInteger(n.pitch) &&
            n.pitch >= 0 &&
            n.pitch <= 127 &&
            [n.start, n.duration, n.velocity].every(Number.isFinite) &&
            n.start >= 0 &&
            n.duration > 0 &&
            n.start + n.duration <= r.duration + 0.001 &&
            n.velocity > 0 &&
            n.velocity <= 1,
        ))) &&
    typeof r.sourceId === "string" &&
    !!r.sourceId &&
    [r.duration, r.start, r.trimStart, r.trimEnd].every(Number.isFinite) &&
    r.duration > 0 &&
    r.duration <= MAX_DAW_SECONDS &&
    r.start >= 0 &&
    r.trimStart >= 0 &&
    r.trimEnd <= r.duration &&
    r.trimEnd > r.trimStart &&
    (r.restoredFrom === undefined || (object(r.restoredFrom) && Number.isSafeInteger(r.restoredFrom.revision) && r.restoredFrom.revision >= 0 && typeof r.restoredFrom.editId === 'string')) &&
    (r.gain === undefined || (Number.isFinite(r.gain) && r.gain >= 0 && r.gain <= 2)) &&
    (r.speed === undefined || (Number.isFinite(r.speed) && r.speed >= 0.25 && r.speed <= 4)) &&
    (r.reverse === undefined || typeof r.reverse === "boolean") &&
    (r.loopDuration === undefined || (!r.notes && Number.isFinite(r.loopDuration) && r.loopDuration >= 0.01)) &&
    (r.loopOffset === undefined || (r.loopDuration !== undefined && Number.isFinite(r.loopOffset) && r.loopOffset >= 0 && r.loopOffset < r.trimEnd - r.trimStart)) &&
    r.start + regionDuration(r) <= MAX_DAW_SECONDS
  );
}
function trackMetadata(value: unknown): value is Record<string, unknown> {
  return (
    object(value) &&
    revision(value) &&
    named(value) &&
    Number.isFinite(value.volume) &&
    (value.volume as number) >= 0 &&
    (value.volume as number) <= 1 &&
    Number.isFinite(value.pan) &&
    (value.pan as number) >= -1 &&
    (value.pan as number) <= 1 &&
    (value.order === undefined ||
      (Number.isSafeInteger(value.order) && (value.order as number) >= 0)) &&
    (value.kind === undefined ||
      value.kind === "audio" ||
      value.kind === "midi") &&
    typeof value.muted === "boolean" &&
    typeof value.solo === "boolean"
  );
}
export function isDawTrack(value: unknown): value is DawTrack {
  return (
    trackMetadata(value) &&
    Array.isArray(value.regions) &&
    value.regions.length <= 1000 &&
    value.regions.every(isDawRegion) &&
    new Set(value.regions.map((r) => r.id)).size === value.regions.length
  );
}
/** Read earlier one-clip tracks without losing recordings, trims or mixer settings. */
export function normaliseDawTrack(value: unknown): DawTrack | null {
  if (isDawTrack(value)) return value;
  if (
    !trackMetadata(value) ||
    value.regions !== undefined ||
    !isDawRegion(value)
  )
    return null;
  const legacy = value as unknown as DawRegion & DawTrack;
  return {
    id: legacy.id,
    name: legacy.name,
    volume: legacy.volume,
    pan: legacy.pan,
    muted: legacy.muted,
    solo: legacy.solo,
    deleted: legacy.deleted,
    revision: legacy.revision,
    editId: legacy.editId,
    regions: [
      {
        id: `legacy:${legacy.id}`,
        name: legacy.name,
        sourceId: legacy.sourceId,
        duration: legacy.duration,
        start: legacy.start,
        trimStart: legacy.trimStart,
        trimEnd: legacy.trimEnd,
        deleted: legacy.deleted,
        revision: legacy.revision,
        editId: legacy.editId,
      },
    ],
  };
}
export const normaliseDawTracks = (tracks: unknown[] = []) =>
  tracks.map(normaliseDawTrack).filter((t): t is DawTrack => t !== null);
/** Delete wins; logical revision and unique edit id break concurrent ties. */
function winner<T extends DawRevision>(a: T, b: T): T {
  if (a.deleted !== b.deleted) return a.deleted ? a : b;
  return a.revision > b.revision ||
    (a.revision === b.revision && a.editId >= b.editId)
    ? a
    : b;
}
/** An explicit undo can supersede its own tombstone, never a newer deletion. */
function regionWinner(a: DawRegion, b: DawRegion) {
  if (a.deleted !== b.deleted) {
    const deleted = a.deleted ? a : b, active = a.deleted ? b : a;
    if (active.revision > deleted.revision && active.restoredFrom && (deleted.revision < active.restoredFrom.revision || (deleted.revision === active.restoredFrom.revision && deleted.editId <= active.restoredFrom.editId))) return active;
  }
  return winner(a, b);
}
export function restoreDawRegion(region: DawRegion, current?: DawRegion): DawRegion {
  return !region.deleted && current?.deleted
    ? { ...region, restoredFrom: { revision: current.revision, editId: current.editId } } : region;
}
export function mergeDawRegions(
  current: DawRegion[],
  incoming: DawRegion[],
): DawRegion[] {
  const all = new Map(current.map((r) => [r.id, r]));
  for (const r of incoming)
    if (isDawRegion(r))
      all.set(r.id, all.has(r.id) ? regionWinner(all.get(r.id)!, r) : r);
  return [...all.values()].sort(
    (a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}
export function mergeDawTrack(
  tracks: DawTrack[] = [],
  value: unknown,
): DawTrack[] {
  const incoming = normaliseDawTrack(value);
  if (!incoming) return tracks;
  const current = tracks.find((t) => t.id === incoming.id);
  const merged = current
    ? {
        ...winner(current, incoming),
        regions: mergeDawRegions(current.regions, incoming.regions),
      }
    : { ...incoming, regions: mergeDawRegions([], incoming.regions) };
  return [...tracks.filter((t) => t.id !== incoming.id), merged].sort(
    compareDawTracks,
  );
}
/** Legacy tracks retain their prior ID order; new tracks append after them. */
export const compareDawTracks = (a: DawTrack, b: DawTrack) =>
  (a.order ?? 0) - (b.order ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
/** Return only changed ranks; callers stamp and share each changed track. */
export function reorderDawTracks(
  tracks: DawTrack[],
  movingId: string,
  targetId: string,
  before: boolean,
): DawTrack[] {
  const ordered = tracks.filter((t) => !t.deleted).sort(compareDawTracks);
  const moving = ordered.find((t) => t.id === movingId);
  if (
    !moving ||
    movingId === targetId ||
    !ordered.some((t) => t.id === targetId)
  )
    return [];
  const next = ordered.filter((t) => t.id !== movingId);
  const target = next.findIndex((t) => t.id === targetId);
  next.splice(target + (before ? 0 : 1), 0, moving);
  if (next.every((t, i) => t.id === ordered[i].id)) return [];
  return next.flatMap((t, i) =>
    t.order === i + 1 ? [] : [{ ...t, order: i + 1 }],
  );
}
export const visibleRegions = (track: DawTrack) =>
  track.deleted ? [] : track.regions.filter((r) => !r.deleted);
export const regionDuration = (region: DawRegion) => region.loopDuration ?? (region.trimEnd - region.trimStart) / (region.speed ?? 1);
export function unloopDawRegion(region: DawRegion): DawRegion {
  if (region.loopDuration === undefined) return region;
  const phase = region.loopOffset ?? 0;
  const length = Math.min(region.loopDuration * (region.speed ?? 1), region.trimEnd - region.trimStart - phase);
  return { ...region, loopDuration: undefined, loopOffset: undefined,
    trimStart: region.reverse ? region.trimEnd - phase - length : region.trimStart + phase,
    trimEnd: region.reverse ? region.trimEnd - phase : region.trimStart + phase + length };
}
export function trimDawRegion(region: DawRegion, edge: 'left' | 'right', delta: number): DawRegion {
  const speed = region.speed ?? 1;
  const length = (region.trimEnd - region.trimStart) / speed;
  const next = { ...region, loopDuration: undefined, loopOffset: undefined };
  if (edge === 'left') {
    const available = (region.reverse ? region.duration - region.trimEnd : region.trimStart) / speed;
    const amount = Math.max(-region.start, -available, Math.min(length - 0.01, delta));
    next.start += amount;
    if (region.reverse) next.trimEnd -= amount * speed;
    else next.trimStart += amount * speed;
  } else {
    const available = (region.reverse ? region.trimStart : region.duration - region.trimEnd) / speed;
    const amount = Math.max(-length + 0.01, Math.min(available, MAX_DAW_SECONDS - region.start - length, delta));
    if (region.reverse) next.trimStart -= amount * speed;
    else next.trimEnd += amount * speed;
  }
  return next;
}
export const dawEnd = (tracks: DawTrack[]) =>
  Math.max(
    0,
    ...tracks.flatMap((t) =>
      visibleRegions(t).map((r) => r.start + regionDuration(r)),
    ),
  );
export const audibleTracks = (tracks: DawTrack[]) => {
  const active = tracks.filter((t) => !t.deleted);
  const solo = active.some((t) => t.solo);
  return active.filter((t) => !t.muted && (!solo || t.solo));
};
export function clipSchedule(region: DawRegion, playhead: number) {
  if (region.deleted) return null;
  const skipped = Math.max(0, playhead - region.start);
  const duration = regionDuration(region) - skipped;
  return duration > 0
    ? {
        delay: Math.max(0, region.start - playhead),
        offset: region.trimStart + (region.loopDuration === undefined ? skipped * (region.speed ?? 1)
          : ((region.loopOffset ?? 0) + skipped * (region.speed ?? 1)) % (region.trimEnd - region.trimStart)),
        duration,
      }
    : null;
}
/** Non-destructive split: both regions retain the original source. */
export function splitDawRegion(
  region: DawRegion,
  position: number,
  rightId: string,
): [DawRegion, DawRegion] | null {
  const offset = position - region.start;
  if (
    region.deleted ||
    offset < 0.01 ||
    offset > regionDuration(region) - 0.01
  )
    return null;
  if (region.loopDuration !== undefined) return [
    { ...region, loopDuration: offset },
    { ...region, id: rightId, start: position, loopDuration: region.loopDuration - offset,
      loopOffset: ((region.loopOffset ?? 0) + offset * (region.speed ?? 1)) % (region.trimEnd - region.trimStart) },
  ];
  const sourceOffset = offset * (region.speed ?? 1);
  if (region.reverse) return [
    { ...region, trimStart: region.trimEnd - sourceOffset },
    { ...region, id: rightId, start: position, trimEnd: region.trimEnd - sourceOffset },
  ];
  return [
    { ...region, trimEnd: region.trimStart + sourceOffset },
    { ...region, id: rightId, start: position, trimStart: region.trimStart + sourceOffset },
  ];
}
export function scheduleDaw(
  context: BaseAudioContext,
  tracks: DawTrack[],
  buffers: Map<string, AudioBuffer>,
  playhead: number,
  when: number,
) {
  const sources: AudioScheduledSourceNode[] = [];
  for (const track of audibleTracks(tracks))
    for (const region of visibleRegions(track)) {
      const buffer = buffers.get(region.sourceId),
        clip = clipSchedule(region, playhead);
      if (!clip) continue;
      if (region.notes) {
        for (const note of region.notes) {
          const from = Math.max(note.start, clip.offset);
          const end = Math.min(
            note.start + note.duration,
            clip.offset + clip.duration,
          );
          if (end <= from) continue;
          const at = when + clip.delay + from - clip.offset;
          sources.push(
            scheduleDawNote(
              context,
              note.pitch,
              note.velocity * track.volume,
              track.pan,
              at,
              end - from,
            ),
          );
        }
        continue;
      }
      if (!buffer) continue;
      const source = context.createBufferSource(),
        gain = context.createGain(),
        pan = context.createStereoPanner();
      source.buffer = region.reverse ? reversedDawBuffer(context, buffer) : buffer;
      source.playbackRate.value = region.speed ?? 1;
      if (region.loopDuration !== undefined) {
        source.loop = true;
        source.loopStart = region.reverse ? buffer.duration - region.trimEnd : region.trimStart;
        source.loopEnd = region.reverse ? buffer.duration - region.trimStart : region.trimEnd;
      }
      gain.gain.value = track.volume * (region.gain ?? 1);
      pan.pan.value = track.pan;
      source.connect(gain).connect(pan).connect(context.destination);
      source.onended = () => {
        source.disconnect();
        gain.disconnect();
        pan.disconnect();
      };
      const offset = region.reverse ? buffer.duration - region.trimEnd + clip.offset - region.trimStart : clip.offset;
      if (region.loopDuration !== undefined) {
        source.start(when + clip.delay, offset);
        source.stop(when + clip.delay + clip.duration);
      } else source.start(when + clip.delay, offset, clip.duration * (region.speed ?? 1));
      sources.push(source);
    }
  return sources;
}

const reverseBuffers = new WeakMap<AudioBuffer, AudioBuffer>();
export function reversedDawBuffer(context: BaseAudioContext, buffer: AudioBuffer) {
  let reversed = reverseBuffers.get(buffer);
  if (!reversed) {
    reversed = context.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const from = buffer.getChannelData(channel), to = reversed.getChannelData(channel);
      for (let i = 0; i < from.length; i++) to[i] = from[from.length - i - 1];
    }
    reverseBuffers.set(buffer, reversed);
  }
  return reversed;
}

/** A basic soft synth, shared by live keys, playback and offline export. */
export function scheduleDawNote(
  context: BaseAudioContext,
  pitch: number,
  volume: number,
  panValue: number,
  when: number,
  duration: number,
) {
  const source = context.createOscillator(),
    gain = context.createGain(),
    pan = context.createStereoPanner();
  source.type = "triangle";
  source.frequency.value = 440 * 2 ** ((pitch - 69) / 12);
  pan.pan.value = panValue;
  gain.gain.setValueAtTime(0, when);
  gain.gain.linearRampToValueAtTime(
    volume * 0.2,
    when + Math.min(0.01, duration / 3),
  );
  gain.gain.setValueAtTime(
    volume * 0.2,
    when + Math.max(Math.min(0.01, duration / 3), duration - 0.03),
  );
  gain.gain.linearRampToValueAtTime(0, when + duration);
  source.connect(gain).connect(pan).connect(context.destination);
  source.onended = () => {
    source.disconnect();
    gain.disconnect();
    pan.disconnect();
  };
  source.start(when);
  source.stop(when + duration);
  return source;
}

export function encodeWav(buffer: AudioBuffer): Blob {
  const channels = buffer.numberOfChannels;
  const bytes = buffer.length * channels * 2;
  const data = new ArrayBuffer(44 + bytes);
  const view = new DataView(data);
  const word = (offset: number, text: string) =>
    [...text].forEach((letter, i) =>
      view.setUint8(offset + i, letter.charCodeAt(0)),
    );
  word(0, "RIFF");
  view.setUint32(4, 36 + bytes, true);
  word(8, "WAVE");
  word(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  word(36, "data");
  view.setUint32(40, bytes, true);
  const samples = Array.from({ length: channels }, (_, c) =>
    buffer.getChannelData(c),
  );
  for (let i = 0; i < buffer.length; i++)
    for (let c = 0; c < channels; c++) {
      const sample = Math.max(-1, Math.min(1, samples[c][i]));
      view.setInt16(
        44 + (i * channels + c) * 2,
        Math.round(sample * (sample < 0 ? 32768 : 32767)),
        true,
      );
    }
  return new Blob([data], { type: "audio/wav" });
}
