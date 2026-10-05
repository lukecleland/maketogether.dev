import { useState, useRef, useCallback, useEffect } from "react";
import { useYouTubeSync, type SyncMessage } from "../hooks/useYouTubeSync";
import { useYouTubePlayer } from "../hooks/useYouTubePlayer";
import { DockButton } from "./Dock";
import type { RoomDataConnection } from "../hooks/usePeer";
import type { PanelPlayback } from "../types/panels";

interface YoutubeWidgetProps {
  id: string;
  dataConnection: RoomDataConnection | null;
  initialVideoId?: string;
  onClose?: () => void;
  /** 0–1 spatial volume multiplier updated by the parent on every canvas transform change. */
  spatialVolume?: number;
  /** Whether this panel currently has a dock shortcut. */
  docked?: boolean;
  onToggleDock?: () => void;
  onMinimize?: () => void;
  /** Reports the loaded video's title so the parent can label the dock chip. */
  onTitleChange?: (title: string) => void;
  initialPlayback?: PanelPlayback;
  playbackRevision?: string;
  onPlaybackChange?: (playback: PanelPlayback) => void;
  onVideoChange?: (videoId: string) => void;
  title?: string;
}

function parseVideoId(input: string): string | null {
  try {
    const url = new URL(input.trim());
    const hostname = url.hostname.toLowerCase().replace(/^(www\.|m\.)/, "");
    if (hostname === "youtu.be") return url.pathname.slice(1).split("/")[0];
    if (hostname !== "youtube.com") return null;
    if (url.searchParams.has("v")) return url.searchParams.get("v");
    const pathMatch = url.pathname.match(
      /^\/(?:embed|shorts|live)\/([^/?]+)/,
    );
    if (pathMatch) return pathMatch[1];
  } catch {
    // not a URL — treat as raw ID
    if (/^[a-zA-Z0-9_-]{11}$/.test(input.trim())) return input.trim();
  }
  return null;
}

function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/** Project a playing media position onto this client's wall clock. */
function currentSyncedTime(time: number, sentAt?: number): number {
  if (!sentAt) return time;
  return time + Math.max(0, Date.now() - sentAt) / 1000;
}

