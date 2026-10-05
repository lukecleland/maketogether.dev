import type { AudioTheme } from '../utils/audioTheme';
import type { BrowserScroll } from "../utils/browserUrl";
import type { BoardContent } from "../utils/whiteboardPanel";
import type { DawTrack } from "../utils/daw";
/** Fixed video panel IDs (always present). */
export type PanelId = "local" | "remote";

/** The type of a dynamically-spawned panel. */
export type DynamicPanelType = "youtube" | "audio" | "browser" | "note" | "code" | "recorder" | "image" | "daw" | "whiteboard" | "pdf";

export interface CodeContent {
  text: string;
  language: string;
}

export interface RecordingClip {
  id: string;
  name: string;
  file: File;
}

export interface RecordingMetadata {
  id: string;
  name: string;
}

export interface PanelPlayback {
  recordingId?: string;
  time: number;
  playing: boolean;
  /** Timestamp of the shared playhead, retained across transfer and join delays. */
  at?: number;
  volume?: number;
}

/** Which face a sticky note is currently showing. */
export type NoteKind = "text" | "chord" | "tab";

/**
 * A chord diagram: six strings, five frets, drawn from `baseFret` upward.
 *
 * `dots` is indexed by string, low E first (left to right as a chord box is
 * conventionally drawn). Each value is a fret number relative to `baseFret`,
 * or one of: 0 open, -1 muted, -2 unset. Unset is the default so a fresh
 * diagram is blank — six muted markers would read as a deliberate shape.
 */
export interface ChordShape {
  name: string;
  baseFret: number;
  dots: number[];
}

/**
 * Contents of a sticky note. All three faces are kept regardless of which one
 * is showing, so switching kind never throws away what you typed.
 */
export interface NoteContent {
  kind: NoteKind;
  text: string;
  /** Six strings of tab, high e first — the order they're drawn in. */
  tab: string[];
  /** One or more chord diagrams. A song usually needs several. */
  chords: ChordShape[];
  /** Legacy single diagram from an older build; folded into `chords` on read. */
  chord?: ChordShape;
  colour: string;
  /** Code snippets embedded by pasting code while editing this note. */
  codeBlocks?: CodeContent[];
}

export function emptyChord(): ChordShape {
  return { name: "", baseFret: 1, dots: [-2, -2, -2, -2, -2, -2] };
}

/** Older notes carried a single `chord`; read both shapes. */
export function chordsOf(note: NoteContent): ChordShape[] {
  if (note.chords?.length) return note.chords;
  if (note.chord) return [note.chord];
  return [emptyChord()];
}

export function defaultNoteContent(): NoteContent {
  return {
    kind: "text",
    text: "",
    tab: ["", "", "", "", "", ""],
    chords: [emptyChord()],
    colour: "amber"
  };
}

/**
 * Layout state for a single panel.
 *
 * x/y/width/height are absolute canvas-world CSS pixels. They are sent and
 * persisted unchanged so a different viewport cannot distort widget shape.
 */
export interface PanelState {
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
}

/** A dynamically spawned panel (YouTube player, audio player or sticky note). */
export interface DynamicPanel {
  id: string;
  type: DynamicPanelType;
  state: PanelState;
  dawTracks?: DawTrack[];
  whiteboard?: BoardContent;
  initialVideoId?: string;
  initialFile?: File;
  /** Filename retained when a portable bundle does not contain media bytes. */
  mediaFileName?: string;
  /** Live contents for a note panel — updated in place as either peer edits. */
  note?: NoteContent;
  /** Live contents for a code panel. */
  code?: CodeContent;
  /** Completed screen recordings retained for this session only. */
  recordings?: RecordingClip[];
  /** Clip list retained independently of locally available File objects. */
  recordingMetadata?: RecordingMetadata[];
  playback?: PanelPlayback;
  /** Local restore generation, never broadcast as a control action. */
  playbackRevision?: string;
  initialUrl?: string;
  browserScroll?: BrowserScroll;
  pdfPage?: number;
  audioTheme?: AudioTheme;
}
