/**
 * Pipeline instrumentation, structured logging, and WebSocket message logging.
 * Provides ring-buffered logs for debugging TTS/STT timing and server events.
 */

import type { ServerResponse } from "http";
import type { PipelineEvent, ServerLogEntry, WsLogEntry, BroadcastFn } from "./types.js";

// --- Pipeline Event Log ---

const pipelineLog: PipelineEvent[] = [];

export function plog(event: string, detail?: string) {
  pipelineLog.push({ ts: Date.now(), event, detail });
  if (pipelineLog.length > 1000) pipelineLog.shift();
}

export function resetPipelineLog() {
  pipelineLog.length = 0;
}

export function broadcastPipelineTrace(broadcast: BroadcastFn) {
  if (pipelineLog.length > 0) {
    broadcast({ type: "pipeline_trace", events: pipelineLog });
  }
}

export function getPipelineLog(): readonly PipelineEvent[] {
  return pipelineLog;
}

// --- Structured Server Log ---

const _serverLog: ServerLogEntry[] = [];
const _sseClients = new Set<ServerResponse>();

export function slog(cat: string, event: string, detail?: Record<string, unknown>) {
  const entry: ServerLogEntry = { ts: Date.now(), cat, event, detail };
  _serverLog.push(entry);
  if (_serverLog.length > 500) _serverLog.shift();
  const line = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of Array.from(_sseClients)) {
    try { res.write(line); } catch { _sseClients.delete(res); }
  }
}

export function getServerLog(): readonly ServerLogEntry[] {
  return _serverLog;
}

export function addSseClient(res: ServerResponse) {
  _sseClients.add(res);
}

export function removeSseClient(res: ServerResponse) {
  _sseClients.delete(res);
}

// --- WebSocket Message Log ---

const _serverWsLog: WsLogEntry[] = [];

export function wslog(dir: "in" | "out", type: string, size?: number) {
  _serverWsLog.push({ ts: Date.now(), dir, type, size });
  if (_serverWsLog.length > 200) _serverWsLog.shift();
}

export function getWsLog(): readonly WsLogEntry[] {
  return _serverWsLog;
}
