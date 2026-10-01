import { SharedAudioPlayback } from "../utils/sharedAudioPlayback";
import { TapeDeck } from './TapeDeck';
import type { AudioTheme } from '../utils/audioTheme';
import { useState, useRef, useCallback, useEffect } from "react";
import { DockButton } from "./Dock";
import { useYouTubeSync, type SyncMessage } from "../hooks/useYouTubeSync";
import type { RoomDataConnection } from "../hooks/usePeer";
import type { PanelPlayback } from "../types/panels";

function formatTime(seconds: number): string {
  if (!isFinite(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ── Deck geometry ────────────────────────────────────────────────────────
// The deck is one SVG drawing, so every part of it — platter, tonearm,
// label type — scales together when the panel is resized. All coordinates
// live in this 420×260 viewBox space.
const DECK_W = 420;
const DECK_H = 260;
/** Platter spindle. */
const HUB = { x: 150, y: 130 };
/** Brushed platter rim (spins with the record). */
const R_PLATTER = 112;
const R_VINYL = 104;
/** Outer playable groove — where the stylus lands at 0:00. */
const R_GROOVE_OUT = 97;
/** Paper label edge — the run-out; the stylus arrives here as the track ends. */
const R_LABEL = 40;
/** Tonearm bearing. */
const PIVOT = { x: 345, y: 46 };
/** Pivot → stylus tip. */
const ARM_LENGTH = 186;

/**
 * Tonearm rotation (degrees) that puts the stylus at radius `r` from the
 * spindle — actual geometry rather than an eyeballed range, so the arm
 * genuinely starts on the outer groove and ends on the label. Law of
 * cosines at the pivot: the stylus sits where the arm's arc crosses the
 * radius-r circle around the spindle.
 */
function armAngleAt(r: number): number {
  const d = Math.hypot(HUB.x - PIVOT.x, HUB.y - PIVOT.y);
  const base = (Math.atan2(HUB.y - PIVOT.y, HUB.x - PIVOT.x) * 180) / Math.PI;
  const cos = (d * d + ARM_LENGTH * ARM_LENGTH - r * r) / (2 * d * ARM_LENGTH);
  return base - (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

/** Parked on the arm rest, clear of the platter, until a record is playing. */
const ARM_REST_DEG = armAngleAt(R_PLATTER + 12);

/** The strobe dots around the platter edge, precomputed once. */
const STROBE_DOTS = Array.from({ length: 48 }, (_, i) => {
  const a = (i / 48) * Math.PI * 2;
  return {
    x: HUB.x + Math.cos(a) * (R_PLATTER - 4),
    y: HUB.y + Math.sin(a) * (R_PLATTER - 4),
  };
});

/** Label type shrinks to fit longer file names rather than clipping them. */
function labelFontSize(name: string): number {
  if (name.length <= 10) return 11;
  if (name.length <= 16) return 9;
  if (name.length <= 24) return 7.5;
  return 6.5;
}

export function AudioPlayer({
  id,
  dataConnection,
  initialFile,
  onClose,
  spatialVolume = 1,
  docked = false,
  onToggleDock,
  onTrackChange,
  transferProgress,
  onFileChosen,
  initialPlayback,
  onPlaybackChange,
  title = "Audio",
  theme = "digital",
  onThemeChange,
}: {
  id: string;
  dataConnection: RoomDataConnection | null;
  initialFile?: File;
  onClose?: () => void;
  /** 0–1 multiplier from spatial positioning — updated by the parent on every canvas transform change. */
  spatialVolume?: number;
  /** Whether this panel currently has a dock shortcut. */
  docked?: boolean;
  onToggleDock?: () => void;
  /** Reports the loaded track name so the parent can label the dock chip. */
  onTrackChange?: (name: string) => void;
  /** 0–1 while a file is still arriving over the data channel. */
  transferProgress?: number;
  /**
   * A file the *local* user picked or dropped onto this panel, so the parent
   * can stream it to the peer. Deliberately not called for a file that arrived
   * from the peer, which would bounce it straight back.
   */
  onFileChosen?: (file: File) => void;
  initialPlayback?: PanelPlayback;
  onPlaybackChange?: (playback: PanelPlayback) => void;
  title?: string;
  theme?: AudioTheme;
  onThemeChange?: (theme: AudioTheme) => void;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const objectUrlRef = useRef<string | null>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const playbackRef = useRef<SharedAudioPlayback | null>(null);
  if (!playbackRef.current) playbackRef.current = new SharedAudioPlayback(() => audioRef.current, setAudioBlocked);

  const [fileName, setFileName] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(initialPlayback?.volume ?? 1);
  const [isDragOver, setIsDragOver] = useState(false);
  const initialPlaybackRef = useRef(initialPlayback);
  const onPlaybackChangeRef = useRef(onPlaybackChange);
  onPlaybackChangeRef.current = onPlaybackChange;

  const handleRemoteSync = useCallback(
    (message: SyncMessage) => {
      if (
        message.type !== "audio-play" &&
        message.type !== "audio-pause" &&
        message.type !== "audio-seek"
      )
        return;
      if (message.id !== id) return;

      initialPlaybackRef.current = undefined;
      playbackRef.current!.set({
        time: message.time,
        at: message.at,
        playing: message.type === "audio-play" || (message.type === "audio-seek" && message.playing === true),
      });
    },
    [id],
  );

  const { sendSync } = useYouTubeSync({
    dataConnection,
    onRemoteSync: handleRemoteSync,
  });

  const loadedFileRef = useRef<File | null>(null);

  const loadFile = useCallback((file: File) => {
    if (!audioRef.current) return;
    // Revoke previous object URL to free memory
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const url = URL.createObjectURL(file);
    objectUrlRef.current = url;
    audioRef.current.src = url;
    audioRef.current.load();
    const name = file.name.replace(/\.[^.]+$/, "");
    setFileName(name);
    onTrackChange?.(name);
    setCurrentTime(0);
    setIsPlaying(false);
  }, [onTrackChange]);

  // Load the file whenever one turns up. It may be present at mount (a local
  // drop) or arrive later, once a chunked transfer from the peer completes.
  useEffect(() => {
    if (initialFile && loadedFileRef.current !== initialFile) {
      loadedFileRef.current = initialFile;
      loadFile(initialFile);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFile]);

  // ── File input ────────────────────────────────────────────────────────
  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    loadedFileRef.current = file;
    playbackRef.current!.reset();
    loadFile(file);
    onFileChosen?.(file);
  };

  // ── Drag and drop ─────────────────────────────────────────────────────
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes("Files")) setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (!file.type.match(/audio\/(mpeg|wav|ogg|flac|aac|mp4)/)) return;
    loadedFileRef.current = file;
    playbackRef.current!.reset();
    loadFile(file);
    onFileChosen?.(file);
  };

  // ── Playback controls ─────────────────────────────────────────────────
  // ── Transport ─────────────────────────────────────────────────────────
  // Three separate mechanical buttons rather than one toggle. Exactly one is
  // latched down at a time, like a cassette deck:
  //   playing → PLAY · paused mid-track → PAUSE · at the start → STOP
  const play = () => {
    const audio = audioRef.current;
    if (!audio || !fileName) return;
    const message = { type: "audio-play" as const, id, time: audio.ended ? 0 : audio.currentTime, at: Date.now() };
    playbackRef.current!.set({ ...message, playing: true });
    sendSync(message);
  };
  const pause = () => {
    const time = audioRef.current?.currentTime ?? 0;
    playbackRef.current!.set({ time, playing: false });
    sendSync({ type: "audio-pause", id, time, at: Date.now() });
  };
  const stop = () => {
    const audio = audioRef.current;
    if (!audio || !fileName) return;
    playbackRef.current!.set({ time: 0, playing: false });
    audio.currentTime = 0;
    setCurrentTime(0);
    sendSync({ type: "audio-seek", id, time: 0, playing: false, at: Date.now() });
  };
  const transport: "play" | "pause" | "stop" = isPlaying
    ? "play"
    : currentTime > 0
      ? "pause"
      : "stop";

  const seekTo = (t: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    t = Math.max(0, Math.min(t, Number.isFinite(audio.duration) ? audio.duration : 0));
    audio.currentTime = t;
    setCurrentTime(t);
    playbackRef.current!.set({ time: t, at: Date.now(), playing: !audio.paused });
    sendSync({
      type: "audio-seek",
      id,
      time: t,
      at: Date.now(),
      playing: !audio.paused,
    });
  };

  const handleVolume = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    setVolume(v);
    if (audioRef.current)
      audioRef.current.volume = Math.min(1, v * spatialVolume);
  };

  // Keep audio.volume in sync whenever spatialVolume changes from the parent
  useEffect(() => {
    if (audioRef.current)
      audioRef.current.volume = Math.min(1, volume * spatialVolume);
  }, [spatialVolume, volume]);

  useEffect(() => {
    if (!fileName || !onPlaybackChange) return;
    const timer = setInterval(() => {
      const audio = audioRef.current;
      if (audio) onPlaybackChangeRef.current?.({ time: audio.currentTime, playing: !audio.paused, volume });
    }, 1000);
    return () => clearInterval(timer);
  }, [fileName, onPlaybackChange, volume]);

  // ── Audio element events ──────────────────────────────────────────────
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onLoadedMetadata = () => {
      const saved = initialPlaybackRef.current;
      if (saved) {
        playbackRef.current!.set(saved);
        initialPlaybackRef.current = undefined;
      } else playbackRef.current!.apply();
    };
    const onEnded = () => setIsPlaying(false);
    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    const onDurationChange = () => setDuration(audio.duration);

    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("durationchange", onDurationChange);

    return () => {
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("durationchange", onDurationChange);
    };
  }, [id]);

  // Revoke object URL on unmount
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div data-audio-theme={theme} className="flex flex-col h-full bg-zinc-900 border border-zinc-700 rounded-2xl overflow-hidden">
      {/* Hidden audio element */}
      <audio ref={audioRef} preload="metadata" />

      {audioBlocked && <button className="no-drag px-3 py-2 text-sm text-amber-200" onClick={() => playbackRef.current!.apply()}>Enable audio to hear shared playback</button>}

      {/* Header / drag handle */}
      <div className="drag-handle flex items-center justify-between px-3 py-2 bg-zinc-800 cursor-grab active:cursor-grabbing select-none shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <svg
            className="w-4 h-4 text-brand-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
          >
            <circle cx="12" cy="12" r="8" />
            <circle cx="12" cy="12" r="2" />
          </svg>
          <span className="text-xs font-semibold text-zinc-300 truncate">
            {title}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <select aria-label="Audio player theme" value={theme} onChange={event => onThemeChange?.(event.target.value as AudioTheme)} className="no-drag max-w-24 rounded border border-zinc-600 bg-zinc-900 px-1 py-0.5 text-[10px] text-zinc-300">
            <option value="digital">Digital</option><option value="record">Record player</option><option value="tape">Tape deck</option>
          </select>
          {onToggleDock && (
            <DockButton docked={docked} onToggle={onToggleDock} />
          )}
          {onClose && (
            <button
              onClick={onClose}
              className="text-zinc-500 hover:text-red-400 transition-colors"
              aria-label="Close"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          )}
        </div>
      </div>

      {(
        <div className="flex flex-col flex-1 gap-2 px-3 py-2 min-w-0 min-h-0 overflow-auto">
          {transferProgress !== undefined && !fileName ? (
            /* ── Arriving over the data channel ── */
            <div className="flex flex-col items-center justify-center flex-1 gap-2 px-3">
              <p className="text-xs text-zinc-400">Receiving track…</p>
              <div className="w-full h-1.5 bg-zinc-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-brand-500 transition-[width] duration-150"
                  style={{ width: `${Math.round(transferProgress * 100)}%` }}
                />
              </div>
              <p className="text-xs text-zinc-500 tabular-nums">
                {Math.round(transferProgress * 100)}%
              </p>
            </div>
          ) : !fileName ? (
            /* ── Drop zone ── */
            <label
              className={`flex flex-col items-center justify-center flex-1 rounded-xl border-2 border-dashed transition-colors cursor-pointer select-none ${
                isDragOver
                  ? "border-brand-500 bg-brand-500/10"
                  : "border-zinc-700 hover:border-zinc-500"
              }`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              <input
                type="file"
                accept="audio/mpeg,audio/wav,audio/ogg,audio/flac,audio/aac,audio/mp4,.mp3,.wav,.ogg,.flac,.aac,.m4a"
                className="sr-only"
                onChange={handleFileInput}
              />
              <svg
                className="w-8 h-8 text-zinc-500 mb-2"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2z"
                />
              </svg>
              <p className="text-xs text-zinc-500 text-center px-2">
                Drop an mp3 or wav here
              </p>
              <p className="text-xs text-zinc-600 mt-0.5">or click to browse</p>
            </label>
          ) : (
            /* ── Player controls ── */
            <>
              {theme === 'digital' ? (
                <div className="flex min-h-14 flex-1 items-center gap-3 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2">
                  <button onClick={isPlaying ? pause : play} aria-label={isPlaying ? 'Pause' : 'Play'} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-500 text-white shadow hover:bg-brand-400">{isPlaying ? 'Ⅱ' : '▶'}</button>
                  <div className="min-w-0 flex-1"><p className="truncate text-xs text-zinc-300">{fileName}</p><p className="font-mono text-lg tabular-nums text-brand-300">{formatTime(currentTime)} <span className="text-[10px] text-zinc-500">/ {formatTime(duration)}</span></p></div>
                  <button onClick={stop} aria-label="Stop" className="p-2 text-zinc-400 hover:text-white">■</button>
                </div>
              ) : theme === 'tape' ? (
                <div className="flex flex-1 items-center justify-center"><TapeDeck id={id} name={fileName} playing={isPlaying} progress={progress} play={play} pause={pause} stop={stop} seek={seconds => seekTo(currentTime + seconds)} /></div>
              ) : (
              <div className="relative flex-1 min-h-0 flex items-center justify-center">
                <div className="relative w-full max-w-[560px]">
                  <svg
                    viewBox={`0 0 ${DECK_W} ${DECK_H}`}
                    className="block w-full h-auto rounded-xl shadow-[0_10px_28px_rgba(0,0,0,0.5)]"
                    role="img"
                    aria-label={`Record player — ${fileName}`}
                  >
                    <defs>
                      <linearGradient id={`wood-${id}`} x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0" stopColor="#5a3620" />
                        <stop offset="0.45" stopColor="#7c4e2c" />
                        <stop offset="0.7" stopColor="#63381f" />
                        <stop offset="1" stopColor="#452817" />
                      </linearGradient>
                      <radialGradient id={`vignette-${id}`} cx="0.5" cy="0.42" r="0.85">
                        <stop offset="0.55" stopColor="rgba(0,0,0,0)" />
                        <stop offset="1" stopColor="rgba(15,6,2,0.42)" />
                      </radialGradient>
                      <radialGradient id={`platter-${id}`} cx="0.38" cy="0.34" r="0.9">
                        <stop offset="0" stopColor="#a1a1aa" />
                        <stop offset="0.55" stopColor="#71717a" />
                        <stop offset="1" stopColor="#3f3f46" />
                      </radialGradient>
                      <radialGradient id={`label-${id}`} cx="0.42" cy="0.38" r="0.95">
                        <stop offset="0" stopColor="#f0c869" />
                        <stop offset="0.75" stopColor="#dfa63f" />
                        <stop offset="1" stopColor="#b97f2a" />
                      </radialGradient>
                      <linearGradient id={`arm-${id}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0" stopColor="#71717a" />
                        <stop offset="0.5" stopColor="#e4e4e7" />
                        <stop offset="1" stopColor="#52525b" />
                      </linearGradient>
                      {/* Circle the flavour type sits on, just outside the spindle */}
                      <path
                        id={`labelarc-${id}`}
                        d={`M ${HUB.x - 27} ${HUB.y} a 27 27 0 1 1 54 0 a 27 27 0 1 1 -54 0`}
                      />
                    </defs>

                    {/* Walnut plinth */}
                    <rect width={DECK_W} height={DECK_H} fill={`url(#wood-${id})`} />
                    {/* Grain — a few lazy contours, barely there */}
                    <g stroke="#2b1a0e" strokeWidth="1" fill="none" opacity="0.3">
                      <path d={`M0 36 C 110 30, 240 44, ${DECK_W} 34`} />
                      <path d={`M0 92 C 150 84, 260 100, ${DECK_W} 90`} />
                      <path d={`M0 168 C 120 176, 300 160, ${DECK_W} 172`} />
                      <path d={`M0 226 C 140 220, 260 234, ${DECK_W} 224`} />
                    </g>
                    <rect width={DECK_W} height={DECK_H} fill={`url(#vignette-${id})`} />

                    {/* Everything that spins: platter rim, strobe dots, vinyl,
                        grooves and the paper label — name and all. */}
                    {/* `animation: none` (rather than paused) when stopped, so
                        the label settles upright and the name stays legible —
                        a record frozen mid-spin leaves it upside down.

                        The rotation origin is pinned to the spindle in
                        view-box units, inline. Safari and Chrome disagree on
                        `transform-box: fill-box` for SVG groups — Chrome spun
                        this around the wrong point, wobbling the whole deck. */}
                    <g
                      className="deck-spin"
                      style={{
                        transformBox: "view-box",
                        transformOrigin: `${HUB.x}px ${HUB.y}px`,
                        ...(isPlaying ? {} : { animation: "none" }),
                      }}
                    >
                      <circle cx={HUB.x} cy={HUB.y} r={R_PLATTER} fill={`url(#platter-${id})`} />
                      {STROBE_DOTS.map((dot, i) => (
                        <circle key={i} cx={dot.x} cy={dot.y} r="1.4" fill="#d4d4d8" opacity="0.55" />
                      ))}
                      <circle cx={HUB.x} cy={HUB.y} r={R_VINYL} fill="#0b0b0d" />
                      {/* Grooves: fine rings, plus two brighter track separators */}
                      {[0.94, 0.86, 0.78, 0.71, 0.64, 0.57, 0.5].map((f, i) => (
                        <circle
                          key={i}
                          cx={HUB.x}
                          cy={HUB.y}
                          r={R_VINYL * f}
                          fill="none"
                          stroke="#27272a"
                          strokeWidth={i === 1 || i === 4 ? 1.6 : 0.8}
                          opacity={i === 1 || i === 4 ? 0.9 : 0.6}
                        />
                      ))}
                      {/* Paper label */}
                      <circle cx={HUB.x} cy={HUB.y} r={R_LABEL} fill={`url(#label-${id})`} stroke="#8a5a1d" strokeWidth="1" />
                      <text
                        x={HUB.x}
                        y={HUB.y - 16}
                        textAnchor="middle"
                        fill="#4a2c10"
                        fontSize={labelFontSize(fileName)}
                        fontWeight="700"
                        style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
                        {...(fileName.length > 12
                          ? { textLength: 64, lengthAdjust: "spacingAndGlyphs" as const }
                          : {})}
                      >
                        {fileName.length > 30 ? `${fileName.slice(0, 29)}…` : fileName}
                      </text>
                      <text
                        fill="#5c3a14"
                        fontSize="5"
                        fontWeight="600"
                        letterSpacing="1.4"
                      >
                        <textPath href={`#labelarc-${id}`} startOffset="25%" textAnchor="middle">
                          MAKETOGETHER.DEV · LONG PLAY · 33⅓ RPM
                        </textPath>
                      </text>
                      {/* Spindle */}
                      <circle cx={HUB.x} cy={HUB.y} r="4" fill="#e4e4e7" stroke="#52525b" strokeWidth="1" />
                    </g>

                    {/* Anisotropic sheen — the light stays put while the record
                        turns, which is what sells the spin. */}
                    <path
                      d={`M ${HUB.x} ${HUB.y} L ${HUB.x - 78} ${HUB.y - 70} A ${R_VINYL} ${R_VINYL} 0 0 1 ${HUB.x + 20} ${HUB.y - 102} Z`}
                      fill="rgba(255,255,255,0.07)"
                    />
                    <path
                      d={`M ${HUB.x} ${HUB.y} L ${HUB.x + 78} ${HUB.y + 70} A ${R_VINYL} ${R_VINYL} 0 0 1 ${HUB.x - 20} ${HUB.y + 102} Z`}
                      fill="rgba(255,255,255,0.04)"
                    />

                    {/* Strobe lamp — glows when the platter turns */}
                    <rect x="14" y={DECK_H - 34} width="24" height="15" rx="3" fill="#1c1917" stroke="#57534e" strokeWidth="1" />
                    {isPlaying && <circle cx="26" cy={DECK_H - 26.5} r="7" fill="#f59e0b" opacity="0.28" />}
                    <circle cx="26" cy={DECK_H - 26.5} r="3.2" fill={isPlaying ? "#fbbf24" : "#451a03"} />

                    {/* Tonearm: rest → outer groove at 0:00 → label run-out at
                        the end, by geometry rather than guesswork. */}
                    <circle cx={PIVOT.x} cy={PIVOT.y} r="17" fill={`url(#platter-${id})`} stroke="#3f3f46" strokeWidth="2" />
                    <g style={{ transform: `translate(${PIVOT.x}px, ${PIVOT.y}px)` }}>
                      <g
                        style={{
                          transform: `rotate(${
                            // Stopped (at 0:00 and not playing) parks the arm
                            // on its rest; play swings it in to the groove.
                            fileName && duration > 0 && (isPlaying || currentTime > 0)
                              ? armAngleAt(
                                  R_GROOVE_OUT -
                                    (R_GROOVE_OUT - R_LABEL) * Math.min(1, currentTime / duration),
                                )
                              : ARM_REST_DEG
                          }deg)`,
                          transition: "transform 0.9s ease-in-out",
                        }}
                      >
                        {/* Counterweight behind the bearing */}
                        <circle cx="-26" cy="0" r="10" fill="#3f3f46" stroke="#18181b" strokeWidth="1.5" />
                        <rect x="-30" y="-2" width="14" height="4" rx="2" fill="#52525b" />
                        {/* Arm tube */}
                        <rect x="-8" y="-2.6" width={ARM_LENGTH - 16} height="5.2" rx="2.6" fill={`url(#arm-${id})`} />
                        {/* Headshell + cartridge, stylus tip at exactly ARM_LENGTH */}
                        <path
                          d={`M ${ARM_LENGTH - 30} -4.2 L ${ARM_LENGTH - 4} -6 L ${ARM_LENGTH} 0 L ${ARM_LENGTH - 4} 6 L ${ARM_LENGTH - 30} 4.2 Z`}
                          fill="#18181b"
                          stroke="#3f3f46"
                          strokeWidth="1"
                        />
                        <circle cx={ARM_LENGTH - 2} cy="1.8" r="1.5" fill="#e4e4e7" />
                        {/* Bearing cap */}
                        <circle cx="0" cy="0" r="6.5" fill="#e4e4e7" stroke="#52525b" strokeWidth="1.5" />
                      </g>
                    </g>

                    {/* Corner screws — the plinth is furniture */}
                    {[
                      [10, 10],
                      [DECK_W - 10, 10],
                      [10, DECK_H - 10],
                      [DECK_W - 10, DECK_H - 10],
                    ].map(([sx, sy], i) => (
                      <g key={i} opacity="0.7">
                        <circle cx={sx} cy={sy} r="3" fill="#52525b" stroke="#1c1917" strokeWidth="0.8" />
                        <path d={`M ${sx - 1.8} ${sy} h 3.6 M ${sx} ${sy - 1.8} v 3.6`} stroke="#1c1917" strokeWidth="0.7" />
                      </g>
                    ))}
                  </svg>

                  {/* Transport — three mechanical square push buttons in a
                      recessed housing, bottom-right of the plinth. The one
                      matching the deck's state stays latched down, like the
                      radio buttons on an old cassette deck. */}
                  <div className="absolute bottom-[5%] right-[3%] flex gap-1 rounded-md bg-stone-950/80 border border-black/70 p-1 shadow-[inset_0_2px_5px_rgba(0,0,0,0.8)]">
                    {(
                      [
                        {
                          key: "stop" as const,
                          label: "Stop",
                          onClick: stop,
                          icon: <rect x="7" y="7" width="10" height="10" rx="1" />,
                        },
                        {
                          key: "play" as const,
                          label: "Play",
                          onClick: play,
                          icon: <path d="M8 5v14l11-7z" />,
                        },
                        {
                          key: "pause" as const,
                          label: "Pause",
                          onClick: pause,
                          icon: <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />,
                        },
                      ]
                    ).map(({ key, label, onClick, icon }) => {
                      const down = transport === key;
                      return (
                        <button
                          key={key}
                          onClick={onClick}
                          aria-label={label}
                          title={label}
                          aria-pressed={down}
                          className={`flex h-8 w-8 items-center justify-center rounded-[4px] border transition-all duration-100 ${
                            down
                              ? "translate-y-[2px] bg-gradient-to-b from-stone-600 to-stone-700 border-stone-800 text-amber-400 shadow-[inset_0_2px_4px_rgba(0,0,0,0.6)]"
                              : "bg-gradient-to-b from-stone-200 to-stone-400 border-stone-500 text-stone-800 shadow-[0_2px_0_rgba(0,0,0,0.55)] hover:from-stone-100 hover:to-stone-300 active:translate-y-[2px] active:shadow-none"
                          }`}
                        >
                          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
                            {icon}
                          </svg>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              )}

              {/* Track name + swap file button */}
              <div className="flex items-center gap-1 min-w-0">
                <p
                  className="text-xs text-zinc-200 font-medium truncate flex-1"
                  title={fileName}
                >
                  {fileName}
                </p>
                <label
                  className="shrink-0 text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
                  title="Load a different file"
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                >
                  <input
                    type="file"
                    accept="audio/mpeg,audio/wav,audio/ogg,audio/flac,audio/aac,audio/mp4,.mp3,.wav,.ogg,.flac,.aac,.m4a"
                    className="sr-only"
                    onChange={handleFileInput}
                  />
                  <svg
                    className="w-3.5 h-3.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                    />
                  </svg>
                </label>
              </div>

              {/* Seek bar */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-500 tabular-nums shrink-0 w-8 text-right">
                  {formatTime(currentTime)}
                </span>
                <div className="relative flex-1 h-1.5 group">
                  <div className="absolute inset-0 bg-zinc-700 rounded-full" />
                  <div
                    className="absolute inset-y-0 left-0 bg-brand-500 rounded-full pointer-events-none"
                    style={{ width: `${progress}%` }}
                  />
                  <input
                    type="range"
                    min={0}
                    max={duration || 0}
                    step={0.1}
                    value={currentTime}
                    onChange={event => seekTo(Number(event.target.value))}
                    aria-label="Audio position"
                    className="absolute inset-0 w-full opacity-0 cursor-pointer h-full"
                  />
                </div>
                <span className="text-xs text-zinc-500 tabular-nums shrink-0 w-8">
                  {formatTime(duration)}
                </span>
              </div>

              {/* Volume */}
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5 flex-1 min-w-0">
                  <svg
                    className="w-3.5 h-3.5 text-zinc-500 shrink-0"
                    fill="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      d={
                        volume === 0
                          ? "M16.5 12A4.5 4.5 0 0014 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0021 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25A6.96 6.96 0 0112.18 19c-.65 0-1.27-.12-1.86-.32l-1.51 1.51A8.928 8.928 0 0012 21a8.95 8.95 0 005.42-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"
                          : volume < 0.5
                            ? "M18.5 12A4.5 4.5 0 0016 7.97v8.05A4.48 4.48 0 0018.5 12zM5 9v6h4l5 5V4L9 9H5z"
                            : "M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77 0-4.28-2.99-7.86-7-8.77z"
                      }
                    />
                  </svg>
                  <div className="relative flex-1 h-1.5">
                    <div className="absolute inset-0 bg-zinc-700 rounded-full" />
                    <div
                      className="absolute inset-y-0 left-0 bg-zinc-500 rounded-full pointer-events-none"
                      style={{ width: `${volume * 100}%` }}
                    />
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.02}
                      value={volume}
                      onChange={handleVolume}
                      aria-label="Audio volume"
                      className="absolute inset-0 w-full opacity-0 cursor-pointer h-full"
                    />
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
