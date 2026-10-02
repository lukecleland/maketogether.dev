import { useState, useEffect, useRef, useCallback } from "react";
import Peer, { type DataConnection, type MediaConnection } from "peerjs";
import type { PanelState } from '../types/panels';
import { participantPanelsForReceiver } from '../utils/participantPanels';

export type PeerStatus = "idle" | "connecting" | "waiting" | "connected" | "error";

export interface RemotePeerStream {
  peerId: string;
  stream: MediaStream;
}

/**
 * A stable, DataConnection-compatible facade over every connection in the
 * room. Existing sync hooks can listen once and broadcast without knowing
 * whether the room currently contains one, two, or three remote peers.
 */
export interface RoomDataConnection {
  readonly open: boolean;
  readonly isLead?: boolean;
  readonly dataChannel?: RTCDataChannel;
  on(event: "data", listener: (data: unknown) => void): void;
  off(event: "data", listener: (data: unknown) => void): void;
  send(data: unknown): void;
}

class MeshDataConnection implements RoomDataConnection {
  private connections = new Map<string, DataConnection>();
  private listeners = new Set<(data: unknown) => void>();
  private localPeerId = "";
  private roomPeerId = "";
  private seenMessages = new Set<string>();

  configure(localPeerId: string, roomPeerId: string) {
    this.localPeerId = localPeerId;
    this.roomPeerId = roomPeerId;
  }

  get isLead() { return this.localPeerId === this.roomPeerId; }

  get open() {
    return [...this.connections.values()].some(connection => connection.open);
  }

  get dataChannel() {
    return [...this.connections.values()].find(connection => connection.open)?.dataChannel;
  }

  on(_event: "data", listener: (data: unknown) => void) {
    this.listeners.add(listener);
  }

  off(_event: "data", listener: (data: unknown) => void) {
    this.listeners.delete(listener);
  }

  emit(data: unknown) {
    this.listeners.forEach(listener => listener(data));
  }

  accept(messageId: string) {
    if (this.seenMessages.has(messageId)) return false;
    this.seenMessages.add(messageId);
    if (this.seenMessages.size > 2_000) {
      const oldest = this.seenMessages.values().next().value;
      if (oldest) this.seenMessages.delete(oldest);
    }
    return true;
  }

  relay(message: MeshMessage, exceptPeerId: string) {
    for (const [peerId, connection] of this.connections) {
      if (peerId !== exceptPeerId && connection.open) connection.send(message);
    }
  }

  add(connection: DataConnection) {
    this.connections.set(connection.peer, connection);
  }

  remove(peerId: string, connection: DataConnection) {
    if (this.connections.get(peerId) === connection) this.connections.delete(peerId);
  }

  has(peerId: string) {
    return this.connections.get(peerId)?.open ?? false;
  }

  peers() {
    return [...this.connections.entries()]
      .filter(([, connection]) => connection.open)
      .map(([peerId]) => peerId);
  }

  send(data: unknown) {
    if (typeof data !== "object" || data === null) return;
    const message = {
      ...data,
      __meshMessageId: crypto.randomUUID(),
      __meshSourcePeerId: this.localPeerId,
    } as MeshMessage;
    this.accept(message.__meshMessageId);
    for (const connection of this.connections.values()) {
      if (connection.open) connection.send(message);
    }
  }

  closeAll() {
    const connections = [...this.connections.values()];
    this.connections.clear();
    connections.forEach(connection => connection.close());
  }
}

interface UsePeerOptions {
  roomCode: string;
  isHost: boolean;
  localStream: MediaStream | null;
}

interface UsePeerResult {
  remoteStreams: RemotePeerStream[];
  dataConnection: RoomDataConnection | null;
  participantCount: number;
  status: PeerStatus;
  error: string | null;
  mediaStatus: string | null;
  retryMedia: () => void;
  replaceVideoTrack: (track: MediaStreamTrack | null) => Promise<void>;
}

