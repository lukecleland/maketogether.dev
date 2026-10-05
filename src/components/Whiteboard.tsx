import { DRAWING_VIEWPORT } from '../utils/drawingCoordinates';
import {
  useEffect,
  useRef,
  useState,
  useCallback,
  forwardRef,
  useImperativeHandle,
} from "react";
import { FONT_STACKS, metalFor, type Nib, type TextFont } from "../utils/brush";

/**
 * Whiteboard — a full-screen collaborative drawing canvas.
 *
 * ## Canvas sizing
 * The canvas buffer is sized to `innerWidth × devicePixelRatio` by
 * `innerHeight × devicePixelRatio` (physical pixels) with CSS dimensions set
 * to `innerWidth × innerHeight` (logical pixels). This keeps strokes crisp on
 * Retina/HiDPI screens. On window resize the canvas is re-sized and the
 * existing art is replayed from shared world coordinates.
 *
 * ## Shared world coordinates
 * Drawing fractions use the fixed DRAWING_VIEWPORT basis on every device.
 * Only the backing buffer uses the local screen size and DPR. Rotating a phone
 * therefore cannot move, stretch or resize shared art relative to panels.
 *
 * ## Imperative handle
 * `drawStroke` and `clearCanvas` are exposed via `forwardRef` / `useImperativeHandle`
 * so Session.tsx can apply remote strokes and clears without the component
 * needing to subscribe to any state.
 */

export interface WhiteboardStroke {
  x0: number; // fraction of the shared drawing width
  y0: number; // fraction of the shared drawing height
  x1: number;
  y1: number;
  color: string;
  width: number; // fraction of the shared drawing basis minimum
  /** Absent on strokes from a peer running an older build — treat as ballpoint. */
  nib?: Nib;
}

export type { Nib };

/**
 * A piece of text placed on the canvas. Stored in the same ordered list as
 * strokes so that an eraser drawn *after* it still wipes it on replay —
 * keeping text in a separate list would make it immune to the eraser.
 */
export interface WhiteboardText {
  kind: "text";
  /** Stable identity, so an edit can name which piece of text it means. */
  id: string;
  x: number; // normalised 0–1, left edge
  y: number; // normalised 0–1, baseline
  text: string;
  color: string;
  /** Normalised against the shared drawing basis, like stroke width. */
  size: number;
  font: TextFont;
}

export type ShapeKind = "rectangle" | "ellipse" | "line" | "arrow";

export interface WhiteboardShape {
  kind: "shape";
  id: string;
  shape: ShapeKind;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  color: string;
  width: number;
}

/** Everything the board can hold, in the order it was laid down. */
export type CanvasItem = WhiteboardStroke | WhiteboardText | WhiteboardShape;

function isText(i: CanvasItem): i is WhiteboardText {
  return (i as WhiteboardText).kind === "text";
}

function isShape(i: CanvasItem): i is WhiteboardShape {
  return (i as WhiteboardShape).kind === "shape";
}

export interface WhiteboardHandle {
  drawStroke(stroke: WhiteboardStroke): void;
  drawText(item: WhiteboardText): void;
  drawShape(item: WhiteboardShape): void;
  editText(id: string, text: string): void;
  moveText(id: string, x: number, y: number): void;
  clearCanvas(): void;
  getItems(): CanvasItem[];
  replaceItems(items: CanvasItem[]): void;
}

interface WhiteboardProps {
  tool: "pointer" | "pen" | "eraser" | "text" | "region" | "shape" | "connector";
  /** True while the session is actively panning the canvas. */
  isPanning?: boolean;
  color: string;
  width: number; // raw toolbar pixel size (3 / 8 / 16)
  nib: Nib;
  font: TextFont;
  textSize: number; // raw pixel size
  onStroke: (stroke: WhiteboardStroke) => void;
  onText: (item: WhiteboardText) => void;
  onTextEdit: (id: string, text: string) => void;
  onTextMove: (id: string, x: number, y: number) => void;
  onShape: (item: WhiteboardShape) => void;
  shapeKind: ShapeKind;
  /** A dragged-out area, in world-normalised coordinates. */
  onRegion: (r: { x: number; y: number; w: number; h: number }) => void;
  canvasTransform: { x: number; y: number; scale: number };
}

/**
 * Deterministic per-segment randomness.
 *
 * Pencil and charcoal are textured, and the canvas is wiped and every stroke
 * replayed on each pan, zoom and resize. Fresh randomness on each replay would
 * make the grain reshuffle constantly — the whole board would crawl. Seeding
 * from the segment's own coordinates makes a segment's texture a property of
 * the segment, so it redraws identically forever, and identically on both
 * peers' screens.
 */
