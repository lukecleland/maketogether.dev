import { regionDuration, type DawRegion } from './daw';

/** Only enumerate repeats intersecting the viewport, including split phases. */
export function dawLoopSections(region: DawRegion, pixelsPerSecond: number, left: number, viewport: number) {
  if (region.loopDuration === undefined) return [];
  const period = (region.trimEnd - region.trimStart) / (region.speed ?? 1);
  const phase = (region.loopOffset ?? 0) / (region.speed ?? 1);
  const length = regionDuration(region);
  const from = Math.max(0, left / pixelsPerSecond);
  const to = Math.min(length, (left + viewport) / pixelsPerSecond);
  if (to <= from) return [];
  const first = Math.floor((from + phase) / period);
  const last = Math.ceil((to + phase) / period);
  // Subpixel repeats cannot show individual rounded corners; use a pattern.
  if (last - first > 2000) return null;
  return Array.from({ length: last - first }, (_, offset) => {
    const index = first + offset;
    const start = Math.max(0, index * period - phase);
    const end = Math.min(length, (index + 1) * period - phase);
    return { index, left: start * pixelsPerSecond, width: (end - start) * pixelsPerSecond };
  });
}
