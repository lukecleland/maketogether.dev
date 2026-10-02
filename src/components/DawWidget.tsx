import { Toast } from './Toast';
import { useDawSync, type DawVoice } from "../hooks/useDawSync";
import type { RoomDataConnection } from "../hooks/usePeer";
import { dawActivityPosition, type DawActivity } from "../utils/dawSync";
import { createDawAudioContext, dawAudioNeedsGesture, resumeDawAudio } from '../utils/dawAudio';
import { DawCreateTrackDialog } from "./DawCreateTrackDialog";
import { DawWaveform } from "./DawWaveform";
import { DawInstrument } from "./DawInstrument";
import {
  useEffect,
  useCallback,
  useEffectEvent,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent,
} from "react";
import { DawPanDial } from "./DawPanDial";
import { DawMenu, type DawMenuItem } from "./DawMenu";
import { DawTransportIcon } from "./DawTransportIcon";
import { dawShortcut } from "../utils/dawShortcuts";
import type { RecordingClip } from "../types/panels";
import {
  audibleTracks,
  compareDawTracks,
  reorderDawTracks,
  scheduleDawNote,
  type DawMidiNote,
  visibleRegions,
  mergeDawTrack,
  mergeDawRegions,
  splitDawRegion,
  type DawRegion,
  dawEnd,
  encodeWav,
  MAX_DAW_FILE_BYTES,
  MAX_DAW_SECONDS,
  scheduleDaw,
  type DawTrack,
} from "../utils/daw";

interface Props {
  id: string;
  dataConnection?: RoomDataConnection | null;
  title: string;
  tracks: DawTrack[];
  recordings: RecordingClip[];
  onTrack: (track: DawTrack) => void;
  onFile: (recording: RecordingClip) => void;
  onClose: () => void;
  onMinimize: () => void;
  onToggleDock: () => void;
  transferProgress?: number;
  minimized?: boolean;
}

const button =
  "rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed";
const colours = ["#34d399", "#a78bfa", "#38bdf8", "#fbbf24", "#fb7185"];
const time = (seconds: number) => {
  const tenths = Math.max(0, Math.floor(seconds * 10));
  return `${Math.floor(tenths / 600)}:${((tenths % 600) / 10).toFixed(1).padStart(4, "0")}`;
};