function seedFor(s: WhiteboardStroke): number {
  const a = Math.round(s.x0 * 1e5);
  const b = Math.round(s.y0 * 1e5);
  const c = Math.round(s.x1 * 1e5);
  const d = Math.round(s.y1 * 1e5);
  const h = (a * 73856093) ^ (b * 19349663) ^ (c * 83492791) ^ (d * 26183659);
  return (h >>> 0) || 1;
}

function rngFrom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const Whiteboard = forwardRef<WhiteboardHandle, WhiteboardProps>(
  (
    {
      tool,
      isPanning = false,
      color,
      width,
      nib,
      font,
      textSize,
      onStroke,
      onText,
      onTextEdit,
      onTextMove,
      onShape,
      shapeKind,
      onRegion,
      canvasTransform
    },
    ref
  ) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const isDrawingRef = useRef(false);
    const lastPointRef = useRef<{ x: number; y: number } | null>(null);
    // Everything drawn, in world-normalised space and in the order it was laid
    // down, so it can be replayed on zoom/pan — and so erasers still cover
    // whatever came before them.
    const strokesRef = useRef<CanvasItem[]>([]);
    // Where a text caret is currently open, in screen coordinates
    // An open caret. `id` is set when editing existing text rather than placing new.
    type Caret = { sx: number; sy: number; value: string; id?: string };
    const [editing, setEditing] = useState<Caret | null>(null);
    const editingRef = useRef<Caret | null>(null);
    const editRef = useRef<HTMLInputElement>(null);
    const [hoveredText, setHoveredText] = useState<WhiteboardText | null>(null);
    const movingTextRef = useRef<{ id: string; dx: number; dy: number } | null>(null);
    // Marquee for the region tool, in screen coordinates while dragging
    const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
    const marqueeRef = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
    const [shapeDraft, setShapeDraft] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
    const shapeDraftRef = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
    // Rolling state for the fountain nib's speed-driven taper
    const fountainRef = useRef({ w: 1, at: 0 });
    // Always-current transform without stale closure issues
    const canvasTransformRef = useRef(canvasTransform);
    useEffect(() => {
      canvasTransformRef.current = canvasTransform;
    }, [canvasTransform]);

    // Draw a segment from world-normalised coordinates.
    // Applies the current canvas transform (pan + zoom) so strokes live in
    // world-space and scale / pan correctly when the view changes.
    const drawSegment = useCallback((stroke: WhiteboardStroke) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!ctx || !canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const vw = DRAWING_VIEWPORT.width;
      const vh = DRAWING_VIEWPORT.height;
      const { x: tx, y: ty, scale } = canvasTransformRef.current;

      // World-normalised → world pixels → screen pixels → physical pixels
      const px0 = (stroke.x0 * vw * scale + tx) * dpr;
      const py0 = (stroke.y0 * vh * scale + ty) * dpr;
      const px1 = (stroke.x1 * vw * scale + tx) * dpr;
      const py1 = (stroke.y1 * vh * scale + ty) * dpr;

      const isEraser = stroke.color === "__eraser__";
      // Width is normalised to the shared basis — also scale it with the zoom level
      const lw = stroke.width * Math.min(vw, vh) * scale * dpr;
      const strokeNib: Nib = stroke.nib ?? "ballpoint";

      const line = (a: number, b: number, c: number, d: number) => {
        ctx.beginPath();
        ctx.moveTo(a, b);
        ctx.lineTo(c, d);
        ctx.stroke();
      };

      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.globalCompositeOperation = isEraser ? "destination-out" : "source-over";

      if (isEraser) {
        ctx.strokeStyle = "rgba(0,0,0,1)";
        ctx.lineWidth = lw;
        line(px0, py0, px1, py1);
        ctx.restore();
        return;
      }

      // Metallic: paint the segment with a gradient across its own width
      const metal = metalFor(stroke.color);
      if (metal) {
        const dx = px1 - px0;
        const dy = py1 - py0;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len;
        const ny = dx / len;
        const mx = (px0 + px1) / 2;
        const my = (py0 + py1) / 2;
        const g = ctx.createLinearGradient(
          mx - (nx * lw) / 2,
          my - (ny * lw) / 2,
          mx + (nx * lw) / 2,
          my + (ny * lw) / 2
        );
        // A wide bright core so even a thin stroke still reads as metal rather
        // than antialiasing down to a muddy average of the two dark edges
        g.addColorStop(0, metal[0]);
        g.addColorStop(0.32, metal[1]);
        g.addColorStop(0.68, metal[1]);
        g.addColorStop(1, metal[2]);
        ctx.strokeStyle = g;
        ctx.lineWidth = lw;
        line(px0, py0, px1, py1);
        ctx.restore();
        return;
      }

      ctx.strokeStyle = stroke.color;

      if (strokeNib === "pencil") {
        // A few thin, jittered passes read as graphite catching on paper
        const r = rngFrom(seedFor(stroke));
        const spread = lw * 0.55;
        ctx.globalAlpha = 0.3;
        ctx.lineWidth = Math.max(0.6, lw * 0.42);
        for (let i = 0; i < 3; i++) {
          const j = () => (r() - 0.5) * spread;
          line(px0 + j(), py0 + j(), px1 + j(), py1 + j());
        }
      } else if (strokeNib === "charcoal") {
        // Scattered specks around the path, heavier and looser than pencil
        const r = rngFrom(seedFor(stroke));
        ctx.fillStyle = stroke.color;
        ctx.globalAlpha = 0.16;
        const specks = 8;
        for (let i = 0; i < specks; i++) {
          const t = r();
          const cx = px0 + (px1 - px0) * t;
          const cy = py0 + (py1 - py0) * t;
          const a = r() * Math.PI * 2;
          const d = r() * lw * 0.85;
          ctx.beginPath();
          ctx.arc(
            cx + Math.cos(a) * d,
            cy + Math.sin(a) * d,
            Math.max(0.5, r() * lw * 0.22),
            0,
            Math.PI * 2
          );
          ctx.fill();
        }
      } else if (strokeNib === "highlighter") {
        // Wide, flat-ended and translucent, so overlaps build up like ink
        ctx.globalAlpha = 0.22;
        ctx.lineCap = "butt";
        ctx.lineWidth = lw * 3.2;
        line(px0, py0, px1, py1);
      } else if (strokeNib === "neon") {
        ctx.shadowBlur = Math.max(6, lw * 2.4);
        ctx.shadowColor = stroke.color;
        ctx.lineWidth = lw;
        line(px0, py0, px1, py1);
        // A pale core sells the tube-of-light look
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 0.85;
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = Math.max(0.7, lw * 0.34);
        line(px0, py0, px1, py1);
      } else {
        // ballpoint, and fountain — whose taper is baked into `width` at emit
        ctx.lineWidth = lw;
        line(px0, py0, px1, py1);
      }

      ctx.restore();
    }, []); // stable — reads transform from ref

    // Text is drawn in the same world space as strokes, so it pans and zooms
    // with everything else rather than floating at a fixed screen size.
    const drawTextItem = useCallback((item: WhiteboardText) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!ctx || !canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const vw = DRAWING_VIEWPORT.width;
      const vh = DRAWING_VIEWPORT.height;
      const { x: tx, y: ty, scale } = canvasTransformRef.current;

      const px = (item.x * vw * scale + tx) * dpr;
      const py = (item.y * vh * scale + ty) * dpr;
      const size = item.size * Math.min(vw, vh) * scale * dpr;

      ctx.save();
      ctx.globalCompositeOperation = "source-over";
      ctx.font = `${size}px ${FONT_STACKS[item.font] ?? FONT_STACKS.sans}`;
      ctx.textBaseline = "alphabetic";
      const metal = metalFor(item.color);
      if (metal) {
        const g = ctx.createLinearGradient(px, py - size, px, py);
        g.addColorStop(0, metal[0]);
        g.addColorStop(0.45, metal[1]);
        g.addColorStop(0.55, metal[1]);
        g.addColorStop(1, metal[2]);
        ctx.fillStyle = g;
      } else {
        ctx.fillStyle = item.color;
      }
      ctx.fillText(item.text, px, py);
      ctx.restore();
    }, []);

    const drawShapeItem = useCallback((item: WhiteboardShape) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!ctx || !canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const vw = DRAWING_VIEWPORT.width;
      const vh = DRAWING_VIEWPORT.height;
      const { x: tx, y: ty, scale } = canvasTransformRef.current;
      const x0 = (item.x0 * vw * scale + tx) * dpr;
      const y0 = (item.y0 * vh * scale + ty) * dpr;
      const x1 = (item.x1 * vw * scale + tx) * dpr;
      const y1 = (item.y1 * vh * scale + ty) * dpr;
      const lineWidth = item.width * Math.min(vw, vh) * scale * dpr;
      const metal = metalFor(item.color);

      ctx.save();
      ctx.strokeStyle = metal?.[1] ?? item.color;
      ctx.fillStyle = metal?.[1] ?? item.color;
      ctx.lineWidth = lineWidth;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      if (item.shape === "rectangle") {
        ctx.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      } else if (item.shape === "ellipse") {
        ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
      } else {
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
      }
      ctx.stroke();

      if (item.shape === "arrow") {
        const angle = Math.atan2(y1 - y0, x1 - x0);
        const head = Math.max(9 * scale * dpr, lineWidth * 4);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 - Math.cos(angle - Math.PI / 6) * head, y1 - Math.sin(angle - Math.PI / 6) * head);
        ctx.lineTo(x1 - Math.cos(angle + Math.PI / 6) * head, y1 - Math.sin(angle + Math.PI / 6) * head);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }, []);

    const drawItem = useCallback(
      (item: CanvasItem) => (isText(item) ? drawTextItem(item) : isShape(item) ? drawShapeItem(item) : drawSegment(item)),
      [drawSegment, drawShapeItem, drawTextItem]
    );

    // Clear and repaint all stored strokes (called on zoom/pan/resize)
    const redrawAll = useCallback(() => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!ctx || !canvas) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const item of strokesRef.current) {
        // The piece being edited is hidden until its replacement is committed
        if (isText(item) && item.id === editingRef.current?.id) continue;
        drawItem(item);
      }
    }, [drawItem]);

    // Size the canvas to physical pixels so it stays sharp on high-DPR screens.
    const applySize = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const w = window.innerWidth;
      const h = window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      // Redraw strokes after resize (canvas buffer was wiped)
      redrawAll();
    }, [redrawAll]);

    useEffect(() => {
      applySize();
      window.addEventListener("resize", applySize);
      return () => window.removeEventListener("resize", applySize);
    }, [applySize]);

    // Redraw all strokes whenever the canvas transform (zoom/pan) changes
    useEffect(() => {
      redrawAll();
    }, [canvasTransform, redrawAll]);

    useImperativeHandle(
      ref,
      () => ({
        drawStroke(stroke: WhiteboardStroke) {
          strokesRef.current.push(stroke);
          drawSegment(stroke);
        },
        drawText(item: WhiteboardText) {
          strokesRef.current.push(item);
          drawTextItem(item);
        },
        drawShape(item: WhiteboardShape) {
          strokesRef.current.push(item);
          drawShapeItem(item);
        },
        editText(id: string, text: string) {
          const idx = strokesRef.current.findIndex(i => isText(i) && i.id === id);
          if (idx === -1) return;
          if (!text) strokesRef.current.splice(idx, 1);
          else strokesRef.current[idx] = { ...(strokesRef.current[idx] as WhiteboardText), text };
          redrawAll();
        },
        moveText(id: string, x: number, y: number) {
          const item = strokesRef.current.find(candidate => isText(candidate) && candidate.id === id) as WhiteboardText | undefined;
          if (!item) return;
          item.x = x;
          item.y = y;
          redrawAll();
        },
        clearCanvas() {
          strokesRef.current = [];
          const canvas = canvasRef.current;
          if (!canvas) return;
          const ctx = canvas.getContext("2d");
          if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
        },
        getItems() {
          return strokesRef.current.map(item => ({ ...item }));
        },
        replaceItems(items) {
          strokesRef.current = items.map(item => ({ ...item }));
          redrawAll();
        },
      }),
      [drawSegment, drawShapeItem, drawTextItem, redrawAll],
    );

    // Convert screen position to world-normalised coords (factors out zoom+pan)
    const getPosFromClient = (clientX: number, clientY: number) => {
      const { x: tx, y: ty, scale } = canvasTransformRef.current;
      return {
        x: (clientX - tx) / scale / DRAWING_VIEWPORT.width,
        y: (clientY - ty) / scale / DRAWING_VIEWPORT.height,
      };
    };

    // ── Pointer handlers (mouse / stylus) ────────────────────────────────
    //
    // Capture the pointer for the lifetime of a stroke. Without capture the
    // canvas stops receiving movement as soon as the cursor crosses a video
    // or another floating panel, which leaves a gap in the stroke.

    /**
     * Topmost piece of text under a screen point, or null.
     *
     * Measured in world pixels rather than screen pixels so the answer doesn't
     * depend on the current zoom. Searched newest-first, so the one you can
     * actually see on top is the one you get.
     */
    const textAt = (clientX: number, clientY: number): WhiteboardText | null => {
      const ctx = canvasRef.current?.getContext("2d");
      if (!ctx) return null;
      const vw = DRAWING_VIEWPORT.width;
      const vh = DRAWING_VIEWPORT.height;
      const pos = getPosFromClient(clientX, clientY);
      const px = pos.x * vw;
      const py = pos.y * vh;

      for (let i = strokesRef.current.length - 1; i >= 0; i--) {
        const item = strokesRef.current[i];
        if (!isText(item)) continue;
        const sizePx = item.size * Math.min(vw, vh);
        ctx.font = `${sizePx}px ${FONT_STACKS[item.font] ?? FONT_STACKS.sans}`;
        const w = ctx.measureText(item.text).width;
        const x0 = item.x * vw;
        const y0 = item.y * vh;
        // Baseline sits at y0; allow a little below it for descenders
        if (px >= x0 && px <= x0 + w && py >= y0 - sizePx && py <= y0 + sizePx * 0.3) {
          return item;
        }
      }
      return null;
    };

    // Commit whatever is in the caret, if anything, and close it
    const commitText = () => {
      const el = editRef.current;
      const at = editingRef.current;
      setEditing(null);
      editingRef.current = null;
      if (!el || !at) return;
      const value = el.value.trim();

      // Editing existing text: replace it where it sits in the list, so an
      // eraser drawn after it still covers it. An empty box deletes it.
      if (at.id) {
        const idx = strokesRef.current.findIndex(i => isText(i) && i.id === at.id);
        if (idx === -1) return;
        if (!value) strokesRef.current.splice(idx, 1);
        else strokesRef.current[idx] = { ...(strokesRef.current[idx] as WhiteboardText), text: value };
        redrawAll();
        onTextEdit(at.id, value);
        return;
      }

      if (!value) return;
      const pos = getPosFromClient(at.sx, at.sy);
      const item: WhiteboardText = {
        kind: "text",
        id: crypto.randomUUID(),
        x: pos.x,
        y: pos.y,
        text: value,
        color,
        size: textSize / Math.min(DRAWING_VIEWPORT.width, DRAWING_VIEWPORT.height),
        font
      };
      strokesRef.current.push(item);
      drawTextItem(item);
      onText(item);
    };

    const openCaret = (sx: number, sy: number) => {
      const hit = textAt(sx, sy);
      // Clicking away from an active caret only commits and blurs it. A second
      // click is required to create another text entity.
      if (editingRef.current) {
        commitText();
        if (!hit) return;
      }
      if (hit) {
        // Re-open existing text where it actually sits, not where you clicked
        const { x: tx, y: ty, scale } = canvasTransformRef.current;
        const next: Caret = {
          sx: hit.x * DRAWING_VIEWPORT.width * scale + tx,
          sy: hit.y * DRAWING_VIEWPORT.height * scale + ty,
          value: hit.text,
          id: hit.id
        };
        editingRef.current = next;
        setEditing(next);
        // Hide the original while its replacement is being typed
        redrawAll();
        return;
      }

      const next: Caret = { sx, sy, value: "" };
      editingRef.current = next;
      setEditing(next);
    };

    const constrainShapeEnd = (draft: { x0: number; y0: number }, x1: number, y1: number, constrain: boolean) => {
      if (!constrain) return { x1, y1 };
      const dx = x1 - draft.x0;
      const dy = y1 - draft.y0;
      if (shapeKind === "rectangle" || shapeKind === "ellipse") {
        const side = Math.max(Math.abs(dx), Math.abs(dy));
        return { x1: draft.x0 + Math.sign(dx || 1) * side, y1: draft.y0 + Math.sign(dy || 1) * side };
      }
      const length = Math.hypot(dx, dy);
      const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      return { x1: draft.x0 + Math.cos(angle) * length, y1: draft.y0 + Math.sin(angle) * length };
    };

    const finishShape = () => {
      const draft = shapeDraftRef.current;
      shapeDraftRef.current = null;
      setShapeDraft(null);
      if (!draft || Math.hypot(draft.x1 - draft.x0, draft.y1 - draft.y0) < 8) return;
      const a = getPosFromClient(draft.x0, draft.y0);
      const b = getPosFromClient(draft.x1, draft.y1);
      const item: WhiteboardShape = {
        kind: "shape",
        id: crypto.randomUUID(),
        shape: shapeKind,
        x0: a.x,
        y0: a.y,
        x1: b.x,
        y1: b.y,
        color,
        width: width / Math.min(DRAWING_VIEWPORT.width, DRAWING_VIEWPORT.height)
      };
      strokesRef.current.push(item);
      drawShapeItem(item);
      onShape(item);
    };

    const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
      // Touch has dedicated multi-touch-aware handlers below.
      if (e.pointerType === "touch") return;
      if (e.button !== 0) return; // left-click only; middle-click reserved for panning
      if (tool === "pointer" || tool === "connector") return;
      // Text is placed on click (see handleCanvasClick) — opening the caret on
      // pointer-down would mount the input mid-gesture, and the pointer-up that
      // follows lands on the canvas and blurs it straight back shut.
      if (tool === "text") return;
      if (tool === "region") {
        e.currentTarget.setPointerCapture(e.pointerId);
        const m = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
        marqueeRef.current = m;
        setMarquee(m);
        return;
      }
      if (tool === "shape") {
        e.currentTarget.setPointerCapture(e.pointerId);
        const draft = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
        shapeDraftRef.current = draft;
        setShapeDraft(draft);
        return;
      }
      e.currentTarget.setPointerCapture(e.pointerId);
      isDrawingRef.current = true;
      lastPointRef.current = getPosFromClient(e.clientX, e.clientY);
    };

    const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (tool !== "text") return;
      openCaret(e.clientX, e.clientY);
    };

    const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (e.pointerType === "touch") return;
      if (tool === "pointer" || tool === "text" || tool === "connector") {
        setHoveredText(textAt(e.clientX, e.clientY));
        if (tool === "text") return;
      }
      if (tool === "region") {
        if (!marqueeRef.current) return;
        const m = { ...marqueeRef.current, x1: e.clientX, y1: e.clientY };
        marqueeRef.current = m;
        setMarquee(m);
        return;
      }
      if (tool === "shape") {
        const draft = shapeDraftRef.current;
        if (!draft) return;
        const end = constrainShapeEnd(draft, e.clientX, e.clientY, e.shiftKey);
        const next = { ...draft, ...end };
        shapeDraftRef.current = next;
        setShapeDraft(next);
        return;
      }
      if (!isDrawingRef.current || !lastPointRef.current) return;
      const curr = getPosFromClient(e.clientX, e.clientY);
      emitStroke(curr);
    };

    const finishRegion = () => {
      const m = marqueeRef.current;
      marqueeRef.current = null;
      setMarquee(null);
      if (!m) return;
      const a = getPosFromClient(Math.min(m.x0, m.x1), Math.min(m.y0, m.y1));
      const b = getPosFromClient(Math.max(m.x0, m.x1), Math.max(m.y0, m.y1));
      const w = (b.x - a.x) * DRAWING_VIEWPORT.width;
      const h = (b.y - a.y) * DRAWING_VIEWPORT.height;
      // Ignore a stray click that never became a drag
      if (w < 12 || h < 12) return;
      onRegion({ x: a.x, y: a.y, w, h });
    };

    const stopDrawing = (e?: React.PointerEvent<HTMLCanvasElement>) => {
      if (e && e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      if (tool === "region") {
        finishRegion();
        return;
      }
      if (tool === "shape") {
        finishShape();
        return;
      }
      isDrawingRef.current = false;
      lastPointRef.current = null;
    };

    // ── Touch handlers (iOS / Android) ───────────────────────────────────

    const handleTouchStart = (e: React.TouchEvent<HTMLCanvasElement>) => {
      if (tool === "pointer" || tool === "connector") return;
      // Text is placed on the click the browser synthesises after the tap
      if (tool === "text") return;
      // Multi-touch is reserved for canvas pinch-to-zoom — cancel any drawing
      if (e.touches.length !== 1) {
        isDrawingRef.current = false;
        lastPointRef.current = null;
        return;
      }
      const touch = e.touches[0];
      if (tool === "shape") {
        const draft = { x0: touch.clientX, y0: touch.clientY, x1: touch.clientX, y1: touch.clientY };
        shapeDraftRef.current = draft;
        setShapeDraft(draft);
        return;
      }
      fountainRef.current = { w: 1, at: performance.now() };
      isDrawingRef.current = true;
      lastPointRef.current = getPosFromClient(touch.clientX, touch.clientY);
    };

    const handleTouchMove = (e: React.TouchEvent<HTMLCanvasElement>) => {
      // A second finger was placed mid-stroke — stop drawing
      if (e.touches.length !== 1) {
        isDrawingRef.current = false;
        lastPointRef.current = null;
        shapeDraftRef.current = null;
        setShapeDraft(null);
        return;
      }
      if (tool === "shape") {
        const draft = shapeDraftRef.current;
        if (!draft) return;
        const touch = e.touches[0];
        const next = { ...draft, x1: touch.clientX, y1: touch.clientY };
        shapeDraftRef.current = next;
        setShapeDraft(next);
        return;
      }
      if (!isDrawingRef.current || !lastPointRef.current) return;
      const touch = e.touches[0];
      const curr = getPosFromClient(touch.clientX, touch.clientY);
      emitStroke(curr);
    };

    // ── Shared stroke emitter ────────────────────────────────────────────

    const emitStroke = (curr: { x: number; y: number }) => {
      if (!lastPointRef.current) return;
      const prev = lastPointRef.current;
      let rawPx = tool === "eraser" ? width * 5 : width;

      // A fountain nib thins as the hand speeds up. Replay has no timing —
      // the canvas is redrawn from stored segments — so the taper has to be
      // measured live and baked into each segment's width.
      if (tool === "pen" && nib === "fountain") {
        const now = performance.now();
        const dt = Math.max(8, now - fountainRef.current.at);
        const { scale } = canvasTransformRef.current;
        // Judge speed by how fast the hand moves on *screen*, not in world
        // units, so a zoomed-out board doesn't read as a frantic scribble.
        const dxs = (curr.x - prev.x) * DRAWING_VIEWPORT.width * scale;
        const dys = (curr.y - prev.y) * DRAWING_VIEWPORT.height * scale;
        const speed = Math.hypot(dxs, dys) / dt;
        const target = Math.max(0.35, Math.min(1.55, 1.55 - speed * 0.3));
        // Ease towards the target so the line doesn't judder frame to frame
        fountainRef.current.w = fountainRef.current.w * 0.6 + target * 0.4;
        fountainRef.current.at = now;
        rawPx = width * fountainRef.current.w;
      }

      const stroke: WhiteboardStroke = {
        x0: prev.x,
        y0: prev.y,
        x1: curr.x,
        y1: curr.y,
        color: tool === "eraser" ? "__eraser__" : color,
        // Normalise so it looks proportionally the same on the remote screen
        width: rawPx / Math.min(DRAWING_VIEWPORT.width, DRAWING_VIEWPORT.height),
        ...(tool === "pen" ? { nib } : {})
      };
      strokesRef.current.push(stroke);
      drawSegment(stroke);
      onStroke(stroke);
      lastPointRef.current = curr;
    };

    return (
      <>
        <canvas
          ref={canvasRef}
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            zIndex: 0,
            cursor:
              isPanning
                ? "grabbing"
                : tool === "pointer"
                  ? "default"
                  : tool === "eraser"
                    ? "cell"
                    : tool === "text"
                      ? "text"
                      : "crosshair",
            touchAction: "none",
          }}
          onClick={handleCanvasClick}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerLeave={event => {
            const next = event.relatedTarget;
            if (!(next instanceof Element && next.closest('[data-text-move-handle]'))) setHoveredText(null);
          }}
          onPointerUp={stopDrawing}
          onPointerCancel={stopDrawing}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={() => stopDrawing()}
          onTouchCancel={() => stopDrawing()}
        />

        {hoveredText && !editing && (() => {
          const { x: tx, y: ty, scale } = canvasTransform;
          const size = hoveredText.size * Math.min(DRAWING_VIEWPORT.width, DRAWING_VIEWPORT.height);
          const left = hoveredText.x * DRAWING_VIEWPORT.width * scale + tx;
          const top = (hoveredText.y * DRAWING_VIEWPORT.height - size) * scale + ty;
          // The exact canvas measurement is only needed for hit-testing. A
          // conservative character-width estimate keeps render ref-free and
          // places the handle just beyond the text's top-right edge.
          const right = left + hoveredText.text.length * size * 0.62 * scale;
          return (
            <button
              data-text-move-handle
              className="fixed z-[996] flex h-6 w-6 items-center justify-center rounded-md border border-zinc-600 bg-zinc-900/95 text-zinc-300 shadow-lg cursor-grab active:cursor-grabbing hover:bg-zinc-700"
              style={{ left: right + 4, top: top - 4, touchAction: "none" }}
              title="Move text"
              aria-label="Move text"
              onPointerDown={event => {
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                const pos = getPosFromClient(event.clientX, event.clientY);
                movingTextRef.current = { id: hoveredText.id, dx: pos.x - hoveredText.x, dy: pos.y - hoveredText.y };
              }}
              onPointerMove={event => {
                const moving = movingTextRef.current;
                if (!moving || moving.id !== hoveredText.id) return;
                const pos = getPosFromClient(event.clientX, event.clientY);
                const item = strokesRef.current.find(candidate => isText(candidate) && candidate.id === moving.id) as WhiteboardText | undefined;
                if (!item) return;
                item.x = pos.x - moving.dx;
                item.y = pos.y - moving.dy;
                setHoveredText({ ...item });
                redrawAll();
              }}
              onPointerUp={event => {
                const moving = movingTextRef.current;
                movingTextRef.current = null;
                if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                const item = strokesRef.current.find(candidate => isText(candidate) && candidate.id === moving?.id) as WhiteboardText | undefined;
                if (item) onTextMove(item.id, item.x, item.y);
              }}
              onPointerLeave={() => {
                if (!movingTextRef.current) setHoveredText(null);
              }}
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor"><circle cx="8" cy="8" r="1.5"/><circle cx="16" cy="8" r="1.5"/><circle cx="8" cy="16" r="1.5"/><circle cx="16" cy="16" r="1.5"/></svg>
            </button>
          );
        })()}

        {shapeDraft && (
          <svg className="pointer-events-none fixed inset-0 z-[997] h-full w-full overflow-visible" aria-hidden="true">
            <defs>
              <marker id="shape-draft-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
                <path d="M0 0l8 4-8 4z" fill={metalFor(color)?.[1] ?? color} />
              </marker>
            </defs>
            {shapeKind === "rectangle" ? (
              <rect x={Math.min(shapeDraft.x0, shapeDraft.x1)} y={Math.min(shapeDraft.y0, shapeDraft.y1)} width={Math.abs(shapeDraft.x1 - shapeDraft.x0)} height={Math.abs(shapeDraft.y1 - shapeDraft.y0)} fill="none" stroke={metalFor(color)?.[1] ?? color} strokeWidth={width} />
            ) : shapeKind === "ellipse" ? (
              <ellipse cx={(shapeDraft.x0 + shapeDraft.x1) / 2} cy={(shapeDraft.y0 + shapeDraft.y1) / 2} rx={Math.abs(shapeDraft.x1 - shapeDraft.x0) / 2} ry={Math.abs(shapeDraft.y1 - shapeDraft.y0) / 2} fill="none" stroke={metalFor(color)?.[1] ?? color} strokeWidth={width} />
            ) : (
              <line x1={shapeDraft.x0} y1={shapeDraft.y0} x2={shapeDraft.x1} y2={shapeDraft.y1} stroke={metalFor(color)?.[1] ?? color} strokeWidth={width} strokeLinecap="round" markerEnd={shapeKind === "arrow" ? "url(#shape-draft-arrow)" : undefined} />
            )}
          </svg>
        )}

        {marquee && (
          <div
            aria-hidden="true"
            style={{
              position: "fixed",
              left: Math.min(marquee.x0, marquee.x1),
              top: Math.min(marquee.y0, marquee.y1),
              width: Math.abs(marquee.x1 - marquee.x0),
              height: Math.abs(marquee.y1 - marquee.y0),
              zIndex: 997,
              border: "2px dashed rgba(251,191,36,0.9)",
              background: "rgba(251,191,36,0.08)",
              borderRadius: 6,
              pointerEvents: "none"
            }}
          />
        )}

        {/*
          The caret is a real input floating over the canvas rather than text
          drawn straight into it, so you get a cursor, selection and IME for
          free. It is styled to match what will be committed, so the preview is
          honest: same font, same colour, same on-screen size at this zoom.
        */}
        {editing && (
          <input
            // Remount per caret so the box always starts from the right text
            key={editing.id ?? `${editing.sx},${editing.sy}`}
            ref={editRef}
            autoFocus
            defaultValue={editing.value}
            spellCheck={false}
            aria-label={editing.id ? "Edit canvas text" : "Canvas text"}
            onBlur={commitText}
            onKeyDown={e => {
              if (e.key === "Enter") commitText();
              if (e.key === "Escape") {
                const wasEditing = !!editingRef.current?.id;
                setEditing(null);
                editingRef.current = null;
                // Abandoning an edit has to repaint: the original is hidden
                // while its replacement is being typed, so without this it
                // simply stays gone.
                if (wasEditing) redrawAll();
              }
              // The canvas binds space to pan mode
              e.stopPropagation();
            }}
            onKeyUp={e => e.stopPropagation()}
            style={{
              position: "fixed",
              left: editing.sx,
              // Sit the box on the baseline the text will be drawn at
              top: editing.sy - textSize * canvasTransform.scale,
              zIndex: 998,
              font: `${textSize * canvasTransform.scale}px ${
                FONT_STACKS[font] ?? FONT_STACKS.sans
              }`,
              color: metalFor(color) ? metalFor(color)![1] : color,
              background: "transparent",
              border: "none",
              borderBottom: "1px dashed rgba(255,255,255,0.45)",
              outline: "none",
              padding: 0,
              minWidth: "2ch",
              caretColor: "#fff",
            }}
          />
        )}
      </>
    );
  },
);

Whiteboard.displayName = "Whiteboard";
export { Whiteboard };
