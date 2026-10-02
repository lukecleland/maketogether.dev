/** Transient session activity; never persisted with the arrangement. */
export interface DawActivity {
  revision: number;
  id: string;
  owner: string;
  mode: "playing" | "stopped" | "recording" | "count-in";
  position: number;
  at: number;
  trackId?: string;
  countInEndsAt?: number;
  peaks?: { at: number; peak: number }[];
  notes?: {
    pitch: number;
    start: number;
    duration: number;
    velocity: number;
  }[];
}

export function validDawActivity(value: unknown): value is DawActivity {
  if (!value || typeof value !== "object") return false;
  const v = value as DawActivity;
  return (
    Number.isSafeInteger(v.revision) &&
    v.revision > 0 &&
    typeof v.id === "string" &&
    v.id.length <= 100 &&
    typeof v.owner === "string" &&
    v.owner.length <= 100 &&
    ["playing", "stopped", "recording", "count-in"].includes(v.mode) &&
    (v.mode !== "count-in" || (Number.isFinite(v.countInEndsAt) && v.countInEndsAt! > v.at && v.countInEndsAt! - v.at <= 8000)) &&
    Number.isFinite(v.position) &&
    v.position >= 0 &&
    v.position <= 1800 &&
    Number.isFinite(v.at) &&
    v.at > 0 &&
    (v.mode !== "recording" ||
      (typeof v.trackId === "string" && v.trackId.length <= 100)) &&
    (v.peaks === undefined ||
      (Array.isArray(v.peaks) &&
        v.peaks.length <= 600 &&
        v.peaks.every(
          (p) =>
            p &&
            Number.isFinite(p.at) &&
            p.at >= 0 &&
            p.at <= 1800 &&
            Number.isFinite(p.peak) &&
            p.peak >= 0 &&
            p.peak <= 1,
        ))) &&
    (v.notes === undefined ||
      (Array.isArray(v.notes) &&
        v.notes.length <= 1000 &&
        v.notes.every(
          (n) =>
            n &&
            Number.isInteger(n.pitch) &&
            n.pitch >= 0 &&
            n.pitch <= 127 &&
            Number.isFinite(n.start) &&
            n.start >= 0 &&
            n.start <= 1800 &&
            Number.isFinite(n.duration) &&
            n.duration > 0 &&
            n.duration <= 1800 &&
            Number.isFinite(n.velocity) &&
            n.velocity > 0 &&
            n.velocity <= 1,
        )))
  );
}
export function compareDawActivity(a: DawActivity, b: DawActivity) {
  return a.revision - b.revision || a.id.localeCompare(b.id);
}
export function dawActivityPosition(activity: DawActivity, now = Date.now()) {
  return Math.min(
    1800,
    activity.position +
      ((activity.mode === "stopped" || activity.mode === "count-in")
        ? 0
        : Math.max(0, (now - activity.at) / 1000)),
  );
}
