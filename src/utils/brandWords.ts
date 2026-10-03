// Shuffle the lyric as one phrase so the in-joke stays in order.
const phrases = ['work', 'watch', 'create', 'record', 'jam', 'learn', 'sing', 'laugh', 'party', 'sketch', 'build', 'develop', 'write', 'compose', 'code', 'grow', 'produce', 'decide', 'teach', 'come', 'talk', ['stop', 'collaborate', 'listen']] as const;
export const brandWordDuration = (word: string) => word === 'make' ? 6000 : 3000;

// Make is the shared bookend between cycles, with one six-second hold.
export function buildBrandWords(random: () => number = Math.random): string[] {
  const shuffled = [...phrases];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
  }
  return ['make', ...shuffled.flatMap(phrase => typeof phrase === 'string' ? [phrase] : [...phrase])];
}