type RoomRole = "owner" | "joiner";
// Keep the wire identifier compatible with clients running earlier releases.
type MeshControl =
  | { __watchTogether: "media-capabilities"; canSendMedia: boolean }
  | { __watchTogether: "media-retry" }
  | { __watchTogether: "roster"; peers: string[] }
  | { __watchTogether: "room-full" }
  | { __watchTogether: "ping"; nonce: string }
  | { __watchTogether: "pong"; nonce: string };

type MeshMessage = {
  __meshMessageId: string;
  __meshSourcePeerId: string;
} & Record<string, unknown>;

const MAX_PARTICIPANTS = 4;

function isMeshControl(data: unknown): data is MeshControl {
  return (
    typeof data === "object" &&
    data !== null &&
    "__watchTogether" in data
  );
}

function isMeshMessage(data: unknown): data is MeshMessage {
  return typeof data === "object" && data !== null && "__meshMessageId" in data && typeof data.__meshMessageId === "string" && "__meshSourcePeerId" in data && typeof data.__meshSourcePeerId === "string";
}

function identifyPeerMessage(
  data: unknown,
  sourcePeerId: string,
  localPeerId: string,
): unknown {
  if (typeof data !== "object" || data === null) return data;
  const panelId = (id: string) => id === "local"
    ? `remote-peer:${sourcePeerId}`
    : id === `remote-peer:${localPeerId}` ? "local" : id;
  // Snapshot keys need the same receiver perspective as live dock messages.
  const message = data as { id?: unknown; type?: string; snapshot?: { dockedIds: string[]; customLabels: Record<string, string>; fixedPanels?: Record<'local' | 'remote', PanelState>; remotePanels?: Record<string, PanelState> } };
  if (message.type === "room-state-snapshot" && message.snapshot) {
    return { ...data, snapshot: { ...message.snapshot,
      ...(message.snapshot.fixedPanels ? participantPanelsForReceiver(message.snapshot.fixedPanels, message.snapshot.remotePanels, sourcePeerId, localPeerId) : {}),
      dockedIds: message.snapshot.dockedIds.map(panelId),
      customLabels: Object.fromEntries(Object.entries(message.snapshot.customLabels).map(([id, label]) => [panelId(id), label])),
    } };
  }
  return typeof message.id === "string" ? { ...data, id: panelId(message.id) } : data;
}

function configuredIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun3.l.google.com:19302" },
    { urls: "stun:stun4.l.google.com:19302" },
  ];
  const urls = import.meta.env.VITE_TURN_URLS?.split(",")
    .map((url: string) => url.trim())
    .filter(Boolean);
  const username = import.meta.env.VITE_TURN_USERNAME?.trim();
  const credential = import.meta.env.VITE_TURN_CREDENTIAL?.trim();
  if (urls?.length && username && credential) {
    servers.push({ urls, username, credential });
  } else {
    // Supplying `config` to PeerJS replaces its complete default ICE config.
    // Keep PeerJS Cloud's public relay as a last-resort path when a deployment
    // has not supplied dedicated TURN credentials. STUN-only works on a local
    // network but fails for many cellular, corporate and symmetric-NAT pairs.
    servers.push({
      urls: [
        "turn:eu-0.turn.peerjs.com:3478",
        "turn:us-0.turn.peerjs.com:3478",
      ],
      username: "peerjs",
      credential: "peerjsp",
    });
  }
  return servers;
}

const peerOptions: NonNullable<ConstructorParameters<typeof Peer>[1]> = {
  debug: 0,
  config: {
    iceServers: configuredIceServers(),
    iceCandidatePoolSize: 10,
    iceTransportPolicy: "all",
    sdpSemantics: "unified-plan",
  },
};

