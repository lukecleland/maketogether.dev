import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { DockButton } from "./Dock";
import { chordsOf, emptyChord } from "../types/panels";
import type { ChordShape, NoteContent, NoteKind } from "../types/panels";
import { codeFromText } from "../utils/code";
import { CodeWidget } from "./CodeWidget";
import { fitNoteText } from "../utils/noteText";

/**
 * StickyNote — a note panel with three faces: plain text, a chord diagram, or
 * guitar tab.
 *
 * ## Why three faces in one panel
 * They are the same object — "a small thing pinned to the board" — and giving
 * each its own spawn button would crowd the top bar. The face is switched from
 * a segmented control in the note itself, and **all three faces keep their own
 * content**, so flipping to chord and back never throws away typed text.
 *
 * ## Editing and sync
 * The parent owns the content and pushes updates over the data channel; this
 * component just reports changes upward. Sends are debounced by the parent, so
 * typing doesn't flood the channel. Incoming remote edits replace the content
 * outright — last write wins, which is the sane outcome for a shared note and
 * avoids any merge machinery for something this small.
 *
 * ## Tab layout
 * Tab is six separate single-line inputs rather than one textarea, so the
 * string labels can never drift out of alignment with the rows.
 */

const COLOURS: Record<string, { bg: string; head: string; text: string }> = {
  amber: { bg: "bg-amber-200/90", head: "bg-amber-300/90", text: "text-amber-950" },
  pink: { bg: "bg-pink-200/90", head: "bg-pink-300/90", text: "text-pink-950" },
  sky: { bg: "bg-sky-200/90", head: "bg-sky-300/90", text: "text-sky-950" },
  lime: { bg: "bg-lime-200/90", head: "bg-lime-300/90", text: "text-lime-950" }
};

/** High e first — the order the strings are drawn, top to bottom. */
const TAB_LABELS = ["e", "B", "G", "D", "A", "E"];

interface StickyNoteProps {
  note: NoteContent;
  onChange: (next: NoteContent) => void;
  onClose?: () => void;
  docked?: boolean;
  onToggleDock?: () => void;
  title?: string;
}

/**
 * ChordDiagram — six strings across, five frets down. Click a cell to place or
 * clear a finger; click the marker above a string to cycle open → muted → off.
 */
function ChordDiagram({
  chord,
  onChange
}: {
  chord: ChordShape;
  onChange: (next: ChordShape) => void;
}) {
  const STRINGS = 6;
  const FRETS = 5;
  const w = 132;
  const h = 132;
  const padX = 14;
  const padY = 22;
  const stepX = (w - padX * 2) / (STRINGS - 1);
  const stepY = (h - padY - 10) / FRETS;

  const setDot = (stringIdx: number, fret: number) => {
    const dots = [...chord.dots];
    // Clicking the same fret again clears the string back to unset
    dots[stringIdx] = dots[stringIdx] === fret ? -2 : fret;
    onChange({ ...chord, dots });
  };

  // Marker above the nut cycles unset → open → muted → unset
  const cycleMarker = (stringIdx: number) => {
    const dots = [...chord.dots];
    const cur = dots[stringIdx];
    dots[stringIdx] = cur === 0 ? -1 : cur === -1 ? -2 : 0;
    onChange({ ...chord, dots });
  };

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-auto max-h-[104px]" role="img" aria-label="Chord diagram">
      {/* Nut — thick only when the diagram starts at the first fret */}
      <line
        x1={padX}
        y1={padY}
        x2={w - padX}
        y2={padY}
        stroke="currentColor"
        strokeWidth={chord.baseFret === 1 ? 4 : 1.5}
        strokeLinecap="round"
      />
      {Array.from({ length: FRETS }, (_, i) => (
        <line
          key={`f${i}`}
          x1={padX}
          y1={padY + stepY * (i + 1)}
          x2={w - padX}
          y2={padY + stepY * (i + 1)}
          stroke="currentColor"
          strokeWidth={1.2}
          opacity={0.55}
        />
      ))}
      {Array.from({ length: STRINGS }, (_, i) => (
        <line
          key={`s${i}`}
          x1={padX + stepX * i}
          y1={padY}
          x2={padX + stepX * i}
          y2={padY + stepY * FRETS}
          stroke="currentColor"
          strokeWidth={1.2}
          opacity={0.55}
        />
      ))}

      {/* Open / muted markers above the nut */}
      {chord.dots.map((d, i) => (
        <g key={`m${i}`} onClick={() => cycleMarker(i)} style={{ cursor: "pointer" }}>
          <rect x={padX + stepX * i - 7} y={2} width={14} height={16} fill="transparent" />
          {d === 0 && (
            <circle cx={padX + stepX * i} cy={11} r={4} fill="none" stroke="currentColor" strokeWidth={1.6} />
          )}
          {d === -1 && (
            <g stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
              <line x1={padX + stepX * i - 4} y1={7} x2={padX + stepX * i + 4} y2={15} />
              <line x1={padX + stepX * i + 4} y1={7} x2={padX + stepX * i - 4} y2={15} />
            </g>
          )}
        </g>
      ))}

      {/* Fret cells — click to place a finger */}
      {Array.from({ length: STRINGS }, (_, s) =>
        Array.from({ length: FRETS }, (_, f) => (
          <rect
            key={`c${s}-${f}`}
            x={padX + stepX * s - stepX / 2}
            y={padY + stepY * f}
            width={stepX}
            height={stepY}
            fill="transparent"
            style={{ cursor: "pointer" }}
            onClick={() => setDot(s, f + 1)}
          />
        ))
      )}

      {chord.dots.map((d, i) =>
        d > 0 ? (
          <circle
            key={`d${i}`}
            cx={padX + stepX * i}
            cy={padY + stepY * (d - 0.5)}
            r={7}
            fill="currentColor"
            pointerEvents="none"
          />
        ) : null
      )}

      {chord.baseFret > 1 && (
        <text x={2} y={padY + stepY * 0.7} fontSize={11} fill="currentColor" opacity={0.8}>
          {chord.baseFret}
        </text>
      )}
    </svg>
  );
}

