import type { DawRegion, DawTrack } from './daw';

interface Edit { trackId: string; before: DawRegion[]; after: DawRegion[] }
interface Transaction { edits: Edit[]; gesture?: string }
/** Undo local region edits only while their revisions are still current. */
export class DawRegionHistory {
  private past: Transaction[] = [];
  private future: Transaction[] = [];
  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
  record(trackId: string, current: DawRegion[], after: DawRegion[], gesture?: string) {
    let transaction = this.past.at(-1);
    if (!gesture || transaction?.gesture !== gesture) {
      transaction = { edits: [], gesture }; this.past.push(transaction);
      if (this.past.length > 100) this.past.shift();
    }
    let edit = transaction!.edits.find(edit => edit.trackId === trackId);
    if (!edit) { edit = { trackId, before: [], after: [] }; transaction!.edits.push(edit); }
    for (const region of after) {
      if (!edit.before.some(r => r.id === region.id)) edit.before.push(current.find(r => r.id === region.id) ?? { ...region, deleted: true });
      edit.after = [...edit.after.filter(r => r.id !== region.id), region];
    }
    this.future = [];
  }
  replay(direction: 'undo' | 'redo', tracks: DawTrack[], apply: (track: DawTrack, regions: DawRegion[]) => DawRegion[]) {
    const from = direction === 'undo' ? this.past : this.future;
    const to = direction === 'undo' ? this.future : this.past;
    const transaction = from.at(-1);
    if (!transaction) return false;
    for (const edit of transaction.edits) {
      const track = tracks.find(t => t.id === edit.trackId && !t.deleted);
      const expected = direction === 'undo' ? edit.after : edit.before;
      if (!track || expected.some(region => {
        const current = track.regions.find(r => r.id === region.id);
        return !current || current.editId !== region.editId || current.revision !== region.revision;
      })) return false;
    }
    for (const edit of transaction.edits) {
      const track = tracks.find(t => t.id === edit.trackId)!;
      const desired = direction === 'undo' ? edit.before : edit.after;
      const restored = apply(track, desired);
      // Fresh replay revisions must remain recognizable by the next local edit.
      for (const earlier of from.slice(0, -1)) for (const candidate of earlier.edits) {
        if (candidate.trackId !== edit.trackId) continue;
        const key = direction === 'undo' ? 'after' : 'before';
        candidate[key] = candidate[key].map(region => {
          const index = desired.findIndex(r => r.id === region.id && r.editId === region.editId && r.revision === region.revision);
          return index < 0 ? region : restored[index];
        });
      }
      if (direction === 'undo') edit.before = restored;
      else edit.after = restored;
    }
    from.pop(); to.push(transaction);
    return true;
  }
}
