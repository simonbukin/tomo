import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Frame, Id } from "./types";

export class RpcFailure extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export async function rpc<T = unknown>(method: string, params?: unknown): Promise<T> {
  try {
    return await invoke<T>("rpc", { method, params: params ?? null });
  } catch (e) {
    const err = e as { code?: string; message?: string };
    throw new RpcFailure(err?.code ?? "internal", err?.message ?? String(e));
  }
}

type PaneSink = (bytes: Uint8Array) => void;
const paneSinks = new Map<Id, Set<PaneSink>>();
const frameSinks = new Set<(f: Frame) => void>();
const stateSinks = new Set<(connected: boolean) => void>();

export function onPaneOutput(paneId: Id, sink: PaneSink): () => void {
  const set = paneSinks.get(paneId) ?? new Set();
  set.add(sink);
  paneSinks.set(paneId, set);
  return () => {
    set.delete(sink);
    if (set.size === 0) paneSinks.delete(paneId);
  };
}

export function onFrame(sink: (f: Frame) => void): () => void {
  frameSinks.add(sink);
  return () => frameSinks.delete(sink);
}

export function onConnection(sink: (connected: boolean) => void): () => void {
  stateSinks.add(sink);
  return () => stateSinks.delete(sink);
}

export function decodeBase64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

let started = false;
export async function startEventPump(): Promise<void> {
  if (started) return;
  started = true;
  await listen<string>("daemon-event", (e) => {
    let frame: Frame & { data?: { pane_id?: string; data_base64?: string } };
    try {
      frame = JSON.parse(e.payload);
    } catch {
      return;
    }
    if (frame.event === "pane_output" && frame.data?.pane_id) {
      const sinks = paneSinks.get(frame.data.pane_id);
      if (sinks && frame.data.data_base64) {
        const bytes = decodeBase64(frame.data.data_base64);
        sinks.forEach((s) => s(bytes));
      }
      return;
    }
    frameSinks.forEach((s) => s(frame));
  });
  await listen<{ connected: boolean }>("daemon-state", (e) => {
    stateSinks.forEach((s) => s(e.payload.connected));
  });
  const connected = await invoke<boolean>("daemon_connected");
  if (connected) stateSinks.forEach((s) => s(true));
}
