import { useEffect, useEffectEvent, useRef } from "react";
import type { RoomDataConnection } from "./usePeer";
import {
  compareDawActivity,
  dawActivityPosition,
  validDawActivity,
  type DawActivity,
} from "../utils/dawSync";

export interface DawView {
  selected: string | null;
  region: string | null;
  zoom: number;
  tempo?: number;
  click?: boolean;
  countIn?: boolean;
  snap?: boolean;
}
export interface DawVoice {
  trackId: string;
  pitch: number;
}
interface SharedView extends DawView {
  revision: number;
  id: string;
}

export function useDawSync(
  id: string,
  connection: RoomDataConnection | null | undefined,
  receive: (activity: DawActivity) => void,
  preview: () => Pick<DawActivity, "peaks" | "notes">,
  receiveView: (view: DawView) => void,
  receiveVoices: (owner: string, voices: DawVoice[]) => void,
) {
  const owner = useRef(crypto.randomUUID());
  const latest = useRef<DawActivity | null>(null);
  const lastSeen = useRef(0);
  const view = useRef<SharedView>({
    selected: null,
    region: null,
    zoom: 0,
    tempo: 120, click: false, countIn: false, snap: false,
    revision: 0,
    id: "",
  });
  const voices = useRef<DawVoice[]>([]);
  const remoteVoices = useRef(new Map<string, number>());
  const onVoices = useEffectEvent(receiveVoices);
  const publishVoices = (next: DawVoice[]) => {
    voices.current = next;
    if (connection?.open)
      connection.send({
        type: "daw-voices",
        panelId: id,
        owner: owner.current,
        voices: next,
      });
  };
  const onView = useEffectEvent(receiveView);
  const publishView = (patch: Partial<DawView>) => {
    view.current = {
      ...view.current,
      ...patch,
      revision: view.current.revision + 1,
      id: crypto.randomUUID(),
    };
    if (connection?.open)
      connection.send({ type: "daw-view", panelId: id, view: view.current });
  };
  const onReceive = useEffectEvent(receive);
  const getPreview = useEffectEvent(preview);
  const send = (activity: DawActivity) => {
    if (connection?.open)
      connection.send({ type: "daw-activity", panelId: id, activity });
  };
  const publish = (
    mode: DawActivity["mode"],
    position: number,
    trackId?: string,
    countInEndsAt?: number,
  ) => {
    const activity: DawActivity = {
      revision: (latest.current?.revision ?? 0) + 1,
      id: crypto.randomUUID(),
      owner: owner.current,
      mode,
      position: Math.min(1800, Math.max(0, position)),
      at: Date.now(),
      trackId,
      countInEndsAt,
    };
    latest.current = activity;
    send(activity);
    return activity;
  };
  useEffect(() => {
    if (!connection) return;
    const heldRemoteVoices = remoteVoices.current;
    const listener = (raw: unknown) => {
      if (!raw || typeof raw !== "object") return;
      const message = raw as {
        type?: string;
        panelId?: string;
        activity?: unknown;
        view?: SharedView;
        owner?: string;
        voices?: DawVoice[];
      };
      if (message.panelId !== id) return;
      if (message.type === "daw-voices") {
        if (
          typeof message.owner !== "string" ||
          message.owner === owner.current ||
          !Array.isArray(message.voices) ||
          message.voices.length > 128 ||
          !message.voices.every(
            (v) =>
              v &&
              typeof v.trackId === "string" &&
              Number.isInteger(v.pitch) &&
              v.pitch >= 0 &&
              v.pitch <= 127,
          )
        )
          return;
        if (message.voices.length)
          remoteVoices.current.set(message.owner, Date.now());
        else remoteVoices.current.delete(message.owner);
        onVoices(message.owner, message.voices);
        return;
      }
      if (message.type === "daw-view") {
        const next = message.view;
        if (
          !next ||
          !Number.isSafeInteger(next.revision) ||
          next.revision < 0 ||
          typeof next.id !== "string" ||
          !Number.isFinite(next.zoom) ||
          next.zoom < 0 ||
          next.zoom > 100 ||
          (next.tempo !== undefined && (!Number.isFinite(next.tempo) || next.tempo < 30 || next.tempo > 300)) ||
          (next.click !== undefined && typeof next.click !== "boolean") ||
          (next.countIn !== undefined && typeof next.countIn !== "boolean") ||
          (next.snap !== undefined && typeof next.snap !== "boolean") ||
          !(next.selected === null || typeof next.selected === "string") ||
          !(next.region === null || typeof next.region === "string")
        )
          return;
        if (
          next.revision < view.current.revision ||
          (next.revision === view.current.revision &&
            next.id <= view.current.id)
        )
          return;
        view.current = next;
        onView(next);
        return;
      }
      if (message.type === "daw-activity-request") {
        if (connection.open)
          connection.send({
            type: "daw-view",
            panelId: id,
            view: view.current,
          });
        if (latest.current && connection.open)
          connection.send({
            type: "daw-activity",
            panelId: id,
            activity: latest.current,
          });
        return;
      }
      if (
        message.type !== "daw-activity" ||
        !validDawActivity(message.activity)
      )
        return;
      const activity = message.activity;
      if (latest.current && compareDawActivity(activity, latest.current) < 0)
        return;
      if (activity.owner === owner.current) return;
      latest.current = activity;
      lastSeen.current = Date.now();
      onReceive(activity);
    };
    connection.on("data", listener);
    if (connection.open)
      connection.send({ type: "daw-activity-request", panelId: id });
    const recover = () => {
      if (document.visibilityState === 'hidden') return;
      // A sleeping phone must fetch current commands before declaring its owner lost.
      lastSeen.current = Date.now();
      if (connection.open) connection.send({ type: "daw-activity-request", panelId: id });
    };
    document.addEventListener('visibilitychange', recover);
    let tick = 0;
    const timer = setInterval(() => {
      tick++;
      for (const [peer, at] of remoteVoices.current) {
        if (Date.now() - at > 2000) {
          remoteVoices.current.delete(peer);
          onVoices(peer, []);
        }
      }
      if (voices.current.length && connection.open)
        connection.send({
          type: "daw-voices",
          panelId: id,
          owner: owner.current,
          voices: voices.current,
        });
      const activity = latest.current;
      if (!activity) {
        if (tick % 8 === 0 && connection.open)
          connection.send({ type: "daw-activity-request", panelId: id });
        return;
      }
      if (activity.mode !== "recording" && tick % 4 !== 0) return;
      if (activity.owner === owner.current) {
        // Periodic snapshots let late joiners catch up without replaying controls.
        const snapshot =
          activity.mode === "recording"
            ? { ...activity, ...getPreview() }
            : activity;
        latest.current = snapshot;
        if (connection.open)
          connection.send({
            type: "daw-activity",
            panelId: id,
            activity: snapshot,
          });
      } else if (
        activity.mode !== "stopped" &&
        Date.now() - lastSeen.current > 8000
      ) {
        const stopped: DawActivity = {
          ...activity,
          mode: "stopped",
          position: dawActivityPosition(activity),
          revision: activity.revision + 1,
          id: crypto.randomUUID(),
          owner: owner.current,
          at: Date.now(),
        };
        latest.current = stopped;
        onReceive(stopped);
        if (connection.open)
          connection.send({
            type: "daw-activity",
            panelId: id,
            activity: stopped,
          });
      }
    }, 250);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', recover);
      connection.off("data", listener);
      for (const peer of heldRemoteVoices.keys()) onVoices(peer, []);
      heldRemoteVoices.clear();
    };
  }, [connection, id]);
  return { publish, publishView, publishVoices, ownerId: owner.current };
}
