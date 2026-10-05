import { useEffect, useRef, useState } from "react";

/** Replace the outgoing camera video while retaining microphone audio. */
export function useScreenShare(
  stream: MediaStream | null,
  replaceVideoTrack: (track: MediaStreamTrack | null) => Promise<void>,
) {
  const supported = typeof navigator.mediaDevices?.getDisplayMedia === "function";
  const [sharing, setSharing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<MediaStream | null>(null);
  const capture = useRef<MediaStream | null>(null);
  const camera = useRef<MediaStreamTrack[]>([]);
  const generation = useRef(0);
  const pending = useRef(false);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    setSharing(false);
    setPreview(null);
    setBusy(false);
    return () => {
      generation.current = currentGeneration + 1;
      capture.current?.getTracks().forEach((track) => {
        track.onended = null;
        track.stop();
      });
      camera.current.forEach((track) => track.stop());
      capture.current = null;
      camera.current = [];
    };
  }, [stream]);

  const stop = async () => {
    const display = capture.current;
    if (!display || !stream) return;
    capture.current = null;
    display.getTracks().forEach((track) => {
      track.onended = null;
      stream.removeTrack(track);
      track.stop();
    });
    const restored = camera.current.filter(
      (track) => track.readyState === "live",
    );
    restored.forEach((track) => stream.addTrack(track));
    camera.current = [];
    setSharing(false);
    setPreview(new MediaStream(stream.getTracks()));
    try {
      await replaceVideoTrack(restored[0] ?? null);
    } catch {
      setError(
        "Screen sharing stopped, but your camera could not reconnect. Try restarting the camera.",
      );
    }
  };

  const toggle = async () => {
    if (pending.current) return;
    if (capture.current) {
      await stop();
      return;
    }
    if (!stream || !navigator.mediaDevices?.getDisplayMedia) {
      setError(
        "Screen sharing is not available in this browser. Try a desktop browser over HTTPS.",
      );
      return;
    }
    pending.current = true;
    setBusy(true);
    setError(null);
    const request = generation.current;
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
      if (request !== generation.current) {
        display.getTracks().forEach((track) => track.stop());
        return;
      }
      const track = display.getVideoTracks()[0];
      if (!track || track.readyState !== "live") {
        display.getTracks().forEach((track) => track.stop());
        return;
      }
      camera.current = stream.getVideoTracks();
      camera.current.forEach((track) => stream.removeTrack(track));
      stream.addTrack(track);
      capture.current = display;
      track.onended = () => void stop();
      setPreview(new MediaStream(stream.getTracks()));
      setSharing(true);
      try {
        await replaceVideoTrack(track);
      } catch {
        await stop();
        setError("Your screen could not be shared. Please try again.");
      }
    } catch (cause) {
      if (
        request === generation.current &&
        !(cause instanceof DOMException && cause.name === "NotAllowedError")
      )
        setError(
          "Screen sharing could not start. Check your browser and system screen-recording permissions.",
        );
    } finally {
      pending.current = false;
      if (request === generation.current) setBusy(false);
    }
  };
  return { supported, sharing, busy, error, preview, toggle, stop };
}
