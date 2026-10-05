import type { CanvasItem } from '../components/Whiteboard';
import type { RoomSnapshot } from './roomPersistence';

// Fractions retain the wire format, but use a shared basis, never the screen.
export const DRAWING_VIEWPORT = { width: 1920, height: 1080 } as const;
export type DrawingViewport = { width: number; height: number };

export function convertDrawing<T extends CanvasItem>(item: T, source: DrawingViewport): T {
  const x = source.width / DRAWING_VIEWPORT.width;
  const y = source.height / DRAWING_VIEWPORT.height;
  const size = Math.min(source.width, source.height) / Math.min(DRAWING_VIEWPORT.width, DRAWING_VIEWPORT.height);
  if ('kind' in item && item.kind === 'text') return { ...item, x: item.x * x, y: item.y * y, size: item.size * size };
  const line = item as Exclude<CanvasItem, { kind: 'text' }>;
  return { ...item, x0: line.x0 * x, x1: line.x1 * x, y0: line.y0 * y, y1: line.y1 * y, width: line.width * size };
}

/** Old rooms used their creator's viewport as the drawing basis. Migrate once. */
export function migrateDrawingCoordinates(snapshot: RoomSnapshot): RoomSnapshot {
  const source = snapshot.drawingViewport ?? snapshot.viewport;
  if (source.width === DRAWING_VIEWPORT.width && source.height === DRAWING_VIEWPORT.height) return snapshot;
  return { ...snapshot, drawingViewport: DRAWING_VIEWPORT, drawings: snapshot.drawings.map(item => convertDrawing(item, source)) };
}
