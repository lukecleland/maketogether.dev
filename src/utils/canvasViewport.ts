import type { PanelState } from '../types/panels';

/** Frame a panel locally without resizing the shared workspace. */
export function framePanel(panel: PanelState, viewport: { width: number; height: number }, top: number, bottom: number) {
  const width = Math.max(1, viewport.width - 24);
  const height = Math.max(1, viewport.height - top - bottom);
  const scale = Math.max(0.25, Math.min(1, width / panel.width, height / panel.height));
  return {
    x: viewport.width / 2 - (panel.x + panel.width / 2) * scale,
    y: top + height / 2 - (panel.y + panel.height / 2) * scale,
    scale,
  };
}

/** Keep the world point under the previous finger midpoint under the new one. */
export function transformGesture(view: { x: number; y: number; scale: number }, previous: { x: number; y: number }, current: { x: number; y: number }, factor: number) {
  const scale = Math.min(4, Math.max(0.25, view.scale * factor));
  return {
    x: current.x - (previous.x - view.x) / view.scale * scale,
    y: current.y - (previous.y - view.y) / view.scale * scale,
    scale,
  };
}
