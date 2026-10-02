import { PanelOverviewContext } from './PanelOverviewContext';
import { useMovementSync } from "../hooks/useMovementSync";
import { useContext, useEffect, useRef, type CSSProperties } from "react";
import Draggable, {
  type DraggableEvent,
  type DraggableData,
} from "react-draggable";
import type { PanelState } from "../types/panels";

/**
 * DraggablePanel — a controlled drag + resize container for a single panel.
 *
 * ## Drag
 * Uses react-draggable in controlled mode (`position` prop) so remote state
 * updates (from `onSyncUpdate`) are reflected immediately without fighting
 * react-draggable's internal position tracking.
 *
 * ## Resize
 * A custom bottom-right corner handle listens to raw `mousemove`/`mouseup`
 * events on `window` so the drag doesn't break when the cursor moves outside
 * the panel boundary quickly.
 *
 * ## Sync throttle
 * Both drag and resize schedule `onSyncUpdate` at most once per 16 ms (~60 fps)
 * to avoid flooding the data channel. The final position is always flushed
 * immediately on drag/resize stop.
 *
 * ## z-order
 * `onBringToFront` is called on `pointerdown`; Session.tsx increments a shared
 * `topZRef` counter and updates the panel's `z` value, which is applied as
 * `zIndex` on the wrapper div and synced to the remote peer.
 */

interface DraggablePanelProps {
  state: PanelState;
  /** Called immediately on every drag/resize tick — update local state here. */
  onLocalUpdate: (next: PanelState) => void;
  /** Throttled — broadcast to the remote peer here. */
  onSyncUpdate: (next: PanelState) => void;
  /** Called on pointer-down to raise this panel above others. */
  onBringToFront: () => void;
  /** Double-clicking a non-interactive panel surface toggles its dock tag. */
  onToggleDock?: () => void;
  minWidth?: number;
  minHeight?: number;
  /** Canvas zoom scale — passed to react-draggable so drag deltas are correct. */
  scale?: number;
  children: React.ReactNode;
  className?: string;
  excludeFromRecording?: boolean;
  panelId?: string;
  minimized?: boolean;
  onMinimize?: () => void;
  minimizeControlHandled?: boolean;
}

interface ResizeEdges {
  top?: boolean;
  right?: boolean;
  bottom?: boolean;
  left?: boolean;
}

const resizeHandles: Array<{
  key: string;
  edges: ResizeEdges;
  className: string;
  cursor: string;
}> = [
  {
    key: "top",
    edges: { top: true },
    className: "top-0 left-3 right-3 h-2",
    cursor: "ns-resize",
  },
  {
    key: "right",
    edges: { right: true },
    className: "right-0 top-3 bottom-3 w-2",
    cursor: "ew-resize",
  },
  {
    key: "bottom",
    edges: { bottom: true },
    className: "bottom-0 left-3 right-3 h-2",
    cursor: "ns-resize",
  },
  {
    key: "left",
    edges: { left: true },
    className: "left-0 top-3 bottom-3 w-2",
    cursor: "ew-resize",
  },
  {
    key: "top-left",
    edges: { top: true, left: true },
    className: "top-0 left-0 w-3 h-3",
    cursor: "nwse-resize",
  },
  {
    key: "top-right",
    edges: { top: true, right: true },
    className: "top-0 right-0 w-3 h-3",
    cursor: "nesw-resize",
  },
  {
    key: "bottom-right",
    edges: { bottom: true, right: true },
    className: "bottom-0 right-0 w-3 h-3",
    cursor: "nwse-resize",
  },
  {
    key: "bottom-left",
    edges: { bottom: true, left: true },
    className: "bottom-0 left-0 w-3 h-3",
    cursor: "nesw-resize",
  },
];