export function StickyNote({ note, onChange, onClose, docked = false, onToggleDock, title = "Note" }: StickyNoteProps) {
  const [showColours, setShowColours] = useState(false);
  const c = COLOURS[note.colour] ?? COLOURS.amber;

  const set = (patch: Partial<NoteContent>) => onChange({ ...note, ...patch });

  const chords = chordsOf(note);
  const writeChords = (next: ChordShape[]) =>
    // Drop the legacy single-chord field once the list is written, so the two
    // can never disagree about what the note holds.
    onChange({ ...note, chords: next, chord: undefined });
  const setChord = (i: number, next: ChordShape) =>
    writeChords(chords.map((c, j) => (j === i ? next : c)));
  const addChord = () => writeChords([...chords, emptyChord()]);
  const removeChord = (i: number) => writeChords(chords.filter((_, j) => j !== i));
  const setKind = (kind: NoteKind) => set({ kind });

  // Apply remote text edits to the textarea. The field is uncontrolled so that
  // typing never fights React, which means remote changes have to be written in
  // by hand. Skipped only while you are *actively* typing — holding off just
  // because the field has focus would mean an idle cursor silently blocks the
  // other person's edits from ever appearing.
  const textRef = useRef<HTMLTextAreaElement>(null);
  const lastTypedRef = useRef(0);
  useEffect(() => {
    const el = textRef.current;
    if (!el || el.value === note.text) return;
    const activelyTyping = document.activeElement === el && Date.now() - lastTypedRef.current < 1200;
    if (activelyTyping) return;
    const atEnd = el.selectionStart === el.value.length;
    el.value = note.text;
    fitNoteText(el);
    // Keep the caret at the end if that's where it was, rather than jumping to 0
    if (document.activeElement === el && atEnd) el.setSelectionRange(note.text.length, note.text.length);
  }, [note.text]);

  useLayoutEffect(() => {
    const field = textRef.current;
    if (!field) return;
    fitNoteText(field);
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => fitNoteText(field));
    });
    observer.observe(field);
    let active = true;
    void document.fonts.ready.then(() => { if (active) fitNoteText(field); });
    return () => {
      active = false;
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [note.kind]);

  return (
    <div
      data-note-widget
      onPaste={e => {
        // Pasting inside an embedded code editor should remain a normal edit.
        if ((e.target as Element).closest('[data-code-widget]')) return;
        const code = codeFromText(e.clipboardData.getData("text/plain"));
        if (!code) return;
        e.preventDefault();
        set({ codeBlocks: [...(note.codeBlocks ?? []), code] });
      }}
      className={`flex flex-col h-full ${c.bg} rounded-xl overflow-hidden shadow-xl border border-black/10`}
    >
      <div className={`drag-handle flex items-center justify-between px-2 py-1.5 ${c.head} cursor-grab active:cursor-grabbing select-none shrink-0`}>
        <div className="no-drag flex items-center gap-0.5">
          <span className={`mr-1 max-w-24 truncate text-[10px] font-bold ${c.text}`}>{title}</span>
          {(["text", "chord", "tab"] as NoteKind[]).map(k => (
            <button
              key={k}
              onClick={() => setKind(k)}
              aria-pressed={note.kind === k}
              className={`text-[10px] font-semibold px-1.5 py-0.5 rounded transition-colors ${
                note.kind === k ? `bg-black/25 ${c.text}` : `${c.text} opacity-55 hover:opacity-90`
              }`}
            >
              {k === "text" ? "Text" : k === "chord" ? "Chord" : "Tab"}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowColours(s => !s)}
            className={`no-drag ${c.text} opacity-60 hover:opacity-100 transition-opacity`}
            title="Note colour"
            aria-label="Note colour"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="12" r="8" />
            </svg>
          </button>
          {onToggleDock && <DockButton docked={docked} onToggle={onToggleDock} />}
          {onClose && (
            <button
              onClick={onClose}
              className={`no-drag ${c.text} opacity-60 hover:opacity-100 transition-opacity`}
              aria-label="Close"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {showColours && (
        <div className="no-drag flex gap-1.5 px-2 py-1.5 bg-black/10 shrink-0">
          {Object.keys(COLOURS).map(name => (
            <button
              key={name}
              onClick={() => {
                set({ colour: name });
                setShowColours(false);
              }}
              aria-label={`${name} note`}
              className={`w-5 h-5 rounded-full border ${
                note.colour === name ? "border-black/60 scale-110" : "border-black/20"
              } ${COLOURS[name].bg} transition-transform`}
            />
          ))}
        </div>
      )}

      <div className={`no-drag flex-1 min-h-0 overflow-auto p-2 ${c.text}`}>
        {note.kind === "text" && (
          <div className="flex h-full flex-col gap-2">
          <textarea
            ref={textRef}
            defaultValue={note.text}
            onChange={e => {
              lastTypedRef.current = Date.now();
              fitNoteText(e.target);
              set({ text: e.target.value });
            }}
            placeholder="Write something…"
            spellCheck={false}
            aria-label="Note text"
            className={`w-full ${note.codeBlocks?.length ? 'min-h-24' : 'min-h-0'} flex-1 bg-transparent resize-none outline-none text-sm leading-snug [overflow-wrap:anywhere] placeholder:opacity-40`}
          />
          {(note.codeBlocks ?? []).map((code, index) => (
            <div key={index} className="h-40 shrink-0">
              <CodeWidget embedded code={code} onChange={next => set({ codeBlocks: (note.codeBlocks ?? []).map((item, i) => i === index ? next : item) })} onClose={() => set({ codeBlocks: (note.codeBlocks ?? []).filter((_, i) => i !== index) })} />
            </div>
          ))}
          </div>
        )}

        {note.kind === "chord" && (
          <div className="flex flex-col gap-2">
            {/* A song needs several chords, so they wrap into a grid and the
                note can simply be resized to fit more. */}
            <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(92px,1fr))]">
              {chords.map((ch, i) => (
                <div key={i} className="flex flex-col gap-1">
                  <div className="flex items-center gap-1">
                    <input
                      value={ch.name}
                      onChange={e => setChord(i, { ...ch, name: e.target.value })}
                      placeholder="Chord"
                      aria-label={`Chord ${i + 1} name`}
                      spellCheck={false}
                      className="flex-1 min-w-0 bg-black/10 rounded px-1.5 py-0.5 text-xs font-semibold outline-none placeholder:opacity-40"
                    />
                    <input
                      type="number"
                      min={1}
                      max={15}
                      value={ch.baseFret}
                      onChange={e =>
                        setChord(i, {
                          ...ch,
                          baseFret: Math.max(1, Math.min(15, Number(e.target.value) || 1))
                        })
                      }
                      aria-label={`Chord ${i + 1} starting fret`}
                      className="w-8 bg-black/10 rounded px-1 py-0.5 text-[10px] outline-none shrink-0"
                    />
                    {chords.length > 1 && (
                      <button
                        onClick={() => removeChord(i)}
                        title="Remove this chord"
                        aria-label={`Remove chord ${i + 1}`}
                        className="shrink-0 opacity-50 hover:opacity-100 transition-opacity"
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    )}
                  </div>
                  <ChordDiagram chord={ch} onChange={next => setChord(i, next)} />
                </div>
              ))}
            </div>

            <button
              onClick={addChord}
              className="self-start flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-lg bg-black/10 hover:bg-black/20 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" />
              </svg>
              Add chord
            </button>
          </div>
        )}

        {note.kind === "tab" && (
          <div className="flex flex-col gap-0.5 font-mono text-xs">
            {TAB_LABELS.map((label, i) => (
              <div key={label} className="flex items-center gap-1.5">
                <span className="w-3 shrink-0 opacity-60 select-none">{label}</span>
                <input
                  value={note.tab[i] ?? ""}
                  onChange={e => {
                    const tab = [...note.tab];
                    tab[i] = e.target.value;
                    set({ tab });
                  }}
                  placeholder="---------------"
                  spellCheck={false}
                  className="flex-1 min-w-0 bg-black/10 rounded px-1.5 py-0.5 outline-none tracking-wider placeholder:opacity-30"
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
