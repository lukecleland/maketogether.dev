import { useEffect, useRef, useState } from "react";
import { FONT_STACKS, METALS, metalFor, TEXT_SIZES, type Nib, type TextFont } from "../utils/brush";
import type { ShapeKind } from "./Whiteboard";

/**
 * WhiteboardToolbar — a floating tool island with a contextual properties panel.
 *
 * ## Structure
 * Two pieces instead of one strip:
 *
 * - **Island** — horizontal below the top bar on compact screens, and a
 *   left-side vertical rail on desktop. Holds only what's always relevant:
 *   the tools, the current colour, and clear.
 * - **Properties panel** — shown below the compact island or beside the desktop
 *   rail, and only
 *   while a tool with options is selected. Colour and brush size live here.
 *
 * ## Why not a flat strip
 * The previous version put every option on screen permanently — two tools,
 * eight colour swatches, three sizes and clear, all competing for the same
 * vertical rail. That doesn't survive more tools being added, and on a phone it
 * occupied a fixed column of a screen where the canvas *is* the content.
 * Splitting "which tool" from "that tool's options" means new tools cost one
 * island slot each, and their options cost nothing until selected.
 *
 * ## Placement
 * Fixed rather than draggable. The old bar could be moved but was reset on every
 * reload, and being able to lose your toolbar behind a panel is not a feature.
 * The responsive placement keeps the panel below the island on narrow screens
 * and beside the rail where desktop space allows it.
 *
 * Tool selection and contextual styling are controlled by Session.tsx.
 */

type Tool = "pointer" | "pen" | "eraser" | "text" | "region" | "shape" | "connector";

interface WhiteboardToolbarProps {
  tool: Tool;
  color: string;
  width: number;
  nib: Nib;
  font: TextFont;
  textSize: number;
  shapeKind: ShapeKind;
  onToolChange: (t: Tool) => void;
  onColorChange: (c: string) => void;
  onWidthChange: (w: number) => void;
  onNibChange: (n: Nib) => void;
  onFontChange: (f: TextFont) => void;
  onTextSizeChange: (s: number) => void;
  onShapeKindChange: (shape: ShapeKind) => void;
  onClear: () => void;
}

const FONTS: { id: TextFont; label: string }[] = [
  { id: "sans", label: "Sans" },
  { id: "serif", label: "Serif" },
  { id: "mono", label: "Mono" },
  { id: "hand", label: "Hand" }
];

const COLORS = [
  "#ffffff",
  "#f87171",
  "#fb923c",
  "#facc15",
  "#4ade80",
  "#60a5fa",
  "#c084fc",
  "#f472b6"
];

/** Bright, saturated shades — the only ones that read as highlighting. */
const HIGHLIGHTER_COLORS = [
  "#facc15",
  "#4ade80",
  "#22d3ee",
  "#fb923c",
  "#f472b6",
  "#a3e635"
];

const NIBS: { id: Nib; label: string; hint: string }[] = [
  { id: "ballpoint", label: "Ballpoint", hint: "Even, solid line" },
  { id: "fountain", label: "Fountain", hint: "Thins as you speed up" },
  { id: "pencil", label: "Pencil", hint: "Light, grainy" },
  { id: "charcoal", label: "Charcoal", hint: "Loose and scattered" },
  { id: "highlighter", label: "Highlighter", hint: "Wide and translucent" },
  { id: "neon", label: "Neon", hint: "Glowing" }
];

