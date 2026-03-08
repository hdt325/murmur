/**
 * Shared types for the Murmur server.
 * Central type definitions reduce coupling between modules.
 */

import type { WebSocket } from "ws";
import type { ServerResponse } from "http";

// --- Pipeline & Logging ---

export interface PipelineEvent {
  ts: number;
  event: string;
  detail?: string;
}

export interface ServerLogEntry {
  ts: number;
  cat: string;
  event: string;
  detail?: Record<string, unknown>;
}

export interface WsLogEntry {
  ts: number;
  dir: "in" | "out";
  type: string;
  size?: number;
}

// --- Conversation ---

export interface ExtractedParagraph {
  text: string;
  speakable: boolean;
}

export interface ConversationEntry {
  id: number;
  role: "user" | "assistant";
  text: string;
  speakable: boolean;
  spoken: boolean;
  ts: number;
  turn: number;
  queued?: boolean;
  inputId?: string;          // Unique ID for this voice/text input (user entries)
  parentInputId?: string;    // Links assistant responses to the user input that triggered them
}

// --- Settings ---

export interface PanelSettings {
  voice?: string;
  speed?: number;
  tmuxTarget?: string;
}

// --- Stream State Machine ---

export type StreamState = "IDLE" | "WAITING" | "THINKING" | "RESPONDING" | "FINALIZING" | "DONE";

// --- VoiceMode ---

export interface VmState {
  ttsPlaying: boolean;
  micActive: boolean;
  conversationActive: boolean;
  phase: string;
}

// --- Queued Voice Input ---

export interface QueuedVoiceInput {
  text: string;
  entryId: number;
  target: string;
}

// --- TTS State (encapsulated) ---

export interface TtsState {
  generation: number;
  clientTimeout: ReturnType<typeof setTimeout> | null;
  inProgress: boolean;
  activeGen: number;
  queue: string[];
  entryIdQueue: (number | null)[];
  retryCount: number;
  pregenPromises: Array<{ promise: Promise<Buffer | null>; gen: number }>;
  forceKokoroFallback: boolean;
}

// --- Entry Model State (encapsulated) ---

export interface EntryState {
  entries: ConversationEntry[];
  idCounter: number;
  currentTurn: number;
  currentTtsEntryId: number | null;
  ttsTimer: ReturnType<typeof setTimeout> | null;
  ttsCursor: Map<number, number>;
}

// --- Broadcast function type ---

export type BroadcastFn = (msg: object) => void;
export type SendToAudioClientFn = (data: Buffer | object) => void;

// --- Service Status ---

export interface ServiceStatus {
  whisper: boolean;
  kokoro: boolean;
}
