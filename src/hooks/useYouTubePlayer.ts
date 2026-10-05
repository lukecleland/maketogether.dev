import { useEffect, useRef, useCallback, type RefObject } from "react";

/**
 * useYouTubePlayer — a stable wrapper around the YouTube IFrame Player API.
 *
 * ## Why not react-youtube?
 * react-youtube wraps the player in React state, which causes it to recreate
 * the underlying iframe on re-renders. The YT.Player instance then loses its
 * internal iframe reference, breaking all subsequent postMessage calls with
 * a "target origin mismatch" error. This hook avoids that by:
 *
 * 1. Loading the iframe_api script exactly once (singleton `apiPromise`).
 * 2. Creating the YT.Player inside a raw DOM div that is appended directly to
 *    a stable container ref — React never touches the player element.
 * 3. Keeping the player mounted for the entire component lifetime; it is only
 *    destroyed on unmount.
 *
 * ## Echo prevention
 * `onStateChange` is called for every playback state transition, including
 * intermediate ones (buffering=3, cued=5). Callers should filter to terminal
 * states 1 (playing) and 2 (paused) and use a time-window guard to avoid
 * echoing remote-triggered state changes back to the peer.
 */

// ----- Minimal YT types (avoids needing @types/youtube) -----
interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  loadVideoById(videoId: string): void;
  setVolume(volume: number): void;
  destroy(): void;
  /**
   * Undocumented but long-stable API returning metadata for the loaded video.
   * Only populated once the player has fetched it, so read it on a state
   * change rather than immediately after `loadVideoById`.
   */
  getVideoData?(): { title?: string; video_id?: string };
}

interface YTPlayerOptions {
  width?: string | number;
  height?: string | number;
  playerVars?: Record<string, unknown>;
  events?: {
    onReady?: (event: { target: YTPlayer }) => void;
    onStateChange?: (event: { data: number; target: YTPlayer }) => void;
  };
}