/** A little preview of what each nib lays down, drawn the way the board draws it. */
function NibSwatch({ nib, color }: { nib: Nib; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const w = cv.width;
    const h = cv.height;
    ctx.clearRect(0, 0, w, h);
    const metal = metalFor(color);
    const pts: [number, number][] = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      pts.push([4 + t * (w - 8), h / 2 + Math.sin(t * Math.PI * 1.6) * (h * 0.22)]);
    }
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 4294967296);
    ctx.lineCap = "round";
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
      if (metal) {
        const dx = x1 - x0;
        const dy = y1 - y0;
        const len = Math.hypot(dx, dy) || 1;
        const g = ctx.createLinearGradient(
          (x0 + x1) / 2 + (dy / len) * 3,
          (y0 + y1) / 2 - (dx / len) * 3,
          (x0 + x1) / 2 - (dy / len) * 3,
          (y0 + y1) / 2 + (dx / len) * 3
        );
        g.addColorStop(0, metal[0]);
        g.addColorStop(0.45, metal[1]);
        g.addColorStop(0.55, metal[1]);
        g.addColorStop(1, metal[2]);
        ctx.strokeStyle = g;
        ctx.lineWidth = 6;
      } else {
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
      }
      if (nib === "fountain") ctx.lineWidth = 1.5 + Math.abs(Math.cos((i / 24) * Math.PI * 1.6)) * 4;
      if (nib === "pencil") {
        ctx.globalAlpha = 0.3;
        ctx.lineWidth = 1.2;
        for (let k = 0; k < 3; k++) {
          const j = () => (rnd() - 0.5) * 3;
          ctx.beginPath();
          ctx.moveTo(x0 + j(), y0 + j());
          ctx.lineTo(x1 + j(), y1 + j());
          ctx.stroke();
        }
        continue;
      }
      if (nib === "charcoal") {
        ctx.globalAlpha = 0.16;
        ctx.fillStyle = color;
        for (let k = 0; k < 6; k++) {
          const a = rnd() * Math.PI * 2;
          const d = rnd() * 5;
          ctx.beginPath();
          ctx.arc(x1 + Math.cos(a) * d, y1 + Math.sin(a) * d, rnd() * 1.5 + 0.4, 0, 7);
          ctx.fill();
        }
        continue;
      }
      if (nib === "highlighter") {
        ctx.globalAlpha = 0.25;
        ctx.lineWidth = 11;
        ctx.lineCap = "butt";
      }
      if (nib === "neon") {
        ctx.shadowBlur = 8;
        ctx.shadowColor = color;
      }
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      if (nib === "neon") {
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 0.85;
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }
    }
  }, [nib, color]);
  return <canvas ref={ref} width={144} height={40} className="w-[72px] h-[20px]" aria-hidden="true" />;
}

const SIZES = [
  { label: "S", value: 3 },
  { label: "M", value: 8 },
  { label: "L", value: 16 }
];

const SHAPES: Array<{ id: ShapeKind; label: string }> = [
  { id: "rectangle", label: "Rectangle" },
  { id: "ellipse", label: "Ellipse" },
  { id: "line", label: "Line" },
  { id: "arrow", label: "Arrow" }
];

/** Below the top bar, allowing for the iOS safe-area inset. */
const TOP_OFFSET = "calc(var(--session-header-height, 3rem) + env(safe-area-inset-top) + 0.5rem)";
const PANEL_OFFSET = "calc(var(--session-header-height, 3rem) + env(safe-area-inset-top) + 3.5rem)";

