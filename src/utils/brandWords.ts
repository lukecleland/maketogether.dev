const words = ['work', 'watch', 'create', 'record', 'jam', 'learn', 'sing', 'laugh', 'party', 'sketch', 'build', 'develop', 'write', 'compose', 'code', 'grow', 'produce', 'decide', 'teach', 'come', 'talk'];
export const BRAND_WORD_DURATION = 2600;

// Build one repeating sequence per page load. Each sixth display is "make".
export function buildBrandWords(random: () => number = Math.random): string[] {
  const shuffled = [...words];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
  }
  // Fill five complete groups, and place the lyric inside a group so make
  // never interrupts "stop, collaborate, listen".
  shuffled.push(shuffled[0]);
  const lyricStart = Math.floor(random() * 5) * 5 + Math.floor(random() * 3);
  shuffled.splice(lyricStart, 0, 'stop', 'collaborate', 'listen');
  return shuffled.flatMap((word, index) => index % 5 === 0 ? ['make', word] : [word]);
}
