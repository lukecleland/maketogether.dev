import { validBrowserScroll } from "./browserUrl";
import { validBoard } from "./whiteboardPanel";
import { normaliseDawTrack, normaliseDawTracks } from "./daw";
import type { RoomSnapshot } from "./roomPersistence";
import { ROOM_STATE_VERSION } from "./roomPersistence";

// Stable file-format identifier: keep existing exported bundles compatible.
const BUNDLE_FORMAT = "watchtogether-room";
const BUNDLE_VERSION = 1;

export interface RoomBundle {
  format: typeof BUNDLE_FORMAT;
  version: typeof BUNDLE_VERSION;
  exportedAt: string;
  mediaIncluded: false;
  snapshot: RoomSnapshot;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function hasPanelState(value: unknown): boolean {
  if (!isObject(value)) return false;
  return ["x", "y", "width", "height", "z"].every(key => isFiniteNumber(value[key])) && (value.width as number) > 0 && (value.height as number) > 0;
}

const PANEL_TYPES = new Set(["youtube", "audio", "browser", "note", "code", "recorder", "image", "daw", "whiteboard", "pdf"]);

function hasStringValues(value: Record<string, unknown>): boolean {
  return Object.values(value).every(item => typeof item === "string");
}

function isDrawing(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.kind === "text") {
    return typeof value.id === "string" && typeof value.text === "string" && typeof value.color === "string" && typeof value.font === "string" && [value.x, value.y, value.size].every(isFiniteNumber);
  }
  if (value.kind === "shape") {
    return typeof value.id === "string" && ["rectangle", "ellipse", "line", "arrow"].includes(value.shape as string) && typeof value.color === "string" && [value.x0, value.y0, value.x1, value.y1, value.width].every(isFiniteNumber);
  }
  return typeof value.color === "string" && [value.x0, value.y0, value.x1, value.y1, value.width].every(isFiniteNumber);
}

function isConnector(value: unknown): boolean {
  return isObject(value) && typeof value.id === "string" && typeof value.fromPanelId === "string" && typeof value.toPanelId === "string" && typeof value.color === "string" && isFiniteNumber(value.width) && value.width > 0;
}

function isPositionTag(value: unknown): boolean {
  return isObject(value) && typeof value.id === "string" && typeof value.label === "string" && isFiniteNumber(value.x) && isFiniteNumber(value.y) && (value.w === undefined || (isFiniteNumber(value.w) && value.w > 0)) && (value.h === undefined || (isFiniteNumber(value.h) && value.h > 0));
}

function isChord(value: unknown): boolean {
  return isObject(value) && typeof value.name === "string" && isFiniteNumber(value.baseFret) && Array.isArray(value.dots) && value.dots.every(isFiniteNumber);
}

function isRecording(value: unknown): boolean {
  return isObject(value) && typeof value.id === "string" && typeof value.name === "string";
}

function isPanel(value: unknown): boolean {
  if (!isObject(value) || typeof value.id !== "string" || typeof value.type !== "string" || !PANEL_TYPES.has(value.type) || !hasPanelState(value.state)) return false;
  if (value.audioTheme !== undefined && !["digital", "record", "tape"].includes(value.audioTheme as string)) return false;
  if (value.pdfPage !== undefined && (typeof value.pdfPage !== "number" || !Number.isSafeInteger(value.pdfPage) || value.pdfPage < 1)) return false;
  if (value.pdfFileName !== undefined && typeof value.pdfFileName !== "string") return false;
  if (value.browserScroll !== undefined && !validBrowserScroll(value.browserScroll)) return false;
  if (value.whiteboard !== undefined && !validBoard(value.whiteboard)) return false;
  if (value.dawTracks !== undefined && (!Array.isArray(value.dawTracks) || value.dawTracks.length > 1000 || !value.dawTracks.every(track => normaliseDawTrack(track) !== null))) return false;
  if (value.code !== undefined && (!isObject(value.code) || typeof value.code.text !== "string" || typeof value.code.language !== "string")) return false;
  if (value.note !== undefined && (!isObject(value.note) || !["text", "chord", "tab"].includes(value.note.kind as string) || typeof value.note.text !== "string" || !Array.isArray(value.note.tab) || !value.note.tab.every(item => typeof item === "string") || !Array.isArray(value.note.chords) || !value.note.chords.every(isChord) || typeof value.note.colour !== "string")) return false;
  if (value.recordings !== undefined && (!Array.isArray(value.recordings) || !value.recordings.every(isRecording))) return false;
  if (value.playback !== undefined && (!isObject(value.playback) || !isFiniteNumber(value.playback.time) || typeof value.playback.playing !== "boolean" || (value.playback.at !== undefined && !isFiniteNumber(value.playback.at)))) return false;
  return true;
}

function isSnapshot(value: unknown): value is RoomSnapshot {
  if (!isObject(value) || value.version !== ROOM_STATE_VERSION) return false;
  if (!Array.isArray(value.panels) || value.panels.length > 10_000) return false;
  if (!value.panels.every(isPanel)) return false;
  if (!Array.isArray(value.drawings) || value.drawings.length > 100_000 || !value.drawings.every(isDrawing)) return false;
  if (value.connectors !== undefined && (!Array.isArray(value.connectors) || value.connectors.length > 10_000 || !value.connectors.every(isConnector))) return false;
  if (!Array.isArray(value.positionTags) || value.positionTags.length > 10_000 || !value.positionTags.every(isPositionTag)) return false;
  if (!Array.isArray(value.dockedIds) || !value.dockedIds.every(id => typeof id === "string")) return false;
  if (!isObject(value.panelLabels) || !hasStringValues(value.panelLabels) || !isObject(value.customLabels) || !hasStringValues(value.customLabels) || !isObject(value.canvas)) return false;
  if (value.drawingViewport !== undefined && (!isObject(value.drawingViewport) || !isFiniteNumber(value.drawingViewport.width) || value.drawingViewport.width <= 0 || !isFiniteNumber(value.drawingViewport.height) || value.drawingViewport.height <= 0)) return false;
  const canvas = value.canvas;
  if (!["x", "y", "scale"].every(key => isFiniteNumber(canvas[key])) || (canvas.scale as number) <= 0) return false;
  if (!isObject(value.viewport) || !isFiniteNumber(value.viewport.width) || value.viewport.width <= 0 || !isFiniteNumber(value.viewport.height) || value.viewport.height <= 0) return false;
  if (!isObject(value.fixedPanels) || !hasPanelState(value.fixedPanels.local) || !hasPanelState(value.fixedPanels.remote)) return false;
  return true;
}

export function serialiseRoomBundle(snapshot: RoomSnapshot): string {
  const bundle: RoomBundle = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    mediaIncluded: false,
    snapshot
  };
  return JSON.stringify(bundle, null, 2);
}

export function parseRoomBundle(source: string): RoomSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("That file is not valid JSON.");
  }
  if (!isObject(parsed) || parsed.format !== BUNDLE_FORMAT || parsed.version !== BUNDLE_VERSION) {
    throw new Error("That is not a supported Make Together room bundle.");
  }
  if (!isSnapshot(parsed.snapshot)) {
    throw new Error(`This bundle is damaged or uses an unsupported room-state version (expected ${ROOM_STATE_VERSION}).`);
  }
  return {
    ...parsed.snapshot,
    panels: parsed.snapshot.panels.map(panel => panel.dawTracks
      ? { ...panel, dawTracks: normaliseDawTracks(panel.dawTracks) }
      : panel)
  };
}
