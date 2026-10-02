// Shuffle the lyric as one group so the in-joke stays in order.
const phrases = ['make', 'work', 'watch', 'create', 'record', 'jam', 'learn', 'sing', 'laugh', 'party', 'sketch', 'build', 'develop', 'write', 'compose', 'code', 'grow', 'produce', 'decide', 'teach', 'come', 'talk', ['stop', 'collaborate', 'listen']] as const;
export const BRAND_WORD_DURATION = 2600;

export function buildBrandWords(random: () => number = Math.random, previousWord?: string): string[] {
  const shuffled = [...phrases];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
  }
  // Avoid displaying the same word twice at the boundary between cycles.
  if (shuffled[0] === previousWord) [shuffled[0], shuffled[1]] = [shuffled[1], shuffled[0]];
  return shuffled.flatMap(phrase => typeof phrase === 'string' ? [phrase] : [...phrase]);
}