export function WhiteboardToolbar({
  tool,
  color,
  width,
  nib,
  font,
  textSize,
  shapeKind,
  onToolChange,
  onColorChange,
  onWidthChange,
  onNibChange,
  onFontChange,
  onTextSizeChange,
  onShapeKindChange,
  onClear
}: WhiteboardToolbarProps) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [mobileCollapsed, setMobileCollapsed] = useState(true);
  const panelRef = useRef<HTMLDivElement>(null);
  const islandRef = useRef<HTMLDivElement>(null);

  // Clicking away closes the panel, so it never sits over the canvas unused
  useEffect(() => {
    if (!panelOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || islandRef.current?.contains(t)) return;
      setPanelOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [panelOpen]);

  const selectTool = (t: Tool) => {
    setMobileCollapsed(true);
    // The region tool has no options — every section of the panel (colour,
    // size) belongs to the drawing tools, so opening it here would show
    // controls that affect nothing.
    if (t === "pointer" || t === "region" || t === "connector") {
      onToolChange(t);
      setPanelOpen(false);
      return;
    }
    // Re-tapping the active tool toggles its options rather than doing nothing
    if (t === tool) setPanelOpen(o => !o);
    else {
      onToolChange(t);
      setPanelOpen(true);
    }
  };

  const hasOptions = (t: Tool) => t !== "pointer" && t !== "region" && t !== "connector";

  // A tool button carries its own state rather than delegating it to a second
  // control: the pen shows the colour it will draw with, and the active tool
  // shows a chevron so "tap again for options" is visible rather than folklore.
  const toolButton = (t: Tool, label: string, path: string, swatch = false) => (
    <button
      onClick={() => selectTool(t)}
      title={tool === t && hasOptions(t) ? `${label} — tap for options` : label}
      aria-label={label}
      aria-pressed={tool === t}
      aria-expanded={tool === t && hasOptions(t) ? panelOpen : undefined}
      className={`group relative w-9 h-9 flex items-center justify-center rounded-xl transition-colors ${
        tool === t
          ? "bg-brand-600 text-white"
          : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700"
      }`}
    >
      <svg className="w-[18px] h-[18px]" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d={path} />
      </svg>

      {swatch && (
        <span
          aria-hidden="true"
          className="absolute bottom-1 left-1/2 -translate-x-1/2 w-4 h-[3px] rounded-full border border-black/30"
          style={{
            background: metalFor(color)
              ? `linear-gradient(90deg, ${metalFor(color)!.join(", ")})`
              : color
          }}
        />
      )}

      {tool === t && hasOptions(t) && (
        <svg
          aria-hidden="true"
          className="absolute -bottom-0.5 right-0.5 w-2.5 h-2.5 opacity-80"
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <path d="M7 10l5 5 5-5z" />
        </svg>
      )}
      <span role="tooltip" className="toolbar-tooltip">{tool === t && hasOptions(t) ? `${label} · tap again for options` : label}</span>
    </button>
  );

  return (
    <>
      {/* ── Island ─────────────────────────────────────────────────────── */}
      <div
        data-canvas-chrome
        ref={islandRef}
        data-mobile-collapsed={mobileCollapsed}
        style={{ position: "fixed", zIndex: 999, top: TOP_OFFSET }}
        className="whiteboard-tools left-1/2 -translate-x-1/2 flex items-center gap-1 bg-zinc-900/95 backdrop-blur border border-zinc-700 rounded-2xl p-1.5 shadow-xl select-none lg:left-3 lg:translate-x-0 lg:flex-col"
      >
        <button
          className="mobile-tools-toggle text-zinc-300"
          aria-label={mobileCollapsed ? "Show drawing tools" : "Hide drawing tools"}
          aria-expanded={!mobileCollapsed}
          onClick={() => { setMobileCollapsed(value => !value); setPanelOpen(false); }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            {mobileCollapsed ? <path strokeLinecap="round" d="M5 6h14M5 12h14M5 18h14" /> : <path strokeLinecap="round" d="m6 6 12 12M18 6 6 18" />}
          </svg>
        </button>
        {toolButton(
          "pointer",
          "Pointer",
          "M5 3l14 9-6.5 1.5L9 20 5 3z"
        )}
        {toolButton(
          "pen",
          "Pen",
          "M15.232 5.232l3.536 3.536M9 11l6.586-6.586a2 2 0 112.828 2.828L11.828 13.828a4 4 0 01-1.414.95l-3.31 1.103 1.104-3.31A4 4 0 019 11z",
          true
        )}
        {toolButton(
          "eraser",
          "Eraser",
          "M20.707 5.826l-2.534-2.533a1 1 0 00-1.414 0l-10 10a1 1 0 000 1.414l2.534 2.534 1.414-1.415-1.829-1.828 8.586-8.585 1.83 1.83-1.415 1.414 1.415 1.414 2.828-2.828a1 1 0 000-1.414zM4 20h7"
        )}

        {toolButton(
          "text",
          "Text tool",
          "M4 7V5h16v2M9 5v14m-2 0h4"
        )}
        {toolButton(
          "region",
          "Tag an area",
          "M4 8V6a2 2 0 012-2h2M16 4h2a2 2 0 012 2v2M20 16v2a2 2 0 01-2 2h-2M8 20H6a2 2 0 01-2-2v-2"
        )}
        {toolButton(
          "shape",
          "Shape tool",
          "M5 5h14v14H5zM8 16l8-8",
          true
        )}
        {toolButton(
          "connector",
          "Connect panels",
          "M7 7h4v4H7zM13 13h4v4h-4zM10.5 10.5l3 3"
        )}

        <div className="w-px h-6 bg-zinc-700 mx-0.5 lg:mx-0 lg:my-0.5 lg:h-px lg:w-6" />

        <button
          onClick={onClear}
          title="Clear canvas"
          aria-label="Clear canvas"
          className="group relative w-9 h-9 flex items-center justify-center rounded-xl text-zinc-400 hover:text-red-400 hover:bg-zinc-700 transition-colors"
        >
          <svg className="w-[18px] h-[18px]" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
            />
          </svg>
          <span role="tooltip" className="toolbar-tooltip">Clear canvas</span>
        </button>
      </div>

      {/* ── Properties ─────────────────────────────────────────────────── */}
      {panelOpen && (
        <div
          ref={panelRef}
          style={{ position: "fixed", zIndex: 999, top: PANEL_OFFSET }}
          className="whiteboard-properties left-3 w-[13.5rem] bg-zinc-900/95 backdrop-blur border border-zinc-700 rounded-2xl p-3 shadow-xl select-none"
        >
          {tool === "text" && (
            <>
              <p className="text-[11px] uppercase tracking-wide text-zinc-500 mb-2">Font</p>
              <div className="grid grid-cols-2 gap-1 mb-3.5">
                {FONTS.map(f => (
                  <button
                    key={f.id}
                    onClick={() => onFontChange(f.id)}
                    aria-label={f.label}
                    aria-pressed={font === f.id}
                    style={{ fontFamily: FONT_STACKS[f.id] }}
                    className={`px-2 py-1.5 rounded-lg text-sm text-zinc-200 transition-colors ${
                      font === f.id ? "bg-zinc-700" : "hover:bg-zinc-800"
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </>
          )}

          {tool === "pen" && (
            <>
              <p className="text-[11px] uppercase tracking-wide text-zinc-500 mb-2">Nib</p>
              <div className="grid grid-cols-2 gap-1 mb-3.5">
                {NIBS.map(n => (
                  <button
                    key={n.id}
                    onClick={() => onNibChange(n.id)}
                    title={`${n.label} — ${n.hint}`}
                    aria-label={n.label}
                    aria-pressed={nib === n.id}
                    className={`flex flex-col items-center gap-0.5 px-1 py-1.5 rounded-lg transition-colors ${
                      nib === n.id ? "bg-zinc-700" : "hover:bg-zinc-800"
                    }`}
                  >
                    <NibSwatch nib={n.id} color={color} />
                    <span className="text-[10px] leading-none text-zinc-400">{n.label}</span>
                  </button>
                ))}
              </div>
            </>
          )}

          {tool === "shape" && (
            <>
              <p className="text-[11px] uppercase tracking-wide text-zinc-500 mb-2">Shape</p>
              <div className="grid grid-cols-2 gap-1 mb-3.5">
                {SHAPES.map(shape => (
                  <button key={shape.id} onClick={() => onShapeKindChange(shape.id)} aria-pressed={shapeKind === shape.id} className={`rounded-lg px-2 py-1.5 text-xs text-zinc-200 transition-colors ${shapeKind === shape.id ? "bg-zinc-700" : "hover:bg-zinc-800"}`}>
                    {shape.label}
                  </button>
                ))}
              </div>
              <p className="mb-3 text-[10px] leading-relaxed text-zinc-500">Hold Shift for squares, circles, and 45° lines.</p>
            </>
          )}

          {/* Colour is shared by the pen and the text tool; the eraser has none */}
          {tool !== "eraser" && (
            <>
              <p className="text-[11px] uppercase tracking-wide text-zinc-500 mb-2">Colour</p>
              <div
                className={`grid gap-1.5 mb-2 ${
                  tool === "pen" && nib === "highlighter" ? "grid-cols-6" : "grid-cols-8"
                }`}
              >
                {(tool === "pen" && nib === "highlighter" ? HIGHLIGHTER_COLORS : COLORS).map(c => (
                  <button
                    key={c}
                    onClick={() => onColorChange(c)}
                    title={c}
                    aria-label={`Colour ${c}`}
                    aria-pressed={color === c}
                    style={{ background: c }}
                    className={`w-full aspect-square rounded-md transition-transform hover:scale-110 ${
                      color === c ? "ring-2 ring-white ring-offset-2 ring-offset-zinc-900" : ""
                    }`}
                  />
                ))}
              </div>

              {/* Metallics are gradients, so they can't be a flat swatch —
                  and they're pointless behind a translucent highlighter. */}
              {!(tool === "pen" && nib === "highlighter") && (
                <div className="grid grid-cols-4 gap-1.5 mb-2">
                  {Object.entries(METALS).map(([name, [a, b, c]]) => (
                    <button
                      key={name}
                      onClick={() => onColorChange(`metal:${name}`)}
                      title={name}
                      aria-label={`Metallic ${name}`}
                      aria-pressed={color === `metal:${name}`}
                      style={{ background: `linear-gradient(135deg, ${a}, ${b} 45%, ${c})` }}
                      className={`w-full aspect-square rounded-md transition-transform hover:scale-110 ${
                        color === `metal:${name}`
                          ? "ring-2 ring-white ring-offset-2 ring-offset-zinc-900"
                          : ""
                      }`}
                    />
                  ))}
                </div>
              )}

              <label className="flex items-center gap-2 mb-3.5 text-[11px] text-zinc-500 cursor-pointer">
                <input
                  type="color"
                  value={color.startsWith("metal:") ? "#ffffff" : color}
                  onChange={e => onColorChange(e.target.value)}
                  aria-label="Custom colour"
                  className="w-6 h-6 rounded-md bg-transparent border border-zinc-600 cursor-pointer p-0"
                />
                Custom
              </label>
            </>
          )}

          <p className="text-[11px] uppercase tracking-wide text-zinc-500 mb-2">
            {tool === "eraser" ? "Eraser size" : tool === "text" ? "Text size" : "Size"}
          </p>
          <div className="flex items-center gap-1.5">
            {tool === "text"
              ? TEXT_SIZES.map(s => (
                  <button
                    key={s.value}
                    onClick={() => onTextSizeChange(s.value)}
                    title={`Text size ${s.label}`}
                    aria-label={`Text size ${s.label}`}
                    aria-pressed={textSize === s.value}
                    className={`flex-1 h-9 flex items-center justify-center rounded-xl transition-colors ${
                      textSize === s.value ? "bg-zinc-700" : "hover:bg-zinc-800"
                    }`}
                  >
                    <span
                      className="leading-none text-zinc-200"
                      style={{ fontSize: Math.round(s.value / 2.6), fontFamily: FONT_STACKS[font] }}
                    >
                      Aa
                    </span>
                  </button>
                ))
              : SIZES.map(s => (
              <button
                key={s.value}
                onClick={() => onWidthChange(s.value)}
                title={`Size ${s.label}`}
                aria-label={`Size ${s.label}`}
                aria-pressed={width === s.value}
                className={`flex-1 h-9 flex items-center justify-center rounded-xl transition-colors ${
                  width === s.value ? "bg-zinc-700" : "hover:bg-zinc-800"
                }`}
              >
                <span
                  style={{
                    width: Math.min(s.value + 6, 20),
                    height: Math.min(s.value + 6, 20),
                    borderRadius: "50%",
                    background: tool === "pen" ? color : "#6b7280"
                  }}
                />
              </button>
                ))}
          </div>
        </div>
      )}
    </>
  );
}