declare global {
  interface Window {
    YT?: {
      Player: new (
        element: HTMLElement | string,
        options: YTPlayerOptions,
      ) => YTPlayer;
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

// Singleton loader — the iframe_api script is never added twice
let apiPromise: Promise<void> | null = null;

function ensureYouTubeAPI(): Promise<void> {
  if (apiPromise) return apiPromise;
  if (window.YT?.Player) return (apiPromise = Promise.resolve());
  apiPromise = new Promise((resolve) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve();
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(script);
  });
  return apiPromise;
}

// -----

interface UseYouTubePlayerOptions {
  /**
   * Called when the player's state changes.
   * `getCurrentTime` is a function you call to get the current timestamp
   * (avoids holding a stale player reference in the callback closure).
   */
  onStateChange?: (state: number, getCurrentTime: () => number) => void;
}

export function useYouTubePlayer(
  containerRef: RefObject<HTMLDivElement | null>,
  options: UseYouTubePlayerOptions = {},
) {
  const playerRef = useRef<YTPlayer | null>(null);
  const pendingTransportRef = useRef<{ time: number; playing: boolean; at: number } | null>(null);
  const pendingVolumeRef = useRef<number | null>(null);
  const pendingVideoRef = useRef<string | null>(null);
  const pendingPlaybackRef = useRef<{ videoId: string; time: number; playing: boolean; at?: number } | null>(null);
  // Always read the latest callback without re-creating the player
  const onStateChangeRef = useRef(options.onStateChange);
  onStateChangeRef.current = options.onStateChange;

  useEffect(() => {
    // containerRef.current is stable for the lifetime of the widget
    const container = containerRef.current;
    if (!container) return;

    // YT.Player replaces the target element with an iframe.
    // Use a child div so our container div stays intact.
    const div = document.createElement("div");
    container.appendChild(div);

    let player: YTPlayer | null = null;
    let cancelled = false;

    ensureYouTubeAPI().then(() => {
      if (cancelled || !window.YT?.Player) return;

      player = new window.YT.Player(div, {
        width: "100%",
        height: "100%",
        playerVars: {
          autoplay: 0,
          playsinline: 1,
          modestbranding: 1,
          rel: 0,
          // Tells YouTube the exact origin allowed to communicate with the player.
          // This prevents the postMessage "target origin mismatch" error.
          origin: window.location.origin,
        },
        events: {
          onReady: ({ target }) => {
            if (cancelled) return;
            playerRef.current = target;
            if (pendingVolumeRef.current !== null) target.setVolume(pendingVolumeRef.current);
            // Apply any video that was requested before the player was ready
            if (pendingVideoRef.current) {
              target.loadVideoById(pendingVideoRef.current);
              pendingVideoRef.current = null;
            }
            if (pendingPlaybackRef.current) {
              const pending = pendingPlaybackRef.current;
              target.loadVideoById(pending.videoId);
              target.seekTo(pending.time + (pending.playing && pending.at !== undefined ? Math.max(0, Date.now() - pending.at) / 1000 : 0), true);
              if (pending.playing) target.playVideo();
              else target.pauseVideo();
              pendingPlaybackRef.current = null;
            }
            const transport = pendingTransportRef.current;
            if (transport) {
              target.seekTo(transport.time + (transport.playing ? Math.max(0, Date.now() - transport.at) / 1000 : 0), true);
              if (transport.playing) target.playVideo();
              else target.pauseVideo();
              pendingTransportRef.current = null;
            }
          },
          onStateChange: ({ data, target }) => {
            if (cancelled) return;
            onStateChangeRef.current?.(data, () => target.getCurrentTime());
          },
        },
      });
    });

    return () => {
      cancelled = true;
      try {
        player?.destroy();
      } catch {
        /* ignore errors during teardown */
      }
      playerRef.current = null;
      if (container.contains(div)) container.removeChild(div);
    };
    // containerRef is a stable ref object — safe to omit from deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadVideo = useCallback((videoId: string) => {
    pendingPlaybackRef.current = null;
    pendingTransportRef.current = null;
    if (playerRef.current) {
      playerRef.current.loadVideoById(videoId);
    } else {
      // Player not ready yet — queue and apply in onReady
      pendingVideoRef.current = videoId;
    }
  }, []);

  const playVideo = useCallback(() => {
    if (playerRef.current) playerRef.current.playVideo();
    else pendingTransportRef.current = { time: pendingTransportRef.current?.time ?? pendingPlaybackRef.current?.time ?? 0, playing: true, at: Date.now() };
  }, []);
  const pauseVideo = useCallback(() => {
    if (playerRef.current) playerRef.current.pauseVideo();
    else pendingTransportRef.current = { time: pendingTransportRef.current?.time ?? pendingPlaybackRef.current?.time ?? 0, playing: false, at: Date.now() };
  }, []);
  const seekTo = useCallback((seconds: number) => {
    if (playerRef.current) playerRef.current.seekTo(seconds, true);
    else pendingTransportRef.current = { time: seconds, playing: pendingTransportRef.current?.playing ?? pendingPlaybackRef.current?.playing ?? false, at: Date.now() };
  }, []);

  const setVolume = useCallback((volume: number) => {
    pendingVolumeRef.current = Math.round(Math.max(0, Math.min(100, volume)));
    playerRef.current?.setVolume(pendingVolumeRef.current);
  }, []);

  const restorePlayback = useCallback((videoId: string, time: number, playing: boolean, at?: number) => {
    pendingTransportRef.current = null;
    const player = playerRef.current;
    if (!player) {
      pendingVideoRef.current = null;
      pendingPlaybackRef.current = { videoId, time, playing, at: at ?? Date.now() };
      return;
    }
    player.loadVideoById(videoId);
    player.seekTo(time + (playing && at !== undefined ? Math.max(0, Date.now() - at) / 1000 : 0), true);
    if (playing) player.playVideo();
    else player.pauseVideo();
  }, []);

  const getCurrentTime = useCallback(() => playerRef.current?.getCurrentTime() ?? 0, []);

  /** Title of the loaded video, or null until the player has the metadata. */
  const getTitle = useCallback((): string | null => {
    try {
      return playerRef.current?.getVideoData?.()?.title || null;
    } catch {
      // getVideoData is undocumented — never let it break the caller
      return null;
    }
  }, []);

  return { loadVideo, playVideo, pauseVideo, seekTo, setVolume, restorePlayback, getCurrentTime, getTitle };
}
