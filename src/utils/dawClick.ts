/** Short synthesized clicks stay out of recorded files and exported mixes. */
export function scheduleDawClick(ctx: AudioContext, at: number, beat: number) {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.frequency.value = beat % 4 === 0 ? 1400 : 950;
  gain.gain.setValueAtTime(0.22, at);
  gain.gain.exponentialRampToValueAtTime(0.001, at + 0.04);
  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
  oscillator.start(at);
  oscillator.stop(at + 0.05);
  return oscillator;
}
