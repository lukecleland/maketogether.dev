export interface AudioPlaybackIntent {
  time: number;
  playing: boolean;
  at?: number;
}

/** Retain shared transport intent while a file loads or autoplay is blocked. */
export class SharedAudioPlayback {
  private intent: AudioPlaybackIntent | null = null;
  private revision = 0;

  private media: () => HTMLAudioElement | null;
  private blocked: (blocked: boolean) => void;

  constructor(media: () => HTMLAudioElement | null, blocked: (blocked: boolean) => void) {
    this.media = media;
    this.blocked = blocked;
  }

  set(intent: AudioPlaybackIntent) {
    if (!Number.isFinite(intent.time) || intent.time < 0 || (intent.at !== undefined && !Number.isFinite(intent.at))) return;
    this.intent = { ...intent, at: intent.at ?? Date.now() };
    this.revision++;
    this.apply();
  }

  snapshot(fallback?: AudioPlaybackIntent): AudioPlaybackIntent | null {
    const media = this.media();
    const intent = this.intent ?? fallback;
    const at = Date.now();
    if (!intent) return media ? { time: media.currentTime, playing: !media.paused, at } : null;
    const time = intent.time + (intent.playing && intent.at !== undefined ? Math.max(0, at - intent.at) / 1000 : 0);
    const duration = media && media.readyState >= 1 && Number.isFinite(media.duration) ? media.duration : Infinity;
    return { time: Math.min(time, duration), playing: intent.playing && time < duration, at };
  }

  reset() {
    this.intent = null;
    this.revision++;
    this.blocked(false);
  }

  apply() {
    const audio = this.media();
    const intent = this.intent;
    if (!audio || !intent || audio.readyState < 1) return;
    const elapsed = intent.playing && intent.at ? Math.max(0, Date.now() - intent.at) / 1000 : 0;
    audio.currentTime = Math.min(intent.time + elapsed, Number.isFinite(audio.duration) ? audio.duration : Infinity);
    if (!intent.playing || audio.currentTime >= audio.duration) {
      audio.pause();
      this.blocked(false);
      return;
    }
    const revision = this.revision;
    void audio.play().then(
      () => { if (revision === this.revision) this.blocked(false); },
      () => { if (revision === this.revision) this.blocked(true); },
    );
  }
}
