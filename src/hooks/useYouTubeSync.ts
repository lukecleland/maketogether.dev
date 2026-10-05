import { DRAWING_VIEWPORT } from '../utils/drawingCoordinates';
import type { AudioTheme } from '../utils/audioTheme';
import type { BoardChange } from "../utils/whiteboardPanel";
import type { DawTrack } from "../utils/daw";
import { useCallback, useEffect, useEffectEvent } from 'react';
import type { RoomDataConnection } from './usePeer';
import type { CodeContent, NoteContent, PanelState } from '../types/panels';
import type { WhiteboardShape, Nib } from '../components/Whiteboard';
import type { PersistedConnector } from '../utils/roomPersistence';
import type { RoomSnapshot } from '../utils/roomPersistence';

/**
 * useYouTubeSync — binds a message handler to a PeerJS DataConnection and
 * exposes a `sendSync` function for broadcasting structured messages to the peer.
 *
 * ## Message routing
 * Two instances of this hook share the same DataConnection (one in Session.tsx,
 * one in YoutubeWidget). PeerJS fires `conn.on("data")` once per connection
 * object, so every message reaches every registered handler. Each instance
 * simply ignores message types it doesn't own.
 *
 * ## Handler stability
 * `onRemoteSync` is stored in a ref so the data event listener never needs to
 * be re-registered when the callback identity changes between renders.
 */

/**
 * All message variants that travel over the WebRTC data channel.
 *
 * - `load` / `play` / `pause` / `seek` — YouTube playback sync (handled by YoutubeWidget)
 * - `panel-update` — panel position/size/z in absolute world CSS pixels
 * - `draw` — a single whiteboard stroke segment; coordinates use the declared shared drawingViewport basis
 * - `draw-clear` — clears the whiteboard canvas for both peers
 * - `dock-tag` / `dock-rename` — shared bookmarks. Tagging a panel puts a chip
 *   in the *other* peer's dock too (pulsing, so they notice); renaming updates
 *   it on both sides. Dismissing is deliberately local and sends nothing, so
 *   neither person can remove a bookmark from the other's bar. For the two
 *   fixed video panels the id is swapped on receipt, exactly as `panel-update`
 *   does — your "You" is their "Guest".
 */