export function DraggablePanel({
  state,
  onLocalUpdate,
  onSyncUpdate,
  onBringToFront,
  onToggleDock,
  minWidth = 240,
  minHeight = 140,
  scale = 1,
  children,
  className = "",
  excludeFromRecording = false,
  panelId,
  minimized = false,
  onMinimize,
  minimizeControlHandled = false,
}: DraggablePanelProps) {
  const overview = useContext(PanelOverviewContext);
  const frame = panelId ? overview?.frames[panelId] : undefined;
  const nodeRef = useRef<HTMLDivElement>(null);
  // Always-current copy of state so resize closure doesn't go stale
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const movementSync = useMovementSync(onSyncUpdate);
  const scheduleSyncUpdate = movementSync.schedule;

  // ── Drag ──────────────────────────────────────────────────────────────
  const handleDrag = (_: DraggableEvent, data: DraggableData) => {
    const next = { ...stateRef.current, x: data.x, y: data.y };
    onLocalUpdate(next);
    scheduleSyncUpdate(next);
  };

  const handleDragStop = (_: DraggableEvent, data: DraggableData) => {
    const next = { ...stateRef.current, x: data.x, y: data.y };
    onLocalUpdate(next);
    // Always flush on stop so final position is always sent
    movementSync.flush(next);
  };

  // ── Resize (all four edges and corners) ───────────────────────────────
  const startResize = (
    startX: number,
    startY: number,
    edges: ResizeEdges,
  ) => {
    const initial = stateRef.current;
    const origin = {
      mx: startX,
      my: startY,
      state: initial,
    };

    const applyResize = (clientX: number, clientY: number): PanelState => {
      const dx = (clientX - origin.mx) / scale;
      const dy = (clientY - origin.my) / scale;
      const next = { ...origin.state };

      if (edges.left) {
        next.width = Math.max(minWidth, origin.state.width - dx);
        next.x = origin.state.x + origin.state.width - next.width;
      } else if (edges.right) {
        next.width = Math.max(minWidth, origin.state.width + dx);
      }

      if (edges.top) {
        next.height = Math.max(minHeight, origin.state.height - dy);
        next.y = origin.state.y + origin.state.height - next.height;
      } else if (edges.bottom) {
        next.height = Math.max(minHeight, origin.state.height + dy);
      }

      return next;
    };

    const onMouseMove = (ev: MouseEvent) => {
      const next = applyResize(ev.clientX, ev.clientY);
      onLocalUpdate(next);
      scheduleSyncUpdate(next);
    };

    const onMouseUp = (ev: MouseEvent) => {
      const next = applyResize(ev.clientX, ev.clientY);
      onLocalUpdate(next);
      movementSync.flush(next);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    const onTouchMove = (ev: TouchEvent) => {
      const t = ev.touches[0];
      const next = applyResize(t.clientX, t.clientY);
      onLocalUpdate(next);
      scheduleSyncUpdate(next);
    };

    const onTouchEnd = (ev: TouchEvent) => {
      const t = ev.changedTouches[0];
      const next = applyResize(t.clientX, t.clientY);
      onLocalUpdate(next);
      movementSync.flush(next);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("touchend", onTouchEnd);
  };

  const startResizeMouseDown = (
    e: React.MouseEvent,
    edges: ResizeEdges,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    startResize(e.clientX, e.clientY, edges);
  };

  const startResizeTouchStart = (
    e: React.TouchEvent,
    edges: ResizeEdges,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const touch = e.touches[0];
    startResize(touch.clientX, touch.clientY, edges);
  };

  return (
    <Draggable
      nodeRef={nodeRef as React.RefObject<HTMLElement>}
      position={{ x: frame?.x ?? state.x, y: frame?.y ?? state.y }}
      disabled={!!frame}
      onDrag={handleDrag}
      onStop={handleDragStop}
      // The panel itself is the drag handle. Native controls and explicitly
      // interactive regions opt out so they retain their normal behaviour.
      cancel="input, button, a, textarea, select, iframe, .no-drag, [contenteditable='true']"
      scale={scale}
      enableUserSelectHack={false}
    >
      <div
        {...(excludeFromRecording ? { "data-recording-exclude": true } : {})}
        ref={nodeRef}
        style={{
          width: frame?.width ?? state.width,
          height: frame?.height ?? state.height,
          zIndex: frame ? 1 : state.z,
          // The full-screen transformed parent is click-through so it cannot
          // block whiteboard strokes; only visible panels opt back in.
          pointerEvents: "auto",
        }}
        className={`draggable-panel absolute ${className}`}
        onPointerDown={frame ? undefined : onBringToFront}
        onDoubleClick={(event) => {
          if (frame) return;
          const target = event.target as HTMLElement;
          if (
            target.closest(
              "input, button, a, textarea, select, iframe, .no-drag, [contenteditable='true']",
            )
          )
            return;
          onToggleDock?.();
        }}
      >
        <div
          data-panel-shell={panelId}
          className="relative h-full w-full"
          inert={!!frame}
          style={{ opacity: minimized && !frame ? 0 : 1, pointerEvents: frame || minimized ? "none" : "auto", ...(frame ? { width: state.width, height: state.height, transform: `scale(${frame.scale})`, transformOrigin: 'top left' } : {}) }}
        >
        {children}

        {onMinimize && !minimized && !minimizeControlHandled && (
          <button
            type="button"
            onClick={onMinimize}
            className="no-drag absolute right-7 top-1 z-30 flex h-6 w-4 items-center justify-center text-base leading-none text-zinc-400 transition-colors hover:text-white"
            title="Minimise to dock"
            aria-label="Minimise to dock"
          >
            _
          </button>
        )}

        {resizeHandles.map((handle) => (
          <div
            key={handle.key}
            data-panel-resize={handle.key}
            onMouseDown={(event) =>
              startResizeMouseDown(event, handle.edges)
            }
            onTouchStart={(event) =>
              startResizeTouchStart(event, handle.edges)
            }
            className={`no-drag absolute z-20 ${handle.className}`}
            style={{
              cursor: handle.cursor,
              touchAction: "none",
              "--panel-resize-scale": scale,
            } as CSSProperties}
          />
        ))}
        </div>
        {frame && <button data-overview-select={panelId} onClick={() => panelId && overview?.onSelect(panelId)} aria-label={`Open ${frame.label}`} className="overview-select absolute inset-0 rounded-xl border-2 border-white/15 shadow-2xl outline-none hover:border-brand-300 focus-visible:border-brand-300">
          <span className="absolute -bottom-7 left-0 w-full truncate text-center text-xs font-medium text-white">{frame.label}{minimized ? ' · minimized' : ''}</span>
        </button>}
      </div>
    </Draggable>
  );
}
