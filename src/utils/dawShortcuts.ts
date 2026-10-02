export type DawShortcut =
  | "undo"
  | "redo"
  | "new-track"
  | "copy"
  | "cut"
  | "paste"
  | "split"
  | "play"
  | "record"
  | "restart"
  | "delete"
  | "duplicate"
  | "mute"
  | "solo"
  | "previous-track"
  | "next-track"
  | "seek-back"
  | "seek-forward"
  | "nudge-back"
  | "nudge-forward"
  | "zoom-in"
  | "zoom-out"
  | "help"
  | "escape";

interface KeyPress {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  isComposing?: boolean;
}

/** Shared by the DAW's scoped handler and tests; text editing always wins. */
export function dawShortcut(
  event: KeyPress,
  editing: boolean,
): DawShortcut | null {
  if (editing || event.isComposing) return null;
  const key = event.key.toLowerCase();
  if (event.metaKey || event.ctrlKey) {
    if (event.repeat) return null;
    if (key === "z" && !event.altKey) return event.shiftKey ? "redo" : "undo";
    if (event.shiftKey) return null;
    if (event.altKey) return key === "n" ? "new-track" : null;
    return (
      (
        {
          d: "duplicate",
          c: "copy",
          x: "cut",
          v: "paste",
          t: "split",
        } as Record<string, DawShortcut>
      )[key] ?? null
    );
  }
  if (event.altKey) {
    if (key === "arrowleft") return "nudge-back";
    if (key === "arrowright") return "nudge-forward";
    return null;
  }
  const repeatable: Record<string, DawShortcut> = {
    arrowup: "previous-track",
    arrowdown: "next-track",
    arrowleft: "seek-back",
    arrowright: "seek-forward",
    "+": "zoom-in",
    "=": "zoom-in",
    "-": "zoom-out",
  };
  if (repeatable[key]) return repeatable[key];
  if (event.repeat) return null;
  const actions: Record<string, DawShortcut> = {
    " ": "play",
    r: "record",
    enter: "restart",
    delete: "delete",
    backspace: "delete",
    m: "mute",
    s: "solo",
    "?": "help",
    escape: "escape",
  };
  return actions[key] ?? (event.code === "Space" ? "play" : null);
}
