import { useVisibleViewport } from '../hooks/useVisibleViewport';
import { DRAWING_VIEWPORT, convertDrawing, migrateDrawingCoordinates } from '../utils/drawingCoordinates';
import { framePanel, transformGesture } from '../utils/canvasViewport';
import { CanvasSystemControls } from '../components/CanvasSystemControls';
import { PanelOverviewContext } from '../components/PanelOverviewContext';
import { layoutOverview } from '../utils/panelOverview';
import { validAudioTheme } from '../utils/audioTheme';
import { PdfWidget } from '../components/PdfWidget';
import { isPdfFile, preparePdf, validPdfPage } from '../utils/pdf';
import { BROWSER_ENABLED } from '../utils/features';
import { normaliseBrowserUrl, validBrowserScroll } from "../utils/browserUrl";
import { WhiteboardWidget } from "../components/WhiteboardWidget";
import { changeBoard } from "../utils/whiteboardPanel";
import { Toast } from '../components/Toast';
import { useMovementSync } from "../hooks/useMovementSync";
import { useScreenShare } from "../hooks/useScreenShare";
import { BrandMark } from "../components/BrandMark";
import { DawWidget } from "../components/DawWidget";
import { mergeDawTrack, normaliseDawTracks } from "../utils/daw";
import { acquireLocalMedia } from "../utils/localMedia";
import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Session — the top-level coordinator for an active maketogether session.
 *
 * ## Responsibilities
 * - Acquires the local camera/mic stream via `getUserMedia`
 * - Owns all panel layout state (`panels`) and the top-z counter (`topZRef`)
 * - Instantiates `usePeer` to manage the WebRTC connection
 * - Instantiates `useYouTubeSync` to route `panel-update`, `draw`, and
 *   `draw-clear` messages (YouTube playback messages are routed by a second
 *   `useYouTubeSync` instance inside YoutubeWidget)
 * - Shares fixed world geometry so screen size never distorts panels or art
 * - Renders the full-screen whiteboard canvas (z=0), the whiteboard toolbar,
 *   and the three floating DraggablePanels (local video, remote video, YouTube)
 * - Owns the dock (`dockedIds`): shared bookmarks that fly the viewport back to
 *   a panel out on the canvas. Tagging and renaming are sent to the peer;
 *   dismissing is local. See the Dock component.
 *
 * ## Panel perspective swap
 * usePeer maps participant IDs to each receiver's perspective. A participant's
 * AV panel keeps the same world position and size whether rendered as "You"
 * locally or as that participant's peer panel on another client.
 *
 * ## z-order management
 * `topZRef` starts at 20 and is incremented each time a panel is clicked
 * (`bringToFront`). The new z value is written into the panel state and
 * immediately synced to the remote peer.
 */

import { VideoPanel } from '../components/VideoPanel';
import { YoutubeWidget } from '../components/YoutubeWidget';
import { AudioPlayer } from '../components/AudioPlayer';
import { StickyNote } from '../components/StickyNote';
import { BrowserWidget } from '../components/BrowserWidget';
import { CodeWidget } from '../components/CodeWidget';
import { ScreenRecorderWidget, type RecordingStatus } from '../components/ScreenRecorderWidget';
import { ImageWidget } from '../components/ImageWidget';
import { DraggablePanel } from '../components/DraggablePanel';
import { Whiteboard, type ShapeKind, type WhiteboardHandle, type WhiteboardShape, type WhiteboardStroke, type WhiteboardText } from '../components/Whiteboard';
import type { Nib, TextFont } from '../utils/brush';
import { WhiteboardToolbar } from '../components/WhiteboardToolbar';
import { Dock, type DockEntry } from '../components/Dock';
import { SummonButton } from '../components/SummonButton';
import { usePeer, type RoomDataConnection } from '../hooks/usePeer';
import { useYouTubeSync, type SyncMessage } from '../hooks/useYouTubeSync';
import type { PanelId, PanelState, DynamicPanel, NoteContent, CodeContent } from '../types/panels';
import { chordsOf, defaultNoteContent } from '../types/panels';
import { TransferReceiver, base64ToChunk, chunkCount, sendFileInChunks } from '../utils/fileTransfer';
import { codeFromText } from '../utils/code';
import { prepareImage } from '../utils/image';
import { parseRoomBundle, serialiseRoomBundle } from '../utils/roomBundle';
import { loadRoomMedia, loadRoomSnapshot, ROOM_STATE_VERSION, saveRoomMedia, saveRoomSnapshot, type PersistedConnector, type RoomSnapshot } from '../utils/roomPersistence';

interface SessionProps {
	roomCode: string;
	isHost: boolean;
}

interface PositionTag {
	id: string;
	x: number;
	y: number;
	label: string;
	/**
	 * Size, in world pixels, when the tag marks an *area* rather than a point.
	 * A point tag can only take you to a spot; one with bounds can frame what
	 * it covers and zoom to fit it — which is the only way to bookmark
	 * handwriting or a drawing, since neither of those is a panel.
	 */
	w?: number;
	h?: number;
}

interface LaserPoint {
	id: string;
	x: number;
	y: number;
	expiresAt: number;
}

interface RemoteCursor {
	x: number;
	y: number;
	updatedAt: number;
	laserPoints: LaserPoint[];
}

const CURSOR_COLOURS = ['#f472b6', '#22d3ee', '#a78bfa', '#34d399', '#fb923c', '#facc15'];

function cursorColour(peerId: string): string {
	let hash = 0;
	for (let index = 0; index < peerId.length; index++) hash = (hash * 31 + peerId.charCodeAt(index)) >>> 0;
	return CURSOR_COLOURS[hash % CURSOR_COLOURS.length];
}

function recordingMetadataFor(panel: DynamicPanel): Array<{ id: string; name: string }> | undefined {
	const metadata = new Map(panel.recordingMetadata?.map(recording => [recording.id, recording]));
	panel.recordings?.forEach(recording => metadata.set(recording.id, { id: recording.id, name: recording.name }));
	return metadata.size ? [...metadata.values()] : undefined;
}

// ── Absolute canvas geometry ─────────────────────────────────────────────
// Panel coordinates and dimensions are world pixels. They must stay absolute:
// scaling width and height by different viewport ratios distorts widgets when
// a mobile client joins or a snapshot is restored on another screen.
function normalisePanel(s: PanelState): PanelState {
	return { ...s };
}

function denormalisePanel(s: PanelState): PanelState {
	return { ...s };
}

// Presentation messages carry the world point at the centre of the viewport,
// rather than screen-space translation. A phone and a desktop can therefore
// follow the same place without requiring identical viewport dimensions.
function presentationView(canvas: { x: number; y: number; scale: number }) {
	return {
		x: (window.innerWidth / 2 - canvas.x) / canvas.scale,
		y: (window.innerHeight / 2 - canvas.y) / canvas.scale,
		scale: canvas.scale
	};
}

function canvasFromPresentation(view: { x: number; y: number; scale: number }) {
	return {
		x: window.innerWidth / 2 - view.x * view.scale,
		y: window.innerHeight / 2 - view.y * view.scale,
		scale: view.scale
	};
}

function panelAnchor(panel: PanelState, toward: PanelState): { x: number; y: number } {
	const x = panel.x + panel.width / 2;
	const y = panel.y + panel.height / 2;
	const dx = toward.x + toward.width / 2 - x;
	const dy = toward.y + toward.height / 2 - y;
	if (dx === 0 && dy === 0) return { x, y };
	const edgeScale = 1 / Math.max(Math.abs(dx) / (panel.width / 2), Math.abs(dy) / (panel.height / 2));
	return { x: x + dx * edgeScale, y: y + dy * edgeScale };
}
// ─────────────────────────────────────────────────────────────────────────

function defaultFixedPanels(): Record<PanelId, PanelState> {
	// Participant feeds default to a wider portrait card. They remain freely
	// resizable, and persisted room geometry still wins when a room is restored.
	const videoW = 300;
	const videoH = 400;
	const topY = 112;
	return {
		local: { x: 460, y: topY, width: videoW, height: videoH, z: 10 },
		remote: { x: 20, y: topY, width: videoW, height: videoH, z: 10 }
	};
}

const REMOTE_PANEL_PREFIX = 'remote-peer:';

function remotePanelId(peerId: string): string {
	return `${REMOTE_PANEL_PREFIX}${peerId}`;
}

function peerIdFromPanelId(id: string): string | null {
	return id.startsWith(REMOTE_PANEL_PREFIX) ? id.slice(REMOTE_PANEL_PREFIX.length) : null;
}

// Shared YouTube URL parser (used for background URL drops)
function parseYouTubeVideoId(input: string): string | null {
	try {
		const url = new URL(input.trim());
		const hostname = url.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
		if (hostname === 'youtu.be') return url.pathname.slice(1).split('/')[0];
		if (hostname !== 'youtube.com') return null;
		if (url.searchParams.has('v')) return url.searchParams.get('v');
		const pathMatch = url.pathname.match(/^\/(?:embed|shorts|live)\/([^/?]+)/);
		if (pathMatch) return pathMatch[1];
	} catch {
		if (/^[a-zA-Z0-9_-]{11}$/.test(input.trim())) return input.trim();
	}
	return null;
}

