import { useEffect, useRef, useState } from "react";

/**
 * Dock — a bottom-centre bar of shortcuts back to panels out on the canvas.
 *
 * ## What it is for
 * Panels can end up anywhere on the infinite canvas. Docking one adds a chip
 * here; clicking that chip flies the viewport back to the panel. The panel
 * itself never moves — this is navigation, not relocation.
 *
 * ## Shared bookmarks
 * Tagging a panel adds a chip to *both* docks — these are landmarks in the
 * shared canvas, not private shortcuts. A chip that arrived from the other
 * person pulses until you click it, so you notice it without your viewport
 * being hijacked. Renames are shared too.
 *
 * Dismissing, though, is local: your × clears your own bar only. Otherwise one
 * person could delete a bookmark out of the other's UI, which is how you get
 * "where did my pill go?".
 *
 * ## Renaming
 * The pencil button on a chip renames it. Submitting an empty name clears the
 * custom label and reverts to the automatic one — the video title, file name,
 * or a numbered fallback.
 *
 * Renaming is deliberately *not* on double-click: the chip's single click is
 * "jump to this panel", so a double-click would fire a viewport flight before
 * the rename box opened. Debouncing the click to detect double-clicks would
 * put latency on the common action to serve the rare one. The pencil and ×
 * are always visible rather than revealed on hover, since touch devices have
 * no hover state.
 *
 * Renders nothing when the dock is empty.
 */

export interface DockEntry {
  id: string;
  type: "local" | "remote" | "youtube" | "audio" | "browser" | "position" | "note" | "code" | "recorder" | "image" | "daw" | "whiteboard" | "pdf";
  label: string;
  /** True when the label is a user-set name rather than a derived one. */
  renamed?: boolean;
  /** Tagged by the other person and not yet acknowledged — pulses for attention. */
  pulsing?: boolean;
  /** Locally hidden in the dock rather than currently visible on the canvas. */
  minimized?: boolean;
}

interface DockProps {
  entries: DockEntry[];
  /** Fly the viewport to this panel. */
  onJump: (id: string) => void;
  /** Remove this panel from the dock. */
  onRemove: (id: string) => void;
  /** Set a custom label; an empty string reverts to the automatic label. */
  onRename: (id: string, label: string) => void;
  /** Nudge the other person to look at this one. */
  onPing: (id: string) => void;
  /** Participant chips use double-click for peer viewport actions. */
  onParticipantDoubleClick: (entry: DockEntry) => void;
}

function DockIcon({ type }: { type: DockEntry["type"] }) {
  if (type === "pdf") return <span className="text-red-300 text-[9px] font-bold">PDF</span>;
  if (type === "whiteboard") return <span className="text-brand-300" aria-hidden="true">▱</span>;
  if (type === "daw") return <span className="text-emerald-400" aria-hidden="true">♫</span>;
  if (type === "image") {
    return (
      <svg className="h-4 w-4 shrink-0 text-fuchsia-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <circle cx="8.5" cy="9" r="1.5" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 17l5-5 3.5 3.5 2-2L20 19" />
      </svg>
    );
  }
  if (type === "recorder") {
    return <span className="h-3.5 w-3.5 shrink-0 rounded-full border-2 border-red-300 bg-red-500" />;
  }
  if (type === "code") {
    return <span className="shrink-0 font-mono text-xs font-bold text-emerald-400">&lt;/&gt;</span>;
  }
  if (type === "position") {
    return (
      <svg
        className="w-4 h-4 text-amber-400 shrink-0"
        viewBox="0 0 24 24"
        fill="currentColor"
      >
        <path d="M6 2a1 1 0 011 1v1h10.2a1 1 0 01.8 1.6L15.45 9 18 12.4a1 1 0 01-.8 1.6H8v7a1 1 0 11-2 0V2z" />
      </svg>
    );
  }
  if (type === "note") {
    return (
      <svg
        className="w-4 h-4 text-amber-300 shrink-0"
        viewBox="0 0 24 24"
        fill="currentColor"
      >
        <path d="M5 3h14a2 2 0 012 2v9l-7 7H5a2 2 0 01-2-2V5a2 2 0 012-2zm9 17.5V15a1 1 0 011-1h5.5L14 20.5z" />
      </svg>
    );
  }
  if (type === "browser") {
    return (
      <svg
        className="w-4 h-4 text-sky-400 shrink-0"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      >
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M3 9h18M7 6.5h.01M10 6.5h.01" strokeLinecap="round" />
      </svg>
    );
  }
  if (type === "youtube") {
    return (
      <svg
        className="w-4 h-4 text-red-500 shrink-0"
        viewBox="0 0 24 24"
        fill="currentColor"
      >
        <path d="M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
      </svg>
    );
  }
  if (type === "audio") {
    return (
      <svg
        className="w-4 h-4 text-brand-400 shrink-0"
        viewBox="0 0 24 24"
        fill="currentColor"
      >
        <path d="M12 3v10.55A4 4 0 1014 17V7h4V3h-6z" />
      </svg>
    );
  }
  // local / remote video
  return (
    <svg
      className="w-4 h-4 text-zinc-400 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15 10l4.553-2.069A1 1 0 0121 8.806v6.388a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z"
      />
    </svg>
  );
}