export function YoutubeWidget({
  id,
  dataConnection,
  initialVideoId,
  onClose,
  spatialVolume = 1,
  docked = false,
  onToggleDock,
  onMinimize,
  onTitleChange,
  initialPlayback,
  playbackRevision,
  onPlaybackChange,
  onVideoChange,
  title = "Make Together",
}: YoutubeWidgetProps) {
  const [hasVideo, setHasVideo] = useState(false);
  const [inputValue, setInputValue] = useState(() =>
    initialVideoId ? watchUrl(initialVideoId) : "",
  );
  const [inputError, setInputError] = useState(false);

  const [playing, setPlaying] = useState(initialPlayback?.playing ?? false);
  const [position, setPosition] = useState(initialPlayback?.time ?? 0);
  const [duration, setDuration] = useState(0);
  const [blocked, setBlocked] = useState(false);
  // Wait for the actual state/position acknowledgement, never a fixed timeout.
  const applyingRef = useRef(false);
  const blockedRef = useRef(false);
  const sampleRef = useRef<{ time: number; at: number; state: number } | null>(null);
  const playerContainerRef = useRef<HTMLDivElement>(null);
  // sendSync is set below after useYouTubeSync; use a ref to avoid circular deps
  const sendSyncRef = useRef<(msg: SyncMessage) => void>(() => {});
  // getTitle comes from the player hook below — same circular-dep dodge
  const getTitleRef = useRef<() => string | null>(() => null);
  const onTitleChangeRef = useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;
  const lastReportedTitleRef = useRef<string | null>(null);
  const playbackStateRef = useRef({ time: initialPlayback?.time ?? 0, at: initialPlayback?.at ?? Date.now(), playing: initialPlayback?.playing ?? false });
  const onPlaybackChangeRef = useRef(onPlaybackChange);
  onPlaybackChangeRef.current = onPlaybackChange;

  // Called by useYouTubePlayer when the player's playback state changes
  const handleStateChange = useCallback(
    (state: number, getCurrentTime: () => number) => {
      // Video metadata arrives asynchronously, so check for a title on *every*
      // state change (including cued/buffering) rather than only 1 and 2.
      const title = getTitleRef.current();
      if (title && title !== lastReportedTitleRef.current) {
        lastReportedTitleRef.current = title;
        onTitleChangeRef.current?.(title);
      }

      const intent = playbackStateRef.current;
      const time = getCurrentTime();
      if (state === 1) { blockedRef.current = false; setBlocked(false); }
      if (applyingRef.current) {
        const expected = intent.playing ? currentSyncedTime(intent.time, intent.at) : intent.time;
        if ((state === (intent.playing ? 1 : 2) || (!intent.playing && state === 5)) && Math.abs(time - expected) < 2) {
          applyingRef.current = false;
          sampleRef.current = null;
        }
        return;
      }
      if (blockedRef.current || (state !== 0 && state !== 1 && state !== 2)) return;
      const expected = intent.playing ? currentSyncedTime(intent.time, intent.at) : intent.time;
      const nextPlaying = state === 1;
      if (nextPlaying === intent.playing && Math.abs(time - expected) < 2) return;
      const at = Date.now();
      playbackStateRef.current = { time, at, playing: nextPlaying };
      setPlaying(nextPlaying); setPosition(time);
      onPlaybackChangeRef.current?.(playbackStateRef.current);
      sendSyncRef.current({ type: nextPlaying ? "play" : "pause", id, time, at });
    },
    [id],
  );

  const { loadVideo, playVideo, pauseVideo, seekTo, setVolume, restorePlayback, getCurrentTime, getTitle, getDuration, getPlayerState } =
    useYouTubePlayer(playerContainerRef, { onStateChange: handleStateChange, onAutoplayBlocked: () => { blockedRef.current = true; setBlocked(true); } });
  getTitleRef.current = getTitle;

  // Keep YouTube player volume in sync with spatial positioning
  useEffect(() => {
    setVolume(spatialVolume * 100);
  }, [spatialVolume, setVolume]);

  // Auto-load if created with an initial video ID (e.g. from a background URL drop)
  useEffect(() => {
    if (initialVideoId) {
      setInputValue(watchUrl(initialVideoId));
      setHasVideo(true);
      applyingRef.current = true;
      if (initialPlayback) {
        setPlaying(initialPlayback.playing); setPosition(initialPlayback.time);
        playbackStateRef.current = { ...initialPlayback, at: initialPlayback.at ?? Date.now() };
        restorePlayback(initialVideoId, initialPlayback.time, initialPlayback.playing, initialPlayback.at);
      }
      else {
        playbackStateRef.current = { time: 0, at: Date.now(), playing: true };
        setPlaying(true); loadVideo(initialVideoId);
      }
    }
    // Mount or authoritative room restore, not ordinary playhead persistence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbackRevision]);

  useEffect(() => {
    if (!hasVideo) return;
    let tickCount = 0;
    const tick = () => {
      const intent = playbackStateRef.current;
      const time = intent.playing ? currentSyncedTime(intent.time, intent.at) : intent.time;
      setPosition(time); setDuration(getDuration());
      if (++tickCount % 4 === 0) onPlaybackChangeRef.current?.({ time, playing: intent.playing, at: Date.now() });
      const actual = getCurrentTime(), state = getPlayerState();
      if (applyingRef.current && !blockedRef.current && state === (intent.playing ? 1 : 2) && Math.abs(actual - time) < 2) applyingRef.current = false;
      const previous = sampleRef.current;
      // A paused iframe seek need not emit any state-change event.
      if (!applyingRef.current && !blockedRef.current && state === 2 && previous?.state === 2 && Math.abs(actual - previous.time) > 0.5) {
        const at = Date.now();
        playbackStateRef.current = { time: actual, at, playing: false };
        setPosition(actual);
        sendSyncRef.current({ type: "seek", id, time: actual, at, playing: false });
      }
      sampleRef.current = applyingRef.current ? null : { time: actual, at: Date.now(), state };
    };
    const timer = setInterval(tick, 250);
    const recover = () => {
      if (document.visibilityState === "hidden") return;
      const intent = playbackStateRef.current;
      applyingRef.current = true; sampleRef.current = null;
      seekTo(intent.playing ? currentSyncedTime(intent.time, intent.at) : intent.time);
      if (intent.playing) playVideo(); else pauseVideo();
    };
    document.addEventListener("visibilitychange", recover);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", recover); };
  }, [id, getCurrentTime, getDuration, getPlayerState, hasVideo, seekTo, playVideo, pauseVideo]);

  const handleRemoteSync = useCallback(
    (msg: SyncMessage) => {
      if (!("id" in msg) || msg.id !== id) return;
      if (msg.type === "load") {
        applyingRef.current = true; sampleRef.current = null;
        playbackStateRef.current = { time: 0, at: Date.now(), playing: true };
        onPlaybackChangeRef.current?.(playbackStateRef.current);
        setPlaying(true); setPosition(0);
        setInputValue(watchUrl(msg.videoId)); setHasVideo(true);
        loadVideo(msg.videoId); onVideoChange?.(msg.videoId);
      } else if (msg.type === "play" || msg.type === "pause" || msg.type === "seek") {
        applyingRef.current = true; sampleRef.current = null;
        const playing = msg.type === "play" || (msg.type === "seek" && (msg.playing ?? playbackStateRef.current.playing));
        playbackStateRef.current = { time: msg.time, at: msg.at ?? Date.now(), playing };
        onPlaybackChangeRef.current?.(playbackStateRef.current);
        setPlaying(playing); setPosition(msg.time);
        seekTo(playing ? currentSyncedTime(msg.time, msg.at) : msg.time);
        if (playing) playVideo(); else pauseVideo();
      }
    },
    [id, loadVideo, onVideoChange, playVideo, pauseVideo, seekTo],
  );

  const { sendSync } = useYouTubeSync({
    dataConnection,
    onRemoteSync: handleRemoteSync,
  });
  // Keep sendSyncRef current without re-creating handleStateChange on every render
  sendSyncRef.current = sendSync;

  const startVideo = (videoId: string) => {
    applyingRef.current = true; sampleRef.current = null;
    playbackStateRef.current = { time: 0, at: Date.now(), playing: true };
    onPlaybackChangeRef.current?.(playbackStateRef.current);
    setPlaying(true); setPosition(0); setHasVideo(true); loadVideo(videoId);
  };

  const control = (time: number, nextPlaying: boolean, seeking = false) => {
    const at = Date.now();
    applyingRef.current = true; sampleRef.current = null;
    playbackStateRef.current = { time, at, playing: nextPlaying };
    setPlaying(nextPlaying); setPosition(time);
    onPlaybackChangeRef.current?.(playbackStateRef.current);
    // Publish the intent even when this device is still waiting for audio permission.
    sendSync({ type: seeking ? "seek" : nextPlaying ? "play" : "pause", id, time, at, playing: nextPlaying });
    seekTo(time);
    if (nextPlaying) playVideo(); else pauseVideo();
  };
  const sharedPosition = () => {
    const intent = playbackStateRef.current;
    return intent.playing ? currentSyncedTime(intent.time, intent.at) : intent.time;
  };

  const handleSubmit = () => {
    const videoId = parseVideoId(inputValue);
    if (!videoId) {
      setInputError(true);
      setTimeout(() => setInputError(false), 1500);
      return;
    }
    startVideo(videoId);
    onVideoChange?.(videoId);
    sendSync({ type: "load", id, videoId });
  };

  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text");
    const videoId = parseVideoId(text);
    if (videoId) {
      e.preventDefault();
      setInputValue(text);
      startVideo(videoId);
      onVideoChange?.(videoId);
      sendSync({ type: "load", id, videoId });
    }
  };

  return (
    <div className="group flex flex-col h-full bg-zinc-900 border border-zinc-700 rounded-2xl overflow-hidden">
      {/* Header / drag handle */}
      <div className="drag-handle flex items-center justify-between px-3 py-2 bg-zinc-800 cursor-grab active:cursor-grabbing select-none shrink-0">
        <div className="flex items-center gap-2">
          <svg
            className="w-4 h-4 text-red-500"
            viewBox="0 0 24 24"
            fill="currentColor"
          >
            <path d="M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
          </svg>
          <span className="text-xs font-semibold text-zinc-300">
            {title}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {onToggleDock && (
            <DockButton docked={docked} onToggle={onToggleDock} reserveMinimizeSlot={false} />
          )}
          {onMinimize && <button onClick={onMinimize} className="no-drag flex h-5 w-4 items-center justify-center text-base leading-none text-zinc-400 hover:text-white" title="Minimise to dock" aria-label="Minimise to dock">_</button>}
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

      <div className="relative flex-1 min-h-0 overflow-hidden">
          {/* The URL control floats over the video instead of taking permanent
              space. Focus keeps it visible while the pointer moves to type. */}
          <div className="youtube-link-controls no-drag pointer-events-none absolute inset-x-0 top-0 z-10 bg-gradient-to-b from-black/90 to-transparent p-2 pb-6 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
            <div className="relative min-w-0">
              <input
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onPaste={onPaste}
                onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
                placeholder="Paste a YouTube URL…"
                className={`w-full bg-zinc-900/95 text-zinc-100 text-xs rounded-lg px-3 py-2 outline-none border shadow-lg transition-colors placeholder:text-zinc-500 ${
                  inputValue ? "pr-6" : ""
                } ${
                  inputError
                    ? "border-red-500"
                    : "border-zinc-700 focus:border-brand-500"
                }`}
              />
              {inputValue && (
                <button
                  onClick={() => setInputValue("")}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors"
                  aria-label="Clear"
                  tabIndex={-1}
                >
                  <svg
                    className="w-3 h-3"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2.5}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              )}
            </div>
          </div>

          {!hasVideo && (
            <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-zinc-600">
              Paste a YouTube URL to watch together
            </div>
          )}

          {/* The player stays mounted so playback state survives panel animations. */}
          <div
            ref={playerContainerRef}
            className={`absolute inset-0 h-full w-full ${!hasVideo ? "hidden" : ""}`}
          />
        </div>
      {hasVideo && <div className="youtube-transport no-drag shrink-0 flex flex-wrap items-center gap-2 px-3 py-2 bg-zinc-800 text-xs text-zinc-200">
        <button className="min-h-11 px-3 rounded bg-zinc-700" aria-label={playing ? "Pause YouTube for everyone" : "Play YouTube for everyone"} onClick={() => control(sharedPosition(), !playing)}>{playing ? "Pause" : "Play"}</button>
        <input className="min-w-16 flex-1 h-11 accent-red-500" type="range" aria-label="YouTube playback position" min={0} max={duration || Math.max(1, position)} step={0.1} value={Math.min(position, duration || position)} disabled={!duration} onChange={event => control(Number(event.target.value), playbackStateRef.current.playing, true)} />
        <span className="tabular-nums">{Math.floor(position / 60)}:{String(Math.floor(position % 60)).padStart(2, "0")}</span>
        {blocked && <button className="min-h-11 px-3 rounded bg-red-700" onClick={() => {
          applyingRef.current = true; sampleRef.current = null;
          seekTo(sharedPosition());
          if (playbackStateRef.current.playing) playVideo(); else pauseVideo();
        }}>Enable playback on this device</button>}
      </div>}
    </div>
  );
}
