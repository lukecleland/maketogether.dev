import { useId } from 'react';
import type { DawRegion } from '../utils/daw';
import { dawLoopSections } from '../utils/dawLoopSections';

export function DawLoopSections({ region, pixelsPerSecond, left, viewport, selected, colour }: {
  region: DawRegion; pixelsPerSecond: number; left: number; viewport: number; selected: boolean; colour: string;
}) {
  const patternId = useId();
  const sections = dawLoopSections(region, pixelsPerSecond, left, viewport);
  const border = selected ? 'white' : colour;
  if (!sections) return <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full">
    <defs><pattern id={patternId} patternUnits="userSpaceOnUse" width={(region.trimEnd - region.trimStart) / (region.speed ?? 1) * pixelsPerSecond} height="100%">
      <rect width="100%" height="100%" fill={`${colour}20`} stroke={border} strokeWidth="1" />
    </pattern></defs><rect width="100%" height="100%" fill={`url(#${patternId})`} />
  </svg>;
  return <div aria-hidden="true" className="pointer-events-none absolute inset-0">
    {sections.map(section => <div key={section.index} data-loop-section={section.index}
      className="absolute inset-y-px overflow-hidden rounded-md border"
      style={{ left: section.left + 1, width: Math.max(0, section.width - 2), borderColor: border, background: `${colour}20` }}>
      <span className="absolute inset-x-0 top-0 h-6 truncate border-b border-current/20 bg-current/10 px-2 py-1 text-[10px]">{region.name}</span>
    </div>)}
  </div>;
}