/**
 * DockButton — the toggle that lives in a panel's header bar.
 * Filled bookmark = currently docked.
 */
export function DockButton({
  docked,
  onToggle,
  reserveMinimizeSlot = true,
}: {
  docked: boolean;
  onToggle: () => void;
  reserveMinimizeSlot?: boolean;
}) {
  return (
    <button
      onClick={onToggle}
      className={`no-drag transition-colors ${reserveMinimizeSlot ? "mr-5" : ""} ${
        docked ? "text-brand-400 hover:text-brand-300" : "text-zinc-400 hover:text-white"
      }`}
      title={docked ? "Remove from dock" : "Add to dock"}
      aria-label={docked ? "Remove from dock" : "Add to dock"}
      aria-pressed={docked}
    >
      <svg
        className="w-4 h-4"
        viewBox="0 0 24 24"
        fill={docked ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth={2}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-4-7 4V5z"
        />
      </svg>
    </button>
  );
}

export function Dock({ entries, onJump, onRemove, onRename, onPing, onParticipantDoubleClick }: DockProps) {
  // Chips that have just been pinged, so the sender gets confirmation it went
  const [pinged, setPinged] = useState<string[]>([]);
  const pingTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  useEffect(() => {
    const timers = pingTimers.current;
    return () => {
      Object.values(timers).forEach(clearTimeout);
    };
  }, []);

  const ping = (id: string) => {
    onPing(id);
    setPinged(p => (p.includes(id) ? p : [...p, id]));
    if (pingTimers.current[id]) clearTimeout(pingTimers.current[id]);
    // Long enough for the last of the three staggered rings to finish
    pingTimers.current[id] = setTimeout(() => {
      setPinged(p => p.filter(x => x !== id));
      delete pingTimers.current[id];
    }, 1900);
  };
  // id of the chip currently being renamed, plus its in-progress text
  const [actionsId, setActionsId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Select the existing name when an edit starts, so typing replaces it
  useEffect(() => {
    if (editingId) inputRef.current?.select();
  }, [editingId]);

  const startEditing = (entry: DockEntry) => {
    setEditingId(entry.id);
    setDraft(entry.label);
  };

  const commitEditing = () => {
    if (editingId) onRename(editingId, draft.trim());
    setEditingId(null);
  };

  return (
    <div
      data-canvas-chrome
      data-dock
      role="navigation"
      aria-label="Canvas dock"
      className="fixed left-3 right-[168px] sm:left-[20%] sm:right-[20%] flex flex-wrap justify-center gap-1 max-h-[40dvh] overflow-y-auto overflow-x-hidden pointer-events-none [&>*]:pointer-events-auto"
      style={{
        zIndex: 999,
        bottom: "calc(1rem + env(safe-area-inset-bottom))",
      }}
    >
      {entries.map((entry) =>
        editingId === entry.id ? (
          // ── Rename mode ──
          <div
            key={entry.id}
            className="flex min-w-0 max-w-full min-h-8 shrink-0 items-center gap-1 bg-zinc-800 border border-brand-500 rounded-lg px-1.5 py-1"
          >
            <DockIcon type={entry.type} />
            <input
              ref={inputRef}
              value={draft}
              size={Math.max(8, draft.length)}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitEditing}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitEditing();
                if (e.key === "Escape") setEditingId(null);
              }}
              // The dock sits over the canvas, which binds space to pan mode
              onKeyUp={(e) => e.stopPropagation()}
              placeholder="Name (empty = auto)"
              aria-label="Rename dock item"
              autoFocus
              spellCheck={false}
              className="bg-transparent text-xs font-medium text-white placeholder:text-zinc-500 outline-none min-w-0"
            />
          </div>
        ) : (
          <div
            key={entry.id}
            data-dock-actions-open={actionsId === entry.id}
            className={`group flex min-w-0 max-w-full min-h-8 shrink-0 items-center gap-0.5 rounded-lg pl-1.5 pr-1 py-1 transition-colors border ${
              entry.pulsing
                ? "dock-pulse bg-brand-950/60 border-brand-500"
                : "bg-zinc-800 hover:bg-zinc-700 border-zinc-700"
            }`}
          >
            <button
              data-dock-entry={entry.id}
              onClick={() => onJump(entry.id)}
              onDoubleClick={() => {
                if (entry.type === "local" || entry.type === "remote") {
                  onParticipantDoubleClick(entry);
                }
              }}
              className={`flex min-w-0 flex-1 items-center gap-1 transition-opacity ${entry.minimized ? "opacity-80" : "opacity-100"}`}
              aria-label={`Go to ${entry.label}`}
              title={
                entry.pulsing
                  ? `Go to ${entry.label} — just tagged by the other person`
                  : `Go to ${entry.label}`
              }
            >
              <DockIcon type={entry.type} />
              {/* Limit visible titles to 20 characters; the full text
                  is available via the button's title tooltip. */}
              <span className="text-[11px] font-medium text-zinc-300 truncate">
                {Array.from(entry.label).length > 20 ? `${Array.from(entry.label).slice(0, 20).join('')}…` : entry.label}
              </span>
            </button>

            <button
              className="dock-actions-toggle"
              aria-label={`Actions for ${entry.label}`}
              aria-expanded={actionsId === entry.id}
              onClick={() => setActionsId(value => value === entry.id ? null : entry.id)}
            >⋯</button>
            <button
              onClick={() => ping(entry.id)}
              className={`relative shrink-0 transition-colors ${
                pinged.includes(entry.id)
                  ? "text-brand-300"
                  : "text-zinc-500 hover:text-brand-400"
              }`}
              title={`Ping — make ${entry.label} flash on their screen`}
              aria-label={`Ping ${entry.label}`}
            >
              {/* Sender-side confirmation: concentric rings radiate out from
                  the button, echoing the pulse landing on the other screen. */}
              {pinged.includes(entry.id) && (
                <>
                  <span className="ping-radiate" />
                  <span className="ping-radiate" style={{ animationDelay: "0.35s" }} />
                  <span className="ping-radiate" style={{ animationDelay: "0.7s" }} />
                </>
              )}
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" d="M4.9 19.1a10 10 0 010-14.2M19.1 4.9a10 10 0 010 14.2" />
                <path strokeLinecap="round" d="M8.4 15.6a5 5 0 010-7.2M15.6 8.4a5 5 0 010 7.2" />
                <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
              </svg>
            </button>

            <button
              onClick={() => startEditing(entry)}
              className="text-zinc-500 hover:text-brand-400 transition-colors shrink-0"
              title="Rename"
              aria-label={`Rename ${entry.label}`}
            >
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15.232 5.232l3.536 3.536M9 11l6.586-6.586a2 2 0 112.828 2.828L11.828 13.828a4 4 0 01-1.414.95l-3.31 1.103 1.104-3.31A4 4 0 019 11z"
                />
              </svg>
            </button>

            {/* Participants are permanent anchors — you can always get back to
                a face, so their chips carry no delete button. */}
            {entry.type !== "local" && entry.type !== "remote" && (
              <button
                onClick={() => onRemove(entry.id)}
                className="text-zinc-400 hover:text-red-400 transition-colors shrink-0"
                title="Undock (remove from this bar)"
                aria-label={`Remove ${entry.label} from dock`}
              >
                <svg
                  className="w-3.5 h-3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.5}
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            )}
          </div>
        ),
      )}
    </div>
  );
}
