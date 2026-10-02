import { regionDuration, type DawRegion, type DawTrack } from '../utils/daw';

const button = 'rounded border border-zinc-700 bg-zinc-800 px-2 py-2 text-xs hover:bg-zinc-700 disabled:opacity-40';
const input = 'rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-white';
export function DawRegionEditor({ region, tracks, trackId, disabled, onPatch, onMove, onGesture, actions }: {
  region: DawRegion; tracks: DawTrack[]; trackId: string; disabled: boolean;
  onPatch: (patch: Partial<DawRegion>) => void;
  onMove: (trackId: string) => void;
  onGesture: (active: boolean) => void;
  actions: { label: string; action: () => void; disabled?: boolean }[];
}) {
  const period = (region.trimEnd - region.trimStart) / (region.speed ?? 1);
  return <fieldset disabled={disabled} aria-label="Audio region controls" onFocusCapture={() => onGesture(true)} onBlurCapture={() => onGesture(false)} className="max-h-56 shrink-0 overflow-auto border-t border-zinc-700 bg-zinc-900 p-2 text-xs">
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-1">Name <input aria-label="Region name" className={`${input} w-36`} maxLength={200} value={region.name} onChange={event => onPatch({ name: event.target.value })} /></label>
      <label className="flex items-center gap-1">Track <select aria-label="Move region to track" className={input} value={trackId} onChange={event => onMove(event.target.value)}>{tracks.filter(track => track.kind !== 'midi').map(track => <option key={track.id} value={track.id}>{track.name}</option>)}</select></label>
      {([
        ['Position', 'start', region.start, 0, 1800],
        ['Trim start', 'trimStart', region.trimStart, 0, region.trimEnd - 0.01],
        ['Trim end', 'trimEnd', region.trimEnd, region.trimStart + 0.01, region.duration],
      ] as const).map(([label, key, value, min, max]) => <label key={key} className="flex items-center gap-1">{label}<input aria-label={`Region ${label.toLowerCase()}`} className={`${input} w-20`} type="number" min={min} max={max} step="0.01" value={Number(value.toFixed(3))} onChange={event => { if (event.target.value !== '') onPatch({ [key]: Number(event.target.value) }); }} />s</label>)}
    </div>
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <button type="button" className={button} aria-label="Loop region" aria-pressed={region.loopDuration !== undefined} onClick={() => onPatch({ loopDuration: region.loopDuration === undefined ? Math.min(1800 - region.start, period * 2) : undefined, loopOffset: undefined })}>↻ Loop</button>
      {region.loopDuration !== undefined && <label className="flex items-center gap-1">Loop length<input aria-label="Region loop length" className={`${input} w-20`} type="number" min="0.01" max={1800 - region.start} step="0.01" value={Number(regionDuration(region).toFixed(3))} onChange={event => { if (event.target.value !== '') onPatch({ loopDuration: Number(event.target.value) }); }} />s</label>}
      <label className="flex items-center gap-1">Gain<input aria-label="Region gain" type="range" min="0" max="2" step="0.01" value={region.gain ?? 1} onChange={event => onPatch({ gain: Number(event.target.value) })} /><span className="w-10">{Math.round((region.gain ?? 1) * 100)}%</span></label>
      <label className="flex items-center gap-1" title="Speed changes pitch and region length">Speed<select aria-label="Region speed" className={input} value={region.speed ?? 1} onChange={event => onPatch({ speed: Number(event.target.value) })}>{[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4].map(speed => <option key={speed} value={speed}>{speed}×</option>)}</select></label>
      <button type="button" className={button} aria-label="Reverse region" aria-pressed={region.reverse ?? false} onClick={() => onPatch({ reverse: !region.reverse })}>Reverse</button>
      <button type="button" className={button} onClick={() => onPatch({ gain: undefined, speed: undefined, reverse: undefined, loopDuration: undefined, loopOffset: undefined })}>Reset settings</button>
    </div>
    <div className="flex flex-wrap gap-1">{actions.map(action => <button type="button" key={action.label} className={button} disabled={action.disabled} onClick={action.action}>{action.label}</button>)}</div>
  </fieldset>;
}