export function usePeer({
  roomCode,
  isHost,
  localStream,
}: UsePeerOptions): UsePeerResult {
  const [remoteStreams, setRemoteStreams] = useState<RemotePeerStream[]>([]);
  const [dataConnection, setDataConnection] = useState<RoomDataConnection | null>(null);
  const [participantCount, setParticipantCount] = useState(1);
  const [status, setStatus] = useState<PeerStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const [mediaStatus, setMediaStatus] = useState<string | null>(null);
  const retryMediaRef = useRef<() => void>(() => {});
  const retryMedia = useCallback(() => retryMediaRef.current(), []);

  const peerRef = useRef<Peer | null>(null);
  const meshRef = useRef(new MeshDataConnection());
  const callsRef = useRef<Map<string, MediaConnection>>(new Map());
  const videoSendersRef = useRef<Set<RTCRtpSender>>(new Set());

  const replaceVideoTrack = useCallback(async (track: MediaStreamTrack | null) => {
    const replacements: Promise<void>[] = [];
    for (const call of callsRef.current.values()) {
      const sender = call.peerConnection.getSenders().find(candidate => candidate.track?.kind === "video" || videoSendersRef.current.has(candidate));
      if (sender) videoSendersRef.current.add(sender);
      if (sender) replacements.push(sender.replaceTrack(track));
      else if (track) call.close();
    }
    await Promise.all(replacements);
  }, []);

  useEffect(() => {
    if (!localStream) return;

    let active = true;
    let role: RoomRole = isHost ? "owner" : "joiner";
    let roomFull = false;
    let transitionTimer: ReturnType<typeof setTimeout> | null = null;
    let signalingTimer: ReturnType<typeof setTimeout> | null = null;
    const roomId = roomCode.toLowerCase();
    const mesh = meshRef.current;
    const dataConnections = new Map<string, DataConnection>();
    const calls = new Map<string, MediaConnection>();
    callsRef.current = calls;
    const mediaRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const streams = new Map<string, MediaStream>();
    const capabilities = new Map<string, boolean>();
    const attempts = new Map<string, number>();
    const callCleanups = new Map<MediaConnection, () => void>();
    const hasMedia = () => localStream.getTracks().some(track => track.readyState !== "ended");
    const publishMediaStatus = () => {
      const peers = mesh.peers();
      const pending = peers.filter(id => (hasMedia() || capabilities.get(id) !== false) &&
        calls.get(id)?.peerConnection?.connectionState !== "connected");
      setMediaStatus(!peers.length ? null : pending.length
        ? pending.some(id => (attempts.get(id) ?? 0) >= 5)
          ? "Audio/video could not connect. Retry, or try another network."
          : `Connecting audio/video with ${pending.length} participant${pending.length === 1 ? "" : "s"}…`
        : !hasMedia() && peers.every(id => capabilities.get(id) === false)
          ? "Everyone joined without a camera or microphone."
          : null);
    };

    const publishStreams = () => {
      setRemoteStreams(
        [...streams.entries()].map(([peerId, stream]) => ({ peerId, stream })),
      );
    };

    const publishConnectionState = () => {
      setParticipantCount(mesh.peers().length + 1);
      if (mesh.open) {
        setDataConnection(mesh);
        setStatus("connected");
        setError(null);
      } else {
        setDataConnection(null);
        setStatus(role === "owner" ? "waiting" : "connecting");
      }
    };

    const clearTransition = () => {
      if (transitionTimer) clearTimeout(transitionTimer);
      transitionTimer = null;
    };

    const clearMesh = () => {
      callCleanups.forEach(cleanup => cleanup());
      callCleanups.clear();
      capabilities.clear();
      attempts.clear();
      setMediaStatus(null);
      dataConnections.clear();
      mesh.closeAll();
      for (const call of calls.values()) call.close();
      calls.clear();
      mediaRetryTimers.forEach(clearTimeout);
      mediaRetryTimers.clear();
      streams.clear();
      setRemoteStreams([]);
      setDataConnection(null);
      setParticipantCount(1);
    };

    const broadcastRoster = (peer: Peer) => {
      if (role !== "owner" || !peer.open) return;
      const peers = [peer.id, ...mesh.peers()].slice(0, MAX_PARTICIPANTS);
      for (const connection of dataConnections.values()) {
        if (connection.open) {
          connection.send({ __watchTogether: "roster", peers } satisfies MeshControl);
        }
      }
    };

    const shouldInitiateCall = (peer: Peer, targetId: string) =>
      hasMedia() && (capabilities.get(targetId) === false || peer.id.localeCompare(targetId) > 0);

    const scheduleCall = (peer: Peer, targetId: string, delay = 120) => {
      if (!active || calls.has(targetId) || mediaRetryTimers.has(targetId) || (attempts.get(targetId) ?? 0) >= 5) return;
      const timer = setTimeout(() => {
        mediaRetryTimers.delete(targetId);
        if (active && mesh.has(targetId) && shouldInitiateCall(peer, targetId)) callPeer(peer, targetId);
      }, delay);
      mediaRetryTimers.set(targetId, timer);
    };

    const setupCall = (peer: Peer, call: MediaConnection) => {
      const previous = calls.get(call.peer);
      calls.set(call.peer, call);
      if (previous && previous !== call) {
        callCleanups.get(previous)?.();
        previous.close();
      }
      let wasConnected = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const pc = call.peerConnection;
      const recover = () => {
        if (!active || calls.get(call.peer) !== call) return;
        cleanup();
        calls.delete(call.peer);
        streams.delete(call.peer);
        call.close();
        if (wasConnected && !shouldInitiateCall(peer, call.peer)) {
          dataConnections.get(call.peer)?.send({ __watchTogether: "media-retry" } satisfies MeshControl);
        }
        publishStreams();
        scheduleCall(peer, call.peer, Math.min(1000 * (attempts.get(call.peer) ?? 1), 5000));
        publishMediaStatus();
      };
      const monitor = () => {
        if (!active || calls.get(call.peer) !== call) return;
        if (pc.connectionState === "connected") {
          wasConnected = true;
          if (timer) clearTimeout(timer);
          timer = undefined;
          attempts.delete(call.peer);
        } else if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          recover();
        } else if (!timer) {
          timer = setTimeout(recover, pc.connectionState === "disconnected" ? 12_000 : 20_000);
        }
        publishMediaStatus();
      };
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        pc.removeEventListener("connectionstatechange", monitor);
        callCleanups.delete(call);
      };
      callCleanups.set(call, cleanup);
      pc.addEventListener("connectionstatechange", monitor);
      monitor();

      call.on("stream", stream => {
        if (!active || calls.get(call.peer) !== call) return;
        streams.set(call.peer, stream);
        publishStreams();
      });
      call.on("close", recover);
      call.on("error", recover);
    };

    const callPeer = (peer: Peer, targetId: string) => {
      if (calls.has(targetId) || !hasMedia() || !peer.open) return;
      attempts.set(targetId, (attempts.get(targetId) ?? 0) + 1);
      const call = peer.call(targetId, localStream);
      if (call) setupCall(peer, call);
    };

    const dialMeshPeer = (peer: Peer, targetId: string) => {
      if (
        !active ||
        targetId === peer.id ||
        mesh.has(targetId) ||
        dataConnections.has(targetId)
      )
        return;
      setupDataConnection(
        peer,
        peer.connect(targetId, {
          reliable: true,
          metadata: { canSendMedia: localStream.getTracks().length > 0 },
        }),
      );
    };

    const handleRoster = (peer: Peer, peers: string[]) => {
      const members = peers.slice(0, MAX_PARTICIPANTS);
      for (const targetId of members) {
        if (targetId === peer.id || targetId === roomId) continue;
        // Exactly one side initiates each non-owner mesh edge.
        if (peer.id.localeCompare(targetId) > 0) dialMeshPeer(peer, targetId);
      }
    };

    function setupDataConnection(peer: Peer, connection: DataConnection) {
      const existing = dataConnections.get(connection.peer);
      if (existing && existing !== connection) {
        connection.close();
        return;
      }
      dataConnections.set(connection.peer, connection);
      let lastSeenAt = Date.now();
      let heartbeatConfirmed = false;
      let resumedFromBackground = false;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      // PeerJS can leave a data connection in its pre-open state indefinitely
      // when ICE has no viable route. Give recovery a deterministic trigger so
      // a joiner can retry/claim the room instead of displaying Connecting…
      // forever.
      let negotiationTimer: ReturnType<typeof setTimeout> | null = setTimeout(
        () => {
          negotiationTimer = null;
          if (
            active &&
            dataConnections.get(connection.peer) === connection &&
            !connection.open
          ) {
            connection.close();
            remove();
          }
        },
        20_000,
      );

      connection.on("open", () => {
        if (!active || dataConnections.get(connection.peer) !== connection) return;
        if (negotiationTimer) clearTimeout(negotiationTimer);
        negotiationTimer = null;

        if (
          role === "owner" &&
          !mesh.has(connection.peer) &&
          mesh.peers().length >= MAX_PARTICIPANTS - 1
        ) {
          connection.send({ __watchTogether: "room-full" } satisfies MeshControl);
          connection.close();
          return;
        }

        mesh.add(connection);
        lastSeenAt = Date.now();
        heartbeat = setInterval(() => {
          // Browsers throttle timers in background tabs. Treat that suspension
          // as a local scheduling gap, not evidence that the remote peer died.
          if (document.hidden) {
            resumedFromBackground = true;
            lastSeenAt = Date.now();
            return;
          }
          if (resumedFromBackground) {
            resumedFromBackground = false;
            lastSeenAt = Date.now();
          }
          const connectionState = connection.peerConnection.connectionState;
          const transportFailed = connectionState === "failed" || connectionState === "disconnected" || connectionState === "closed";
          if (heartbeatConfirmed && transportFailed && Date.now() - lastSeenAt > 15_000) {
            connection.close();
            return;
          }
          try {
            connection.send({ __watchTogether: "ping", nonce: crypto.randomUUID() } satisfies MeshControl);
          } catch {
            connection.close();
          }
        }, 2_000);
        clearTransition();
        publishConnectionState();
        if (role === "owner") broadcastRoster(peer);

        // Metadata belongs to the data-channel initiator, not necessarily the
        // remote participant. Exchange capabilities in both directions instead.
        connection.send({ __watchTogether: "media-capabilities", canSendMedia: hasMedia() } satisfies MeshControl);
        scheduleCall(peer, connection.peer);
        publishMediaStatus();
      });

      connection.on("data", raw => {
        if (!active || dataConnections.get(connection.peer) !== connection) return;
        lastSeenAt = Date.now();
        if (isMeshMessage(raw)) {
          if (!mesh.accept(raw.__meshMessageId)) return;
          mesh.relay(raw, connection.peer);
          if (!raw.__meshTargetPeerId || raw.__meshTargetPeerId === peer.id)
            mesh.emit(identifyPeerMessage(raw, raw.__meshSourcePeerId, peer.id));
          return;
        }
        if (isMeshControl(raw)) {
          if (raw.__watchTogether === "media-capabilities") {
            capabilities.set(connection.peer, raw.canSendMedia);
            scheduleCall(peer, connection.peer);
            publishMediaStatus();
          }
          if (raw.__watchTogether === "media-retry") {
            const call = calls.get(connection.peer);
            if (call) {
              callCleanups.get(call)?.();
              calls.delete(connection.peer);
              streams.delete(connection.peer);
              call.close();
              publishStreams();
            }
            attempts.delete(connection.peer);
            scheduleCall(peer, connection.peer);
            publishMediaStatus();
          }
          if (raw.__watchTogether === "roster") handleRoster(peer, raw.peers);
          if (raw.__watchTogether === "room-full") {
            roomFull = true;
            setError("This room is full (maximum 4 people).");
            setStatus("error");
          }
          if (raw.__watchTogether === "ping") connection.send({ __watchTogether: "pong", nonce: raw.nonce } satisfies MeshControl);
          if (raw.__watchTogether === "pong") heartbeatConfirmed = true;
          return;
        }
        mesh.emit(identifyPeerMessage(raw, connection.peer, peer.id));
      });

      const remove = () => {
        if (negotiationTimer) clearTimeout(negotiationTimer);
        negotiationTimer = null;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        if (!active || dataConnections.get(connection.peer) !== connection) return;
        dataConnections.delete(connection.peer);
        mesh.remove(connection.peer, connection);
        const call = calls.get(connection.peer);
        calls.delete(connection.peer);
        if (call) callCleanups.get(call)?.();
        call?.close();
        capabilities.delete(connection.peer);
        attempts.delete(connection.peer);
        streams.delete(connection.peer);
        publishStreams();
        publishMediaStatus();
        if (roomFull) return;
        publishConnectionState();
        if (role === "owner") broadcastRoster(peer);
        else if (connection.peer === roomId) recoverRoom();
      };
      connection.on("close", remove);
      connection.on("error", remove);
    }

    const dialOwner = (peer: Peer) => {
      if (!active || peerRef.current !== peer || !peer.open) return;
      setStatus("connecting");
      dialMeshPeer(peer, roomId);
    };

    const createPeer = (nextRole: RoomRole) => {
      if (!active) return;
      clearTransition();
      role = nextRole;
      clearMesh();
      peerRef.current?.destroy();

      const peer =
        nextRole === "owner" ? new Peer(roomId, peerOptions) : new Peer(peerOptions);
      peerRef.current = peer;
      setStatus("connecting");

      peer.on("connection", connection => setupDataConnection(peer, connection));
      peer.on("call", call => {
        // The owner rejects unsolicited fifth-member media calls.
        if (
          role === "owner" &&
          !dataConnections.has(call.peer) &&
          mesh.peers().length >= MAX_PARTICIPANTS - 1
        ) {
          call.close();
          return;
        }
        call.answer(localStream);
        setupCall(peer, call);
      });

      peer.on("open", () => {
        if (!active || peerRef.current !== peer) return;
        setError(null);
        mesh.configure(peer.id, roomId);
        if (mesh.open) {
          publishConnectionState();
          mesh.peers().forEach(id => scheduleCall(peer, id));
        } else if (role === "owner") setStatus("waiting");
        else dialOwner(peer);
      });

      peer.on("disconnected", () => {
        if (!active || peerRef.current !== peer || peer.destroyed) return;
        setStatus("connecting");
        if (signalingTimer) clearTimeout(signalingTimer);
        signalingTimer = setTimeout(() => {
          signalingTimer = null;
          if (active && peerRef.current === peer && !peer.destroyed && peer.disconnected) {
            peer.reconnect();
          }
        }, 1_000);
      });

      peer.on("error", peerError => {
        if (!active || peerRef.current !== peer) return;
        if (peerError.type === "unavailable-id" && role === "owner") {
          if (!transitionTimer) {
            transitionTimer = setTimeout(() => createPeer("joiner"), 300);
          }
          return;
        }
        if (peerError.type === "peer-unavailable" && role === "joiner") {
          if (!transitionTimer) {
            setError("Restoring the session…");
            transitionTimer = setTimeout(() => createPeer("owner"), 500);
          }
          return;
        }
        setError(`Connection error: ${peerError.message}`);
        setStatus("error");
      });
    };

    function recoverRoom() {
      if (!active || role === "owner" || transitionTimer) return;
      setStatus("connecting");
      setError("Restoring the session…");
      transitionTimer = setTimeout(() => createPeer("owner"), 500);
    }

    retryMediaRef.current = () => {
      const peer = peerRef.current;
      if (!peer || !active) return;
      attempts.clear();
      for (const id of mesh.peers()) {
        if (calls.get(id)?.peerConnection.connectionState === "connected") continue;
        const call = calls.get(id);
        if (call) {
          callCleanups.get(call)?.();
          calls.delete(id);
          call.close();
        }
        dataConnections.get(id)?.send({ __watchTogether: "media-retry" } satisfies MeshControl);
        scheduleCall(peer, id);
      }
      publishMediaStatus();
    };
    createPeer(role);

    return () => {
      active = false;
      retryMediaRef.current = () => {};
      clearTransition();
      if (signalingTimer) clearTimeout(signalingTimer);
      clearMesh();
      if (callsRef.current === calls) callsRef.current = new Map();
      peerRef.current?.destroy();
      peerRef.current = null;
    };
  }, [localStream, roomCode, isHost]);

  return { remoteStreams, dataConnection, participantCount, status, error, mediaStatus, retryMedia, replaceVideoTrack };
}