export type SyncMessage = (
	| { type: 'room-state-request'; requestId?: string }
	| { type: 'room-state-snapshot'; snapshot: RoomSnapshot; requestId?: string }
	| { type: 'room-state-import'; snapshot: RoomSnapshot }
	| { type: 'load'; id: string; videoId: string }
	| { type: 'play'; id: string; time: number; at?: number }
	| { type: 'pause'; id: string; time: number; at?: number }
	| { type: 'seek'; id: string; time: number; at?: number; playing?: boolean }
	| { type: 'audio-play'; id: string; time: number; at?: number }
	| { type: 'audio-pause'; id: string; time: number; at?: number }
	| { type: 'audio-seek'; id: string; time: number; at?: number; playing?: boolean }
	| { type: 'panel-update'; id: string; state: PanelState }
	| { type: 'panel-announce'; id: string; state: PanelState }
	| {
			type: 'draw';
			x0: number;
			y0: number;
			x1: number;
			y1: number;
			color: string;
			width: number;
			nib?: Nib;
	  }
	| { type: 'draw-clear' }
	| { type: 'draw-shape'; shape: WhiteboardShape }
	| { type: 'connector-add'; connector: PersistedConnector }
	| { type: 'connector-remove'; id: string }
	/** A piece of text placed on the canvas. Coordinates are viewport fractions
	 *  and size is a fraction of min(viewportW, viewportH), like stroke width. */
	| {
			type: 'draw-text';
			id: string;
			x: number;
			y: number;
			text: string;
			color: string;
			size: number;
			font: string;
	  }
	/** Text was re-typed. An empty string deletes it. */
	| { type: 'text-edit'; id: string; text: string }
	| { type: 'text-move'; id: string; x: number; y: number }
	| { type: 'spawn-youtube'; id: string; videoId?: string; state: PanelState }
	| { type: 'spawn-browser'; id: string; url?: string; state: PanelState }
	| { type: 'spawn-whiteboard'; id: string; state: PanelState }
	| { type: 'whiteboard-change'; id: string; change: BoardChange }
	| { type: 'spawn-pdf'; id: string; state: PanelState }
	| { type: 'audio-theme'; id: string; theme: AudioTheme }
	| { type: 'pdf-page'; id: string; page: number }
	| { type: 'spawn-image'; id: string; state: PanelState }
	| { type: 'browser-load'; id: string; url: string }
	| { type: 'browser-scroll'; id: string; url: string; position: number }
	| {
			type: 'spawn-audio';
			id: string;
			state: PanelState;
			fileName?: string;
			mimeType?: string;
			dataB64?: string;
	  }
	| { type: 'remove-panel'; id: string }
	/** A sticky note was spawned, carrying its starting contents. */
	| { type: 'spawn-note'; id: string; state: PanelState; note: NoteContent }
	/** Note contents changed. Sent whole rather than as a diff: a note is small,
	 *  and last-write-wins is the right outcome for two people editing one. */
	| { type: 'note-update'; id: string; note: NoteContent }
	| { type: 'spawn-code'; id: string; state: PanelState; code: CodeContent }
	| { type: 'code-update'; id: string; code: CodeContent }
	| { type: 'spawn-daw'; id: string; state: PanelState }
	| { type: 'daw-track'; id: string; track: DawTrack }
	| { type: 'spawn-recorder'; id: string; state: PanelState }
	| { type: 'recording-select'; id: string; recordingId: string }
	| { type: 'recording-play'; id: string; recordingId: string; time: number; at?: number }
	| { type: 'recording-pause'; id: string; recordingId: string; time: number; at?: number }
	| { type: 'recording-seek'; id: string; recordingId: string; time: number; at?: number; playing?: boolean }
	/** A canvas bookmark in absolute canvas-world pixels. */
	| { type: 'position-tag'; id: string; x: number; y: number; label: string; w?: number; h?: number }
	| { type: 'position-tag-remove'; id: string }
	/** A panel was tagged; add a pulsing chip to the peer's dock. `label` is
	 *  sent only when the tagger has given it a custom name — automatic labels
	 *  (video title, file name, numbering) are derived identically on both sides. */
	| { type: 'dock-tag'; id: string; label?: string }
	/** Renamed a bookmark. An empty `label` clears the custom name. Never adds a
	 *  chip, so a rename can't resurrect one the peer has dismissed. */
	| { type: 'dock-rename'; id: string; label: string }
	/** "Look at this one, now." Pulses the named bookmark on the peer's dock,
	 *  and re-adds it if they had dismissed it — a ping is an explicit nudge,
	 *  so silently doing nothing would be worse than the small intrusion. */
	| { type: 'dock-ping'; id: string }
	| { type: 'view-request'; id: string }
	| { type: 'view-response'; id: string; canvas: { x: number; y: number; scale: number } }
	| { type: 'view-suggestion'; id: string; canvas: { x: number; y: number; scale: number } }
	| { type: 'presentation-invite'; id: string; canvas: { x: number; y: number; scale: number } }
	| { type: 'presentation-accept'; id: string }
	| { type: 'presentation-leave'; id: string }
	| { type: 'presentation-view'; id: string; canvas: { x: number; y: number; scale: number } }
	| { type: 'presentation-stop'; id: string }
	| { type: 'participant-name'; label: string }
	| { type: 'cursor-move'; x: number; y: number; laser: boolean; label?: string }
	| { type: 'cursor-leave' }
	/** Announces a chunked file transfer and the panel it belongs to. */
	| {
			type: 'file-begin';
			transferId: string;
			panelId: string;
			fileName: string;
			mimeType: string;
			size: number;
			chunks: number;
			recordingId?: string;
	  }
	/** One slice of a file, base64, placed by index rather than appended. */
	| { type: 'file-chunk'; transferId: string; index: number; data: string }
	| { type: 'file-abort'; transferId: string }) & { viewSpace?: 'world-center'; drawingViewport?: { width: number; height: number } };

interface UseYouTubeSyncOptions {
	dataConnection: RoomDataConnection | null;
	onRemoteSync: (msg: SyncMessage) => void;
}

interface UseYouTubeSyncResult {
	sendSync: (msg: SyncMessage, targetPeerId?: string) => void;
}

export function useYouTubeSync({ dataConnection, onRemoteSync }: UseYouTubeSyncOptions): UseYouTubeSyncResult {
	const handleRemoteData = useEffectEvent((raw: unknown) => {
		onRemoteSync(raw as SyncMessage);
	});

	useEffect(() => {
		if (!dataConnection) return;
		const listener = (raw: unknown) => handleRemoteData(raw);
		dataConnection.on('data', listener);
		return () => dataConnection.off('data', listener);
	}, [dataConnection]);

	const sendSync = useCallback(
		(msg: SyncMessage, targetPeerId?: string) => {
			if (dataConnection?.open) {
				const outgoing = { ...msg, drawingViewport: DRAWING_VIEWPORT };
				dataConnection.send(targetPeerId ? { ...outgoing, __meshTargetPeerId: targetPeerId } : outgoing);
			}
		},
		[dataConnection]
	);

	return { sendSync };
}