export function Session({ roomCode, isHost }: SessionProps) {
	useVisibleViewport();
	const [savedRoom] = useState(() => { const saved = loadRoomSnapshot(roomCode); return saved ? migrateDrawingCoordinates(saved) : null; });
	const [localStream, setLocalStream] = useState<MediaStream | null>(null);
	const [microphoneEnabled, setMicrophoneEnabled] = useState(false);
	const [cameraEnabled, setCameraEnabled] = useState(false);
	const [mediaRetryKey, setMediaRetryKey] = useState(0);
	const [mediaError, setMediaError] = useState<string | null>(null);
	const [imageToast, setImageToast] = useState<{ message: string; id: string } | null>(null);
	const [fixedPanels, setFixedPanels] = useState<Record<PanelId, PanelState>>(() => {
		if (!savedRoom) return defaultFixedPanels();
		// Snapshots written before per-peer participant persistence used `remote`
		// as a cross-client fallback, and that value may contain viewport-scaled
		// corruption. Preserve the user's own panel but reset that unsafe fallback.
		return savedRoom.remotePanels
			? savedRoom.fixedPanels
			: { local: savedRoom.fixedPanels.local, remote: defaultFixedPanels().remote };
	});
	const [remotePanelStates, setRemotePanelStates] = useState<Record<string, PanelState>>(() => savedRoom?.remotePanels ?? {});
	const knownRemoteGeometryRef = useRef(new Set(Object.keys(savedRoom?.remotePanels ?? {})));
	const [dynamicPanels, setDynamicPanels] = useState<DynamicPanel[]>(() => savedRoom?.panels.map(panel => ({
		id: panel.id,
		type: panel.type,
		state: panel.state,
		initialVideoId: panel.initialVideoId,
		initialUrl: panel.initialUrl,
		browserScroll: panel.browserScroll,
		pdfPage: panel.pdfPage,
		audioTheme: panel.audioTheme,
		note: panel.note,
		code: panel.code,
		whiteboard: panel.whiteboard,
		dawTracks: panel.dawTracks ? normaliseDawTracks(panel.dawTracks) : undefined,
		playback: panel.playback,
		mediaFileName: panel.type === 'audio' ? panel.audioFileName : panel.type === 'image' ? panel.imageFileName : panel.type === 'pdf' ? panel.pdfFileName : undefined,
		recordingMetadata: panel.recordings,
		recordings: []
	})) ?? []);
	const [positionTags, setPositionTags] = useState<PositionTag[]>(() => savedRoom?.positionTags ?? []);
	const [connectors, setConnectors] = useState<PersistedConnector[]>(() => savedRoom?.connectors ?? []);
	const [connectorStartId, setConnectorStartId] = useState<string | null>(null);
	const [selectedConnectorId, setSelectedConnectorId] = useState<string | null>(null);
	const positionTagsRef = useRef<PositionTag[]>([]);
	positionTagsRef.current = positionTags;
	// Tracks the highest z-index currently in use so we can raise panels on click
	const topZRef = useRef(Math.max(20, ...(savedRoom?.panels.map(panel => panel.state.z) ?? []), ...(savedRoom ? Object.values(savedRoom.fixedPanels).map(panel => panel.z) : []), ...(savedRoom?.remotePanels ? Object.values(savedRoom.remotePanels).map(panel => panel.z) : [])));
	// Background drag-over indicator
	const [bgDragOver, setBgDragOver] = useState(false);
	// The "nobody here yet" nudge. Dismissing it is final for the session —
	// being told twice how to invite someone is worse than not being told.
	const [recorderStatuses, setRecorderStatuses] = useState<Record<string, RecordingStatus>>({});
	const [widgetMenuOpen, setWidgetMenuOpen] = useState(false);
	const [mobileToolsTarget, setMobileToolsTarget] = useState<HTMLDivElement | null>(null);
	const widgetMenuRef = useRef<HTMLDivElement>(null);
	const imagePdfInputRef = useRef<HTMLInputElement>(null);
	const roomBundleInputRef = useRef<HTMLInputElement>(null);
	const [bundleNotice, setBundleNotice] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);

	// Ref for the outer container div — used to attach native touch listeners
	const containerRef = useRef<HTMLDivElement>(null);
	// Two-touch gesture state for pinch-to-zoom + two-finger pan
	const gestureRef = useRef<{
		lastDist: number;
		lastMid: { x: number; y: number };
	} | null>(null);

	// ── Infinite canvas transform ────────────────────────────────────────────
	const [canvas, setCanvas] = useState(() => savedRoom?.canvas ?? { x: 0, y: 0, scale: 1 });
	const canvasStateRef = useRef({ x: 0, y: 0, scale: 1 });
	canvasStateRef.current = canvas;
	const [overviewOpen, setOverviewOpen] = useState(false);
	const overviewOpenRef = useRef(false);
	overviewOpenRef.current = overviewOpen;
	const [overviewSize, setOverviewSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
	useEffect(() => {
		const resized = () => setOverviewSize({ width: window.innerWidth, height: window.innerHeight });
		window.addEventListener('resize', resized);
		return () => window.removeEventListener('resize', resized);
	}, []);
	useEffect(() => {
		if (!overviewOpen) return;
		const previous = document.activeElement as HTMLElement | null;
		const selectors = '[data-overview-select], [data-overview-close]';
		document.querySelector<HTMLElement>(selectors)?.focus();
		const keydown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); setOverviewOpen(false); }
			else if (event.key === 'Tab') {
				const buttons = Array.from(document.querySelectorAll<HTMLElement>(selectors));
				const index = buttons.indexOf(document.activeElement as HTMLElement);
				event.preventDefault(); event.stopImmediatePropagation();
				buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
			}
		};
		document.addEventListener('keydown', keydown, true);
		return () => { document.removeEventListener('keydown', keydown, true); previous?.focus(); };
	}, [overviewOpen]);
	const [isPanMode, setIsPanMode] = useState(false);
	const [isGrabbing, setIsGrabbing] = useState(false);
	const isPanningRef = useRef(false);
	const panStartRef = useRef({ mx: 0, my: 0, cx: 0, cy: 0 });
	const longPressRef = useRef<{
		timer: ReturnType<typeof setTimeout>;
		x: number;
		y: number;
	} | null>(null);

	// ── Dock ─────────────────────────────────────────────────────────────────
	// Panel ids bookmarked in the dock, in the order they were added. Tagging
	// and renaming are shared with the peer (see `dock-tag` / `dock-rename`);
	// dismissing is local, so neither person can clear the other's bar.
	const [dockedIds, setDockedIds] = useState<string[]>(() => savedRoom?.dockedIds ?? []);
	const [minimizedIds, setMinimizedIds] = useState<string[]>([]);
	// ── File transfer ────────────────────────────────────────────────────────
	// Files stream in chunks rather than arriving whole, so a panel can appear
	// immediately and show how far along its contents are.
	const receiverRef = useRef(new TransferReceiver());
	// The live connection, so a transfer can watch the channel's send buffer
	const dataConnectionRef = useRef<RoomDataConnection | null>(null);
	const [transferProgress, setTransferProgress] = useState<Record<string, number>>({});
	// transferId -> panelId, so an in-flight transfer can be attributed
	const transferPanelRef = useRef<Record<string, string>>({});
	const pendingPanelForTransfer = (transferId: string) => transferPanelRef.current[transferId];

	// Bookmarks the peer tagged that we haven't acknowledged yet — these pulse.
	const [pulsingIds, setPulsingIds] = useState<string[]>([]);

	useEffect(() => {
		if (!widgetMenuOpen) return;
		const closeIfOutside = (event: MouseEvent | TouchEvent) => {
			if (!widgetMenuRef.current?.contains(event.target as Node)) setWidgetMenuOpen(false);
		};
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === 'Escape') setWidgetMenuOpen(false);
		};
		document.addEventListener('mousedown', closeIfOutside);
		document.addEventListener('touchstart', closeIfOutside);
		window.addEventListener('keydown', closeOnEscape);
		return () => {
			document.removeEventListener('mousedown', closeIfOutside);
			document.removeEventListener('touchstart', closeIfOutside);
			window.removeEventListener('keydown', closeOnEscape);
		};
	}, [widgetMenuOpen]);
	// Pulse timers, so they can be cleared on acknowledge / unmount
	const pulseTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
	// Self-describing label per panel id, used for its dock chip: the YouTube
	// video's title or the audio file's name. Panels report these upward once
	// their content is known, so two YouTube chips aren't indistinguishable.
	const [panelLabels, setPanelLabels] = useState<Record<string, string>>(() => savedRoom?.panelLabels ?? {});
	// User-set chip names. Take precedence over the derived label above, and
	// survive the underlying content changing — if you named it, you meant it.
	const [customLabels, setCustomLabels] = useState<Record<string, string>>(() => savedRoom?.customLabels ?? {});
	// In-flight "fly to panel" animation, so a second jump cancels the first
	const jumpAnimRef = useRef<number | null>(null);
	const pendingViewRequestRef = useRef<string | null>(null);
	const sendSyncRef = useRef<(message: SyncMessage) => void>(() => {});
	const [viewSuggestion, setViewSuggestion] = useState<{ from: string; canvas: { x: number; y: number; scale: number } } | null>(null);
	const [presentationInvite, setPresentationInvite] = useState<{ id: string; presenterPeerId: string; canvas: { x: number; y: number; scale: number } } | null>(null);
	const [presentingId, setPresentingId] = useState<string | null>(null);
	const [following, setFollowing] = useState<{ id: string; presenterPeerId: string } | null>(null);
	const [presentationFollowers, setPresentationFollowers] = useState<string[]>([]);
	const presentationSendRef = useRef<{ lastAt: number; timer: ReturnType<typeof setTimeout> | null }>({ lastAt: 0, timer: null });
	const [laserEnabled, setLaserEnabled] = useState(false);
	const [remoteCursors, setRemoteCursors] = useState<Record<string, RemoteCursor>>({});
	const [localLaserPoints, setLocalLaserPoints] = useState<LaserPoint[]>([]);

	// Whiteboard
	const whiteboardRef = useRef<WhiteboardHandle>(null);
	const [whiteboardRevision, setWhiteboardRevision] = useState(0);
	const whiteboardSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const markWhiteboardDirty = useCallback(() => {
		if (whiteboardSaveTimerRef.current) clearTimeout(whiteboardSaveTimerRef.current);
		whiteboardSaveTimerRef.current = setTimeout(() => setWhiteboardRevision(value => value + 1), 400);
	}, []);
	const [wbTool, setWbTool] = useState<'pointer' | 'pen' | 'eraser' | 'text' | 'region' | 'shape' | 'connector'>('pointer');
	const [wbShapeKind, setWbShapeKind] = useState<ShapeKind>('rectangle');
	const [wbColor, setWbColor] = useState('#ffffff');
	const [wbWidth, setWbWidth] = useState(3);
	const [wbNib, setWbNib] = useState<Nib>('ballpoint');
	const [wbFont, setWbFont] = useState<TextFont>('sans');
	const [wbTextSize, setWbTextSize] = useState(30);
	// The highlighter keeps its own colour. Sharing the pen's would mean
	// highlighting in white, which does nothing on a dark canvas.
	const [wbHighlightColor, setWbHighlightColor] = useState('#facc15');
	const activeColor = wbNib === 'highlighter' ? wbHighlightColor : wbColor;
	const setActiveColor = (c: string) => (wbNib === 'highlighter' ? setWbHighlightColor(c) : setWbColor(c));
	const latestSnapshotRef = useRef<RoomSnapshot | null>(savedRoom);
	const sendRoomStateRef = useRef<(targetPeerId: string, requestId: string) => void>(() => {});
	const persistedMediaRef = useRef<WeakSet<File>>(new WeakSet());
	const mediaHydratedRef = useRef(!savedRoom);
	const mediaHydrationPromiseRef = useRef<Promise<void>>(Promise.resolve());
	const pendingRoomRequestRef = useRef(new Map<string, string>());
	const roomRequestIdRef = useRef<string | null>(null);
	const roomSnapshotReceivedRef = useRef(false);
	const ignoreLocalHydrationRef = useRef(false);

	useEffect(() => {
		if (savedRoom?.drawings.length) {
			requestAnimationFrame(() => whiteboardRef.current?.replaceItems(savedRoom.drawings));
		}
		if (!savedRoom) return;
		let cancelled = false;
		const hydration = Promise.all(savedRoom.panels.map(async persisted => {
			if (persisted.type === 'audio' && persisted.audioFileName) {
				const file = await loadRoomMedia(roomCode, persisted.id);
				if (!cancelled && !ignoreLocalHydrationRef.current && file) setDynamicPanels(prev => prev.map(panel => panel.id === persisted.id ? { ...panel, initialFile: file } : panel));
			}
			if ((persisted.type === 'image' && persisted.imageFileName) || (persisted.type === 'pdf' && persisted.pdfFileName)) {
				const file = await loadRoomMedia(roomCode, persisted.id);
				if (!cancelled && !ignoreLocalHydrationRef.current && file) setDynamicPanels(prev => prev.map(panel => panel.id === persisted.id ? { ...panel, initialFile: file } : panel));
			}
			if ((persisted.type === 'recorder' || persisted.type === 'daw') && persisted.recordings?.length) {
				const recordings = (await Promise.all(persisted.recordings.map(async recording => {
					const file = await loadRoomMedia(roomCode, persisted.id, recording.id);
					return file ? { id: recording.id, name: recording.name, file } : null;
				}))).filter(recording => recording !== null);
				if (!cancelled && !ignoreLocalHydrationRef.current) setDynamicPanels(prev => prev.map(panel => panel.id === persisted.id ? { ...panel, recordings } : panel));
			}
		})).then(() => undefined).catch(() => undefined).finally(() => {
			mediaHydratedRef.current = true;
			for (const [peerId, requestId] of pendingRoomRequestRef.current)
				setTimeout(() => sendRoomStateRef.current(peerId, requestId), 0);
			pendingRoomRequestRef.current.clear();
		});
		mediaHydrationPromiseRef.current = hydration;
		void hydration;
		return () => { cancelled = true; };
	}, [roomCode, savedRoom, savedRoom?.panels]);

	useEffect(() => {
		const snapshot: RoomSnapshot = {
			version: ROOM_STATE_VERSION,
			drawingViewport: DRAWING_VIEWPORT,
			savedAt: Date.now(),
			viewport: { width: window.innerWidth, height: window.innerHeight },
			fixedPanels,
			remotePanels: remotePanelStates,
			panels: dynamicPanels.map(panel => ({
				id: panel.id,
				type: panel.type,
				state: panel.state,
				initialVideoId: panel.initialVideoId,
				initialUrl: panel.initialUrl,
				browserScroll: panel.browserScroll,
				pdfPage: panel.pdfPage,
				audioTheme: panel.audioTheme,
				note: panel.note,
				code: panel.code,
				whiteboard: panel.whiteboard,
				dawTracks: panel.dawTracks ? normaliseDawTracks(panel.dawTracks) : undefined,
				audioFileName: panel.type === 'audio' ? panel.initialFile?.name ?? panel.mediaFileName ?? savedRoom?.panels.find(saved => saved.id === panel.id)?.audioFileName : undefined,
				imageFileName: panel.type === 'image' ? panel.initialFile?.name ?? panel.mediaFileName ?? savedRoom?.panels.find(saved => saved.id === panel.id)?.imageFileName : undefined,
				pdfFileName: panel.type === 'pdf' ? panel.initialFile?.name ?? panel.mediaFileName ?? savedRoom?.panels.find(saved => saved.id === panel.id)?.pdfFileName : undefined,
				recordings: recordingMetadataFor(panel) ?? savedRoom?.panels.find(saved => saved.id === panel.id)?.recordings,
				playback: panel.playback
			})),
			drawings: whiteboardRef.current?.getItems() ?? savedRoom?.drawings ?? [],
			positionTags,
			connectors,
			dockedIds,
			panelLabels,
			customLabels,
			canvas
		};
		latestSnapshotRef.current = snapshot;
		const saveTimer = setTimeout(() => saveRoomSnapshot(roomCode, snapshot), 250);
		dynamicPanels.forEach(panel => {
			if (panel.initialFile && !persistedMediaRef.current.has(panel.initialFile)) {
				persistedMediaRef.current.add(panel.initialFile);
				void saveRoomMedia(roomCode, panel.id, panel.initialFile).catch(() => {});
			}
			panel.recordings?.forEach(recording => {
				if (persistedMediaRef.current.has(recording.file)) return;
				persistedMediaRef.current.add(recording.file);
				void saveRoomMedia(roomCode, panel.id, recording.file, recording.id).catch(() => {});
			});
		});
		return () => clearTimeout(saveTimer);
	}, [canvas, connectors, customLabels, dockedIds, dynamicPanels, fixedPanels, panelLabels, positionTags, remotePanelStates, roomCode, savedRoom?.drawings, savedRoom?.panels, whiteboardRevision]);

	const { remoteStreams, dataConnection, participantCount, connectionRevision, status, error, mediaStatus, retryMedia, replaceVideoTrack } = usePeer({
		roomCode,
		isHost,
		localStream
	});
	const screenShare = useScreenShare(localStream, replaceVideoTrack);
	dataConnectionRef.current = dataConnection;

	useEffect(() => {
		setRemotePanelStates(prev => {
			// Retain disconnected peers so a transient reconnect with the same id
			// cannot discard its persisted size before the stream returns.
			const next: Record<string, PanelState> = { ...prev };
			remoteStreams.forEach(({ peerId }, index) => {
				next[peerId] =
					prev[peerId] ?? {
						...fixedPanels.remote,
						x: fixedPanels.remote.x + index * 28,
						y: fixedPanels.remote.y + index * 28,
						z: fixedPanels.remote.z + index
					};
			});
			return next;
		});
	}, [remoteStreams, fixedPanels.remote]);

	// The video panels are docked from the start, so however far someone wanders
	// the canvas there is always a chip back to the faces. Purely local — each
	// side seeds its own chips, so nothing travels and nothing pulses.
	useEffect(() => {
		// Guarded on tracks like the panel itself: someone who joined without
		// media has no "You" panel, so a chip to it would jump to empty canvas.
		if (localStream && localStream.getTracks().length > 0) {
			setDockedIds(prev => (prev.includes('local') ? prev : [...prev, 'local']));
		}
	}, [localStream]);
	// One chip per guest, seeded once when that peer first appears — the seen
	// set means another peer joining later can't resurrect a chip that was
	// deliberately dismissed, and a peer who leaves takes their chip with them
	// (dockEntriesFor drops ids with no matching stream).
	const seededPeerChipsRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		const newcomers = remoteStreams
			.map(remote => remote.peerId)
			.filter(peerId => !seededPeerChipsRef.current.has(peerId));
		if (newcomers.length === 0) return;
		newcomers.forEach(peerId => seededPeerChipsRef.current.add(peerId));
		setDockedIds(prev => [...prev, ...newcomers.map(remotePanelId).filter(id => !prev.includes(id))]);
	}, [remoteStreams]);

	// Stop a chip pulsing — it's been seen
	const acknowledgePulse = useCallback((id: string) => {
		const timer = pulseTimersRef.current[id];
		if (timer) {
			clearTimeout(timer);
			delete pulseTimersRef.current[id];
		}
		setPulsingIds(prev => (prev.includes(id) ? prev.filter(p => p !== id) : prev));
	}, []);

	// Start a chip pulsing, and stop it on its own after a while so a bookmark
	// nobody clicks doesn't pulse for the rest of the session.
	const startPulse = useCallback(
		(id: string) => {
			setPulsingIds(prev => (prev.includes(id) ? prev : [...prev, id]));
			if (pulseTimersRef.current[id]) clearTimeout(pulseTimersRef.current[id]);
			pulseTimersRef.current[id] = setTimeout(() => acknowledgePulse(id), 10000);
		},
		[acknowledgePulse]
	);

	// Any z arriving from the peer has to push our own counter up. Without this
	// the counters drift apart: they raise a panel to 21, we still think the top
	// is 20, and the next panel we spawn is handed 21 as well — a tie that leaves
	// it level with or behind theirs, and if it lands over the top of one it
	// can't be clicked at all.
	const noteRemoteZ = useCallback((z: number) => {
		if (Number.isFinite(z) && z > topZRef.current) topZRef.current = z;
	}, []);

	// Drop any dock chip / cached label belonging to a panel that no longer exists
	const forgetPanel = useCallback((id: string) => {
		setDockedIds(prev => (prev.includes(id) ? prev.filter(d => d !== id) : prev));
		setPanelLabels(prev => {
			if (!(id in prev)) return prev;
			const next = { ...prev };
			delete next[id];
			return next;
		});
		setCustomLabels(prev => {
			if (!(id in prev)) return prev;
			const next = { ...prev };
			delete next[id];
			return next;
		});
		acknowledgePulse(id);
	}, [acknowledgePulse]);

	const applyRoomSnapshot = useCallback((incoming: RoomSnapshot) => {
		const snapshot = migrateDrawingCoordinates(incoming);
		ignoreLocalHydrationRef.current = true;
		// usePeer maps AV geometry to this client's participant identities. The
		// shared layout must replace stale device-local positions when joining.
		setFixedPanels(snapshot.fixedPanels);
		setRemotePanelStates(snapshot.remotePanels ?? {});
		knownRemoteGeometryRef.current = new Set(Object.keys(snapshot.remotePanels ?? {}));
		topZRef.current = Math.max(topZRef.current,
			...Object.values(snapshot.fixedPanels).map(panel => panel.z),
			...Object.values(snapshot.remotePanels ?? {}).map(panel => panel.z),
			...snapshot.panels.map(panel => panel.state.z));
		const playbackRevision = crypto.randomUUID();
		setDynamicPanels(previous => snapshot.panels.map(panel => ({
			id: panel.id,
			type: panel.type,
			state: { ...panel.state },
			initialVideoId: panel.initialVideoId,
			initialUrl: panel.initialUrl,
			browserScroll: panel.browserScroll,
			pdfPage: panel.pdfPage,
			audioTheme: panel.audioTheme,
			note: panel.note,
			code: panel.code,
			whiteboard: panel.whiteboard,
			dawTracks: panel.dawTracks ? normaliseDawTracks(panel.dawTracks) : undefined,
			playback: panel.playback,
			playbackRevision,
			initialFile: previous.find(item => item.id === panel.id && item.initialFile?.name === (panel.audioFileName ?? panel.imageFileName ?? panel.pdfFileName))?.initialFile,
			mediaFileName: panel.type === 'audio' ? panel.audioFileName : panel.type === 'image' ? panel.imageFileName : panel.type === 'pdf' ? panel.pdfFileName : undefined,
			recordingMetadata: panel.recordings,
			recordings: previous.find(item => item.id === panel.id)?.recordings ?? []
		})));
		setPositionTags(snapshot.positionTags.map(tag => ({ ...tag })));
		setConnectors(snapshot.connectors?.map(connector => ({ ...connector })) ?? []);
		setDockedIds(previous => [...new Set([...snapshot.dockedIds, ...previous.filter(id => id === 'local')])]);
		setPanelLabels(snapshot.panelLabels);
		// Joining state must not erase a name this participant already chose.
		setCustomLabels(previous => ({ ...snapshot.customLabels, ...(previous.local !== undefined ? { local: previous.local } : {}) }));
		setCanvas({ ...snapshot.canvas,
			x: window.innerWidth / 2 - (snapshot.viewport.width / 2 - snapshot.canvas.x),
			y: window.innerHeight / 2 - (snapshot.viewport.height / 2 - snapshot.canvas.y),
		});
		whiteboardRef.current?.replaceItems(snapshot.drawings);
		// The normal persistence effect writes the merged local perspective. Do
		// not store the host snapshot verbatim or it will replace this client's
		// participant geometry on the next refresh.
	}, []);

	const applyPortableSnapshot = useCallback((incoming: RoomSnapshot) => {
		const snapshot = migrateDrawingCoordinates(incoming);
		const playbackRevision = crypto.randomUUID();
		const panels: DynamicPanel[] = snapshot.panels.map(panel => ({
			id: panel.id,
			type: panel.type,
			state: { ...panel.state },
			initialVideoId: panel.initialVideoId,
			initialUrl: panel.initialUrl,
			browserScroll: panel.browserScroll,
			pdfPage: panel.pdfPage,
			audioTheme: panel.audioTheme,
			note: panel.note,
			code: panel.code,
			whiteboard: panel.whiteboard,
			dawTracks: panel.dawTracks ? normaliseDawTracks(panel.dawTracks) : undefined,
			playback: panel.playback,
			playbackRevision,
			mediaFileName: panel.type === 'audio' ? panel.audioFileName : panel.type === 'image' ? panel.imageFileName : panel.type === 'pdf' ? panel.pdfFileName : undefined,
			recordingMetadata: panel.recordings,
			recordings: []
		}));
		const sharedIds = new Set([...panels.map(panel => panel.id), ...snapshot.positionTags.map(tag => tag.id)]);
		const onlySharedLabels = (labels: Record<string, string>) => Object.fromEntries(Object.entries(labels).filter(([id]) => sharedIds.has(id)));
		const scale = Math.max(0.25, Math.min(4, snapshot.canvas.scale));
		const sourceWidth = Math.max(1, snapshot.viewport.width);
		const sourceHeight = Math.max(1, snapshot.viewport.height);
		const centreX = (sourceWidth / 2 - snapshot.canvas.x) / scale;
		const centreY = (sourceHeight / 2 - snapshot.canvas.y) / scale;

		setDynamicPanels(panels);
		setPositionTags(snapshot.positionTags.map(tag => ({ ...tag })));
		setConnectors((snapshot.connectors ?? []).filter(connector => sharedIds.has(connector.fromPanelId) && sharedIds.has(connector.toPanelId)).map(connector => ({ ...connector })));
		setDockedIds(snapshot.dockedIds.filter(id => sharedIds.has(id)));
		setPanelLabels(onlySharedLabels(snapshot.panelLabels));
		setCustomLabels(onlySharedLabels(snapshot.customLabels));
		setCanvas({ x: window.innerWidth / 2 - centreX * scale, y: window.innerHeight / 2 - centreY * scale, scale });
		receiverRef.current.clear();
		transferPanelRef.current = {};
		setTransferProgress({});
		setRecorderStatuses({});
		whiteboardRef.current?.replaceItems(snapshot.drawings);
		setWhiteboardRevision(revision => revision + 1);
		topZRef.current = Math.max(20, ...panels.map(panel => panel.state.z));

		// Bundles intentionally omit media bytes. If this browser still has files
		// for the same room and panel ids, quietly reconnect them after restore.
		void Promise.all(snapshot.panels.map(async panel => {
			if ((panel.type === 'audio' && panel.audioFileName) || (panel.type === 'image' && panel.imageFileName) || (panel.type === 'pdf' && panel.pdfFileName)) {
				const file = await loadRoomMedia(roomCode, panel.id).catch(() => null);
				if (file) setDynamicPanels(previous => previous.map(item => item.id === panel.id ? { ...item, initialFile: file } : item));
			}
			if ((panel.type === 'recorder' || panel.type === 'daw') && panel.recordings?.length) {
				const recordings = (await Promise.all(panel.recordings.map(async recording => {
					const file = await loadRoomMedia(roomCode, panel.id, recording.id).catch(() => null);
					return file ? { id: recording.id, name: recording.name, file } : null;
				}))).filter(recording => recording !== null);
				if (recordings.length) setDynamicPanels(previous => previous.map(item => item.id === panel.id ? { ...item, recordings } : item));
			}
		}));
	}, [roomCode]);

	// Panel sync — wired to the same data channel as YouTube sync
	const handleRemoteSync = useCallback((msg: SyncMessage) => {
		const sourcePeerId = (msg as SyncMessage & { __meshSourcePeerId?: string }).__meshSourcePeerId;
		if (msg.type === 'presentation-invite') {
			if (sourcePeerId && msg.id !== presentingId) setPresentationInvite({ id: msg.id, presenterPeerId: sourcePeerId, canvas: canvasFromPresentation(msg.canvas) });
			return;
		}
		if (msg.type === 'presentation-accept') {
			if (msg.id === presentingId && sourcePeerId) setPresentationFollowers(previous => previous.includes(sourcePeerId) ? previous : [...previous, sourcePeerId]);
			return;
		}
		if (msg.type === 'presentation-leave') {
			if (msg.id === presentingId && sourcePeerId) setPresentationFollowers(previous => previous.filter(peerId => peerId !== sourcePeerId));
			return;
		}
		if (msg.type === 'presentation-view') {
			if (following?.id === msg.id && following.presenterPeerId === sourcePeerId) setCanvas(canvasFromPresentation(msg.canvas));
			return;
		}
		if (msg.type === 'presentation-stop') {
			if (following?.id === msg.id && following.presenterPeerId === sourcePeerId) setFollowing(null);
			if (presentationInvite?.id === msg.id && presentationInvite.presenterPeerId === sourcePeerId) setPresentationInvite(null);
			return;
		}
		// A participant's cursor identity belongs to its mesh sender, regardless
		// of panel perspective or whether a dock rename arrived before joining.
		if (sourcePeerId && (msg.type === 'participant-name' || msg.type === 'cursor-move') && typeof msg.label === 'string') {
			const id = remotePanelId(sourcePeerId);
			const label = msg.label;
			setCustomLabels(previous => {
				if ((previous[id] ?? '') === label) return previous;
				const next = { ...previous };
				if (label) next[id] = label;
				else delete next[id];
				return next;
			});
		}
		if (msg.type === 'cursor-move') {
			if (!sourcePeerId) return;
			const now = Date.now();
			setRemoteCursors(previous => {
				const current = previous[sourcePeerId];
				const laserPoints = msg.laser
					? [...(current?.laserPoints.filter(point => point.expiresAt > now) ?? []), { id: crypto.randomUUID(), x: msg.x, y: msg.y, expiresAt: now + 900 }].slice(-32)
					: current?.laserPoints ?? [];
				return { ...previous, [sourcePeerId]: { x: msg.x, y: msg.y, updatedAt: now, laserPoints } };
			});
			return;
		}
		if (msg.type === 'cursor-leave') {
			if (!sourcePeerId) return;
			setRemoteCursors(previous => {
				if (!(sourcePeerId in previous)) return previous;
				const next = { ...previous };
				delete next[sourcePeerId];
				return next;
			});
			return;
		}
		if (msg.type === 'room-state-request') {
			if (dataConnectionRef.current?.isLead && sourcePeerId) sendRoomStateRef.current(sourcePeerId, msg.requestId ?? `legacy:${sourcePeerId}`);
			return;
		}
		if (msg.type === 'room-state-snapshot') {
			if (!roomSnapshotReceivedRef.current && (msg.requestId === undefined || msg.requestId === roomRequestIdRef.current) && sourcePeerId === roomCode.toLowerCase()) {
				roomSnapshotReceivedRef.current = true;
				applyRoomSnapshot(msg.snapshot);
			}
			return;
		}
		if (msg.type === 'room-state-import') {
			applyPortableSnapshot(msg.snapshot);
			setBundleNotice({ kind: 'success', message: 'A participant restored a room bundle.' });
			return;
		}
		if (msg.type === 'view-request') {
			if (msg.id === 'local') {
				const current = canvasStateRef.current;
				sendSyncRef.current({ type: 'view-response', id: 'local', viewSpace: 'world-center', canvas: presentationView(current) });
			}
			return;
		}
		if (msg.type === 'view-response') {
			if (pendingViewRequestRef.current === msg.id) {
				pendingViewRequestRef.current = null;
				setCanvas(msg.viewSpace === 'world-center' ? canvasFromPresentation(msg.canvas) : { ...msg.canvas });
			}
			return;
		}
		if (msg.type === 'view-suggestion') {
			setViewSuggestion({ from: msg.id, canvas: msg.viewSpace === 'world-center' ? canvasFromPresentation(msg.canvas) : msg.canvas });
			return;
		}
		if (msg.type === 'audio-theme') {
			if (validAudioTheme(msg.theme)) setDynamicPanels(previous => previous.map(panel => panel.id === msg.id && panel.type === 'audio' ? { ...panel, audioTheme: msg.theme } : panel));
			return;
		}
		if (msg.type === 'pdf-page') {
			if (validPdfPage(msg.page)) setDynamicPanels(previous => previous.map(panel => panel.id === msg.id && panel.type === 'pdf' ? { ...panel, pdfPage: msg.page } : panel));
			return;
		}
		if (msg.type === 'browser-load') {
			const url = normaliseBrowserUrl(msg.url);
			if (url) {
				setDynamicPanels(previous => previous.map(panel => panel.id === msg.id && panel.type === 'browser' ? { ...panel, initialUrl: url, browserScroll: undefined } : panel));
				setPanelLabels(previous => ({ ...previous, [msg.id]: new URL(url).hostname }));
			}
			return;
		}
		if (msg.type === 'browser-scroll') {
			if (validBrowserScroll(msg)) setDynamicPanels(previous => previous.map(panel => panel.id === msg.id && panel.type === 'browser' && panel.initialUrl === msg.url ? { ...panel, browserScroll: { url: msg.url, position: msg.position } } : panel));
			return;
		}
		if (msg.type === 'whiteboard-change') {
			setDynamicPanels(previous => previous.map(panel => panel.id === msg.id && panel.type === 'whiteboard' ? { ...panel, whiteboard: changeBoard(panel.whiteboard, msg.change) } : panel));
			return;
		}
		if (msg.type === 'connector-add') {
			setConnectors(previous => previous.some(connector => connector.id === msg.connector.id) ? previous : [...previous, msg.connector]);
			return;
		}
		if (msg.type === 'connector-remove') {
			setConnectors(previous => previous.filter(connector => connector.id !== msg.id));
			return;
		}
		// Every message that carries panel geometry carries a z with it
		if ('state' in msg) noteRemoteZ(msg.state.z);
		if (msg.type.startsWith('spawn-') && 'id' in msg) {
			setDockedIds(prev => (prev.includes(msg.id) ? prev : [...prev, msg.id]));
		}

		if (msg.type === 'panel-announce') {
			const remotePeerId = peerIdFromPanelId(msg.id);
			if (remotePeerId && !knownRemoteGeometryRef.current.has(remotePeerId)) {
				knownRemoteGeometryRef.current.add(remotePeerId);
				setRemotePanelStates(prev => ({ ...prev, [remotePeerId]: denormalisePanel(msg.state) }));
			}
		} else if (msg.type === 'panel-update') {
			const remotePeerId = peerIdFromPanelId(msg.id);
			if (remotePeerId) {
				knownRemoteGeometryRef.current.add(remotePeerId);
				setRemotePanelStates(prev => ({
					...prev,
					[remotePeerId]: denormalisePanel(msg.state)
				}));
			} else if (msg.id === 'local' || msg.id === 'remote') {
				// usePeer has already translated a targeted remote-peer id to local.
				// Swapping again corrupts the fallback dimensions used after refresh.
				const targetId: PanelId = msg.id;
				setFixedPanels(prev => ({
					...prev,
					[targetId]: denormalisePanel(msg.state)
				}));
			} else {
				// Dynamic panel — update by id if it exists
				setDynamicPanels(prev => prev.map(p => (p.id === msg.id ? { ...p, state: denormalisePanel(msg.state) } : p)));
			}
		} else if (msg.type === 'spawn-youtube') {
			setDynamicPanels(prev => [
				...prev,
				{
					id: msg.id,
					type: 'youtube' as const,
					state: denormalisePanel(msg.state),
					...(msg.videoId ? { initialVideoId: msg.videoId } : {})
				}
			]);
		} else if (msg.type === 'spawn-browser') {
			if (!BROWSER_ENABLED) return;
			setDynamicPanels(prev => [
				...prev,
				{
					id: msg.id,
					type: 'browser' as const,
					state: denormalisePanel(msg.state),
					...(msg.url ? { initialUrl: msg.url } : {})
				}
			]);
		} else if (msg.type === 'spawn-whiteboard') {
			setDynamicPanels(previous => previous.some(panel => panel.id === msg.id) ? previous : [...previous, { id: msg.id, type: 'whiteboard', state: denormalisePanel(msg.state) }]);
		} else if (msg.type === 'spawn-pdf') {
			setDynamicPanels(prev => prev.some(panel => panel.id === msg.id) ? prev : [...prev, { id: msg.id, type: 'pdf', state: denormalisePanel(msg.state) }]);
		} else if (msg.type === 'spawn-image') {
			setDynamicPanels(prev => [...prev, { id: msg.id, type: 'image', state: denormalisePanel(msg.state) }]);
		} else if (msg.type === 'spawn-audio') {
			// Older builds inlined the whole file here; newer ones stream it
			// separately, so the panel arrives empty and fills in.
			let initialFile: File | undefined;
			if (msg.dataB64 && msg.fileName && msg.mimeType) {
				initialFile = new File([base64ToChunk(msg.dataB64)], msg.fileName, { type: msg.mimeType });
			}
			setDynamicPanels(prev => [
				...prev,
				{
					id: msg.id,
					type: 'audio' as const,
					state: denormalisePanel(msg.state),
					...(initialFile ? { initialFile } : {})
				}
			]);
		} else if (msg.type === 'spawn-note') {
			setDynamicPanels(prev => [
				...prev,
				{ id: msg.id, type: 'note' as const, state: denormalisePanel(msg.state), note: msg.note }
			]);
		} else if (msg.type === 'note-update') {
			// Last write wins — a note is small enough that merging isn't worth it
			setDynamicPanels(prev => prev.map(p => (p.id === msg.id ? { ...p, note: msg.note } : p)));
		} else if (msg.type === 'spawn-code') {
			setDynamicPanels(prev => [...prev, { id: msg.id, type: 'code', state: denormalisePanel(msg.state), code: msg.code }]);
		} else if (msg.type === 'code-update') {
			setDynamicPanels(prev => prev.map(p => (p.id === msg.id ? { ...p, code: msg.code } : p)));
		} else if (msg.type === 'spawn-daw') {
			setDynamicPanels(prev => prev.some(p => p.id === msg.id) ? prev : [...prev, { id: msg.id, type: 'daw', state: denormalisePanel(msg.state), dawTracks: [], recordings: [] }]);
		} else if (msg.type === 'daw-track') {
			setDynamicPanels(prev => prev.map(p => p.id === msg.id && p.type === 'daw' ? { ...p, dawTracks: mergeDawTrack(p.dawTracks, msg.track) } : p));
		} else if (msg.type === 'spawn-recorder') {
			setDynamicPanels(prev => [...prev, { id: msg.id, type: 'recorder', state: denormalisePanel(msg.state), recordings: [] }]);
		} else if (msg.type === 'remove-panel') {
			setDynamicPanels(prev => prev.filter(p => p.id !== msg.id));
			setConnectors(prev => prev.filter(connector => connector.fromPanelId !== msg.id && connector.toPanelId !== msg.id));
			setConnectorStartId(previous => previous === msg.id ? null : previous);
			// The panel is gone, so any local dock chip pointing at it must go too
			forgetPanel(msg.id);
		} else if (msg.type === 'position-tag') {
			const tag: PositionTag = {
				...(msg.w !== undefined && msg.h !== undefined
					? { w: msg.w, h: msg.h }
					: {}),
				id: msg.id,
				x: msg.x,
				y: msg.y,
				label: msg.label
			};
			setPositionTags(prev => (prev.some(item => item.id === tag.id) ? prev : [...prev, tag]));
			setDockedIds(prev => (prev.includes(tag.id) ? prev : [...prev, tag.id]));
			startPulse(tag.id);
		} else if (msg.type === 'position-tag-remove') {
			setPositionTags(prev => prev.filter(tag => tag.id !== msg.id));
			forgetPanel(msg.id);
		} else if (msg.type === 'dock-tag') {
			// The mesh has already resolved participant IDs for this receiver.
			const id = msg.id;
			setDockedIds(prev => (prev.includes(id) ? prev : [...prev, id]));
			// Only custom names travel; automatic labels are derived identically
			// on both sides, and for video panels the derived name is the
			// correct one for whichever side is looking.
			if (msg.label) setCustomLabels(prev => ({ ...prev, [id]: msg.label as string }));
			startPulse(id);
		} else if (msg.type === 'dock-ping') {
			const id = msg.id;
			// A ping is an explicit "look here", so it re-adds a bookmark the
			// receiver had dismissed rather than failing silently on their side.
			setDockedIds(prev => (prev.includes(id) ? prev : [...prev, id]));
			startPulse(id);
		} else if (msg.type === 'dock-rename') {
			const id = msg.id;
			setCustomLabels(prev => {
				if (!msg.label) {
					if (!(id in prev)) return prev;
					const next = { ...prev };
					delete next[id];
					return next;
				}
				return { ...prev, [id]: msg.label };
			});
		} else if (msg.type === 'file-begin') {
			transferPanelRef.current[msg.transferId] = msg.panelId;
			receiverRef.current.begin(msg);
			setTransferProgress(prev => ({ ...prev, [msg.panelId]: 0 }));
		} else if (msg.type === 'file-chunk') {
			const done = receiverRef.current.accept(msg.transferId, msg.index, msg.data);
			if (done) {
				delete transferPanelRef.current[msg.transferId];
				if (!done.meta.recordingId) setPanelLabels(prev => ({ ...prev, [done.meta.panelId]: done.file.name }));
				setDynamicPanels(prev => prev.map(p => {
					if (p.id !== done.meta.panelId) return p;
					if (done.meta.recordingId) {
						if (p.recordings?.some(recording => recording.id === done.meta.recordingId)) return p;
						return { ...p, recordings: [...(p.recordings ?? []), { id: done.meta.recordingId, name: done.file.name, file: done.file }] };
					}
					return { ...p, initialFile: done.file, mediaFileName: done.file.name };
				}));
				setTransferProgress(prev => {
					const next = { ...prev };
					delete next[done.meta.panelId];
					return next;
				});
			} else {
				const panelId = pendingPanelForTransfer(msg.transferId);
				if (panelId) {
					const p = receiverRef.current.progressFor(panelId);
					if (p !== null) setTransferProgress(prev => ({ ...prev, [panelId]: p }));
				}
			}
		} else if (msg.type === 'file-abort') {
			receiverRef.current.abort(msg.transferId);
		} else if (msg.type === 'draw') {
			whiteboardRef.current?.drawStroke(convertDrawing({ x0: msg.x0, y0: msg.y0, x1: msg.x1, y1: msg.y1, color: msg.color, width: msg.width, ...(msg.nib ? { nib: msg.nib } : {}) }, msg.drawingViewport ?? { width: window.innerWidth, height: window.innerHeight }));
			markWhiteboardDirty();
		} else if (msg.type === 'draw-shape') {
			whiteboardRef.current?.drawShape(convertDrawing(msg.shape, msg.drawingViewport ?? { width: window.innerWidth, height: window.innerHeight }));
			markWhiteboardDirty();
		} else if (msg.type === 'draw-text') {
			whiteboardRef.current?.drawText(convertDrawing({ kind: 'text', id: msg.id, x: msg.x, y: msg.y, text: msg.text, color: msg.color, size: msg.size, font: msg.font as TextFont }, msg.drawingViewport ?? { width: window.innerWidth, height: window.innerHeight }));
			markWhiteboardDirty();
		} else if (msg.type === 'text-edit') {
			whiteboardRef.current?.editText(msg.id, msg.text);
			markWhiteboardDirty();
		} else if (msg.type === 'text-move') {
			whiteboardRef.current?.moveText(msg.id, msg.x * (msg.drawingViewport?.width ?? window.innerWidth) / DRAWING_VIEWPORT.width, msg.y * (msg.drawingViewport?.height ?? window.innerHeight) / DRAWING_VIEWPORT.height);
			markWhiteboardDirty();
		} else if (msg.type === 'draw-clear') {
			whiteboardRef.current?.clearCanvas();
			setConnectors([]);
			markWhiteboardDirty();
		}
	}, [applyPortableSnapshot, applyRoomSnapshot, following, forgetPanel, roomCode, markWhiteboardDirty, noteRemoteZ, presentationInvite, presentingId, startPulse]);

	// We use useYouTubeSync here to route panel-update and whiteboard messages.
	// YoutubeWidget mounts its own useYouTubeSync instance for YT playback messages.
	const { sendSync } = useYouTubeSync({
		dataConnection,
		onRemoteSync: handleRemoteSync
	});
	sendSyncRef.current = sendSync;

	// Older saved rooms used one anonymous "remote" bookmark. Bind it to the
	// actual participant so its dock, video and cursor share the same name.
	const firstRemotePeerId = remoteStreams[0]?.peerId;
	const hasLegacyRemoteDock = dockedIds.includes('remote');
	const legacyRemoteLabel = customLabels.remote;
	useEffect(() => {
		if (!firstRemotePeerId || (!hasLegacyRemoteDock && legacyRemoteLabel === undefined)) return;
		const id = remotePanelId(firstRemotePeerId);
		setDockedIds(previous => [...new Set(previous.map(entry => entry === 'remote' ? id : entry))]);
		setCustomLabels(previous => {
			if (previous.remote === undefined) return previous;
			const next = { ...previous };
			// Keep the identified participant's name; the old placeholder has no identity.
			delete next.remote;
			return next;
		});
	}, [firstRemotePeerId, hasLegacyRemoteDock, legacyRemoteLabel]);

	const localDisplayName = customLabels.local ?? '';
	useEffect(() => {
		if (status !== 'connected') return;
		// Announce changes even when the pointer is stationary, and reannounce
		// when peers connect so a name chosen beforehand is not lost.
		sendSync({ type: 'participant-name', label: localDisplayName });
	}, [localDisplayName, participantCount, sendSync, status]);


	const startPresenting = useCallback(() => {
		if (participantCount < 2) return;
		const id = crypto.randomUUID();
		if (following) sendSync({ type: 'presentation-leave', id: following.id });
		setFollowing(null);
		setPresentationInvite(null);
		setPresentationFollowers([]);
		setPresentingId(id);
		const current = canvasStateRef.current;
		sendSync({ type: 'presentation-invite', id, canvas: presentationView(current) });
	}, [following, participantCount, sendSync]);

	const stopPresenting = useCallback(() => {
		if (!presentingId) return;
		sendSync({ type: 'presentation-stop', id: presentingId });
		setPresentingId(null);
		setPresentationFollowers([]);
	}, [presentingId, sendSync]);

	const acceptPresentation = useCallback(() => {
		if (!presentationInvite) return;
		if (presentingId) sendSync({ type: 'presentation-stop', id: presentingId });
		if (following) sendSync({ type: 'presentation-leave', id: following.id });
		setPresentingId(null);
		setPresentationFollowers([]);
		setFollowing({ id: presentationInvite.id, presenterPeerId: presentationInvite.presenterPeerId });
		setCanvas({ ...presentationInvite.canvas });
		sendSync({ type: 'presentation-accept', id: presentationInvite.id });
		setPresentationInvite(null);
	}, [following, presentationInvite, presentingId, sendSync]);

	const stopFollowing = useCallback(() => {
		if (!following) return;
		sendSync({ type: 'presentation-leave', id: following.id });
		setFollowing(null);
	}, [following, sendSync]);

	// Viewport updates are intentionally throttled: panning can produce a state
	// update for every pointer event, while presentation feels smooth at 12fps.
	useEffect(() => {
		if (!presentingId) return;
		const sender = presentationSendRef.current;
		const sendView = () => {
			sender.lastAt = Date.now();
			sender.timer = null;
			sendSync({ type: 'presentation-view', id: presentingId, canvas: presentationView(canvasStateRef.current) });
		};
		const remaining = 80 - (Date.now() - sender.lastAt);
		if (remaining <= 0) sendView();
		else if (!sender.timer) sender.timer = setTimeout(sendView, remaining);
	}, [canvas, presentingId, sendSync]);

	useEffect(() => () => {
		if (presentationSendRef.current.timer) clearTimeout(presentationSendRef.current.timer);
	}, []);

	useEffect(() => {
		if (participantCount > 1) return;
		setFollowing(null);
		setPresentationInvite(null);
		setPresentingId(null);
		setPresentationFollowers([]);
	}, [participantCount]);

	const cursorSync = useMovementSync(({ clientX, clientY }: { clientX: number; clientY: number }) => {
		const now = Date.now();
		const current = canvasStateRef.current;
		const x = (clientX - current.x) / current.scale;
		const y = (clientY - current.y) / current.scale;
		sendSync({ type: 'cursor-move', x, y, laser: laserEnabled, label: localDisplayName });
		if (laserEnabled) {
			setLocalLaserPoints(previous => [...previous.filter(point => point.expiresAt > now), { id: crypto.randomUUID(), x, y, expiresAt: now + 900 }].slice(-32));
		}
	});
	const broadcastCursor = useCallback((clientX: number, clientY: number) => {
		cursorSync.schedule({ clientX, clientY });
	}, [cursorSync]);

	useEffect(() => {
		const timer = setInterval(() => {
			const now = Date.now();
			setLocalLaserPoints(previous => {
				const next = previous.filter(point => point.expiresAt > now);
				return next.length === previous.length ? previous : next;
			});
			setRemoteCursors(previous => {
				let changed = false;
				const next: Record<string, RemoteCursor> = {};
				for (const [peerId, cursor] of Object.entries(previous)) {
					if (now - cursor.updatedAt > 10_000) {
						changed = true;
						continue;
					}
					const laserPoints = cursor.laserPoints.filter(point => point.expiresAt > now);
					if (laserPoints.length !== cursor.laserPoints.length) changed = true;
					next[peerId] = laserPoints === cursor.laserPoints ? cursor : { ...cursor, laserPoints };
				}
				return changed ? next : previous;
			});
		}, 200);
		return () => clearInterval(timer);
	}, []);

	useEffect(() => {
		const toggleLaser = (event: KeyboardEvent) => {
			if (event.repeat || event.key.toLowerCase() !== 'l' || (event.target as HTMLElement)?.closest('input, textarea, [contenteditable="true"]')) return;
			setLaserEnabled(enabled => !enabled);
		};
		window.addEventListener('keydown', toggleLaser);
		return () => window.removeEventListener('keydown', toggleLaser);
	}, []);

	const exportRoomBundle = useCallback(() => {
		const current = latestSnapshotRef.current;
		if (!current) {
			setBundleNotice({ kind: 'error', message: 'The room is still being prepared. Try exporting again in a moment.' });
			return;
		}
		const snapshot: RoomSnapshot = {
			...current,
			savedAt: Date.now(),
			viewport: { width: window.innerWidth, height: window.innerHeight },
			canvas: { ...canvasStateRef.current },
			drawings: whiteboardRef.current?.getItems() ?? current.drawings
		};
		const blob = new Blob([serialiseRoomBundle(snapshot)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url;
		link.download = `maketogether-${roomCode.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.json`;
		document.body.appendChild(link);
		link.click();
		link.remove();
		setTimeout(() => URL.revokeObjectURL(url), 0);
		setBundleNotice({ kind: 'success', message: 'Room bundle exported. Media files remain stored only in this browser.' });
	}, [roomCode]);

	const importRoomBundle = useCallback(async (file: File) => {
		try {
			if (file.size > 20 * 1024 * 1024) throw new Error('Room bundles must be smaller than 20 MB.');
			const snapshot = parseRoomBundle(await file.text());
			applyPortableSnapshot(snapshot);
			sendSync({ type: 'room-state-import', snapshot });
			setBundleNotice({ kind: 'success', message: 'Room restored. Media metadata was imported; media files remain local to their original browser.' });
		} catch (error) {
			setBundleNotice({ kind: 'error', message: error instanceof Error ? error.message : 'The room bundle could not be imported.' });
		}
	}, [applyPortableSnapshot, sendSync]);

	useEffect(() => {
		if (!bundleNotice) return;
		const timer = setTimeout(() => setBundleNotice(null), 7000);
		return () => clearTimeout(timer);
	}, [bundleNotice]);

	const sendPanelUpdate = useCallback(
		(id: string, state: PanelState) => {
			sendSync({ type: 'panel-update', id, state: normalisePanel(state) });
		},
		[sendSync]
	);

	const handleWbStroke = useCallback(
		(stroke: WhiteboardStroke) => {
			sendSync({ type: 'draw', ...stroke });
			markWhiteboardDirty();
		},
		[markWhiteboardDirty, sendSync]
	);

	const handleWbShape = useCallback(
		(shape: WhiteboardShape) => {
			sendSync({ type: 'draw-shape', shape });
			markWhiteboardDirty();
		},
		[markWhiteboardDirty, sendSync]
	);

	const handleWbText = useCallback(
		(item: WhiteboardText) => {
			sendSync({ type: 'draw-text', id: item.id, x: item.x, y: item.y, text: item.text, color: item.color, size: item.size, font: item.font });
			markWhiteboardDirty();
		},
		[markWhiteboardDirty, sendSync]
	);

	const handleWbTextEdit = useCallback(
		(id: string, text: string) => {
			sendSync({ type: 'text-edit', id, text });
			markWhiteboardDirty();
		},
		[markWhiteboardDirty, sendSync]
	);
	const handleWbTextMove = useCallback(
		(id: string, x: number, y: number) => {
			sendSync({ type: 'text-move', id, x, y });
			markWhiteboardDirty();
		},
		[markWhiteboardDirty, sendSync]
	);

	// A dragged-out area becomes a tag with bounds, so it can frame what it
	// covers — the only way to bookmark strokes or text, neither being a panel.
	const handleWbRegion = useCallback(
		(r: { x: number; y: number; w: number; h: number }) => {
			const id = crypto.randomUUID();
			const tag: PositionTag = {
				id,
				x: r.x * DRAWING_VIEWPORT.width,
				y: r.y * DRAWING_VIEWPORT.height,
				w: r.w,
				h: r.h,
				label: `Area ${positionTagsRef.current.length + 1}`
			};
			setPositionTags(prev => [...prev, tag]);
			setDockedIds(prev => (prev.includes(id) ? prev : [...prev, id]));
			// Tags use the same absolute world pixels as shared panels.
			sendSync({
				type: 'position-tag',
				id,
				x: tag.x,
				y: tag.y,
				w: tag.w,
				h: tag.h,
				label: tag.label
			});
		},
		[sendSync]
	);

	// Stream a file to the peer for an already-spawned panel
	const sendFileTo = useCallback(
		(panelId: string, file: File, recordingId?: string, targetPeerId?: string) => {
			const transferId = crypto.randomUUID();
			transferPanelRef.current[transferId] = panelId;
			sendSync({
				type: 'file-begin',
				transferId,
				panelId,
				fileName: file.name,
				mimeType: file.type,
				size: file.size,
				chunks: chunkCount(file.size),
				...(recordingId ? { recordingId } : {})
			}, targetPeerId);
			setTransferProgress(prev => ({ ...prev, [panelId]: 0 }));
			void sendFileInChunks(
				file,
				dataConnectionRef.current,
				({ index, data }) => sendSync({ type: 'file-chunk', transferId, index, data }, targetPeerId),
				fraction => {
					setTransferProgress(prev => ({ ...prev, [panelId]: fraction }));
					if (fraction >= 1) {
						delete transferPanelRef.current[transferId];
						setTransferProgress(prev => {
							const next = { ...prev };
							delete next[panelId];
							return next;
						});
					}
				}
			);
		},
		[sendSync]
	);

	useEffect(() => {
		sendRoomStateRef.current = (targetPeerId, requestId) => {
			if (!dataConnectionRef.current?.isLead) return;
			if (!mediaHydratedRef.current) {
				pendingRoomRequestRef.current.set(targetPeerId, requestId);
				void mediaHydrationPromiseRef.current;
				return;
			}
			const snapshot = latestSnapshotRef.current;
			if (!snapshot) return;
			// Assign the joining participant's AV slot even if its media stream has
			// not arrived yet, so both sides start with the same world geometry.
			const peerIndex = Object.keys(snapshot.remotePanels ?? {}).length;
			const participantState = snapshot.remotePanels?.[targetPeerId] ?? {
				...snapshot.fixedPanels.remote,
				x: snapshot.fixedPanels.remote.x + peerIndex * 28,
				y: snapshot.fixedPanels.remote.y + peerIndex * 28,
				z: snapshot.fixedPanels.remote.z + peerIndex
			};
			knownRemoteGeometryRef.current.add(targetPeerId);
			setRemotePanelStates(previous => ({ ...previous, [targetPeerId]: previous[targetPeerId] ?? participantState }));
			sendSync({ type: 'room-state-snapshot', snapshot: { ...snapshot, remotePanels: { ...snapshot.remotePanels, [targetPeerId]: participantState }, drawings: whiteboardRef.current?.getItems() ?? snapshot.drawings, savedAt: Date.now() }, requestId }, targetPeerId);
			dynamicPanels.forEach(panel => {
				if (panel.initialFile) sendFileTo(panel.id, panel.initialFile, undefined, targetPeerId);
				panel.recordings?.forEach(recording => sendFileTo(panel.id, recording.file, recording.id, targetPeerId));
			});
		};
	}, [dynamicPanels, sendFileTo, sendSync]);

	useEffect(() => {
		if (status !== 'connected' || dataConnectionRef.current?.isLead) return;
		roomSnapshotReceivedRef.current = false;
		const requestId = crypto.randomUUID();
		roomRequestIdRef.current = requestId;
		// A data channel can open before the host's React listener is attached.
		// Retry the initial handshake until the first snapshot arrives.
		const request = () => {
			if (!roomSnapshotReceivedRef.current && !dataConnectionRef.current?.isLead) sendSync({ type: 'room-state-request', requestId });
		};
		request();
		const timer = setInterval(request, 1000);
		return () => clearInterval(timer);
	}, [connectionRevision, sendSync, status]);

	useEffect(() => {
		// Guests must adopt the shared layout before announcing their own panel;
		// otherwise default/persisted self geometry can overwrite the room layout.
		if (status === 'connected' && (dataConnectionRef.current?.isLead || roomSnapshotReceivedRef.current)) sendSync({ type: 'panel-announce', id: 'local', state: normalisePanel(fixedPanels.local) });
	}, [fixedPanels.local, sendSync, status]);

	const handleWbClear = useCallback(() => {
		whiteboardRef.current?.clearCanvas();
		setConnectors([]);
		setConnectorStartId(null);
		sendSync({ type: 'draw-clear' });
		markWhiteboardDirty();
	}, [markWhiteboardDirty, sendSync]);

	const bringToFront = useCallback(
		(id: PanelId) => {
			const nextZ = ++topZRef.current;
			setFixedPanels(prev => {
				const next = { ...prev, [id]: { ...prev[id], z: nextZ } };
				sendPanelUpdate(id, next[id]);
				return next;
			});
		},
		[sendPanelUpdate]
	);

	const makePanelHandlers = (id: PanelId) => ({
		onLocalUpdate: (next: PanelState) => setFixedPanels(prev => ({ ...prev, [id]: next })),
		onSyncUpdate: (next: PanelState) => sendPanelUpdate(id, next),
		onBringToFront: () => bringToFront(id)
	});

	const makeDynamicPanelHandlers = (id: string) => ({
		onLocalUpdate: (next: PanelState) => setDynamicPanels(prev => prev.map(p => (p.id === id ? { ...p, state: next } : p))),
		onSyncUpdate: (next: PanelState) => sendPanelUpdate(id, next),
		onBringToFront: () => {
			const nextZ = ++topZRef.current;
			const panel = dynamicPanels.find(p => p.id === id);
			setDynamicPanels(prev => prev.map(p => (p.id === id ? { ...p, state: { ...p.state, z: nextZ } } : p)));
			// Fixed panels already sync their raise. Spawned ones only did so by
			// accident, via the drag-stop that usually follows a pointer-down —
			// so raising one by clicking a control inside it stayed local.
			// The send sits outside the state updater; StrictMode runs updaters
			// twice, which would send it twice.
			if (panel) sendPanelUpdate(id, { ...panel.state, z: nextZ });
		}
	});

	const removePanel = (id: string) => {
		const attached = connectors.filter(connector => connector.fromPanelId === id || connector.toPanelId === id);
		setConnectors(prev => prev.filter(connector => connector.fromPanelId !== id && connector.toPanelId !== id));
		attached.forEach(connector => sendSync({ type: 'connector-remove', id: connector.id }));
		setConnectorStartId(previous => previous === id ? null : previous);
		setDynamicPanels(prev => prev.filter(p => p.id !== id));
		setRecorderStatuses(prev => {
			if (!(id in prev)) return prev;
			const next = { ...prev };
			delete next[id];
			return next;
		});
		forgetPanel(id);
		sendSync({ type: 'remove-panel', id });
	};

	const selectConnectorPanel = useCallback((id: string) => {
		if (!connectorStartId) {
			setConnectorStartId(id);
			return;
		}
		if (connectorStartId === id) {
			setConnectorStartId(null);
			return;
		}
		const connector: PersistedConnector = {
			id: crypto.randomUUID(),
			fromPanelId: connectorStartId,
			toPanelId: id,
			color: activeColor,
			width: wbWidth
		};
		setConnectors(previous => [...previous, connector]);
		sendSync({ type: 'connector-add', connector });
		setConnectorStartId(null);
	}, [activeColor, connectorStartId, sendSync, wbWidth]);

	const removeConnector = useCallback((id: string) => {
		setConnectors(previous => previous.filter(connector => connector.id !== id));
		setSelectedConnectorId(previous => previous === id ? null : previous);
		sendSync({ type: 'connector-remove', id });
	}, [sendSync]);

	useEffect(() => {
		if (wbTool !== 'connector') setConnectorStartId(null);
	}, [wbTool]);

	// The video panels are permanent anchors — you can always get back to a
	// face. Their chips carry no delete button, and this guard backs that up
	// so no other path (panel bookmark, double-click) can un-dock one either.
	const isParticipantId = (id: string) =>
		id === 'local' || id === 'remote' || peerIdFromPanelId(id) !== null;

	// Tagging is shared; untagging is not. Removing a chip clears it from your
	// own bar only — nobody gets to delete a bookmark out of the other's UI.
	const toggleDock = (id: string) => {
		// The send stays outside the state updater — StrictMode invokes updaters
		// twice, which would tag the peer twice.
		if (dockedIds.includes(id)) {
			if (isParticipantId(id)) return;
			acknowledgePulse(id);
			setDockedIds(prev => prev.filter(d => d !== id));
			return;
		}
		sendSync({ type: 'dock-tag', id, ...(customLabels[id] ? { label: customLabels[id] } : {}) });
		setDockedIds(prev => (prev.includes(id) ? prev : [...prev, id]));
	};

	const removeDockEntry = (id: string) => {
		if (minimizedIds.includes(id)) return;
		if (positionTags.some(tag => tag.id === id)) {
			setPositionTags(prev => prev.filter(tag => tag.id !== id));
			forgetPanel(id);
			sendSync({ type: 'position-tag-remove', id });
			return;
		}
		toggleDock(id);
	};

	const dockElementFor = (id: string) => document.querySelector<HTMLElement>(`[data-dock-entry="${CSS.escape(id)}"]`);
	const panelShellFor = (id: string) => document.querySelector<HTMLElement>(`[data-panel-shell="${CSS.escape(id)}"]`);
	const panelDockOffset = (id: string) => {
		const panel = panelShellFor(id);
		const dock = dockElementFor(id);
		if (!panel || !dock) return null;
		const panelRect = panel.getBoundingClientRect();
		const dockRect = dock.getBoundingClientRect();
		return {
			panel,
			x: (dockRect.left + dockRect.width / 2 - panelRect.left - panelRect.width / 2) / canvasStateRef.current.scale,
			y: (dockRect.top + dockRect.height / 2 - panelRect.top - panelRect.height / 2) / canvasStateRef.current.scale
		};
	};

	const minimizePanel = (id: string) => {
		if (!dockedIds.includes(id)) {
			sendSync({ type: 'dock-tag', id, ...(customLabels[id] ? { label: customLabels[id] } : {}) });
			setDockedIds(previous => previous.includes(id) ? previous : [...previous, id]);
		}
		requestAnimationFrame(() => requestAnimationFrame(() => {
			const target = panelDockOffset(id);
			if (!target) {
				setMinimizedIds(previous => previous.includes(id) ? previous : [...previous, id]);
				return;
			}
			const animation = target.panel.animate([
				{ transform: 'translate(0, 0) scale(1)', opacity: 1 },
				{ transform: `translate(${target.x}px, ${target.y}px) scale(0.05)`, opacity: 0 }
			], { duration: 300, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' });
			void animation.finished.then(() => {
				setMinimizedIds(previous => previous.includes(id) ? previous : [...previous, id]);
				// Keep the collapsed animation frame visible until React has painted
				// the panel's persistent hidden state underneath it. Cancelling the
				// effect immediately causes a one-frame full-size flash.
				requestAnimationFrame(() => requestAnimationFrame(() => animation.cancel()));
			}).catch(() => {});
		}));
	};

	const restorePanel = (id: string) => {
		const target = panelDockOffset(id);
		if (!target) {
			setMinimizedIds(previous => previous.filter(item => item !== id));
			return;
		}
		const animation = target.panel.animate([
			{ transform: `translate(${target.x}px, ${target.y}px) scale(0.05)`, opacity: 0 },
			{ transform: 'translate(0, 0) scale(1)', opacity: 1 }
		], { duration: 340, easing: 'cubic-bezier(0, 0, 0.2, 1)' });
		setMinimizedIds(previous => previous.filter(item => item !== id));
		void animation.finished.catch(() => {});
	};

	// Fly the viewport so the given panel sits in the middle of the screen at a
	// size that's actually usable for its content. The panel itself never moves
	// — the dock is navigation, not relocation; only the viewport changes.
	const jumpToPanel = (id: string, focusRestored = false) => {
		if (minimizedIds.includes(id)) {
			if (!focusRestored) { restorePanel(id); return; }
			setMinimizedIds(previous => previous.filter(item => item !== id));
		}
		// Going there counts as seeing it
		acknowledgePulse(id);
		const positionTag = positionTags.find(tag => tag.id === id);
		const isFixed = id === 'local' || id === 'remote';
		const remotePeerId = peerIdFromPanelId(id);
		const panel = isFixed || remotePeerId ? null : dynamicPanels.find(p => p.id === id);
		// Dock navigation is also an explicit request to surface the target.
		// Raise it before the camera starts moving so overlapping panels cannot
		// obscure it when the zoom animation arrives.
		if (!positionTag) {
			if (isFixed) {
				bringToFront(id);
			} else if (remotePeerId) {
				const state = remotePanelStates[remotePeerId];
				if (state) {
					const next = { ...state, z: ++topZRef.current };
					setRemotePanelStates(previous => ({ ...previous, [remotePeerId]: next }));
					sendPanelUpdate(id, next);
				}
			} else if (panel) {
				const next = { ...panel.state, z: ++topZRef.current };
				setDynamicPanels(previous => previous.map(item => item.id === id ? { ...item, state: next } : item));
				sendPanelUpdate(id, next);
			}
		}
		const target = positionTag
			? {
					x: positionTag.x,
					y: positionTag.y,
					width: positionTag.w ?? 0,
					height: positionTag.h ?? 0,
					z: 0
			  }
			: isFixed
				? fixedPanels[id]
				: remotePeerId
					? remotePanelStates[remotePeerId]
					: panel?.state;
		if (!target) return;

		const type: DockEntry['type'] = positionTag ? 'position' : remotePeerId ? 'remote' : isFixed ? id : (panel?.type ?? 'youtube');
		const vw = window.innerWidth;
		const vh = window.innerHeight;

		// How wide the panel should appear on screen, by content type. A video
		// needs real estate to be watchable; an audio player would look absurd
		// blown up to fill the viewport.
		const IDEAL_ON_SCREEN_WIDTH: Record<DockEntry['type'], number> = {
			youtube: 720,
			local: 480,
			remote: 480,
			audio: 360,
			note: 420,
			browser: 760,
			whiteboard: 800,
			code: 640,
			recorder: 720,
			daw: 900,
			image: 680,
			pdf: 760,
			position: 0
		};

		// Start from the ideal width, then make sure the whole panel still fits
		// on screen with a margin, and stay inside the app's zoom limits.
		const hasBounds = !!positionTag && !!positionTag.w && !!positionTag.h;
		const fitScale =
			positionTag && !hasBounds
				? canvasStateRef.current.scale
				: Math.min((vw * 0.9) / target.width, (vh * 0.85) / target.height);
		const idealScale = positionTag ? canvasStateRef.current.scale : IDEAL_ON_SCREEN_WIDTH[type] / target.width;
		// Position tags are points of interest rather than sizeable panels:
		// centre the point and zoom closer on every visit.
		const toScale = hasBounds
			? // An area tag knows its own size, so frame it rather than guessing
				Math.max(0.25, Math.min(4, fitScale))
			: positionTag
				? // A point has no size: creep closer on each visit instead
					Math.min(4, Math.max(1.5, canvasStateRef.current.scale * 1.6))
				: Math.max(0.25, Math.min(4, fitScale, idealScale));

		const { x: fromX, y: fromY, scale: fromScale } = canvasStateRef.current;
		if ((vw < 640 || (vh < 500 && window.matchMedia('(pointer: coarse)').matches)) && !positionTag) {
			if (jumpAnimRef.current !== null) cancelAnimationFrame(jumpAnimRef.current);
			const top = (document.querySelector('.whiteboard-tools')?.getBoundingClientRect().bottom ?? document.querySelector('.session-header')?.getBoundingClientRect().bottom ?? 48) + 12;
			setCanvas(framePanel(target, { width: vw, height: vh }, top, 48));
			return;
		}
		const destX = vw / 2 - (target.x + target.width / 2) * toScale;
		const destY = vh / 2 - (target.y + target.height / 2) * toScale;
		const dx = destX - fromX;
		const dy = destY - fromY;
		const dScale = toScale - fromScale;
		// Already framed — nothing to animate
		if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(dScale) < 0.01) return;

		if (jumpAnimRef.current !== null) cancelAnimationFrame(jumpAnimRef.current);

		const DURATION = 420;
		const startedAt = performance.now();
		const step = (now: number) => {
			const t = Math.min(1, (now - startedAt) / DURATION);
			const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
			setCanvas({
				x: fromX + dx * eased,
				y: fromY + dy * eased,
				scale: fromScale + dScale * eased
			});
			jumpAnimRef.current = t < 1 ? requestAnimationFrame(step) : null;
		};
		jumpAnimRef.current = requestAnimationFrame(step);
	};

	// Cancel any in-flight jump and pending timers on unmount
	useEffect(() => {
		const pulseTimers = pulseTimersRef.current;
		return () => {
			if (jumpAnimRef.current !== null) cancelAnimationFrame(jumpAnimRef.current);
			Object.values(pulseTimers).forEach(clearTimeout);
		};
	}, []);

	// Fallback dock label for a panel with nothing yet to name itself after (no
	// video loaded, no file chosen). Numbered only when more than one of that
	// type exists, so a lone panel reads "YouTube" rather than "YouTube 1".
	const fallbackLabel = (panel: DynamicPanel): string => {
		// A note names itself after its contents where it can — the chord name,
		// or the note's first line — before falling back to a numbered label.
		if (panel.type === 'note' && panel.note) {
			const { kind, text } = panel.note;
			if (kind === 'chord') {
				const named = chordsOf(panel.note).filter(c => c.name.trim());
				if (named.length) {
					const first = named[0].name.trim();
					return named.length > 1 ? `${first} +${named.length - 1}` : first;
				}
			}
			const firstLine = text.split('\n')[0].trim();
			if (kind === 'text' && firstLine) return firstLine.slice(0, 40);
		}
		const base = panel.type === 'pdf' ? 'PDF' : panel.type === 'whiteboard' ? 'Whiteboard' : panel.type === 'daw' ? 'Make Music Together' : panel.type === 'youtube' ? 'YouTube' : panel.type === 'note' ? 'Note' : panel.type === 'browser' ? 'Browser' : panel.type === 'code' ? 'Code' : panel.type === 'recorder' ? 'Recorder' : panel.type === 'image' ? 'Image' : 'Audio';
		const sameType = dynamicPanels.filter(p => p.type === panel.type);
		if (sameType.length < 2) return base;
		return `${base} ${sameType.findIndex(p => p.id === panel.id) + 1}`;
	};

	// Label precedence: user-set name → derived from content → typed fallback
	const dockEntries: DockEntry[] = dockedIds.flatMap((id): DockEntry[] => {
		const custom = customLabels[id];
		const pulsing = pulsingIds.includes(id);
		const minimized = minimizedIds.includes(id);
		const positionTag = positionTags.find(tag => tag.id === id);
		if (positionTag) {
			return [{ id, type: 'position', label: custom ?? positionTag.label, renamed: !!custom, pulsing, minimized }];
		}
		if (id === 'remote') return []; // Legacy placeholder is migrated to a real peer above.
		if (id === 'local') {
			const auto = 'You';
			return [{ id, type: id, label: custom ?? auto, renamed: !!custom, pulsing, minimized }];
		}
		const remotePeerId = peerIdFromPanelId(id);
		if (remotePeerId) {
			const index = remoteStreams.findIndex(remote => remote.peerId === remotePeerId);
			if (index < 0) return [];
			return [{ id, type: 'remote', label: custom ?? `Guest ${index + 1}`, renamed: !!custom, pulsing, minimized }];
		}
		const panel = dynamicPanels.find(p => p.id === id);
		if (!panel) return [];
		return [
			{
				id,
				type: panel.type,
				label: custom ?? panelLabels[id] ?? fallbackLabel(panel),
				renamed: !!custom,
				pulsing,
				minimized
			}
		];
	});

	const pingDockEntry = (id: string) => {
		sendSync({ type: 'dock-ping', id });
	};

	const handleParticipantDoubleClick = (entry: DockEntry) => {
		if (entry.type === 'local') {
			const current = canvasStateRef.current;
			sendSync({ type: 'view-suggestion', id: 'local', viewSpace: 'world-center', canvas: presentationView(current) });
			return;
		}
		pendingViewRequestRef.current = entry.id;
		sendSync({ type: 'view-request', id: entry.id });
	};

	const fitScreen = () => {
		setOverviewOpen(false);
		const bounds: Array<{ x: number; y: number; width: number; height: number }> = [];
		if (localStream?.getTracks().length) bounds.push(fixedPanels.local);
		bounds.push(...Object.values(remotePanelStates), ...dynamicPanels.map(panel => panel.state));
		positionTags.forEach(tag => bounds.push({ x: tag.x, y: tag.y, width: tag.w ?? 1, height: tag.h ?? 1 }));
		for (const item of whiteboardRef.current?.getItems() ?? []) {
			if ('kind' in item && item.kind === 'text') {
				const size = item.size * Math.min(DRAWING_VIEWPORT.width, DRAWING_VIEWPORT.height);
				bounds.push({ x: item.x * DRAWING_VIEWPORT.width, y: item.y * DRAWING_VIEWPORT.height - size, width: Math.max(size, item.text.length * size * 0.55), height: size * 1.3 });
			} else if ('x0' in item) {
				const x0 = item.x0 * DRAWING_VIEWPORT.width;
				const y0 = item.y0 * DRAWING_VIEWPORT.height;
				const x1 = item.x1 * DRAWING_VIEWPORT.width;
				const y1 = item.y1 * DRAWING_VIEWPORT.height;
				bounds.push({ x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.max(1, Math.abs(x1 - x0)), height: Math.max(1, Math.abs(y1 - y0)) });
			}
		}
		if (!bounds.length) {
			setCanvas({ x: 0, y: 0, scale: 1 });
			return;
		}
		const minX = Math.min(...bounds.map(item => item.x));
		const minY = Math.min(...bounds.map(item => item.y));
		const maxX = Math.max(...bounds.map(item => item.x + item.width));
		const maxY = Math.max(...bounds.map(item => item.y + item.height));
		const width = Math.max(1, maxX - minX);
		const height = Math.max(1, maxY - minY);
		const scale = Math.max(0.25, Math.min(4, (window.innerWidth * 0.9) / width, (window.innerHeight * 0.78) / height));
		setCanvas({ x: window.innerWidth / 2 - (minX + width / 2) * scale, y: window.innerHeight / 2 - (minY + height / 2) * scale, scale });
	};

	const overviewItems = [
		...(localStream?.getTracks().length ? [{ id: 'local', label: customLabels.local ?? 'You', ...fixedPanels.local }] : []),
		...remoteStreams.flatMap(({ peerId }, index) => remotePanelStates[peerId] ? [{ id: remotePanelId(peerId), label: customLabels[remotePanelId(peerId)] ?? `Guest ${index + 1}`, ...remotePanelStates[peerId] }] : []),
		...dynamicPanels.map(panel => ({ id: panel.id, label: customLabels[panel.id] ?? panelLabels[panel.id] ?? fallbackLabel(panel), ...panel.state })),
	];
	const overview = overviewOpen ? { frames: layoutOverview(overviewItems, overviewSize), onSelect: (id: string) => { setOverviewOpen(false); jumpToPanel(id, true); } } : null;

	// Empty string clears the custom name and reverts to the automatic label.
	// Shared, since these are bookmarks in a canvas both people are looking at.
	const renameDockEntry = (id: string, label: string) => {
		sendSync({ type: 'dock-rename', id, label });
		setCustomLabels(prev => {
			if (!label) {
				if (!(id in prev)) return prev;
				const next = { ...prev };
				delete next[id];
				return next;
			}
			return { ...prev, [id]: label };
		});
	};

	/**
	 * Zoomed far enough out that panel headers are too small to hit.
	 *
	 * At 30% a header bar is about 8px tall on screen — visible, but not
	 * something you can reliably click, which leaves anything untagged
	 * effectively unreachable until you zoom back in and hunt for it.
	 */
	const zoomedOut = canvas.scale < 0.45;

	/**
	 * A tag handle that stays the same size on screen however far out you are.
	 *
	 * Counter-scaling by the canvas scale is what keeps it legible: everything
	 * inside the canvas shrinks with the zoom, so a handle that didn't fight
	 * back would be exactly as unclickable as the header it stands in for.
	 * Only shown for things that aren't tagged yet — once it's in the dock, the
	 * chip is the way back to it.
	 */
	const zoomTagHandle = (id: string, label: string) =>
		zoomedOut && !dockedIds.includes(id) ? (
			<button
				onClick={e => {
					e.stopPropagation();
					toggleDock(id);
				}}
				title={`Tag ${label}`}
				aria-label={`Tag ${label}`}
				className="zoom-tag-handle absolute top-0 left-0 z-30 flex items-center gap-1 rounded-md bg-brand-600/95 hover:bg-brand-500 text-white text-[11px] font-medium px-1.5 py-1 shadow-lg pointer-events-auto"
				style={{
					transform: `scale(${1 / canvas.scale})`,
					transformOrigin: 'top left'
				}}>
				<svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
					<path d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-4-7 4V5z" />
				</svg>
				<span className="max-w-[7rem] truncate">{label}</span>
			</button>
		) : null;

	// Compute spatial volume (0–1) for an audio panel.
	//
	// Two factors multiplied together:
	//   sizeFactor    — how large the panel appears on screen (zoom-driven).
	//                   Full volume when apparent height ≥ 20% of viewport height.
	//   proximityFactor — how close the panel centre is to the viewport centre
	//                   (pan-driven). Falls to 0 as the panel drifts to ~1.5×
	//                   the viewport radius away from centre.
	const spatialVolumeForPanel = (state: PanelState): number => {
		const { x: tx, y: ty, scale } = canvas;
		const vw = window.innerWidth;
		const vh = window.innerHeight;

		// Panel bounds in screen-space pixels
		const left = state.x * scale + tx;
		const right = (state.x + state.width) * scale + tx;
		const top = state.y * scale + ty;
		const bottom = (state.y + state.height) * scale + ty;

		// Off-screen → silence
		const ix = Math.min(right, vw) - Math.max(left, 0);
		const iy = Math.min(bottom, vh) - Math.max(top, 0);
		if (ix <= 0 || iy <= 0) return 0;

		// Size factor: apparent height relative to 20% of viewport (zoom-driven)
		const apparentH = state.height * scale;
		const sizeFactor = Math.min(1, apparentH / (vh * 0.2));

		// Proximity factor: distance of panel centre from viewport centre (pan-driven)
		const cx = (left + right) / 2;
		const cy = (top + bottom) / 2;
		const ndx = (cx - vw / 2) / (vw / 2); // ±1 at each edge
		const ndy = (cy - vh / 2) / (vh / 2);
		const dist = Math.sqrt(ndx * ndx + ndy * ndy);
		// Full at centre (dist=0), falls to 0 at ~1.5× viewport radius
		const proximityFactor = Math.max(0, 1 - dist / 1.5);

		return Math.min(1, sizeFactor * proximityFactor);
	};

	// Spawn a new dynamic panel at the given screen position (screen coords → world coords).
	// Pass fromRemote=true when applying a remote-initiated spawn (skips sync to avoid loops).
	const spawnPanel = (
		type: 'youtube' | 'audio' | 'browser' | 'note' | 'code' | 'recorder' | 'image' | 'daw' | 'whiteboard' | 'pdf',
		screenX: number,
		screenY: number,
		extra?: { initialVideoId?: string; initialFile?: File; initialUrl?: string; note?: NoteContent; code?: CodeContent; dimensions?: { width: number; height: number } },
		remoteId?: string
	) => {
		if (type === 'browser' && !BROWSER_ENABLED) return;
		const { x: tx, y: ty, scale } = canvasStateRef.current;
		const imageRatio = extra?.dimensions ? extra.dimensions.width / extra.dimensions.height : 4 / 3;
		const imageWidth = imageRatio >= 1 ? 520 : Math.max(240, 420 * imageRatio);
		const imageHeight = (imageRatio >= 1 ? Math.max(180, 520 / imageRatio) : 420) + 32;
		const w = type === 'audio' ? 360 : type === 'pdf' ? 560 : type === 'whiteboard' ? 720 : type === 'daw' ? 900 : type === 'image' ? imageWidth : type === 'browser' ? 560 : type === 'recorder' ? 600 : type === 'code' ? 520 : type === 'youtube' ? 320 : type === 'note' ? 300 : 300;
		const h = type === 'audio' ? 220 : type === 'pdf' ? 720 : type === 'whiteboard' ? 540 : type === 'daw' ? 480 : type === 'image' ? imageHeight : type === 'browser' ? 420 : type === 'recorder' ? 480 : type === 'code' ? 380 : type === 'youtube' ? 260 : type === 'note' ? 300 : 360;
		const worldX = (screenX - tx) / scale - w / 2;
		const worldY = (screenY - ty) / scale - h / 2;
		const nextZ = ++topZRef.current;
		const id = remoteId ?? crypto.randomUUID();
		const state: PanelState = { x: worldX, y: worldY, width: w, height: h, z: nextZ };
		const panelExtra: Partial<DynamicPanel> = {
			initialVideoId: extra?.initialVideoId,
			initialFile: extra?.initialFile,
			initialUrl: extra?.initialUrl,
			note: extra?.note,
			code: extra?.code
		};
		setDynamicPanels(prev => [...prev, { id, type, state, ...panelExtra }]);
		const imageFile = (type === 'image' || type === 'pdf') ? extra?.initialFile : undefined;
		if (imageFile) setPanelLabels(prev => ({ ...prev, [id]: imageFile.name }));
		setDockedIds(prev => (prev.includes(id) ? prev : [...prev, id]));

		// Only sync outward for locally-initiated spawns
		if (!remoteId) {
			if (window.innerWidth < 640 || (window.innerHeight < 500 && window.matchMedia('(pointer: coarse)').matches)) {
				if (jumpAnimRef.current !== null) cancelAnimationFrame(jumpAnimRef.current);
				const top = (document.querySelector('.whiteboard-tools')?.getBoundingClientRect().bottom ?? document.querySelector('.session-header')?.getBoundingClientRect().bottom ?? 48) + 12;
				setCanvas(framePanel(state, { width: window.innerWidth, height: window.innerHeight }, top, 48));
			}
			if (type === 'youtube') {
				sendSync({ type: 'spawn-youtube', id, videoId: extra?.initialVideoId, state: normalisePanel(state) });
			} else if (type === 'whiteboard') {
				sendSync({ type: 'spawn-whiteboard', id, state: normalisePanel(state) });
			} else if (type === 'browser') {
				sendSync({ type: 'spawn-browser', id, url: extra?.initialUrl, state: normalisePanel(state) });
			} else if (type === 'audio') {
				// The panel goes over first and the bytes follow, so the other
				// side sees it appear and fill rather than waiting on silence.
				sendSync({ type: 'spawn-audio', id, state: normalisePanel(state) });
				if (extra?.initialFile) sendFileTo(id, extra.initialFile);
			} else if (type === 'note') {
				sendSync({ type: 'spawn-note', id, state: normalisePanel(state), note: extra?.note ?? defaultNoteContent() });
			} else if (type === 'code') {
				sendSync({ type: 'spawn-code', id, state: normalisePanel(state), code: extra?.code ?? { text: '', language: 'text' } });
			} else if (type === 'daw') {
				sendSync({ type: 'spawn-daw', id, state: normalisePanel(state) });
			} else if (type === 'recorder') {
				sendSync({ type: 'spawn-recorder', id, state: normalisePanel(state) });
			} else if (type === 'image' || type === 'pdf') {
				sendSync({ type: type === 'pdf' ? 'spawn-pdf' : 'spawn-image', id, state: normalisePanel(state) });
				if (extra?.initialFile) sendFileTo(id, extra.initialFile);
			}
		}
	};

	const addPdf = async (file: File, screenX: number, screenY: number, panelId?: string) => {
		try {
			const prepared = await preparePdf(file);
			if (panelId) {
				updateDynamicPanel(panelId, { initialFile: prepared, mediaFileName: prepared.name });
				sendFileTo(panelId, prepared);
			} else spawnPanel('pdf', screenX, screenY, { initialFile: prepared });
		} catch (error) {
			setImageToast({ id: crypto.randomUUID(), message: error instanceof Error ? error.message : 'The PDF could not be added.' });
		}
	};

	const addImage = async (file: File, screenX: number, screenY: number) => {
		try {
			const prepared = await prepareImage(file);
			spawnPanel('image', screenX, screenY, {
				initialFile: prepared.file,
				dimensions: { width: prepared.width, height: prepared.height }
			});
			setImageToast(null);
		} catch (error) {
			const isHeic = /\.hei[cf]$/i.test(file.name) || /^image\/hei[cf]/i.test(file.type);
			setImageToast({ id: crypto.randomUUID(), message: isHeic
				? 'This HEIC image could not be opened. Try exporting it as JPEG or PNG.'
				: error instanceof Error ? error.message : 'The image could not be added.' });
		}
	};

	// Publish edits when they are applied locally so their shared revision has
	// the same ordering as the UI; a delayed send can otherwise revive stale text.
	const updateNote = (id: string, note: NoteContent) => {
		setDynamicPanels(prev => prev.map(p => (p.id === id ? { ...p, note } : p)));
		sendSync({ type: 'note-update', id, note });
	};
	const updateCode = (id: string, code: CodeContent) => {
		setDynamicPanels(prev => prev.map(p => (p.id === id ? { ...p, code } : p)));
		sendSync({ type: 'code-update', id, code });
	};
	const updatePanelPlayback = useCallback((id: string, playback: NonNullable<DynamicPanel['playback']>) => {
		setDynamicPanels(prev => prev.map(panel => panel.id === id ? { ...panel, playback } : panel));
	}, []);
	const updateDynamicPanel = useCallback((id: string, patch: Partial<DynamicPanel>) => {
		setDynamicPanels(prev => prev.map(panel => panel.id === id ? { ...panel, ...patch } : panel));
	}, []);
	const toggleMicrophone = useCallback(() => {
		const tracks = localStream?.getAudioTracks() ?? [];
		if (!tracks.length) return;
		const enabled = !tracks.some(track => track.enabled);
		tracks.forEach(track => { track.enabled = enabled; });
		setMicrophoneEnabled(enabled);
	}, [localStream]);
	const toggleCamera = useCallback(async () => {
		const tracks = localStream?.getVideoTracks() ?? [];
		if (tracks.length && !tracks.some(track => track.enabled)) {
			tracks.forEach(track => { track.enabled = true; });
			await replaceVideoTrack(tracks[0]);
			setCameraEnabled(true);
			return;
		}
		if (tracks.length) {
			await replaceVideoTrack(null);
			tracks.forEach(track => {
				track.stop();
				localStream?.removeTrack(track);
			});
			setCameraEnabled(false);
			return;
		}
		try {
			const cameraStream = await navigator.mediaDevices.getUserMedia({ video: true });
			const track = cameraStream.getVideoTracks()[0];
			if (!track || !localStream) return;
			localStream.addTrack(track);
			await replaceVideoTrack(track);
			setCameraEnabled(true);
			setMediaError(null);
		} catch {
			setMediaError('Camera could not be restarted. Check browser permission and try again.');
		}
	}, [localStream, replaceVideoTrack]);

	useEffect(() => {
		let active = true;
		let stream: MediaStream | undefined;
		const acquireMedia = async () => {
			const result = await acquireLocalMedia();
			stream = result.stream;
			if (!active) {
				stream.getTracks().forEach(track => track.stop());
				return;
			}
			setLocalStream(stream);
			setMicrophoneEnabled(false);
			setCameraEnabled(false);
			setMediaError(result.error);
		};
		void acquireMedia();
		return () => {
			active = false;
			stream?.getTracks().forEach(track => track.stop());
		};
	}, [mediaRetryKey]);

	// ── Paste onto the canvas ────────────────────────────────────────────────
	// Whatever is on the clipboard lands where the pointer is, as the nearest
	// sensible thing: an image becomes a compressed panel, a YouTube link becomes
	// a player, and other links and plain text become canvas text.
	// Other URLs become shared-browser panels when the service is enabled.
	const pointerRef = useRef({ x: 0, y: 0 });
	useEffect(() => {
		const onPointer = (e: PointerEvent) => {
			pointerRef.current = { x: e.clientX, y: e.clientY };
		};
		window.addEventListener('pointermove', onPointer);
		return () => window.removeEventListener('pointermove', onPointer);
	}, []);

	useEffect(() => {
		const { x, y } = pointerRef.current;
		if (x || y) broadcastCursor(x, y);
	}, [broadcastCursor, canvas]);

	useEffect(() => {
		const onPaste = (e: ClipboardEvent) => {
			if (e.defaultPrevented) return;
			// Never hijack a paste aimed at a note, the rename box or a URL bar.
			// The target is only an Element when something is focused — a paste
			// with focus on the document itself reports the window.
			const el = e.target instanceof Element ? e.target : null;
			if (el?.closest('input, textarea, [contenteditable="true"]')) return;

			// Drop it where the pointer is; fall back to the middle of the screen
			// when pasted by keyboard without the mouse having moved.
			const { x, y } = pointerRef.current;
			const px = x || window.innerWidth / 2;
			const py = y || window.innerHeight / 2;
			const pdfs = Array.from(e.clipboardData?.files ?? []).filter(isPdfFile);
			if (pdfs.length) { e.preventDefault(); pdfs.forEach((file, index) => { void addPdf(file, px + index * 30, py + index * 30); }); return; }
			const image = Array.from(e.clipboardData?.items ?? [])
				.find(item => item.kind === 'file' && item.type.startsWith('image/'))
				?.getAsFile();
			if (image) {
				e.preventDefault();
				void addImage(image, px, py);
				return;
			}

			const raw = e.clipboardData?.getData('text')?.trim();
			if (!raw) return;
			e.preventDefault();

			const videoId = parseYouTubeVideoId(raw);
			if (videoId) {
				spawnPanel('youtube', px, py, { initialVideoId: videoId });
				return;
			}

			if (BROWSER_ENABLED && /^https?:\/\//i.test(raw)) {
				spawnPanel('browser', px, py, { initialUrl: raw });
				return;
			}

			const code = codeFromText(raw);
			if (code) {
				spawnPanel('code', px, py, { code });
				return;
			}

			// Anything else is words: place it as canvas text
			const item: WhiteboardText = {
				kind: 'text',
				id: crypto.randomUUID(),
				x: (px - canvasStateRef.current.x) / canvasStateRef.current.scale / DRAWING_VIEWPORT.width,
				y: (py - canvasStateRef.current.y) / canvasStateRef.current.scale / DRAWING_VIEWPORT.height,
				text: raw.split('\n')[0].slice(0, 200),
				color: activeColor,
				size: wbTextSize / Math.min(DRAWING_VIEWPORT.width, DRAWING_VIEWPORT.height),
				font: wbFont
			};
			whiteboardRef.current?.drawText(item);
			handleWbText(item);
		};
		window.addEventListener('paste', onPaste);
		return () => window.removeEventListener('paste', onPaste);
	});

	// Wheel → zoom toward cursor (non-passive so we can preventDefault)
	useEffect(() => {
		const onWheel = (e: WheelEvent) => {
			if (overviewOpenRef.current) return;
			e.preventDefault();
			const factor = e.deltaY < 0 ? 1.04 : 1 / 1.04;
			setCanvas(prev => {
				const s = Math.max(0.25, Math.min(4, prev.scale * factor));
				return {
					x: e.clientX - ((e.clientX - prev.x) / prev.scale) * s,
					y: e.clientY - ((e.clientY - prev.y) / prev.scale) * s,
					scale: s
				};
			});
		};
		window.addEventListener('wheel', onWheel, { passive: false });
		return () => window.removeEventListener('wheel', onWheel);
	}, []);

	// Pinch-to-zoom + two-finger pan (touch devices)
	// Attached as native listeners (passive: false on move so we can preventDefault)
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;

		let panTouch: { id: number; x: number; y: number } | null = null;
		const onTouchStart = (e: TouchEvent) => {
			if (overviewOpenRef.current) return;
			if (e.touches.length === 1 && wbTool === 'pointer' && e.target instanceof HTMLCanvasElement) {
				const touch = e.touches[0];
				panTouch = { id: touch.identifier, x: touch.clientX, y: touch.clientY };
				return;
			}
			panTouch = null;
			if (e.touches.length < 2 || (e.target as Element)?.closest('[data-canvas-chrome], .no-drag, input, textarea, select, button')) return;
			const t0 = e.touches[0];
			const t1 = e.touches[1];
			gestureRef.current = {
				lastDist: Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY),
				lastMid: {
					x: (t0.clientX + t1.clientX) / 2,
					y: (t0.clientY + t1.clientY) / 2
				}
			};
		};

		const onTouchMove = (e: TouchEvent) => {
			if (overviewOpenRef.current) return;
			if (e.touches.length === 1 && panTouch) {
				const touch = e.touches[0];
				if (touch.identifier !== panTouch.id) return;
				e.preventDefault();
				const dx = touch.clientX - panTouch.x, dy = touch.clientY - panTouch.y;
				setCanvas(previous => ({ ...previous, x: previous.x + dx, y: previous.y + dy }));
				panTouch = { id: touch.identifier, x: touch.clientX, y: touch.clientY };
				return;
			}
			if (e.touches.length < 2 || !gestureRef.current) return;
			e.preventDefault();
			const t0 = e.touches[0];
			const t1 = e.touches[1];
			const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
			const mid = {
				x: (t0.clientX + t1.clientX) / 2,
				y: (t0.clientY + t1.clientY) / 2
			};
			const { lastDist, lastMid } = gestureRef.current;
			const factor = lastDist > 0 ? dist / lastDist : 1;
			setCanvas(prev => transformGesture(prev, lastMid, mid, factor));
			gestureRef.current = { lastDist: dist, lastMid: mid };
		};

		const onTouchEnd = (e: TouchEvent) => {
			panTouch = null;
			if (e.touches.length < 2) gestureRef.current = null;
		};

		el.addEventListener('touchstart', onTouchStart, { passive: true });
		el.addEventListener('touchmove', onTouchMove, { passive: false });
		el.addEventListener('touchend', onTouchEnd, { passive: true });
		el.addEventListener('touchcancel', onTouchEnd, { passive: true });
		return () => {
			el.removeEventListener('touchstart', onTouchStart);
			el.removeEventListener('touchmove', onTouchMove);
			el.removeEventListener('touchend', onTouchEnd);
			el.removeEventListener('touchcancel', onTouchEnd);
			gestureRef.current = null;
		};
	}, [wbTool]);

	// Space key → pan mode (shows grab-cursor overlay that intercepts all clicks)
	useEffect(() => {
		const onDown = (e: KeyboardEvent) => {
			if (overviewOpenRef.current) return;
			if (e.code === 'Space' && !(e.target as HTMLElement)?.closest('input, textarea, select, button, [contenteditable="true"]')) {
				e.preventDefault();
				setIsPanMode(true);
			}
		};
		const onUp = (e: KeyboardEvent) => {
			if (e.code === 'Space') {
				setIsPanMode(false);
				setIsGrabbing(false);
				isPanningRef.current = false;
			}
		};
		window.addEventListener('keydown', onDown);
		window.addEventListener('keyup', onUp);
		return () => {
			window.removeEventListener('keydown', onDown);
			window.removeEventListener('keyup', onUp);
		};
	}, []);

	// ── Pan helpers (shared by space-overlay and middle-click) ───────────
	const startPan = (clientX: number, clientY: number) => {
		isPanningRef.current = true;
		panStartRef.current = {
			mx: clientX,
			my: clientY,
			cx: canvasStateRef.current.x,
			cy: canvasStateRef.current.y
		};
		setIsGrabbing(true);
	};

	const movePan = (clientX: number, clientY: number) => {
		if (!isPanningRef.current) return;
		const dx = clientX - panStartRef.current.mx;
		const dy = clientY - panStartRef.current.my;
		setCanvas(prev => ({
			...prev,
			x: panStartRef.current.cx + dx,
			y: panStartRef.current.cy + dy
		}));
	};

	const endPan = () => {
		isPanningRef.current = false;
		setIsGrabbing(false);
	};

	const cancelLongPress = () => {
		if (!longPressRef.current) return;
		clearTimeout(longPressRef.current.timer);
		longPressRef.current = null;
	};

	// Middle or right-click drag on the background pans without space held
	const handleOuterMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
		if ((e.button === 1 || e.button === 2) && e.target instanceof HTMLCanvasElement) {
			e.preventDefault();
			startPan(e.clientX, e.clientY);
			return;
		}
		if (e.button !== 0 || !(e.target instanceof HTMLCanvasElement) || isPanMode) return;

		cancelLongPress();
		const screenX = e.clientX;
		const screenY = e.clientY;
		const timer = setTimeout(() => {
			const { x: tx, y: ty, scale } = canvasStateRef.current;
			const tag: PositionTag = {
				id: crypto.randomUUID(),
				x: (screenX - tx) / scale,
				y: (screenY - ty) / scale,
				label: `Position ${positionTagsRef.current.length + 1}`
			};
			longPressRef.current = null;
			setPositionTags(prev => [...prev, tag]);
			setDockedIds(prev => [...prev, tag.id]);
			sendSync({
				type: 'position-tag',
				id: tag.id,
				x: tag.x,
				y: tag.y,
				label: tag.label
			});
		}, 2000);
		longPressRef.current = { timer, x: screenX, y: screenY };
	};
	const handleOuterMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
		const pending = longPressRef.current;
		if (pending && Math.hypot(e.clientX - pending.x, e.clientY - pending.y) > 6) cancelLongPress();
		movePan(e.clientX, e.clientY);
	};
	const handleOuterMouseUp = (e: React.MouseEvent<HTMLDivElement>) => {
		cancelLongPress();
		if (e.button === 1 || e.button === 2) endPan();
	};

	useEffect(
		() => () => {
			if (longPressRef.current) clearTimeout(longPressRef.current.timer);
		},
		[]
	);

	// ── Dot-grid background ───────────────────────────────────────────────
	const GRID = 32;
	const scaledGrid = Math.max(8, GRID * canvas.scale);
	const bgX = ((canvas.x % scaledGrid) + scaledGrid) % scaledGrid;
	const bgY = ((canvas.y % scaledGrid) + scaledGrid) % scaledGrid;

	const statusLabel: Record<string, string> = {
		idle: 'Setting up…',
		connecting: 'Connecting…',
		waiting: 'Waiting for guest…',
		connected: `Connected · ${participantCount}/4`,
		error: ''
	};
	const recorderStatusList = Object.values(recorderStatuses);
	const anyRecorderActive = recorderStatusList.some(item => item.recording);
	const recorderErrors = [...new Set(recorderStatusList.flatMap(item => item.errors))];

	const zoomControls = (
				<div className="flex items-center gap-0.5">
					<button
						onClick={() => setCanvas(c => ({ ...c, scale: Math.max(0.25, c.scale / 1.1) }))}
						className="w-7 h-7 flex items-center justify-center rounded text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors text-base leading-none"
						title="Zoom out">
						−
					</button>
					<button
						onClick={() => setCanvas({ x: 0, y: 0, scale: 1 })}
						className="px-1 sm:px-1.5 tabular-nums text-xs text-zinc-400 hover:text-white transition-colors min-w-[2.75rem] sm:min-w-[3.25rem] text-center rounded hover:bg-zinc-700 py-1"
						title="Reset view (100%)">
						{Math.round(canvas.scale * 100)}%
					</button>
					<button
						onClick={() => setCanvas(c => ({ ...c, scale: Math.min(4, c.scale * 1.1) }))}
						className="w-7 h-7 flex items-center justify-center rounded text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors text-base leading-none"
						title="Zoom in">
						+
					</button>
					<button
						onClick={() => setLaserEnabled(enabled => !enabled)}
						className={`ml-1 flex h-7 items-center gap-1 rounded border px-1.5 text-xs transition-colors ${laserEnabled ? 'border-rose-400 bg-rose-500/20 text-rose-300' : 'border-zinc-700 text-zinc-400 hover:bg-zinc-700 hover:text-white'}`}
						title={laserEnabled ? 'Turn off laser pointer (L)' : 'Turn on laser pointer (L)'}
						aria-pressed={laserEnabled}>
						<span className={`h-2 w-2 rounded-full ${laserEnabled ? 'animate-pulse bg-rose-400 shadow-[0_0_8px_#fb7185]' : 'bg-zinc-500'}`} />
						<span className="hidden lg:inline">Laser</span>
					</button>
				</div>
	);

	return (
		<div
			className="session-screen relative w-full h-full overflow-hidden select-none"
			ref={containerRef}
			style={{
				backgroundColor: '#111',
				backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.18) 1px, transparent 1px)',
				backgroundSize: `${scaledGrid}px ${scaledGrid}px`,
				backgroundPosition: `${bgX}px ${bgY}px`,
				...(bgDragOver && {
					outline: '2px solid rgba(139,92,246,0.6)',
					outlineOffset: '-2px'
				})
			}}
			onMouseDown={handleOuterMouseDown}
			onMouseMove={handleOuterMouseMove}
			onMouseUp={handleOuterMouseUp}
			onMouseLeave={handleOuterMouseUp}
			onPointerMove={event => broadcastCursor(event.clientX, event.clientY)}
			onPointerLeave={() => { cursorSync.cancel(); sendSync({ type: 'cursor-leave' }); }}
			onContextMenu={e => {
				if (e.target instanceof HTMLCanvasElement) e.preventDefault();
			}}
			onDragOver={e => {
				const hasFile = e.dataTransfer.types.includes('Files');
				const hasUrl = e.dataTransfer.types.includes('text/uri-list') || e.dataTransfer.types.includes('text/plain');
				if (hasFile || hasUrl) {
					e.preventDefault();
					setBgDragOver(true);
				}
			}}
			onDragLeave={e => {
				// Only clear if leaving the root element entirely
				if (!e.currentTarget.contains(e.relatedTarget as Node)) setBgDragOver(false);
			}}
			onDrop={e => {
				e.preventDefault();
				setBgDragOver(false);
				const pdfs = Array.from(e.dataTransfer.files).filter(isPdfFile);
				if (pdfs.length) { pdfs.forEach((file, index) => { void addPdf(file, e.clientX + index * 30, e.clientY + index * 30); }); return; }
				const image = Array.from(e.dataTransfer.files).find(file => file.type.startsWith('image/'));
				if (image) {
					void addImage(image, e.clientX, e.clientY);
					return;
				}
				// Audio file
				const file = Array.from(e.dataTransfer.files).find(f => f.type.match(/audio\//));
				if (file) {
					spawnPanel('audio', e.clientX, e.clientY, { initialFile: file });
					return;
				}
				// YouTube URL (dragged link from browser)
				const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
				if (text) {
					const videoId = parseYouTubeVideoId(text);
					if (videoId)
						spawnPanel('youtube', e.clientX, e.clientY, {
							initialVideoId: videoId
						});
				}
			}}>
			<input
				ref={imagePdfInputRef}
				type="file"
				accept="image/*,application/pdf,.pdf"
				multiple
				className="hidden"
				onChange={event => {
					Array.from(event.target.files ?? []).forEach((file, index) => {
						const x = window.innerWidth / 2 + index * 30;
						const y = window.innerHeight / 2 + index * 30;
						if (isPdfFile(file)) void addPdf(file, x, y);
						else void addImage(file, x, y);
					});
					event.target.value = '';
				}}
			/>
			<input
				ref={roomBundleInputRef}
				type="file"
				accept=".json,application/json"
				className="hidden"
				onChange={event => {
					const file = event.target.files?.[0];
					if (file) void importRoomBundle(file);
					event.target.value = '';
				}}
			/>
			{/* Top bar — fixed overlay, not part of draggable canvas */}
			<div
				data-canvas-chrome
				className="session-header absolute top-0 left-0 right-0 z-[1000] flex items-center justify-between px-2 sm:px-4 bg-zinc-950/90 backdrop-blur-sm border-b border-zinc-800/60"
				style={{
					paddingTop: 'env(safe-area-inset-top)',
					paddingBottom: '0.5rem'
				}}>
				<div className="flex items-center gap-2 sm:gap-3 min-w-0">
					<div className="flex min-w-0 items-center gap-1.5">
						<BrandMark className="h-5 w-5" />
						<span className="brand-wordmark text-white font-semibold text-sm sm:text-base tracking-tight truncate">maketogether</span>
						<span className="shrink-0 text-[9px] font-normal tabular-nums text-zinc-500" aria-label={`Version ${__APP_VERSION__}`} title={`Version ${__APP_VERSION__}`}>v{__APP_VERSION__}</span>
					</div>
					<span
						aria-label={error ? 'Connection error' : status === 'waiting' ? 'Waiting for guest' : statusLabel[status]}
						role="status"
						className={`session-connection-status text-xs px-2 sm:px-2.5 py-0.5 rounded-full font-medium shrink-0 ${
							status === 'connected' ? 'bg-emerald-500/20 text-emerald-400' : status === 'error' ? 'bg-red-500/20 text-red-400' : 'bg-zinc-700 text-zinc-400'
						}`}>
						{error ? (
							'Error'
						) : status === 'waiting' ? (
							<span>
								<span className="hidden sm:inline">Waiting for guest…</span>
								<span className="sm:hidden">Waiting…</span>
							</span>
						) : (
							statusLabel[status]
						)}
					</span>
				</div>

				<div className="ml-auto flex w-fit shrink-0 items-center justify-end gap-1 sm:gap-2">
				<div className="header-zoom-controls">{zoomControls}</div>

				{/* Add media buttons (desktop rail) */}
				<div className="fixed right-3 z-[999] hidden max-h-[calc(100vh-5rem)] w-32 shrink-0 flex-col items-stretch gap-1.5 overflow-y-auto lg:flex" style={{ top: 'calc(3rem + env(safe-area-inset-top) + 0.75rem)' }}>
					<button
						onClick={() => void screenShare.toggle()}
						disabled={!screenShare.supported || screenShare.busy || !localStream}
						aria-pressed={screenShare.sharing}
						title={screenShare.sharing ? 'Stop sharing your screen' : 'Share your screen with participants'}
						className="grid w-full grid-cols-[1.25rem_1fr] items-center gap-1.5 text-left [&>:first-child]:justify-self-center bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-violet-300 text-xs font-medium px-3 py-2 rounded-lg transition-colors disabled:opacity-50">
						<svg aria-hidden="true" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><rect x="3" y="3" width="18" height="14" rx="2" /><path d="M8 21h8M12 17v4M12 13V7m-3 3 3-3 3 3" strokeLinecap="round" strokeLinejoin="round" /></svg>
						<span>{screenShare.busy ? 'Starting…' : screenShare.sharing ? 'Stop sharing' : 'Share screen'}</span>
					</button>
					<button onClick={() => spawnPanel('whiteboard', window.innerWidth / 2, window.innerHeight / 2)} title="Add a whiteboard"
						className="grid w-full grid-cols-[1.25rem_1fr] items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-left text-xs font-medium text-zinc-300 hover:bg-zinc-700">
						<svg className="h-4 w-4 text-brand-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><rect x="3" y="3" width="18" height="14" rx="2" /><path d="m8 21 4-4 4 4M7 12l3-4 3 3 4-4" /></svg><span>Whiteboard</span>
					</button>
					<button
						onClick={() => imagePdfInputRef.current?.click()}
						className="grid w-full grid-cols-[1.25rem_1fr] items-center gap-1.5 text-left [&>:first-child]:justify-self-center bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 border border-zinc-700 text-zinc-300 text-xs font-medium px-3 py-2 rounded-lg transition-colors"
						title="Add images or PDFs">
						<svg className="h-3.5 w-3.5 shrink-0 text-fuchsia-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
							<rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9" r="1.5" /><path strokeLinecap="round" strokeLinejoin="round" d="M4 17l5-5 3.5 3.5 2-2L20 19" />
						</svg>
						<span>Image / PDF</span>
					</button>
					<button
						onClick={() => spawnPanel('note', window.innerWidth / 2, window.innerHeight / 2)}
						className="grid w-full grid-cols-[1.25rem_1fr] items-center gap-1.5 text-left [&>:first-child]:justify-self-center bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 border border-zinc-700 text-zinc-300 text-xs font-medium px-3 py-2 rounded-lg transition-colors"
						title="Add a sticky note">
						<svg className="w-3.5 h-3.5 text-amber-300 shrink-0" viewBox="0 0 24 24" fill="currentColor">
							<path d="M5 3h14a2 2 0 012 2v9l-7 7H5a2 2 0 01-2-2V5a2 2 0 012-2zm9 17.5V15a1 1 0 011-1h5.5L14 20.5z" />
						</svg>
						<span>Note</span>
					</button>
					<button
						onClick={() => spawnPanel('code', window.innerWidth / 2, window.innerHeight / 2, { code: { text: '', language: 'text' } })}
						className="grid w-full grid-cols-[1.25rem_1fr] items-center gap-1.5 text-left [&>:first-child]:justify-self-center bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 border border-zinc-700 text-zinc-300 text-xs font-medium px-3 py-2 rounded-lg transition-colors"
						title="Add a code editor">
						<span className="font-mono text-emerald-400">&lt;/&gt;</span>
						<span>Code</span>
					</button>
					<button
						onClick={() => spawnPanel('recorder', window.innerWidth / 2, window.innerHeight / 2)}
						className="grid w-full grid-cols-[1.25rem_1fr] items-center gap-1.5 text-left [&>:first-child]:justify-self-center bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 border border-zinc-700 text-zinc-300 text-xs font-medium px-3 py-2 rounded-lg transition-colors"
						title="Add a screen recorder">
						<span className="h-3.5 w-3.5 rounded-full border-2 border-red-300 bg-red-500" />
						<span>Record</span>
					</button>
					<button
						onClick={() => spawnPanel('youtube', window.innerWidth / 2, window.innerHeight / 2)}
						className="grid w-full grid-cols-[1.25rem_1fr] items-center gap-1.5 text-left [&>:first-child]:justify-self-center bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 border border-zinc-700 text-zinc-300 text-xs font-medium px-3 py-2 rounded-lg transition-colors"
						title="Add a YouTube player">
						<svg className="w-3.5 h-3.5 text-red-500 shrink-0" viewBox="0 0 24 24" fill="currentColor">
							<path d="M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
						</svg>
						<span>YouTube</span>
					</button>
					<button
						onClick={() => spawnPanel('daw', window.innerWidth / 2, window.innerHeight / 2)}
						className="grid w-full grid-cols-[1.25rem_1fr] items-center gap-1.5 text-left [&>:first-child]:justify-self-center bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-emerald-300 text-xs font-medium px-3 py-2 rounded-lg"
						title="Add a shared multitrack DAW">
						<span aria-hidden="true">♫</span><span>DAW</span>
					</button>
					<button
						onClick={() => spawnPanel('audio', window.innerWidth / 2, window.innerHeight / 2)}
						className="grid w-full grid-cols-[1.25rem_1fr] items-center gap-1.5 text-left [&>:first-child]:justify-self-center bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 border border-zinc-700 text-zinc-300 text-xs font-medium px-3 py-2 rounded-lg transition-colors"
						title="Add an audio player">
						<svg className="w-3.5 h-3.5 text-violet-400 shrink-0" viewBox="0 0 24 24" fill="currentColor">
							<path d="M12 3v10.55A4 4 0 1014 17V7h4V3h-6z" />
						</svg>
						<span>Audio</span>
					</button>
					{BROWSER_ENABLED && (<button
						onClick={() => spawnPanel('browser', window.innerWidth / 2, window.innerHeight / 2)}
						className="grid w-full grid-cols-[1.25rem_1fr] items-center gap-1.5 text-left [&>:first-child]:justify-self-center bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 border border-zinc-700 text-zinc-300 text-xs font-medium px-3 py-2 rounded-lg transition-colors"
						title="Add a mini browser">
						<svg className="w-3.5 h-3.5 text-sky-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
							<rect x="3" y="4" width="18" height="16" rx="2" />
							<path d="M3 9h18M7 6.5h.01M10 6.5h.01" strokeLinecap="round" />
						</svg>
						<span>Browser</span>
					</button>)}
				</div>

				{/* Add media buttons (mobile/tablet hamburger) */}
				<div ref={widgetMenuRef} className="relative shrink-0 lg:hidden">
					<button
						onClick={() => setWidgetMenuOpen(open => !open)}
						className="w-8 h-8 flex items-center justify-center bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 border border-zinc-700 text-zinc-300 rounded-lg transition-colors"
						title="Open menu"
						aria-label="Open menu"
						aria-haspopup="menu"
						aria-expanded={widgetMenuOpen}>
						<svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
							<path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16M4 12h16M4 17h16" />
						</svg>
					</button>
					{widgetMenuOpen && (
						<div className="widget-menu absolute right-0 mt-2 w-48 overflow-y-auto bg-zinc-900/95 backdrop-blur border border-zinc-700 rounded-xl p-1.5 shadow-xl z-50">
                            <div className="mobile-menu-tools" ref={setMobileToolsTarget} />
                            <div className="mobile-menu-zoom">{zoomControls}</div>
                            <button onClick={() => { void exportRoomBundle(); setWidgetMenuOpen(false); }} className="mobile-room-action sm:hidden w-full rounded-lg px-2.5 py-2 text-left text-xs text-zinc-200 hover:bg-zinc-800">Export room bundle</button>
                            <button onClick={() => { roomBundleInputRef.current?.click(); setWidgetMenuOpen(false); }} className="mobile-room-action sm:hidden w-full rounded-lg px-2.5 py-2 text-left text-xs text-zinc-200 hover:bg-zinc-800">Import room bundle</button>
							<button onClick={() => { spawnPanel('recorder', window.innerWidth / 2, window.innerHeight / 2); setWidgetMenuOpen(false); }} className="w-full rounded-lg px-2.5 py-2 text-left text-xs text-zinc-200 hover:bg-zinc-800">Record canvas</button>
							<button onClick={() => { spawnPanel('whiteboard', window.innerWidth / 2, window.innerHeight / 2); setWidgetMenuOpen(false); }} className="w-full rounded-lg px-2.5 py-2 text-left text-xs text-zinc-200 hover:bg-zinc-800">Whiteboard</button>
							<button disabled={!screenShare.supported || screenShare.busy || !localStream} aria-pressed={screenShare.sharing}
								onClick={() => { void screenShare.toggle(); setWidgetMenuOpen(false); }}
								className="w-full text-left px-2.5 py-2 text-xs text-violet-300 rounded-lg hover:bg-zinc-800 disabled:opacity-50">
								{!screenShare.supported ? 'Screen sharing unavailable' : screenShare.sharing ? 'Stop sharing' : 'Share screen'}
							</button>
							<button
								onClick={() => {
									imagePdfInputRef.current?.click();
									setWidgetMenuOpen(false);
								}}
								className="w-full text-left px-2.5 py-2 text-xs text-zinc-200 rounded-lg hover:bg-zinc-800 transition-colors">
								Image / PDF
							</button>
							<button
								onClick={() => {
									spawnPanel('note', window.innerWidth / 2, window.innerHeight / 2);
									setWidgetMenuOpen(false);
								}}
								className="w-full text-left px-2.5 py-2 text-xs text-zinc-200 rounded-lg hover:bg-zinc-800 transition-colors">
								Note
							</button>
							<button
								onClick={() => {
									spawnPanel('code', window.innerWidth / 2, window.innerHeight / 2, { code: { text: '', language: 'text' } });
									setWidgetMenuOpen(false);
								}}
								className="w-full text-left px-2.5 py-2 text-xs text-zinc-200 rounded-lg hover:bg-zinc-800 transition-colors">
								Code
							</button>
							<button
								onClick={() => {
									spawnPanel('youtube', window.innerWidth / 2, window.innerHeight / 2);
									setWidgetMenuOpen(false);
								}}
								className="w-full text-left px-2.5 py-2 text-xs text-zinc-200 rounded-lg hover:bg-zinc-800 transition-colors">
								YouTube
							</button>
							<button
								onClick={() => {
									spawnPanel('audio', window.innerWidth / 2, window.innerHeight / 2);
									setWidgetMenuOpen(false);
								}}
								className="w-full text-left px-2.5 py-2 text-xs text-zinc-200 rounded-lg hover:bg-zinc-800 transition-colors">
								Audio
							</button>
							<button
								onClick={() => {
									spawnPanel('daw', window.innerWidth / 2, window.innerHeight / 2);
									setWidgetMenuOpen(false);
								}}
								className="w-full text-left px-2.5 py-2 text-xs text-emerald-300 rounded-lg hover:bg-zinc-800 transition-colors">
								DAW
							</button>
							{BROWSER_ENABLED && (<button
								onClick={() => {
									spawnPanel('browser', window.innerWidth / 2, window.innerHeight / 2);
									setWidgetMenuOpen(false);
								}}
								className="w-full text-left px-2.5 py-2 text-xs text-zinc-200 rounded-lg hover:bg-zinc-800 transition-colors">
								Browser
							</button>)}
						</div>
					)}
				</div>

				<button
					onClick={presentingId ? stopPresenting : startPresenting}
					disabled={!presentingId && participantCount < 2}
					className={`flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${presentingId ? 'border-brand-400 bg-brand-600 text-white hover:bg-brand-500' : 'border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}
					title={presentingId ? 'Stop presenting your viewport' : participantCount < 2 ? 'Invite someone before presenting' : 'Invite everyone to follow your viewport'}>
					<svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
						<path strokeLinecap="round" strokeLinejoin="round" d="M8 5h8a3 3 0 013 3v5a3 3 0 01-3 3h-3l-3.5 3v-3H8a3 3 0 01-3-3V8a3 3 0 013-3z" />
						<path strokeLinecap="round" d="M9 9.5h6M9 12.5h4" />
					</svg>
					<span className="hidden lg:inline">{presentingId ? 'Stop presenting' : 'Present'}</span>
				</button>
				<div className="room-bundle-actions hidden sm:flex shrink-0 items-center gap-1">
					<button
						onClick={exportRoomBundle}
						className="flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-800 text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-white"
						title="Export room bundle"
						aria-label="Export room bundle">
						<svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 3v12m0 0l-4-4m4 4l4-4M5 15v4a2 2 0 002 2h10a2 2 0 002-2v-4" /></svg>
					</button>
					<button
						onClick={() => roomBundleInputRef.current?.click()}
						className="flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-800 text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-white"
						title="Import room bundle"
						aria-label="Import room bundle">
						<svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 16V4m0 0L8 8m4-4l4 4M5 9v10a2 2 0 002 2h10a2 2 0 002-2V9" /></svg>
					</button>
				</div>

				{/* Anyone in the room can summon, not just whoever opened it — a
				    room holds four, so a guest may well be the one who wants to
				    pull in the fourth. */}
				<SummonButton roomCode={roomCode} />
				</div>
			</div>


			{bundleNotice && (
				<div role={bundleNotice.kind === 'error' ? 'alert' : 'status'} className={`fixed bottom-24 left-1/2 z-[1002] w-[min(32rem,calc(100vw-1.5rem))] -translate-x-1/2 rounded-xl border px-3 py-2 text-center text-xs shadow-xl backdrop-blur ${bundleNotice.kind === 'error' ? 'border-red-700 bg-red-950/95 text-red-200' : 'border-emerald-700 bg-emerald-950/95 text-emerald-200'}`}>
					{bundleNotice.message}
				</div>
			)}

			{viewSuggestion && (
				<div className="fixed left-3 top-16 z-[1000] flex items-center gap-2 rounded-xl border border-brand-500/60 bg-zinc-900/95 p-2 shadow-xl backdrop-blur">
					<button
						onClick={() => {
							setCanvas({ ...viewSuggestion.canvas });
							setViewSuggestion(null);
						}}
						className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-500">
						A participant suggested their view — switch
					</button>
					<button onClick={() => setViewSuggestion(null)} className="px-1 text-zinc-400 hover:text-white" title="Dismiss" aria-label="Dismiss view suggestion">×</button>
				</div>
			)}
			{wbTool === 'connector' && (
				<div className="pointer-events-none fixed left-1/2 top-28 z-[999] -translate-x-1/2 rounded-full border border-brand-500/60 bg-zinc-900/95 px-3 py-1.5 text-xs font-medium text-brand-100 shadow-lg">
					{connectorStartId ? 'Select another panel to connect · select the first again to cancel' : 'Select the first panel to connect'}
				</div>
			)}

			{presentationInvite && (
				<div role="dialog" aria-label="Presentation invitation" className="fixed left-1/2 top-16 z-[1002] w-[min(26rem,calc(100vw-1.5rem))] -translate-x-1/2 rounded-xl border border-brand-500/60 bg-zinc-900/95 p-3 shadow-2xl backdrop-blur">
					<p className="text-sm font-semibold text-white">A participant wants to present</p>
					<p className="mt-1 text-xs leading-relaxed text-zinc-400">Accept to follow their canvas as they pan and zoom. You can stop following at any time.</p>
					<div className="mt-3 flex justify-end gap-2">
						<button onClick={() => setPresentationInvite(null)} className="rounded-lg px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800 hover:text-white">Decline</button>
						<button onClick={acceptPresentation} className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-500">Follow presenter</button>
					</div>
				</div>
			)}

			{following && (
				<div aria-label="Presentation status" className="fixed left-1/2 z-[1001] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full border border-brand-500/40 bg-zinc-900/95 py-1 pl-3 pr-1 text-[11px] leading-4 shadow-lg backdrop-blur" style={{ top: 'calc(3rem + env(safe-area-inset-top) + 0.5rem)' }}>
					<span className="flex items-center gap-1.5 font-medium text-brand-200"><span className="h-1.5 w-1.5 rounded-full bg-brand-400" />Following</span>
					<button onClick={stopFollowing} aria-label="Stop following" className="rounded-full bg-zinc-800 px-2.5 py-1 font-medium text-white hover:bg-zinc-700">Stop</button>
				</div>
			)}

			{presentingId && (
				<div aria-label="Presentation status" className="fixed left-1/2 z-[1001] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full border border-brand-500/40 bg-zinc-900/95 py-1 pl-3 pr-1 text-[11px] leading-4 shadow-lg backdrop-blur" style={{ top: 'calc(3rem + env(safe-area-inset-top) + 0.5rem)' }}>
					<span className="font-medium text-brand-200">Presenting</span>
					<span className="text-zinc-400">{presentationFollowers.length} following</span>
					<button onClick={stopPresenting} aria-label="Stop presenting" className="rounded-full bg-zinc-800 px-2.5 py-1 font-medium text-white hover:bg-zinc-700">Stop</button>
				</div>
			)}

			<Toast key={imageToast?.id} message={imageToast?.message} label="File upload error" onDismiss={() => setImageToast(null)} />
			<Toast message={error} label="Connection error" />
			<Toast message={screenShare.error} label="Screen sharing error" />
			<Toast message={mediaError} label="Camera or microphone error" onDismiss={() => setMediaError(null)}
				action={{ label: 'Retry camera / microphone', onClick: () => { setMediaError(null); setMediaRetryKey(key => key + 1); } }} />
			<Toast message={mediaStatus} label="Audio/video connection" status action={{ label: 'Retry audio/video connection', onClick: retryMedia }} />
			{recorderErrors.map(message => <Toast key={message} message={message} label="Recording warning" />)}
			{anyRecorderActive && (
				<div className="absolute right-3 z-[1001] flex items-center gap-1.5 rounded-xl border border-zinc-700 bg-zinc-900/95 px-2.5 py-2 text-xs font-semibold text-red-300 shadow-xl" style={{ top: 'calc(3rem + env(safe-area-inset-top) + 0.5rem)' }}>
					<span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" />Recording
				</div>
			)}

			{/* Whiteboard canvas — sits below all panels, transparent so grid shows through */}
			<Whiteboard
				ref={whiteboardRef}
				tool={wbTool}
				isPanning={isGrabbing}
				color={activeColor}
				width={wbWidth}
				nib={wbNib}
				font={wbFont}
				textSize={wbTextSize}
				shapeKind={wbShapeKind}
				onStroke={handleWbStroke}
				onShape={handleWbShape}
				onText={handleWbText}
				onTextEdit={handleWbTextEdit}
				onTextMove={handleWbTextMove}
				onRegion={handleWbRegion}
				canvasTransform={canvas}
			/>

			{/* Whiteboard toolbar */}
			<WhiteboardToolbar
				mobileMenuTarget={mobileToolsTarget}
				tool={wbTool}
				color={activeColor}
				width={wbWidth}
				nib={wbNib}
				font={wbFont}
				textSize={wbTextSize}
				shapeKind={wbShapeKind}
				onFontChange={setWbFont}
				onTextSizeChange={setWbTextSize}
				onShapeKindChange={setWbShapeKind}
				onToolChange={setWbTool}
				onColorChange={setActiveColor}
				onWidthChange={setWbWidth}
				onNibChange={setWbNib}
				onClear={handleWbClear}
			/>

			{/* Space-key pan overlay — sits above whiteboard, below panels, grabs all pointer events */}
			{isPanMode && !overviewOpen && (
				<div
					style={{
						position: 'absolute',
						inset: 0,
						zIndex: 998,
						cursor: isGrabbing ? 'grabbing' : 'grab'
					}}
					onMouseDown={e => {
						e.preventDefault();
						startPan(e.clientX, e.clientY);
					}}
					onMouseMove={e => movePan(e.clientX, e.clientY)}
					onMouseUp={endPan}
					onMouseLeave={endPan}
				/>
			)}

			{overviewOpen && <>
				<div data-canvas-chrome className="absolute inset-0 z-[1190] bg-zinc-950/95 backdrop-blur-xl" onClick={() => setOverviewOpen(false)} />
			</>}
			{/* Infinite canvas — all panels live here and transform together */}
			<PanelOverviewContext.Provider value={overview}>
			<div
				data-panel-canvas
				data-overview={overviewOpen || undefined}
				role={overviewOpen ? 'dialog' : undefined}
				aria-modal={overviewOpen || undefined}
				aria-label={overviewOpen ? 'All panels' : undefined}
				style={{
					position: 'absolute',
					inset: 0,
					transform: overviewOpen ? 'none' : `translate(${canvas.x}px, ${canvas.y}px) scale(${canvas.scale})`,
					zIndex: overviewOpen ? 1200 : undefined,
					transformOrigin: '0 0',
					// The wrapper covers the viewport but is visually empty outside
					// its children. Let those empty areas reach the whiteboard.
					pointerEvents: 'none'
				}}>
				{overviewOpen && (
				<div data-overview-header data-canvas-chrome className="pointer-events-auto absolute left-6 right-6 top-5 z-[1102] flex items-center justify-between text-white"><div><h2 className="text-lg font-semibold">Show all</h2><p className="text-xs text-zinc-400">{overviewItems.length ? 'Choose a panel to return to it' : 'No panels yet. Add a widget to get started.'}</p></div><button data-overview-close onClick={() => setOverviewOpen(false)} className="rounded-lg border border-white/20 px-3 py-1.5 text-sm">Done</button></div>
				)}
				<svg className="absolute inset-0 z-[4] overflow-visible" width="100%" height="100%" aria-label="Panel connections">
					{connectors.map(connector => {
						const from = dynamicPanels.find(panel => panel.id === connector.fromPanelId)?.state;
						const to = dynamicPanels.find(panel => panel.id === connector.toPanelId)?.state;
						if (!from || !to) return null;
						const start = panelAnchor(from, to);
						const end = panelAnchor(to, from);
						return <g key={connector.id} data-connector={connector.id} role="button" tabIndex={wbTool === 'pointer' || wbTool === 'connector' ? 0 : -1}
							aria-label="Select connection" aria-pressed={selectedConnectorId === connector.id}
							className="cursor-pointer outline-none"
							onFocus={() => setSelectedConnectorId(connector.id)} onBlur={() => setSelectedConnectorId(null)}
							onMouseDown={event => event.stopPropagation()}
							onPointerDown={event => { event.preventDefault(); event.stopPropagation(); event.currentTarget.focus(); setSelectedConnectorId(connector.id); }}
							onKeyDown={event => {
								if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
								if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); removeConnector(connector.id); }
								if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); event.currentTarget.blur(); }
							}}>
							<title>Connection · Delete to remove</title>
							{selectedConnectorId === connector.id && <line x1={start.x} y1={start.y} x2={end.x} y2={end.y} stroke="#c4b5fd" strokeWidth={connector.width + 8 / canvas.scale} strokeLinecap="round" />}
							<line data-connector-hit x1={start.x} y1={start.y} x2={end.x} y2={end.y} stroke="transparent" strokeWidth={Math.max(16, connector.width * canvas.scale + 8)} vectorEffect="non-scaling-stroke" style={{ pointerEvents: !isPanMode && (wbTool === 'pointer' || wbTool === 'connector') ? 'stroke' : 'none' }} />
							<line x1={start.x} y1={start.y} x2={end.x} y2={end.y} stroke="#18181b" strokeWidth={connector.width + 4} strokeLinecap="round" />
							<line x1={start.x} y1={start.y} x2={end.x} y2={end.y} stroke={connector.color} strokeWidth={connector.width} strokeLinecap="round" />
							<circle cx={start.x} cy={start.y} r={Math.max(4, connector.width)} fill={connector.color} stroke="#18181b" strokeWidth="2" />
							<circle cx={end.x} cy={end.y} r={Math.max(4, connector.width)} fill={connector.color} stroke="#18181b" strokeWidth="2" />
						</g>;
					})}
				</svg>
				{wbTool === 'connector' && connectors.map(connector => {
					const from = dynamicPanels.find(panel => panel.id === connector.fromPanelId)?.state;
					const to = dynamicPanels.find(panel => panel.id === connector.toPanelId)?.state;
					if (!from || !to) return null;
					const start = panelAnchor(from, to);
					const end = panelAnchor(to, from);
					return <button key={`remove:${connector.id}`} type="button" onClick={() => removeConnector(connector.id)} aria-label="Remove connector" title="Remove connector" className="absolute z-[997] flex h-6 w-6 items-center justify-center rounded-full border border-zinc-600 bg-zinc-900 text-sm text-zinc-300 shadow hover:border-red-500 hover:text-red-300" style={{ left: (start.x + end.x) / 2, top: (start.y + end.y) / 2, pointerEvents: 'auto', transform: `translate(-50%, -50%) scale(${1 / canvas.scale})` }}>×</button>;
				})}
				{localLaserPoints.map(point => (
					<span
						key={point.id}
						className="laser-trail-point absolute z-[995] h-3 w-3 rounded-full bg-rose-400 shadow-[0_0_12px_4px_rgba(251,113,133,0.8)]"
						style={{ left: point.x, top: point.y, transform: `translate(-50%, -50%) scale(${1 / canvas.scale})` }}
					/>
				))}
				{Object.entries(remoteCursors).flatMap(([peerId, cursor]) => {
					const colour = cursorColour(peerId);
					const remoteIndex = remoteStreams.findIndex(remote => remote.peerId === peerId);
					const label = customLabels[remotePanelId(peerId)] ?? (remoteIndex >= 0 ? `Guest ${remoteIndex + 1}` : `Participant ${peerId.slice(-4)}`);
					return [
						...cursor.laserPoints.map(point => (
							<span
								key={point.id}
								className="laser-trail-point absolute z-[995] h-3 w-3 rounded-full"
								style={{ left: point.x, top: point.y, backgroundColor: colour, boxShadow: `0 0 12px 4px ${colour}cc`, transform: `translate(-50%, -50%) scale(${1 / canvas.scale})` }}
							/>
						)),
						<div
							key={`cursor:${peerId}`}
							data-participant-cursor={peerId}
							className="absolute z-[996]"
							style={{ left: cursor.x, top: cursor.y, transform: `scale(${1 / canvas.scale})`, transformOrigin: 'top left' }}>
							<svg className="h-6 w-5 drop-shadow-md" viewBox="0 0 20 24" aria-hidden="true">
								<path d="M2 1.5v18l4.8-4.7 3.2 7.2 3.2-1.5-3.1-7H17z" fill={colour} stroke="#18181b" strokeWidth="1.4" strokeLinejoin="round" />
							</svg>
							<span className="absolute left-4 top-4 max-w-32 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-zinc-950 shadow-lg" style={{ backgroundColor: colour }}>{label}</span>
						</div>
					];
				})}
				{positionTags.map(tag =>
					tag.w && tag.h ? (
						<div
							key={tag.id}
							className="absolute z-[5] rounded-md border-2 border-dashed border-amber-400/70 bg-amber-400/5 pointer-events-none"
							style={{ left: tag.x, top: tag.y, width: tag.w, height: tag.h }}
							title={customLabels[tag.id] ?? tag.label}
						/>
					) : (
					<div
						key={tag.id}
						className="absolute z-[5] -translate-x-1/2 -translate-y-full"
						style={{ left: tag.x, top: tag.y }}
						title={customLabels[tag.id] ?? tag.label}>
						<span className="position-tag-ripple absolute left-1/2 bottom-0 w-5 h-5 -translate-x-1/2 translate-y-1/2 rounded-full border-2 border-amber-400" />
						<svg className="relative w-6 h-8 drop-shadow-lg" viewBox="0 0 24 32" aria-hidden="true">
							<path d="M12 4v23" stroke="#fbbf24" strokeWidth="2.5" strokeLinecap="round" />
							<path d="M12 5h8l-2.5 4L20 13h-8z" fill="#fbbf24" stroke="#f59e0b" strokeWidth="0.75" strokeLinejoin="round" />
							<circle cx="12" cy="28" r="3.25" fill="#fbbf24" />
							<circle cx="12" cy="28" r="1.25" fill="#18181b" />
						</svg>
					</div>
					)
				)}
				{localStream && localStream.getTracks().length > 0 && (
					<DraggablePanel panelId="local" minimized={minimizedIds.includes('local')} onMinimize={() => minimizePanel('local')} minimizeControlHandled state={fixedPanels.local} {...makePanelHandlers('local')} onToggleDock={() => toggleDock('local')} minWidth={200} minHeight={120} scale={canvas.scale} className="z-10">
						{zoomTagHandle('local', 'You')}
						{/* No onToggleDock: participants are permanently docked, so a
						    bookmark toggle here would be a button that does nothing */}
						<VideoPanel stream={screenShare.sharing ? screenShare.preview : localStream} label={screenShare.sharing ? "Your screen" : customLabels.local ?? 'You'} muted docked={dockedIds.includes('local')} localControls microphoneEnabled={microphoneEnabled} cameraEnabled={cameraEnabled} onToggleMicrophone={toggleMicrophone} cameraDisabled={screenShare.sharing || screenShare.busy} onToggleCamera={() => void toggleCamera()} onMinimize={() => minimizePanel('local')} />
					</DraggablePanel>
				)}

				{remoteStreams.map(({ peerId, stream }, index) => {
					const state = remotePanelStates[peerId];
					if (!state) return null;
					const label = `Guest ${index + 1}`;
					const panelId = remotePanelId(peerId);
					return (
						<DraggablePanel
							key={peerId}
							panelId={panelId}
							minimized={minimizedIds.includes(panelId)}
							onMinimize={() => minimizePanel(panelId)}
							minimizeControlHandled
							state={state}
							onLocalUpdate={next => setRemotePanelStates(prev => ({ ...prev, [peerId]: next }))}
							onSyncUpdate={next => sendPanelUpdate(panelId, next)}
							onBringToFront={() => {
								const z = ++topZRef.current;
								const next = { ...state, z };
								setRemotePanelStates(prev => ({ ...prev, [peerId]: next }));
								sendPanelUpdate(panelId, next);
							}}
							onToggleDock={() => toggleDock(panelId)}
							minWidth={200}
							minHeight={120}
							scale={canvas.scale}
							className="z-10">
							{zoomTagHandle(panelId, label)}
							<VideoPanel
								stream={stream}
								label={customLabels[panelId] ?? label}
								docked={dockedIds.includes(panelId)}
								onMinimize={() => minimizePanel(panelId)}
							/>
						</DraggablePanel>
					);
				})}

				{dynamicPanels.map(panel => (
					<DraggablePanel
						key={panel.id}
						panelId={panel.id}
						minimized={minimizedIds.includes(panel.id)}
						onMinimize={() => minimizePanel(panel.id)}
						landscapeLabel={panel.type === 'daw' ? 'DAW' : panel.type === 'youtube' ? 'YouTube' : panel.type === 'browser' ? 'Browser' : undefined}
						minimizeControlHandled={panel.type === 'whiteboard' || panel.type === 'youtube' || panel.type === 'code' || panel.type === 'daw'}
						state={panel.state}
						excludeFromRecording={panel.type === 'recorder'}
						{...makeDynamicPanelHandlers(panel.id)}
						onToggleDock={() => toggleDock(panel.id)}
						minWidth={panel.type === 'pdf' ? 300 : panel.type === 'whiteboard' ? 360 : panel.type === 'daw' ? 520 : panel.type === 'browser' ? 360 : panel.type === 'recorder' ? 420 : panel.type === 'code' ? 380 : panel.type === 'youtube' ? 280 : panel.type === 'image' ? 180 : 260}
						minHeight={panel.type === 'pdf' ? 300 : panel.type === 'whiteboard' ? 280 : panel.type === 'daw' ? 320 : panel.type === 'browser' ? 240 : panel.type === 'audio' ? (panel.audioTheme && panel.audioTheme !== 'digital' ? 340 : 200) : panel.type === 'image' ? 140 : 60}
						scale={canvas.scale}>
						{zoomTagHandle(panel.id, panelLabels[panel.id] ?? fallbackLabel(panel))}
						{panel.type === 'whiteboard' ? (
							<WhiteboardWidget content={panel.whiteboard} title={customLabels[panel.id] ?? fallbackLabel(panel)}
								onChange={change => {
									setDynamicPanels(previous => previous.map(item => item.id === panel.id ? { ...item, whiteboard: changeBoard(item.whiteboard, change) } : item));
									sendSync({ type: 'whiteboard-change', id: panel.id, change });
								}}
								onClose={() => removePanel(panel.id)} onMinimize={() => minimizePanel(panel.id)}
								docked={dockedIds.includes(panel.id)} onToggleDock={() => toggleDock(panel.id)} />
						) : panel.type === 'note' ? (
							<StickyNote
								title={customLabels[panel.id] ?? panelLabels[panel.id] ?? fallbackLabel(panel)}
								note={panel.note ?? defaultNoteContent()}
								onChange={next => updateNote(panel.id, next)}
								onClose={() => removePanel(panel.id)}
								docked={dockedIds.includes(panel.id)}
								onToggleDock={() => toggleDock(panel.id)}
							/>
						) : panel.type === 'code' ? (
								<CodeWidget
									onMinimize={() => minimizePanel(panel.id)}
								title={customLabels[panel.id] ?? panelLabels[panel.id] ?? fallbackLabel(panel)}
								code={panel.code ?? { text: '', language: 'text' }}
								onChange={next => updateCode(panel.id, next)}
								onClose={() => removePanel(panel.id)}
								docked={dockedIds.includes(panel.id)}
								onToggleDock={() => toggleDock(panel.id)}
							/>
						) : panel.type === 'youtube' ? (
							<YoutubeWidget
								onMinimize={() => minimizePanel(panel.id)}
								title={customLabels[panel.id] ?? panelLabels[panel.id] ?? fallbackLabel(panel)}
								id={panel.id}
								dataConnection={dataConnection}
								initialVideoId={panel.initialVideoId}
								initialPlayback={panel.playback}
								playbackRevision={panel.playbackRevision}
								onPlaybackChange={playback => updatePanelPlayback(panel.id, playback)}
								onVideoChange={videoId => updateDynamicPanel(panel.id, { initialVideoId: videoId })}
								onClose={() => removePanel(panel.id)}
								spatialVolume={spatialVolumeForPanel(panel.state)}
								docked={dockedIds.includes(panel.id)}
								onToggleDock={() => toggleDock(panel.id)}
								onTitleChange={title => setPanelLabels(prev => ({ ...prev, [panel.id]: title }))}
							/>
						) : panel.type === 'daw' ? (
							<DawWidget
								id={panel.id}
								dataConnection={dataConnection}
								minimized={minimizedIds.includes(panel.id)}
								title={customLabels[panel.id] ?? fallbackLabel(panel)}
								tracks={panel.dawTracks ?? []}
								recordings={panel.recordings ?? []}
								onTrack={track => {
									setDynamicPanels(prev => prev.map(p => p.id === panel.id ? { ...p, dawTracks: mergeDawTrack(p.dawTracks, track) } : p));
									sendSync({ type: 'daw-track', id: panel.id, track });
								}}
								onFile={recording => {
									setDynamicPanels(prev => prev.map(p => p.id === panel.id ? { ...p, recordings: [...(p.recordings ?? []).filter(r => r.id !== recording.id), recording] } : p));
									sendFileTo(panel.id, recording.file, recording.id);
								}}
								transferProgress={transferProgress[panel.id]}
								onClose={() => removePanel(panel.id)}
								onMinimize={() => minimizePanel(panel.id)}
								onToggleDock={() => toggleDock(panel.id)}
							/>
						) : panel.type === 'recorder' ? (
							<ScreenRecorderWidget
								title={customLabels[panel.id] ?? panelLabels[panel.id] ?? fallbackLabel(panel)}
								id={panel.id}
								dataConnection={dataConnection}
								getCanvasElement={() => containerRef.current}
								recordings={panel.recordings}
								initialPlayback={panel.playback}
								playbackRevision={panel.playbackRevision}
								onPlaybackChange={playback => updatePanelPlayback(panel.id, playback)}
								onRecordingComplete={recording => {
									updateDynamicPanel(panel.id, { recordings: [...(panel.recordings ?? []), recording] });
									sendFileTo(panel.id, recording.file, recording.id);
								}}
								onStatusChange={status => setRecorderStatuses(prev => ({ ...prev, [panel.id]: status }))}
								transferProgress={transferProgress[panel.id]}
								onClose={() => removePanel(panel.id)}
								docked={dockedIds.includes(panel.id)}
								onToggleDock={() => toggleDock(panel.id)}
							/>
						) : panel.type === 'pdf' ? (
							<PdfWidget file={panel.initialFile} title={customLabels[panel.id] ?? panel.initialFile?.name ?? panel.mediaFileName ?? 'PDF'} page={panel.pdfPage}
								transferProgress={transferProgress[panel.id]} onClose={() => removePanel(panel.id)} docked={dockedIds.includes(panel.id)} onToggleDock={() => toggleDock(panel.id)}
								onRestore={file => { void addPdf(file, 0, 0, panel.id); }}
								onPageChange={page => { updateDynamicPanel(panel.id, { pdfPage: page }); sendSync({ type: 'pdf-page', id: panel.id, page }); }} />
						) : panel.type === 'image' ? (
							<ImageWidget
								file={panel.initialFile}
								title={customLabels[panel.id] ?? panelLabels[panel.id] ?? panel.initialFile?.name ?? fallbackLabel(panel)}
								transferProgress={transferProgress[panel.id]}
								onClose={() => removePanel(panel.id)}
								docked={dockedIds.includes(panel.id)}
								onToggleDock={() => toggleDock(panel.id)}
							/>
						) : panel.type === 'audio' ? (
							<AudioPlayer
								theme={panel.audioTheme}
								onThemeChange={theme => {
									const state = { ...panel.state, width: Math.max(panel.state.width, theme === 'digital' ? 320 : 400), height: theme === 'digital' ? 220 : theme === 'tape' ? 400 : 420 };
									updateDynamicPanel(panel.id, { audioTheme: theme, state });
									sendSync({ type: 'audio-theme', id: panel.id, theme });
									sendPanelUpdate(panel.id, state);
								}}
								title={customLabels[panel.id] ?? panelLabels[panel.id] ?? fallbackLabel(panel)}
								id={panel.id}
								dataConnection={dataConnection}
								initialFile={panel.initialFile}
								initialPlayback={panel.playback}
								playbackRevision={panel.playbackRevision}
								onPlaybackChange={playback => updatePanelPlayback(panel.id, playback)}
								onClose={() => removePanel(panel.id)}
								spatialVolume={spatialVolumeForPanel(panel.state)}
								docked={dockedIds.includes(panel.id)}
								onToggleDock={() => toggleDock(panel.id)}
								onTrackChange={name => setPanelLabels(prev => ({ ...prev, [panel.id]: name }))}
								transferProgress={transferProgress[panel.id]}
								onFileChosen={file => {
									updateDynamicPanel(panel.id, { initialFile: file });
									sendFileTo(panel.id, file);
								}}
							/>
						) : (
							<BrowserWidget
								roomCode={roomCode}
								panelId={panel.id}
								title={customLabels[panel.id] ?? panelLabels[panel.id] ?? fallbackLabel(panel)}
								initialUrl={panel.initialUrl}
								onClose={() => removePanel(panel.id)}
								docked={dockedIds.includes(panel.id)}
								onToggleDock={() => toggleDock(panel.id)}
								onUrlChange={url => {
									updateDynamicPanel(panel.id, { initialUrl: url, browserScroll: undefined });
									setPanelLabels(previous => ({ ...previous, [panel.id]: new URL(url).hostname }));
									sendSync({ type: 'browser-load', id: panel.id, url });
								}}
							/>
						)}
					</DraggablePanel>
				))}
				{wbTool === 'connector' && dynamicPanels.map(panel => (
					<button
						key={`connector-target:${panel.id}`}
						type="button"
						onClick={() => selectConnectorPanel(panel.id)}
						aria-label={`${connectorStartId ? 'Connect to' : 'Start connector from'} ${panelLabels[panel.id] ?? fallbackLabel(panel)}`}
						className={`absolute rounded-xl border-2 transition-colors ${connectorStartId === panel.id ? 'border-brand-300 bg-brand-400/20' : 'border-brand-500/70 bg-brand-500/5 hover:bg-brand-500/20'}`}
						style={{ left: panel.state.x, top: panel.state.y, width: panel.state.width, height: panel.state.height, zIndex: 10000 + panel.state.z, pointerEvents: 'auto' }}
					/>
				))}
			</div>

			</PanelOverviewContext.Provider>
			<CanvasSystemControls overview={overviewOpen} onFit={fitScreen} onShowAll={() => setOverviewOpen(open => !open)} />
			{/* Dock — fixed overlay above the canvas; shortcuts back to docked panels */}
			<Dock entries={dockEntries} onJump={jumpToPanel} onRemove={removeDockEntry} onRename={renameDockEntry} onPing={pingDockEntry} onParticipantDoubleClick={handleParticipantDoubleClick} />
		</div>
	);
}
