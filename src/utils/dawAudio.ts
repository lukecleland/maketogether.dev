/** Web Audio must share the conferencing audio route on iPad Safari. */
function prepareAudioSession() {
  const session = typeof navigator !== 'undefined'
    ? (navigator as Navigator & { audioSession?: { type: string } }).audioSession
    : undefined;
  if (!session) return;
  try {
    if (session.type !== 'play-and-record') session.type = 'play-and-record';
  } catch {
    // Unsupported session configuration must not prevent normal Web Audio.
  }
}

export function createDawAudioContext(): AudioContext {
  prepareAudioSession();
  const Constructor = globalThis.AudioContext ??
    (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Constructor) throw new Error('Audio playback is not supported by this browser.');
  return new Constructor();
}

/** Call synchronously from the gesture, before awaiting file or microphone access. */
export function resumeDawAudio(context: AudioContext, unlock = false): Promise<void> {
  prepareAudioSession();
  const resumed = context.resume();
  if (unlock && context.state !== 'running') {
    const source = context.createBufferSource();
    source.buffer = context.createBuffer(1, 1, context.sampleRate);
    source.connect(context.destination);
    source.onended = () => source.disconnect();
    source.start();
  }
  return resumed;
}

export function dawAudioNeedsGesture(context: AudioContext): boolean {
  // Safari also reports "interrupted", which is not covered by suspended alone.
  return context.state !== 'running' && context.state !== 'closed';
}