export function DawWidget({
  id,
  dataConnection,
  title,
  tracks,
  recordings,
  onTrack,
  onFile,
  onClose,
  onMinimize,
  onToggleDock,
  transferProgress,
  minimized = false,
}: Props) {
  const remoteActivityRef = useRef<DawActivity | null>(null);
  const remoteClockRef = useRef<{
    id: string;
    position: number;
    at: number;
  } | null>(null);
  const remotePosition = useCallback((activity: DawActivity) => {
    const clock = remoteClockRef.current;
    if (!clock || clock.id !== activity.id)
      return dawActivityPosition(activity);
    return Math.min(
      MAX_DAW_SECONDS,
      clock.position +
        (activity.mode === "stopped"
          ? 0
          : (performance.now() - clock.at) / 1000),
    );
  }, []);
  const receivedCommandRef = useRef("");
  const localTakeRef = useRef(false);
  const [remoteNotes, setRemoteNotes] = useState<DawMidiNote[]>([]);
  const contextRef = useRef<AudioContext | null>(null);
  const buffersRef = useRef(new Map<string, AudioBuffer>());
  const filesRef = useRef(new Map<string, File>());
  const [buffers, setBuffers] = useState(new Map<string, AudioBuffer>());
  const [selected, setSelectedLocal] = useState<string | null>(null);
  const [selectedRegionId, setSelectedRegionIdLocal] = useState<string | null>(
    null,
  );
  const [menu, setMenu] = useState<{
    kind: string;
    x: number;
    y: number;
    trackId?: string;
    regionId?: string;
  } | null>(null);
  const [trackDrag, setTrackDrag] = useState<{
    id: string;
    target: string;
    before: boolean;
  } | null>(null);
  const trackDragRef = useRef<{
    id: string;
    target: string;
    before: boolean;
    y: number;
    moved: boolean;
  } | null>(null);
  const clipboard = useRef<DawRegion | null>(null);
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const [playhead, setPlayhead] = useState(0);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [recording, setRecording] = useState(false);
  const [zoom, setZoomLocal] = useState(0);
  const setSelected = (value: string | null) => {
    setSelectedLocal(value);
    sync.publishView({ selected: value });
  };
  const setSelectedRegionId = (value: string | null) => {
    setSelectedRegionIdLocal(value);
    sync.publishView({ region: value });
  };
  const setZoom = (value: number | ((previous: number) => number)) => {
    const next = typeof value === "function" ? value(zoom) : value;
    setZoomLocal(next);
    sync.publishView({ zoom: next });
  };
  const [viewportWidth, setViewportWidth] = useState(640);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [createTrackOpen, setCreateTrackOpen] = useState(false);
  const remoteVoicesRef = useRef(new Map<string, AudioScheduledSourceNode>());
  const remoteVoiceStateRef = useRef(new Map<string, DawVoice[]>());
  const instrumentNotes = useRef(new Map<number, AudioScheduledSourceNode>());
  const midiTake = useRef<{
    trackId: string;
    start: number;
    notes: DawMidiNote[];
    held: Map<number, number>;
  } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [keyboardActive, setKeyboardActive] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [liveTake, setLiveTake] = useState<{
    trackId: string;
    start: number;
  } | null>(null);
  const [livePeaks, setLivePeaks] = useState<{ at: number; peak: number }[]>(
    [],
  );
  const analyserRef = useRef<AnalyserNode | null>(null);
  const microphoneSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const scrubbingRef = useRef<number | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const recordingStartedRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const relinkRef = useRef<DawRegion | null>(null);
  const aliveRef = useRef(true);
  const revisionRef = useRef(0);
  const sourcesRef = useRef<AudioScheduledSourceNode[]>([]);
  const transportRequestRef = useRef(0);
  const transportRef = useRef({ active: false, at: 0, offset: 0 });
  const recorderRef = useRef<MediaRecorder | null>(null);
  const micRef = useRef<MediaStream | null>(null);
  const recordTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragRef = useRef<{
    id: string;
    x: number;
    region: DawRegion;
    edge: string;
    pixelsPerSecond: number;
  } | null>(null);
  const active = tracks.filter((t) => !t.deleted).sort(compareDawTracks);
  const selectedTrack = active.find((t) => t.id === selected);
  const selectedRegion =
    selectedTrack &&
    visibleRegions(selectedTrack).find((r) => r.id === selectedRegionId);
  const duration = dawEnd(tracks);
  const cursor =
    recording && liveTake ? liveTake.start + recordingSeconds : playhead;
  const timelineSeconds = Math.max(
    30,
    duration + 5,
    Math.ceil((cursor + 5) / 30) * 30,
  );
  const fitWidth = Math.max(100, viewportWidth - 230);
  const timelineWidth = fitWidth * 2 ** (zoom / 15);
  const pixelsPerSecond = timelineWidth / timelineSeconds;
  const rulerStep =
    [1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find(
      (step) => step * pixelsPerSecond >= 65,
    ) ?? 600;
  useEffect(() => {
    const node = timelineRef.current;
    if (!node) return;
    const resize = new ResizeObserver(() => setViewportWidth(node.clientWidth));
    resize.observe(node);
    setViewportWidth(node.clientWidth);
    return () => resize.disconnect();
  }, []);
  const missing = audibleTracks(tracks).some((t) =>
    visibleRegions(t).some((r) => !r.notes && !buffers.has(r.sourceId)),
  );

  const context = () => {
    if (!contextRef.current || contextRef.current.state === 'closed') {
      const ctx = createDawAudioContext();
      contextRef.current = ctx;
      ctx.onstatechange = () => {
        if (aliveRef.current) setAudioBlocked(dawAudioNeedsGesture(ctx));
      };
      setAudioBlocked(dawAudioNeedsGesture(ctx));
    }
    return contextRef.current;
  };
  const stopSources = () => {
    sourcesRef.current.forEach((source) => {
      try {
        source.stop();
      } catch {
        /* Already finished. */
      }
    });
    sourcesRef.current = [];
  };
  const stop = (reset = false, share = true) => {
    const position = reset ? 0 : currentPosition();
    if (share) {
      sync.publish("stopped", position);
      remoteActivityRef.current = null;
    }
    transportRequestRef.current++;
    const transport = transportRef.current;
    setPlayhead(position);
    transport.active = false;
    stopSources();
    setPlaying(false);
  };

  useEffect(() => {
    aliveRef.current = true;
    const voices = instrumentNotes.current;
    const remoteVoices = remoteVoicesRef.current;
    return () => {
      aliveRef.current = false;
      transportRef.current.active = false;
      sourcesRef.current.forEach((source) => {
        try {
          source.stop();
        } catch {
          /* Finished. */
        }
      });
      if (recordTimerRef.current) clearTimeout(recordTimerRef.current);
      if (recorderRef.current?.state === "recording")
        recorderRef.current.stop();
      voices.forEach((note) => {
        try {
          note.stop();
        } catch {
          /* stopped */
        }
      });
      voices.clear();
      remoteVoices.forEach((node) => {
        try {
          node.stop();
        } catch {
          /* stopped */
        }
      });
      remoteVoices.clear();
      midiTake.current = null;
      microphoneSourceRef.current?.disconnect();
      analyserRef.current?.disconnect();
      micRef.current?.getTracks().forEach((track) => track.stop());
      void contextRef.current?.close();
      contextRef.current = null;
    };
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    const releaseKeyboard = (event: PointerEvent) => {
      if (
        root &&
        !root.contains(event.target as Node) &&
        root.contains(document.activeElement)
      ) {
        (document.activeElement as HTMLElement | null)?.blur();
      }
    };
    document.addEventListener("pointerdown", releaseKeyboard, true);
    return () =>
      document.removeEventListener("pointerdown", releaseKeyboard, true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const decode = async () => {
      for (const clip of recordings) {
        if (filesRef.current.get(clip.id) === clip.file) continue;
        try {
          const decoded = await context().decodeAudioData(
            await clip.file.arrayBuffer(),
          );
          if (cancelled) return;
          filesRef.current.set(clip.id, clip.file);
          buffersRef.current.set(clip.id, decoded);
          setBuffers(new Map(buffersRef.current));
        } catch {
          if (!cancelled)
            setError(
              `Could not decode ${clip.name}. Try a WAV, MP3 or another browser-supported audio file.`,
            );
        }
      }
    };
    void decode();
    return () => {
      cancelled = true;
    };
  }, [recordings]);

  // Rebuild the remaining schedule on shared edits, retaining the local playhead.
  useEffect(() => {
    const transport = transportRef.current;
    const ctx = contextRef.current;
    if (!transport.active || !ctx) return;
    const position = remoteActivityRef.current?.mode === "playing"
      ? remotePosition(remoteActivityRef.current)
      : transport.offset + ctx.currentTime - transport.at;
    sourcesRef.current.forEach((source) => {
      try {
        source.stop();
      } catch {
        /* Finished. */
      }
    });
    sourcesRef.current = scheduleDaw(
      ctx,
      tracks,
      buffers,
      position,
      ctx.currentTime,
    );
    transport.offset = position;
    transport.at = ctx.currentTime;
  }, [tracks, buffers, remotePosition]);

  // One animation clock owns the visible playhead. Network snapshots and audio
  // scheduling must not write older positions over an already-rendered frame.
  useEffect(() => {
    if (!playing && !recording) return;
    let frame = 0;
    const tick = () => {
      const remote = remoteActivityRef.current;
      if (recording) {
        const elapsed =
          remote?.mode === "recording"
            ? remotePosition(remote) - remote.position
            : Math.max(
                0,
                (performance.now() - recordingStartedRef.current) / 1000,
              );
        setRecordingSeconds(elapsed);
      } else {
        const t = transportRef.current;
        if ((t.active && contextRef.current) || remote?.mode === "playing") {
          const position =
            remote?.mode === "playing"
              ? remotePosition(remote)
              : t.offset + contextRef.current!.currentTime - t.at;
          if (position >= duration) {
            t.active = false;
            sourcesRef.current.forEach((source) => {
              try {
                source.stop();
              } catch {
                /* Finished. */
              }
            });
            sourcesRef.current = [];
            setPlaying(false);
            setPlayhead(0);
            return;
          }
          setPlayhead(position);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, recording, duration, remotePosition]);

  useEffect(() => {
    if (!recording || remoteActivityRef.current?.mode === "recording") return;
    const samples = new Float32Array(analyserRef.current?.fftSize ?? 2048);
    const timer = setInterval(() => {
      if (!localTakeRef.current) return;
      const elapsed = (performance.now() - recordingStartedRef.current) / 1000;
      analyserRef.current?.getFloatTimeDomainData(samples);
      let peak = 0;
      for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
      setLivePeaks((points) => [...points, { at: elapsed, peak }]);
    }, 50);
    return () => clearInterval(timer);
  }, [recording]);

  useEffect(() => {
    if (!recording || !liveTake || !timelineRef.current) return;
    const node = timelineRef.current;
    const x = 230 + (cursor / timelineSeconds) * timelineWidth;
    if (
      x > node.scrollLeft + node.clientWidth - 40 ||
      x < node.scrollLeft + 230
    )
      node.scrollLeft = Math.max(0, x - node.clientWidth + 80);
  }, [recording, liveTake, cursor, timelineSeconds, timelineWidth]);

  const revision = () => {
    revisionRef.current =
      Math.max(
        revisionRef.current,
        ...tracksRef.current.flatMap((t) => [
          t.revision,
          ...t.regions.map((r) => r.revision),
        ]),
      ) + 1;
    return { revision: revisionRef.current, editId: crypto.randomUUID() };
  };
  const sendTrack = (track: DawTrack) => {
    tracksRef.current = mergeDawTrack(tracksRef.current, track);
    onTrack(track);
  };
  const publish = (track: DawTrack, patch: Partial<DawTrack> = {}) => {
    const latest = tracksRef.current.find((t) => t.id === track.id) ?? track;
    sendTrack({ ...latest, ...patch, ...revision() });
  };
  const publishRegions = (track: DawTrack, regions: DawRegion[]) => {
    const latest = tracksRef.current.find((t) => t.id === track.id) ?? track;
    if (latest.deleted) return;
    sendTrack({
      ...latest,
      regions: mergeDawRegions(
        latest.regions,
        regions.map((r) => ({ ...r, ...revision() })),
      ),
    });
  };
  const reorderTracks = (id: string, target: string, before: boolean) => {
    if (recording || busy) return;
    for (const track of reorderDawTracks(tracksRef.current, id, target, before))
      publish(track, { order: track.order });
  };
  const cancelTrackDrag = () => {
    trackDragRef.current = null;
    setTrackDrag(null);
  };
  const newTrack = (
    name = `Audio ${tracksRef.current.filter((t) => !t.deleted).length + 1}`,
    kind: "audio" | "midi" = "audio",
  ) => {
    const track: DawTrack = {
      id: crypto.randomUUID(),
      name,
      kind,
      order: Math.max(0, ...tracksRef.current.map((t) => t.order ?? 0)) + 1,
      volume: 0.8,
      pan: 0,
      muted: false,
      solo: false,
      regions: [],
      deleted: false,
      ...revision(),
    };
    sendTrack(track);
    setSelected(track.id);
    setSelectedRegionId(null);
    return track;
  };

  const addFiles = async (
    files: File[],
    relink: DawRegion | null = null,
    start = playhead,
    targetId: string | null = null,
  ) => {
    setBusy(true);
    setError("");
    try {
      for (const file of files) {
        if (!file.size || file.size > MAX_DAW_FILE_BYTES)
          throw new Error("Choose recordings smaller than 50 MB.");
        const decoded = await context().decodeAudioData(
          await file.arrayBuffer(),
        );
        if (!aliveRef.current) return;
        if (
          !Number.isFinite(decoded.duration) ||
          decoded.duration <= 0 ||
          decoded.duration + (relink ? 0 : start) > MAX_DAW_SECONDS
        )
          throw new Error("Keep each project within 30 minutes.");
        if (relink && Math.abs(decoded.duration - relink.duration) > 0.1)
          throw new Error(
            "Choose the original recording with the same duration to restore this track.",
          );
        const sourceId = relink?.sourceId ?? crypto.randomUUID();
        buffersRef.current.set(sourceId, decoded);
        filesRef.current.set(sourceId, file);
        setBuffers(new Map(buffersRef.current));
        if (!relink) {
          const target = targetId
            ? tracksRef.current.find((t) => t.id === targetId && !t.deleted)
            : newTrack(file.name.slice(0, 200));
          if (!target)
            throw new Error(
              "The target track was removed. Add a track and import the recording again.",
            );
          const region: DawRegion = {
            id: crypto.randomUUID(),
            sourceId,
            name: file.name.slice(0, 200),
            duration: decoded.duration,
            start,
            trimStart: 0,
            trimEnd: decoded.duration,
            deleted: false,
            revision: 0,
            editId: "",
          };
          publishRegions(target, [region]);
          setSelected(target.id);
          setSelectedRegionId(region.id);
          if (targetId) start += decoded.duration;
        }
        onFile({ id: sourceId, name: file.name, file });
      }
    } catch (cause) {
      if (aliveRef.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not load that recording.",
        );
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  const currentPosition = () => {
    const transport = transportRef.current;
    if (remoteActivityRef.current?.mode === "playing")
      return Math.min(duration, remotePosition(remoteActivityRef.current));
    return transport.active && contextRef.current
      ? Math.min(
          duration,
          transport.offset + contextRef.current.currentTime - transport.at,
        )
      : playhead;
  };

  const playFrom = async (position: number, share = true) => {
    if (share && (recording || busy || !active.length || missing)) return;
    const request = ++transportRequestRef.current;
    try {
      const ctx = context();
      await resumeDawAudio(ctx, share);
      if (!aliveRef.current || request !== transportRequestRef.current) return;
      if (dawAudioNeedsGesture(ctx)) {
        setAudioBlocked(true);
        return;
      }
      const current =
        !share && remoteActivityRef.current?.mode === "playing"
          ? remotePosition(remoteActivityRef.current)
          : position;
      const currentTracks = tracksRef.current;
      const currentDuration = dawEnd(currentTracks);
      if (!share && current >= currentDuration) {
        stopSources();
        transportRef.current.active = false;
        return;
      }
      const offset = Math.max(0, current >= currentDuration ? 0 : current);
      stopSources();
      sourcesRef.current = scheduleDaw(
        ctx,
        currentTracks,
        buffersRef.current,
        offset,
        ctx.currentTime,
      );
      transportRef.current = { active: true, at: ctx.currentTime, offset };
      if (share) {
        setPlayhead(offset);
        setPlaying(true);
        remoteActivityRef.current = null;
        sync.publish("playing", offset);
      }
      setError("");
    } catch {
      if (aliveRef.current)
        setError("Audio playback could not start. Try pressing Play again.");
    }
  };

  const recoverAudio = useEffectEvent(() => {
    const ctx = contextRef.current;
    if (!ctx || document.visibilityState === 'hidden' || !dawAudioNeedsGesture(ctx)) return;
    void resumeDawAudio(ctx).then(() => {
      if (!aliveRef.current || dawAudioNeedsGesture(ctx)) return;
      const activity = remoteActivityRef.current;
      if (activity?.mode === 'playing') void playFrom(remotePosition(activity), false);
      else if (transportRef.current.active) void playFrom(currentPosition(), false);
    }).catch(() => { if (aliveRef.current) setAudioBlocked(true); });
  });
  useEffect(() => {
    const recover = () => recoverAudio();
    document.addEventListener('visibilitychange', recover);
    window.addEventListener('focus', recover);
    return () => {
      document.removeEventListener('visibilitychange', recover);
      window.removeEventListener('focus', recover);
    };
  }, []);

  const noteOff = (pitch: number) => {
    const node = instrumentNotes.current.get(pitch);
    if (node) {
      try {
        node.stop();
      } catch {
        /* already stopped */
      }
      instrumentNotes.current.delete(pitch);
      sync.publishVoices(
        [...instrumentNotes.current.keys()].map((pitch) => ({
          pitch,
          trackId: midiTake.current?.trackId ?? selected ?? "",
        })),
      );
    }
    const take = midiTake.current;
    const start = take?.held.get(pitch);
    if (take && start !== undefined) {
      take.notes.push({
        pitch,
        start,
        duration: Math.max(
          0.01,
          (performance.now() - recordingStartedRef.current) / 1000 - start,
        ),
        velocity: 0.8,
      });
      take.held.delete(pitch);
    }
  };
  const noteOn = (pitch: number) => {
    if (
      instrumentNotes.current.has(pitch) ||
      selectedTrack?.kind !== "midi" ||
      (midiTake.current && midiTake.current.trackId !== selectedTrack.id)
    )
      return;
    const ctx = context();
    void resumeDawAudio(ctx, true).catch(() => setAudioBlocked(true));
    instrumentNotes.current.set(
      pitch,
      scheduleDawNote(
        ctx,
        pitch,
        audibleTracks(tracksRef.current).some(track => track.id === selectedTrack.id) ? selectedTrack.volume : 0,
        selectedTrack.pan,
        ctx.currentTime,
        MAX_DAW_SECONDS,
      ),
    );
    sync.publishVoices(
      [...instrumentNotes.current.keys()].map((pitch) => ({
        pitch,
        trackId: selectedTrack.id,
      })),
    );
    if (midiTake.current)
      midiTake.current.held.set(
        pitch,
        (performance.now() - recordingStartedRef.current) / 1000,
      );
  };
  const releaseSharedVoices = useEffectEvent(() => sync.publishVoices([]));
  useEffect(() => {
    const voices = instrumentNotes.current;
    const release = () => {
      voices.forEach((node) => {
        try {
          node.stop();
        } catch {
          /* stopped */
        }
      });
      voices.clear();
      releaseSharedVoices();
      const take = midiTake.current;
      if (take) {
        const now = (performance.now() - recordingStartedRef.current) / 1000;
        take.held.forEach((start, pitch) =>
          take.notes.push({
            pitch,
            start,
            duration: Math.max(0.01, now - start),
            velocity: 0.8,
          }),
        );
        take.held.clear();
      }
    };
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("blur", release);
      release();
    };
  }, [selected, minimized]);

  const finishRecording = () => {
    if (remoteActivityRef.current?.mode === "recording") {
      sync.publish("stopped", remotePosition(remoteActivityRef.current));
      remoteActivityRef.current = null;
      setRecording(false);
      setLiveTake(null);
      setPlayhead(cursor);
      return;
    }
    if (midiTake.current) {
      const take = midiTake.current;
      [...take.held.keys()].forEach(noteOff);
      const length = Math.min(
        MAX_DAW_SECONDS - take.start,
        Math.max(
          0.01,
          (performance.now() - recordingStartedRef.current) / 1000,
          ...take.notes.map((n) => n.start + n.duration),
        ),
      );
      const notes = take.notes
        .filter((note) => note.start < length)
        .map((note) => ({
          ...note,
          duration: Math.min(note.duration, length - note.start),
        }));
      midiTake.current = null;
      instrumentNotes.current.forEach((node) => {
        try {
          node.stop();
        } catch {
          /* stopped */
        }
      });
      instrumentNotes.current.clear();
      if (recordTimerRef.current) clearTimeout(recordTimerRef.current);
      const track = tracksRef.current.find(
        (t) => t.id === take.trackId && !t.deleted,
      );
      if (track && notes.length && length > 0) {
        const region: DawRegion = {
          id: crypto.randomUUID(),
          sourceId: "midi",
          name: "MIDI take",
          duration: length,
          start: take.start,
          trimStart: 0,
          trimEnd: length,
          deleted: false,
          notes,
          ...revision(),
        };
        publishRegions(track, [region]);
        setSelectedRegionId(region.id);
      }
      setRecording(false);
      setLiveTake(null);
      setPlayhead(take.start + length);
      if (localTakeRef.current) sync.publish("stopped", take.start + length);
      localTakeRef.current = false;
      return;
    }
    if (recorderRef.current?.state === "recording") {
      setBusy(true);
      recorderRef.current.stop();
    }
  };

  const togglePlay = () => {
    if (recording) {
      finishRecording();
      return;
    }
    if (busy) return;
    if (playing || remoteActivityRef.current?.mode === "playing" || transportRef.current.active) stop();
    else void playFrom(playhead);
  };

  const stopTransport = () => {
    if (recording) finishRecording();
    else stop();
  };

  const startRecording = async () => {
    if (recording) {
      finishRecording();
      return;
    }
    if (busy) return;
    const start = currentPosition();
    if (start >= MAX_DAW_SECONDS - 0.01) {
      setError("Move the playhead before the 30-minute limit to record.");
      return;
    }
    setError("");
    stop();
    if (selectedTrack?.kind === "midi") {
      recordingStartedRef.current = performance.now();
      midiTake.current = {
        trackId: selectedTrack.id,
        start,
        notes: [],
        held: new Map(),
      };
      setLiveTake({ trackId: selectedTrack.id, start });
      setLivePeaks([]);
      setRecordingSeconds(0);
      setRecording(true);
      localTakeRef.current = true;
      remoteActivityRef.current = null;
      sync.publish("recording", start, selectedTrack.id);
      recordTimerRef.current = setTimeout(
        finishRecording,
        Math.max(100, (MAX_DAW_SECONDS - start - 0.1) * 1000),
      );
      rootRef.current?.focus({ preventScroll: true });
      return;
    }
    const request = ++transportRequestRef.current;
    setBusy(true);
    setError("");
    try {
      if (
        !navigator.mediaDevices?.getUserMedia ||
        typeof MediaRecorder === "undefined"
      )
        throw new Error(
          "Microphone recording is not available in this browser. You can still add audio files.",
        );
      const ctx = context();
      const audioReady = resumeDawAudio(ctx, true).catch(() => setAudioBlocked(true));
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      if (!aliveRef.current || request !== transportRequestRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      micRef.current = stream;
      await audioReady;
      if (!aliveRef.current || request !== transportRequestRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      if (dawAudioNeedsGesture(ctx)) throw new Error('Tap Enable audio, then try recording again.');
      const target = selected
        ? tracksRef.current.find((t) => t.id === selected && !t.deleted)
        : newTrack();
      if (!target)
        throw new Error(
          "The selected track was removed. Select another track to record.",
        );
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      const source = ctx.createMediaStreamSource(stream);
      source.connect(analyser);
      microphoneSourceRef.current = source;
      analyserRef.current = analyser;
      setLiveTake({ trackId: target.id, start });
      setLivePeaks([]);
      setSelected(target.id);
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      const chunks: Blob[] = [];
      let size = 0;
      recorder.ondataavailable = (event) => {
        chunks.push(event.data);
        size += event.data.size;
        if (size >= MAX_DAW_FILE_BYTES && recorder.state === "recording")
          recorder.stop();
      };
      recorder.onerror = () => {
        if (aliveRef.current)
          setError(
            "Microphone recording failed. Try again or add an audio file.",
          );
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        micRef.current = null;
        source.disconnect();
        analyser.disconnect();
        analyserRef.current = null;
        microphoneSourceRef.current = null;
        if (recordTimerRef.current) clearTimeout(recordTimerRef.current);
        if (!aliveRef.current) return;
        const ownsTransport = localTakeRef.current;
        if (ownsTransport)
          sync.publish(
            "stopped",
            start + (performance.now() - recordingStartedRef.current) / 1000,
          );
        localTakeRef.current = false;
        if (ownsTransport) {
          setRecording(false);
          setPlayhead(
            start + (performance.now() - recordingStartedRef.current) / 1000,
          );
          setLiveTake(null);
        }
        const type = recorder.mimeType || chunks[0]?.type || "audio/webm";
        const extension = type.includes("mp4")
          ? "m4a"
          : type.includes("ogg")
            ? "ogg"
            : "webm";
        const file = new File(
          chunks,
          `Take ${new Date().toLocaleTimeString().replaceAll(":", "-")}.${extension}`,
          { type },
        );
        void addFiles([file], null, start, target.id);
      };
      recorder.start(1000);
      recordingStartedRef.current = performance.now();
      setRecordingSeconds(0);
      setRecording(true);
      localTakeRef.current = true;
      remoteActivityRef.current = null;
      sync.publish("recording", start, target.id);
      // Disabling Record while permission is pending can move focus to the
      // document. Restore the DAW shortcut target once capture starts.
      rootRef.current?.focus({ preventScroll: true });
      recordTimerRef.current = setTimeout(
        () => {
          if (recorder.state === "recording") recorder.stop();
        },
        Math.max(1000, (MAX_DAW_SECONDS - start - 1) * 1000),
      );
    } catch (cause) {
      microphoneSourceRef.current?.disconnect();
      analyserRef.current?.disconnect();
      setLiveTake(null);
      micRef.current?.getTracks().forEach((t) => t.stop());
      setError(
        cause instanceof Error
          ? cause.message
          : "Microphone access was denied.",
      );
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  const receiveVoices = (owner: string, voices: DawVoice[]) => {
    if (voices.length) remoteVoiceStateRef.current.set(owner, voices);
    else remoteVoiceStateRef.current.delete(owner);
    const audible = audibleTracks(tracksRef.current);
    const desired = new Set(
      voices.filter(v => audible.some(track => track.id === v.trackId)).map((v) => `${owner}:${v.trackId}:${v.pitch}`),
    );
    for (const [key, node] of remoteVoicesRef.current) {
      if (key.startsWith(`${owner}:`) && !desired.has(key)) {
        try {
          node.stop();
        } catch {
          /* stopped */
        }
        remoteVoicesRef.current.delete(key);
      }
    }
    for (const voice of voices) {
      const key = `${owner}:${voice.trackId}:${voice.pitch}`;
      const track = audible.find((t) => t.id === voice.trackId);
      if (!track || remoteVoicesRef.current.has(key)) continue;
      const ctx = context();
      void resumeDawAudio(ctx).catch(() => setAudioBlocked(true));
      remoteVoicesRef.current.set(
        key,
        scheduleDawNote(
          ctx,
          voice.pitch,
          track.volume,
          track.pan,
          ctx.currentTime,
          MAX_DAW_SECONDS,
        ),
      );
    }
  };

  const refreshVoices = useEffectEvent(() => {
    // Held instrument notes must follow shared mixer edits just like arrangement playback.
    const localPitches = [...instrumentNotes.current.keys()];
    for (const node of instrumentNotes.current.values()) {
      try { node.stop(); } catch { /* Already stopped. */ }
    }
    instrumentNotes.current.clear();
    const track = tracksRef.current.find(track => track.id === selected && !track.deleted);
    if (track && localPitches.length) {
      const ctx = context();
      const volume = audibleTracks(tracksRef.current).some(t => t.id === track.id) ? track.volume : 0;
      for (const pitch of localPitches) instrumentNotes.current.set(pitch, scheduleDawNote(ctx, pitch, volume, track.pan, ctx.currentTime, MAX_DAW_SECONDS));
    }
    for (const node of remoteVoicesRef.current.values()) {
      try { node.stop(); } catch { /* Already stopped. */ }
    }
    remoteVoicesRef.current.clear();
    for (const [owner, voices] of remoteVoiceStateRef.current) receiveVoices(owner, voices);
  });
  useEffect(() => { refreshVoices(); }, [tracks, selected]);

  const sync = useDawSync(
    id,
    dataConnection,
    (activity) => {
      const changed = receivedCommandRef.current !== activity.id;
      receivedCommandRef.current = activity.id;
      if (changed) {
        remoteClockRef.current = {
          id: activity.id,
          position: dawActivityPosition(activity),
          at: performance.now(),
        };
        // A peer's Stop also finalizes the actual recorder, rather than only its UI.
        if (localTakeRef.current) {
          localTakeRef.current = false;
          finishRecording();
        }
        stop(false, false);
      }
      remoteActivityRef.current = activity;
      const position = remotePosition(activity);
      if (activity.mode === "recording") {
        setRecording(true);
        setLiveTake({ trackId: activity.trackId!, start: activity.position });
        if (changed) setRecordingSeconds(position - activity.position);
        setLivePeaks(activity.peaks ?? []);
        setRemoteNotes(activity.notes ?? []);
      } else {
        setRecording(false);
        setLiveTake(null);
        if (activity.mode === "playing") {
          setPlaying(position < duration);
          if (changed) setPlayhead(position < duration ? position : 0);
          // Correct drift without restarting audio on every heartbeat.
          if (
            changed ||
            !transportRef.current.active ||
            Math.abs(
              transportRef.current.offset +
                (contextRef.current?.currentTime ?? 0) -
                transportRef.current.at -
                position,
            ) > 0.3
          )
            if (position < duration) void playFrom(position, false);
        } else setPlayhead(position);
      }
    },
    () => {
      const stride = Math.max(1, Math.ceil(livePeaks.length / 600));
      const peaks = [];
      for (let i = 0; i < livePeaks.length; i += stride) {
        const group = livePeaks.slice(i, i + stride);
        peaks.push({
          at: group[0].at,
          peak: Math.min(1, Math.max(...group.map((p) => p.peak))),
        });
      }
      return {
        peaks,
        notes: [
          ...(midiTake.current?.notes ?? []),
          ...[...(midiTake.current?.held ?? [])].map(([pitch, start]) => ({
            pitch,
            start,
            duration: Math.max(0.01, recordingSeconds - start),
            velocity: 0.8,
          })),
        ].slice(-1000),
      };
    },
    (view) => {
      setSelectedLocal(view.selected);
      setSelectedRegionIdLocal(view.region);
      setZoomLocal(view.zoom);
    },
    receiveVoices,
  );

  const exportMix = async () => {
    setBusy(true);
    setError("");
    try {
      const offline = new OfflineAudioContext(
        2,
        Math.ceil(duration * 44100),
        44100,
      );
      scheduleDaw(offline, tracks, buffersRef.current, 0, 0);
      const mixed = await offline.startRendering();
      if (!aliveRef.current) return;
      const url = URL.createObjectURL(encodeWav(mixed));
      const link = document.createElement("a");
      link.href = url;
      link.download = "maketogether-mix.wav";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setError("Could not export this mix. Try a shorter arrangement.");
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  const seek = (position: number) => {
    if (recording || busy) return;
    const next = Math.max(0, Math.min(duration, position));
    setPlayhead(next);
    if ((playing || remoteActivityRef.current?.mode === "playing" || transportRef.current.active) && next < duration) {
      // Share the seek immediately, even if this browser cannot output audio yet.
      stop(false, false);
      remoteActivityRef.current = null;
      setPlayhead(next);
      setPlaying(true);
      sync.publish("playing", next);
      void playFrom(next, false);
    }
    else {
      stop(false, false);
      setPlayhead(next);
      remoteActivityRef.current = null;
      sync.publish("stopped", next);
    }
  };
  const scrubTo = (clientX: number) => {
    const rect = rulerRef.current?.getBoundingClientRect();
    if (rect) seek(((clientX - rect.left) / rect.width) * timelineSeconds);
  };
  const scrubHandlers = {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 || recording || busy) return;
      event.preventDefault();
      event.stopPropagation();
      scrubbingRef.current = event.pointerId;
      event.currentTarget.setPointerCapture(event.pointerId);
      scrubTo(event.clientX);
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      if (scrubbingRef.current === event.pointerId) scrubTo(event.clientX);
    },
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => {
      if (scrubbingRef.current !== event.pointerId) return;
      scrubTo(event.clientX);
      scrubbingRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
    },
    onPointerCancel: () => {
      scrubbingRef.current = null;
    },
    onLostPointerCapture: () => {
      scrubbingRef.current = null;
    },
  };
  const restart = () => seek(0);
  const moveRegion = (track: DawTrack, region: DawRegion, start: number) =>
    publishRegions(track, [
      {
        ...region,
        start: Math.max(
          0,
          Math.min(MAX_DAW_SECONDS - region.trimEnd + region.trimStart, start),
        ),
      },
    ]);
  const deleteRegion = (track = selectedTrack, region = selectedRegion) => {
    if (!track || !region || recording || busy) return;
    publishRegions(track, [{ ...region, deleted: true }]);
    setSelectedRegionId(null);
  };
  const duplicateRegion = (
    track = selectedTrack,
    region = selectedRegion,
    at?: number,
  ) => {
    if (!track || !region || recording || busy) return;
    const start = at ?? region.start + region.trimEnd - region.trimStart;
    if (start + region.trimEnd - region.trimStart > MAX_DAW_SECONDS) return;
    const copy = { ...region, id: crypto.randomUUID(), start, deleted: false };
    publishRegions(track, [copy]);
    setSelected(track.id);
    setSelectedRegionId(copy.id);
  };
  const splitRegion = (track = selectedTrack, region = selectedRegion) => {
    if (!track || !region || recording || busy) return;
    const parts = splitDawRegion(
      region,
      currentPosition(),
      crypto.randomUUID(),
    );
    if (parts) publishRegions(track, parts);
  };
  const menuTrack = active.find((t) => t.id === (menu?.trackId ?? selected));
  const menuRegion =
    menuTrack &&
    visibleRegions(menuTrack).find(
      (r) => r.id === (menu?.regionId ?? selectedRegionId),
    );
  const locked = busy || recording;
  const importAudio = () => {
    relinkRef.current = null;
    inputRef.current?.click();
  };
  const trackItems: DawMenuItem[] = [
    {
      label: "New Audio Track",
      shortcut: "⌥⌘N",
      action: () => {
        newTrack();
      },
      disabled: locked,
    },
    { label: "Import Audio…", action: importAudio, disabled: locked },
    {
      label: "Rename Track",
      action: () => setRenaming(menuTrack!.id),
      disabled: !menuTrack || locked,
    },
    {
      label: "Duplicate Track Settings",
      action: () => {
        const t = newTrack(
          `${menuTrack!.name} copy`,
          menuTrack!.kind ?? "audio",
        );
        publish(t, {
          volume: menuTrack!.volume,
          pan: menuTrack!.pan,
          muted: menuTrack!.muted,
        });
      },
      disabled: !menuTrack || locked,
    },
    {
      label: "Center Pan",
      action: () => publish(menuTrack!, { pan: 0 }),
      disabled: !menuTrack,
    },
    {
      label: "Delete Track",
      danger: true,
      action: () => {
        publish(menuTrack!, { deleted: true });
        setSelected(null);
        setSelectedRegionId(null);
      },
      disabled: !menuTrack || locked,
    },
  ];
  const regionItems: DawMenuItem[] = [
    {
      label: "Copy Region",
      shortcut: "⌘C",
      action: () => {
        clipboard.current = menuRegion!;
      },
      disabled: !menuRegion,
    },
    {
      label: "Cut Region",
      shortcut: "⌘X",
      action: () => {
        clipboard.current = menuRegion!;
        deleteRegion(menuTrack, menuRegion);
      },
      disabled: !menuRegion || locked,
    },
    {
      label: "Paste at Playhead",
      shortcut: "⌘V",
      action: () =>
        duplicateRegion(
          menuTrack,
          clipboard.current ?? undefined,
          currentPosition(),
        ),
      disabled: !menuTrack || !clipboard.current || locked,
    },
    {
      label: "Duplicate Region",
      shortcut: "⌘D",
      action: () => duplicateRegion(menuTrack, menuRegion),
      disabled: !menuRegion || locked,
    },
    {
      label: "Split at Playhead",
      shortcut: "⌘T",
      action: () => splitRegion(menuTrack, menuRegion),
      disabled:
        !menuRegion ||
        locked ||
        !splitDawRegion(menuRegion, currentPosition(), "preview"),
    },
    {
      label: "Delete Region",
      shortcut: "Delete",
      danger: true,
      action: () => deleteRegion(menuTrack, menuRegion),
      disabled: !menuRegion || locked,
    },
  ];
  const workspaceItems: DawMenuItem[] = [
    {
      label: "Add Track",
      shortcut: "⌥⌘N",
      action: () => {
        newTrack();
      },
      disabled: locked,
    },
    { label: "Import Audio…", action: importAudio, disabled: locked },
    {
      label: "Paste at Playhead",
      shortcut: "⌘V",
      action: () => {
        const region = clipboard.current;
        if (!region) return;
        duplicateRegion(selectedTrack ?? newTrack(), region, currentPosition());
      },
      disabled:
        !clipboard.current ||
        locked ||
        !!(
          clipboard.current &&
          currentPosition() +
            clipboard.current.trimEnd -
            clipboard.current.trimStart >
            MAX_DAW_SECONDS
        ),
    },
    {
      label: "Go to Beginning",
      shortcut: "Return",
      action: restart,
      disabled: locked,
    },
    {
      label: "Export WAV…",
      action: () => {
        void exportMix();
      },
      disabled: !duration || missing || locked,
    },
    {
      label: "Keyboard Shortcuts",
      action: () => setShowShortcuts((show) => !show),
    },
  ];
  const menuItems =
    menu?.kind === "File"
      ? [
          { label: "Import Audio…", action: importAudio, disabled: locked },
          {
            label: "Export WAV…",
            action: () => {
              void exportMix();
            },
            disabled: !duration || missing || locked,
          },
        ]
      : menu?.kind === "View"
        ? [
            { label: "Fit Entire Project", action: () => setZoom(0) },
            {
              label: "Zoom In",
              action: () => setZoom((z) => Math.min(100, z + 5)),
            },
            {
              label: "Zoom Out",
              action: () => setZoom((z) => Math.max(0, z - 5)),
            },
            {
              label: "Keyboard Shortcuts",
              action: () => setShowShortcuts((v) => !v),
            },
          ]
        : menu?.kind === "Track"
          ? trackItems
          : menu?.kind === "DAW"
            ? workspaceItems
            : regionItems;
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (minimized) return;
    // Keep canvas pan/laser shortcuts out of this window, including text inputs.
    event.stopPropagation();
    if (event.key === "Escape" && trackDragRef.current) {
      event.preventDefault();
      cancelTrackDrag();
      return;
    }
    const target = event.target as HTMLElement;
    const editing = !!target.closest(
      'input, textarea, select, [contenteditable="true"]',
    );
    const action = dawShortcut(
      { ...event, isComposing: event.nativeEvent.isComposing },
      editing,
    );
    if (!action) {
      // Swallow repeats of one-shot shortcuts instead of invoking a native
      // button click or browser bookmark action after the first keydown.
      if (
        event.repeat &&
        dawShortcut(
          {
            ...event,
            repeat: false,
            isComposing: event.nativeEvent.isComposing,
          },
          editing,
        )
      )
        event.preventDefault();
      return;
    }
    // Standard keyboard activation still works for window controls and help.
    if (
      !(recording && action === "play") &&
      (action === "play" || action === "restart") &&
      target.closest("[data-native-keys]")
    )
      return;
    event.preventDefault();
    switch (action) {
      case "play":
        togglePlay();
        break;
      case "record":
        void startRecording();
        break;
      case "restart":
        restart();
        break;
      case "delete":
        deleteRegion();
        break;
      case "duplicate":
        duplicateRegion();
        break;
      case "new-track":
        if (!locked) newTrack();
        break;
      case "copy":
        clipboard.current = selectedRegion ?? null;
        break;
      case "cut":
        clipboard.current = selectedRegion ?? null;
        deleteRegion();
        break;
      case "paste":
        duplicateRegion(
          selectedTrack,
          clipboard.current ?? undefined,
          currentPosition(),
        );
        break;
      case "split":
        splitRegion();
        break;
      case "mute":
        if (selectedTrack)
          publish(selectedTrack, { muted: !selectedTrack.muted });
        break;
      case "solo":
        if (selectedTrack)
          publish(selectedTrack, { solo: !selectedTrack.solo });
        break;
      case "previous-track":
      case "next-track": {
        const index = active.findIndex((t) => t.id === selected);
        const next =
          index < 0
            ? 0
            : Math.max(
                0,
                Math.min(
                  active.length - 1,
                  index + (action === "next-track" ? 1 : -1),
                ),
              );
        setSelected(active[next]?.id ?? null);
        setSelectedRegionId(null);
        rootRef.current
          ?.querySelector<HTMLElement>(
            `[data-track-row="${CSS.escape(active[next]?.id ?? "")}"]`,
          )
          ?.scrollIntoView({ block: "nearest", inline: "nearest" });
        break;
      }
      case "seek-back":
        seek(currentPosition() - (event.shiftKey ? 5 : 1));
        break;
      case "seek-forward":
        seek(currentPosition() + (event.shiftKey ? 5 : 1));
        break;
      case "nudge-back":
      case "nudge-forward":
        if (selectedTrack && selectedRegion && !locked)
          moveRegion(
            selectedTrack,
            selectedRegion,
            selectedRegion.start +
              (action === "nudge-back" ? -1 : 1) * (event.shiftKey ? 1 : 0.1),
          );
        break;
      case "zoom-in":
        setZoom((z) => Math.min(100, z + 5));
        break;
      case "zoom-out":
        setZoom((z) => Math.max(0, z - 5));
        break;
      case "help":
        setShowShortcuts((show) => !show);
        break;
      case "escape":
        setShowShortcuts(false);
        setSelected(null);
        setSelectedRegionId(null);
        break;
    }
  };

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      role="region"
      aria-label={`${title} multitrack editor`}
      aria-keyshortcuts="Space R Enter Delete Backspace M S Meta+D Control+D"
      data-daw-root
      onKeyDown={handleKeyDown}
      onKeyUp={(e) => e.stopPropagation()}
      onFocusCapture={() => setKeyboardActive(true)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
          setKeyboardActive(false);
      }}
      onPointerDownCapture={(e) => {
        if (
          !(e.target as HTMLElement).closest(
            'input, textarea, select, [contenteditable="true"]',
          )
        )
          rootRef.current?.focus({ preventScroll: true });
      }}
      className="outline-none focus-within:ring-1 focus-within:ring-emerald-500/60 flex h-full flex-col overflow-hidden rounded-xl border border-emerald-900/60 bg-zinc-950 text-zinc-200 shadow-xl"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-900 px-3 py-2">
        <span className="truncate text-sm font-semibold">
          <span className="mr-2 text-emerald-400">♫</span>
          {title}
        </span>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-emerald-400">
            SHARED MULTITRACK
          </span>
          <button
            className={button}
            data-native-keys
            onClick={onToggleDock}
            aria-label="Bookmark DAW"
          >
            ◇
          </button>
          <button
            className={button}
            data-native-keys
            onClick={() => {
              (document.activeElement as HTMLElement | null)?.blur();
              onMinimize();
            }}
            aria-label="Minimize DAW"
          >
            −
          </button>
          <button
            className={button}
            data-native-keys
            onClick={onClose}
            aria-label="Close DAW"
          >
            ×
          </button>
        </div>
      </div>
      <div
        className="no-drag flex min-h-0 flex-1 flex-col"
        onPointerDown={(e) => e.stopPropagation()}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!busy && !recording)
            void addFiles(Array.from(e.dataTransfer.files));
        }}
      >
        <div
          role="menubar"
          aria-label="DAW menus"
          className="flex shrink-0 gap-1 border-b border-zinc-800 bg-zinc-900/60 px-2 py-1"
        >
          {["File", "Edit", "Track", "View"].map((kind) => (
            <button
              key={kind}
              data-native-keys
              aria-haspopup="menu"
              aria-expanded={menu?.kind === kind}
              className="rounded px-3 py-1 text-xs hover:bg-zinc-700"
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                setMenu({ kind, x: rect.left, y: rect.bottom });
              }}
            >
              {kind}
            </button>
          ))}
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="audio/*,.wav,.mp3,.m4a,.flac,.ogg,.webm"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            const relink = relinkRef.current;
            relinkRef.current = null;
            e.target.value = "";
            void addFiles(relink ? files.slice(0, 1) : files, relink);
          }}
        />
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-800 p-2">
          <div
            className="flex items-center gap-0.5 rounded-lg border border-zinc-700 bg-zinc-900 p-1"
            aria-label="Transport controls"
          >
            <button
              className={button}
              aria-label="Go to beginning"
              title="Go to beginning (Return)"
              onClick={restart}
              disabled={recording || busy}
            >
              <DawTransportIcon name="start" />
            </button>
            <button
              className={button}
              aria-label="Rewind"
              title="Rewind 1 second (←); Shift+← for 5 seconds"
              onClick={() => seek(currentPosition() - 1)}
              disabled={recording || busy}
            >
              <DawTransportIcon name="rewind" />
            </button>
            <button
              className={button}
              aria-label="Forward"
              title="Forward 1 second (→); Shift+→ for 5 seconds"
              onClick={() => seek(currentPosition() + 1)}
              disabled={recording || busy}
            >
              <DawTransportIcon name="forward" />
            </button>
            <button
              className={button}
              aria-label="Stop"
              title="Stop playback or finish recording"
              onClick={stopTransport}
            >
              <DawTransportIcon name="stop" />
            </button>
            <button
              className={`${button} ${playing ? "border-emerald-400 bg-emerald-900 text-emerald-200" : "text-emerald-300"}`}
              aria-label={playing ? "Pause" : "Play"}
              aria-pressed={playing}
              title="Play / pause (Space)"
              onClick={togglePlay}
              disabled={
                (!playing && (!active.length || missing)) || recording || busy
              }
            >
              <DawTransportIcon name={playing ? "pause" : "play"} />
            </button>
            <button
              className={`${button} ${recording ? "border-red-400 bg-red-950 text-red-400 animate-pulse" : "text-red-400"}`}
              aria-label={recording ? "Finish recording" : "Record"}
              aria-pressed={recording}
              title="Record / finish take (R)"
              onClick={() => void startRecording()}
              disabled={busy}
            >
              <DawTransportIcon name="record" />
            </button>
          </div>
          <div
            className={`min-w-24 rounded-md border border-zinc-700 bg-zinc-950 px-3 py-1 text-center ${recording ? "text-red-300" : "text-emerald-300"}`}
          >
            <output
              aria-label={
                recording ? "Recording elapsed time" : "Playhead position"
              }
              className="block font-mono text-sm tabular-nums"
            >
              {time(recording ? recordingSeconds : playhead)}
            </output>
            <span className="block text-[9px] uppercase tracking-widest text-zinc-500">
              {recording ? "Recording" : playing ? "Playing" : "Stopped"}
            </span>
          </div>
          <button
            className={button}
            onClick={() => setCreateTrackOpen(true)}
            disabled={busy || recording}
          >
            + Add audio
          </button>
          <button
            className={button}
            onClick={() => void exportMix()}
            disabled={!duration || missing || busy || recording}
          >
            Export WAV
          </button>
          <label className="ml-auto flex items-center gap-1 text-[10px] text-zinc-400">
            Zoom
            <input
              aria-label="Timeline zoom"
              type="range"
              min="0"
              max="100"
              value={zoom}
              aria-valuetext={
                zoom === 0
                  ? "Fit entire project"
                  : `${Math.round(2 ** (zoom / 15) * 100)}% of fit`
              }
              title="Zoom all the way out to fit the entire project"
              onChange={(e) => setZoom(+e.target.value)}
              className="w-16 accent-emerald-400"
            />
          </label>
          <button
            className={button}
            data-native-keys
            aria-label="Keyboard shortcuts"
            aria-expanded={showShortcuts}
            title="Keyboard shortcuts (?)"
            onClick={() => setShowShortcuts((show) => !show)}
          >
            ?
          </button>
        </div>
        {showShortcuts && (
          <div
            className="shrink-0 border-b border-zinc-800 bg-zinc-900/80 px-3 py-2 text-xs"
            role="note"
            aria-label="DAW keyboard shortcuts"
          >
            <div className="mb-2 flex items-center justify-between">
              <strong>Keyboard shortcuts</strong>
              <span className="text-zinc-500">
                Active in this window; typing keeps its normal keys.
              </span>
            </div>
            <div className="grid grid-cols-2 gap-x-5 gap-y-1 text-zinc-400">
              {[
                ["Space", "Play / pause; finish recording"],
                ["R", "Record / finish take"],
                ["Return", "Go to beginning"],
                ["Delete / Backspace", "Delete selected region"],
                ["↑ / ↓", "Select previous / next track"],
                ["← / →", "Seek 1s (Shift: 5s)"],
                ["Alt + ← / →", "Nudge clip 0.1s (Shift: 1s)"],
                ["M / S", "Mute / solo selected track"],
                ["⌘ / Ctrl + D", "Duplicate selected region"],
                ["⌘ / Ctrl + T", "Split region at playhead"],
                ["⌘ / Ctrl + C / X / V", "Copy / cut / paste region"],
                ["⌥ + ⌘ / Ctrl + N", "New audio track"],
                ["+ / −", "Zoom timeline"],
                ["Esc", "Deselect / close shortcuts"],
                ["Double-click name", "Rename track"],
              ].map(([key, action]) => (
                <div key={key}>
                  <kbd className="mr-2 text-zinc-200">{key}</kbd>
                  {action}
                </div>
              ))}
            </div>
          </div>
        )}
        <Toast message={error} label="DAW error" onDismiss={() => setError("")} />
        <div
          ref={timelineRef}
          onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
          className="min-h-0 flex-1 overflow-auto"
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setMenu({ kind: "DAW", x: event.clientX, y: event.clientY });
          }}
        >
          {!active.length ? (
            <div className="flex h-full min-h-32 flex-col items-center justify-center gap-2 px-5 text-center">
              <span className="text-3xl text-emerald-400">♫</span>
              <p className="text-sm">Make Music Together</p>
              <p className="max-w-sm text-xs text-zinc-500">
                Drop recordings here, add audio files, or record a take. Each
                track can hold multiple audio regions. Use Track → New Audio
                Track to start.
              </p>
            </div>
          ) : (
            <div className="relative" style={{ width: timelineWidth + 230 }}>
              <div className="flex h-5 border-b border-zinc-800 text-[9px] text-zinc-500">
                <div className="sticky left-0 z-20 w-[230px] shrink-0 bg-zinc-900 px-3 py-0.5">
                  {active.length} tracks · {time(duration)}
                </div>
                <div
                  ref={rulerRef}
                  data-time-ruler
                  className="relative touch-none cursor-ew-resize select-none"
                  style={{ width: timelineWidth }}
                  {...scrubHandlers}
                >
                  {Array.from(
                    {
                      length: Math.ceil(timelineSeconds / rulerStep),
                    },
                    (_, i) => {
                      const seconds = i * rulerStep;
                      return (
                        <span
                          key={seconds}
                          className="absolute top-0.5 border-l border-zinc-700 pl-1"
                          style={{
                            left: `${(seconds / timelineSeconds) * 100}%`,
                          }}
                        >
                          {time(seconds)}
                        </span>
                      );
                    },
                  )}
                </div>
              </div>
              {active.map((track, index) => (
                <div
                  key={track.id}
                  data-track-row={track.id}
                  data-reordering={trackDrag?.id === track.id || undefined}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setSelected(track.id);
                    setSelectedRegionId(null);
                    setMenu({
                      kind: "Track",
                      x: e.clientX,
                      y: e.clientY,
                      trackId: track.id,
                    });
                  }}
                  onClick={() => {
                    setSelected(track.id);
                    setSelectedRegionId(null);
                  }}
                  className={`relative flex h-24 border-b border-zinc-800 ${selected === track.id ? "bg-emerald-950/20" : "bg-zinc-950"}`}
                >
                  {trackDrag?.target === track.id &&
                    trackDrag.id !== track.id && (
                      <div
                        data-track-drop-indicator
                        className={`pointer-events-none absolute inset-x-0 z-30 h-0.5 bg-brand-300 ${trackDrag.before ? "top-0" : "bottom-0"}`}
                      />
                    )}
                  <div
                    className={`sticky left-0 z-20 flex w-[230px] shrink-0 flex-col justify-center gap-2 border-r border-zinc-800 px-2 py-1 ${selected === track.id ? "bg-emerald-950 ring-1 ring-inset ring-emerald-500/60" : "bg-zinc-900"}`}
                    onClick={() => {
                      setSelected(track.id);
                      setSelectedRegionId(null);
                    }}
                  >
                    <div className="flex h-5 items-center gap-1">
                      <button
                        aria-label={`Reorder track ${track.name}`}
                        title="Drag to reorder; use ↑ / ↓ when focused"
                        disabled={locked}
                        className="shrink-0 touch-none cursor-grab rounded px-1 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-200 active:cursor-grabbing disabled:opacity-30"
                        onClick={(e) => e.stopPropagation()}
                        onPointerDown={(e) => {
                          if (e.button !== 0 || locked) return;
                          e.preventDefault();
                          e.stopPropagation();
                          e.currentTarget.focus();
                          e.currentTarget.setPointerCapture(e.pointerId);
                          trackDragRef.current = {
                            id: track.id,
                            target: track.id,
                            before: true,
                            y: e.clientY,
                            moved: false,
                          };
                        }}
                        onPointerMove={(e) => {
                          const drag = trackDragRef.current;
                          if (!drag || drag.id !== track.id) return;
                          if (Math.abs(e.clientY - drag.y) < 4 && !drag.moved)
                            return;
                          drag.moved = true;
                          const timeline = timelineRef.current;
                          if (!timeline) return;
                          const bounds = timeline.getBoundingClientRect();
                          const scale =
                            bounds.height / timeline.clientHeight || 1;
                          if (e.clientY < bounds.top + 28)
                            timeline.scrollTop -= 16 / scale;
                          if (e.clientY > bounds.bottom - 28)
                            timeline.scrollTop += 16 / scale;
                          const rows = [
                            ...timeline.querySelectorAll<HTMLElement>(
                              "[data-track-row]",
                            ),
                          ];
                          const target =
                            rows.find((row) => {
                              const r = row.getBoundingClientRect();
                              return e.clientY < r.top + r.height / 2;
                            }) ?? rows.at(-1);
                          if (!target) return;
                          const rect = target.getBoundingClientRect();
                          drag.target = target.dataset.trackRow!;
                          drag.before = e.clientY < rect.top + rect.height / 2;
                          setTrackDrag({
                            id: drag.id,
                            target: drag.target,
                            before: drag.before,
                          });
                        }}
                        onPointerUp={(e) => {
                          const drag = trackDragRef.current;
                          if (drag?.moved)
                            reorderTracks(drag.id, drag.target, drag.before);
                          cancelTrackDrag();
                          if (e.currentTarget.hasPointerCapture(e.pointerId))
                            e.currentTarget.releasePointerCapture(e.pointerId);
                        }}
                        onPointerCancel={cancelTrackDrag}
                        onLostPointerCapture={cancelTrackDrag}
                        onKeyDown={(e) => {
                          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                            e.preventDefault();
                            e.stopPropagation();
                            const target =
                              active[index + (e.key === "ArrowUp" ? -1 : 1)];
                            if (target)
                              reorderTracks(
                                track.id,
                                target.id,
                                e.key === "ArrowUp",
                              );
                          }
                        }}
                      >
                        ⠿
                      </button>
                      {renaming === track.id ? (
                        <input
                          aria-label={`Track name ${index + 1}`}
                          value={track.name}
                          maxLength={200}
                          autoFocus
                          onFocus={(e) => e.target.select()}
                          onChange={(e) =>
                            publish(track, { name: e.target.value })
                          }
                          onBlur={() => setRenaming(null)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === "Escape") {
                              e.preventDefault();
                              e.stopPropagation();
                              setRenaming(null);
                              rootRef.current?.focus({ preventScroll: true });
                            }
                          }}
                          className="w-full rounded bg-zinc-950 px-1 text-xs outline-none focus:text-emerald-300"
                        />
                      ) : (
                        <button
                          className="flex h-5 w-full items-center gap-2 truncate text-left text-xs"
                          aria-label={`Select track ${track.name}`}
                          aria-pressed={selected === track.id}
                          title="Select track; double-click to rename"
                          onClick={() => {
                            setSelected(track.id);
                            setSelectedRegionId(null);
                          }}
                          onDoubleClick={() => setRenaming(track.id)}
                        >
                          <span className="text-[10px] text-zinc-500">
                            {String(index + 1).padStart(2, "0")}
                          </span>
                          <span className="truncate">
                            {track.name || "Untitled track"}
                          </span>
                        </button>
                      )}
                    </div>
                    <div className="flex h-10 items-center gap-1.5">
                      <button
                        className={`${button} ${track.muted ? "text-amber-300" : ""}`}
                        aria-pressed={track.muted}
                        aria-label={`Mute ${track.name}`}
                        onClick={() => publish(track, { muted: !track.muted })}
                      >
                        M
                      </button>
                      <button
                        className={`${button} ${track.solo ? "text-emerald-300" : ""}`}
                        aria-pressed={track.solo}
                        aria-label={`Solo ${track.name}`}
                        onClick={() => publish(track, { solo: !track.solo })}
                      >
                        S
                      </button>
                      <input
                        aria-label={`Volume ${track.name}`}
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        value={track.volume}
                        onChange={(e) =>
                          publish(track, { volume: +e.target.value })
                        }
                        className="min-w-0 flex-1 accent-emerald-400"
                      />
                      <DawPanDial
                        name={track.name}
                        value={track.pan}
                        onChange={(pan) => publish(track, { pan })}
                      />
                    </div>
                    {visibleRegions(track).some(
                      (r) => !r.notes && !buffers.has(r.sourceId),
                    ) && (
                      <button
                        className="text-left text-[10px] text-amber-300"
                        disabled={locked}
                        onClick={() => {
                          relinkRef.current = visibleRegions(track).find(
                            (r) => !r.notes && !buffers.has(r.sourceId),
                          )!;
                          inputRef.current?.click();
                        }}
                      >
                        Restore missing audio…
                      </button>
                    )}
                  </div>
                  <div
                    className="relative"
                    style={{
                      width: timelineWidth,
                      backgroundImage:
                        "linear-gradient(to right, #27272a 1px, transparent 1px)",
                      backgroundSize: `${(rulerStep / timelineSeconds) * timelineWidth}px 100%`,
                    }}
                  >
                    {visibleRegions(track).map((region) => (
                      <div
                        key={region.id}
                        role="button"
                        tabIndex={0}
                        data-region-id={region.id}
                        aria-label={`Region ${region.name}`}
                        aria-pressed={selectedRegionId === region.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelected(track.id);
                          setSelectedRegionId(region.id);
                        }}
                        onFocus={() => {
                          setSelected(track.id);
                          setSelectedRegionId(region.id);
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setSelected(track.id);
                          setSelectedRegionId(region.id);
                          setMenu({
                            kind: "Region",
                            x: e.clientX,
                            y: e.clientY,
                            trackId: track.id,
                            regionId: region.id,
                          });
                        }}
                        className="absolute inset-y-0 min-w-1 touch-none overflow-hidden rounded border text-left outline-none focus:ring-1 focus:ring-white"
                        style={{
                          left: `${(region.start / timelineSeconds) * 100}%`,
                          width: `${((region.trimEnd - region.trimStart) / timelineSeconds) * 100}%`,
                          color: colours[index % colours.length],
                          background: `${colours[index % colours.length]}20`,
                          borderColor:
                            selectedRegionId === region.id
                              ? "white"
                              : colours[index % colours.length],
                          opacity: track.muted ? 0.35 : 1,
                        }}
                        onPointerDown={(e) => {
                          if (e.button !== 0 || locked) return;
                          e.stopPropagation();
                          setSelected(track.id);
                          setSelectedRegionId(region.id);
                          e.currentTarget.setPointerCapture(e.pointerId);
                          dragRef.current = {
                            id: region.id,
                            x: e.clientX,
                            region,
                            edge:
                              (e.target as HTMLElement).dataset.edge ?? "move",
                            pixelsPerSecond:
                              e.currentTarget.parentElement!.getBoundingClientRect()
                                .width / timelineSeconds,
                          };
                        }}
                        onPointerMove={(e) => {
                          const drag = dragRef.current;
                          if (drag?.id !== region.id || !e.buttons) return;
                          const delta =
                            (e.clientX - drag.x) / drag.pixelsPerSecond;
                          const r = drag.region;
                          if (drag.edge === "left") {
                            const d = Math.max(
                              -r.start,
                              -r.trimStart,
                              Math.min(r.trimEnd - r.trimStart - 0.01, delta),
                            );
                            publishRegions(track, [
                              {
                                ...r,
                                start: r.start + d,
                                trimStart: r.trimStart + d,
                              },
                            ]);
                          } else if (drag.edge === "right")
                            publishRegions(track, [
                              {
                                ...r,
                                trimEnd: Math.max(
                                  r.trimStart + 0.01,
                                  Math.min(
                                    r.duration,
                                    MAX_DAW_SECONDS - r.start + r.trimStart,
                                    r.trimEnd + delta,
                                  ),
                                ),
                              },
                            ]);
                          else moveRegion(track, r, r.start + delta);
                        }}
                        onPointerUp={() => {
                          dragRef.current = null;
                        }}
                        onPointerCancel={() => {
                          dragRef.current = null;
                        }}
                      >
                        <span className="pointer-events-none absolute inset-x-0 top-0 h-6 truncate border-b border-current/20 bg-current/10 px-2 py-1 text-[10px]">
                          {region.name}
                        </span>
                        <div className="pointer-events-none absolute inset-x-0 bottom-0 top-6">
                          {region.notes ? (
                            <svg
                              data-midi-region
                              viewBox={`0 0 ${region.trimEnd - region.trimStart} 128`}
                              preserveAspectRatio="none"
                              className="h-full w-full"
                              aria-hidden="true"
                            >
                              {region.notes.map((note, i) => (
                                <rect
                                  key={i}
                                  x={note.start - region.trimStart}
                                  y={127 - note.pitch}
                                  width={note.duration}
                                  height={3}
                                  fill="currentColor"
                                />
                              ))}
                            </svg>
                          ) : (
                            <DawWaveform
                              buffer={buffers.get(region.sourceId)}
                              region={region}
                              width={
                                (region.trimEnd - region.trimStart) *
                                pixelsPerSecond
                              }
                              offset={
                                scrollLeft - region.start * pixelsPerSecond
                              }
                              viewport={viewportWidth}
                            />
                          )}
                        </div>
                        <span
                          data-edge="left"
                          title="Trim region start"
                          className="absolute inset-y-0 left-0 w-2 cursor-ew-resize hover:bg-white/30"
                        />
                        <span
                          data-edge="right"
                          title="Trim region end"
                          className="absolute inset-y-0 right-0 w-2 cursor-ew-resize hover:bg-white/30"
                        />
                      </div>
                    ))}
                    {recording && liveTake?.trackId === track.id && (
                      <div
                        data-live-recording
                        aria-label="Live recording waveform"
                        className="pointer-events-none absolute inset-y-0 z-10 min-w-1 overflow-hidden rounded border border-red-300 bg-red-950/90 text-red-300"
                        style={{
                          left: `${(liveTake.start / timelineSeconds) * 100}%`,
                          width: `${(recordingSeconds / timelineSeconds) * 100}%`,
                        }}
                      >
                        <div className="absolute inset-x-0 top-0 h-6 whitespace-nowrap border-b border-red-400/30 bg-red-500/20 px-2 py-1 text-[10px]">
                          ● Recording
                        </div>
                        {track.kind === "midi" ? (
                          <svg
                            data-live-midi
                            viewBox={`0 0 ${Math.max(0.01, recordingSeconds)} 128`}
                            preserveAspectRatio="none"
                            className="absolute bottom-0 top-6 h-[calc(100%-1.5rem)] w-full"
                            aria-hidden="true"
                          >
                            {[
                              ...(remoteActivityRef.current?.mode ===
                              "recording"
                                ? remoteNotes
                                : (midiTake.current?.notes ?? [])),
                              ...[...(midiTake.current?.held ?? [])].map(
                                ([pitch, start]) => ({
                                  pitch,
                                  start,
                                  duration: Math.max(
                                    0.01,
                                    recordingSeconds - start,
                                  ),
                                  velocity: 0.8,
                                }),
                              ),
                            ].map((n, i) => (
                              <rect
                                key={i}
                                x={n.start}
                                y={127 - n.pitch}
                                width={n.duration}
                                height={3}
                                fill="currentColor"
                              />
                            ))}
                          </svg>
                        ) : (
                          <svg
                            className="absolute bottom-0 top-6 h-[calc(100%-1.5rem)] w-full"
                            viewBox={`0 0 ${Math.max(1, recordingSeconds * 20)} 50`}
                            preserveAspectRatio="none"
                            aria-hidden="true"
                          >
                            <path
                              d={`M0 25H${recordingSeconds * 20}`}
                              stroke="currentColor"
                              strokeOpacity=".3"
                            />
                            <path
                              data-live-peaks
                              d={livePeaks
                                .map(
                                  (p) =>
                                    `M${p.at * 20} ${25 - p.peak * 23}v${Math.max(0.4, p.peak * 46)}`,
                                )
                                .join(" ")}
                              stroke="currentColor"
                              strokeWidth=".7"
                            />
                          </svg>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              <div
                data-playhead
                className={`pointer-events-none absolute bottom-0 top-1 z-10 w-px ${recording ? "bg-red-300" : "bg-emerald-300"}`}
                style={{
                  left: 230 + (cursor / timelineSeconds) * timelineWidth,
                }}
              >
                <span
                  data-playhead-handle
                  title="Drag to scrub"
                  {...scrubHandlers}
                  className="pointer-events-auto absolute -left-1.5 top-0 h-3 w-3 touch-none cursor-ew-resize rounded-t-sm bg-inherit"
                  style={{
                    clipPath: "polygon(0 0, 100% 0, 100% 60%, 50% 100%, 0 60%)",
                  }}
                />
              </div>
            </div>
          )}
        </div>
        {selectedTrack?.kind === "midi" && (
          <DawInstrument
            name={selectedTrack.name}
            onNoteOn={noteOn}
            onNoteOff={noteOff}
          />
        )}
        <div className="shrink-0 border-t border-zinc-800 px-3 py-1.5 text-[10px] text-zinc-500">
          {audioBlocked && (
              <button
                className={`${button} mr-2`}
                onClick={() => {
                  // Resume inside the gesture, then rebuild from the shared clock.
                  const ctx = context();
                  void resumeDawAudio(ctx, true).then(() => {
                    if (dawAudioNeedsGesture(ctx)) {
                      setAudioBlocked(true);
                      return;
                    }
                    const activity = remoteActivityRef.current;
                    if (activity?.mode === "playing")
                      void playFrom(remotePosition(activity), false);
                    else if (transportRef.current.active) void playFrom(currentPosition(), false);
                  }).catch(() => setError("Audio playback could not start. Try enabling audio again."));
                }}
              >
                Enable audio
              </button>
            )}
          <span role="status" className="mr-2 text-emerald-300">
            {busy
              ? "Preparing audio…"
              : transferProgress !== undefined
                ? `Sharing audio: ${Math.round(transferProgress * 100)}%`
                : ""}
          </span>
          <span
            className={keyboardActive && !minimized ? "text-emerald-400" : ""}
          >
            {keyboardActive && !minimized
              ? "Keyboard active"
              : "Click this window to use keys"}
          </span>
          {
            " · Space Play / pause · R Record · Return Start · Delete Region · ? Help"
          }
        </div>
      </div>
      {createTrackOpen && !minimized && (
        <DawCreateTrackDialog
          disabled={locked}
          onClose={() => {
            setCreateTrackOpen(false);
            rootRef.current?.focus({ preventScroll: true });
          }}
          onChoose={(kind) => {
            setCreateTrackOpen(false);
            if (kind === "upload") importAudio();
            else
              newTrack(
                kind === "midi" ? `Instrument ${active.length + 1}` : undefined,
                kind === "midi" ? "midi" : "audio",
              );
            rootRef.current?.focus({ preventScroll: true });
          }}
        />
      )}
      {menu && (
        <DawMenu
          x={menu.x}
          y={menu.y}
          title={menu.kind}
          items={menuItems}
          onClose={(restore) => {
            setMenu(null);
            if (restore) rootRef.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </div>
  );
}
