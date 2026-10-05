import { useState, useRef, useCallback, useEffect } from "react";
import { useYouTubeSync, type SyncMessage } from "../hooks/useYouTubeSync";
import { useYouTubePlayer } from "../hooks/useYouTubePlayer";
import { DockButton } from "./Dock";
import type { RoomDataConnection } from "../hooks/usePeer";
import type { PanelPlayback } from "../types/panels";

/**
 * YoutubeWidget — YouTube player with URL input and bidirectional sync.
 *
 * ## Sync flow (outbound)
 * User actions (play/pause/seek) → `handleStateChange` → `sendSync`
 *
 * ## Sync flow (inbound)
 * Remote message → `handleRemoteSync` → `seekTo` + `playVideo`/`pauseVideo`
 *
 * ## Echo prevention
 * Calling `seekTo()` and then `playVideo()` causes the YT IFrame API to fire
 * `onStateChange` events, which would echo back to the remote peer. A
 * timestamp-based guard (`syncUntilRef`) suppresses all state events for 500 ms
 * after any remote-triggered command, regardless of how many intermediate
 * states (buffering, seeking) the player emits before settling.
 */

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

  // Suppress echoing remote-triggered state changes back to the peer.
  // Set to a future timestamp when a remote sync arrives; all state events
  // fired within that window are ignored, regardless of type.
  const syncUntilRef = useRef<number>(0);
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

      // Only act on terminal playback states; ignore buffering (3), cued (5), etc.
      if (state !== 0 && state !== 1 && state !== 2) return;

      // Suppress all state changes fired within the remote-sync window.
      if (Date.now() < syncUntilRef.current) return;
      const time = getCurrentTime();
      playbackStateRef.current = { time, at: Date.now(), playing: state === 1 };
      onPlaybackChangeRef.current?.({ time, playing: state === 1, at: Date.now() });
      const at = Date.now();
      if (state === 1) sendSyncRef.current({ type: "play", id, time, at });
      if (state === 0 || state === 2) sendSyncRef.current({ type: "pause", id, time, at });
    },
    [id],
  );

  const { loadVideo, playVideo, pauseVideo, seekTo, setVolume, restorePlayback, getCurrentTime, getTitle } =
    useYouTubePlayer(playerContainerRef, { onStateChange: handleStateChange });
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
      if (initialPlayback) {
        playbackStateRef.current = { ...initialPlayback, at: initialPlayback.at ?? Date.now() };
        restorePlayback(initialVideoId, initialPlayback.time, initialPlayback.playing, initialPlayback.at);
      }
      else loadVideo(initialVideoId);
    }
    // Mount or authoritative room restore, not ordinary playhead persistence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbackRevision]);

  useEffect(() => {
    if (!hasVideo || !onPlaybackChange) return;
    const timer = setInterval(() => {
      const intent = playbackStateRef.current;
      onPlaybackChangeRef.current?.({ time: intent.playing ? currentSyncedTime(intent.time, intent.at) : intent.time, playing: intent.playing, at: Date.now() });
    }, 1000);
    return () => clearInterval(timer);
  }, [getCurrentTime, hasVideo, onPlaybackChange]);

  const handleRemoteSync = useCallback(
    (msg: SyncMessage) => {
      if (msg.type === "load") {
        if (msg.id !== id) return;
        setInputValue(watchUrl(msg.videoId));
        setHasVideo(true);
        loadVideo(msg.videoId);
        onVideoChange?.(msg.videoId);
      } else if (msg.type === "play") {
        if (msg.id !== id) return;
        syncUntilRef.current = Date.now() + 500;
        playbackStateRef.current = { time: msg.time, at: msg.at ?? Date.now(), playing: true };
        seekTo(currentSyncedTime(msg.time, msg.at));
        playVideo();
      } else if (msg.type === "pause") {
        if (msg.id !== id) return;
        syncUntilRef.current = Date.now() + 500;
        playbackStateRef.current = { time: msg.time, at: msg.at ?? Date.now(), playing: false };
        seekTo(msg.time);
        pauseVideo();
      } else if (msg.type === "seek") {
        if (msg.id !== id) return;
        syncUntilRef.current = Date.now() + 500;
        playbackStateRef.current = { ...playbackStateRef.current, time: msg.time, at: msg.at ?? Date.now() };
        seekTo(msg.time);
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

  const handleSubmit = () => {
    const videoId = parseVideoId(inputValue);
    if (!videoId) {
      setInputError(true);
      setTimeout(() => setInputError(false), 1500);
      return;
    }
    setHasVideo(true);
    loadVideo(videoId);
    onVideoChange?.(videoId);
    sendSync({ type: "load", id, videoId });
  };

  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text");
    const videoId = parseVideoId(text);
    if (videoId) {
      e.preventDefault();
      setInputValue(text);
      setHasVideo(true);
      loadVideo(videoId);
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
              Hover here and paste a YouTube URL to watch together
            </div>
          )}

          {/* The player stays mounted so playback state survives panel animations. */}
          <div
            ref={playerContainerRef}
            className={`absolute inset-0 h-full w-full ${!hasVideo ? "hidden" : ""}`}
          />
        </div>
    </div>
  );
}
