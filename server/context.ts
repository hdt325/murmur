/**
 * Shared server context — single object holding all mutable state.
 * Replaces dozens of loose globals with one typed, inspectable object.
 * Modules receive this context as a parameter instead of reaching for globals.
 */

import type { WebSocket } from "ws";
import type {
  ConversationEntry,
  StreamState,
  VmState,
  QueuedVoiceInput,
  ServiceStatus,
  PanelSettings,
} from "./types.js";
import type { TerminalManager } from "../terminal/interface.js";

export interface ServerContext {
  // --- Terminal ---
  terminal: TerminalManager;

  // --- Service Status ---
  serviceStatus: ServiceStatus;
  lastServiceCheckAt: number;

  // --- Audio Client ---
  activeAudioClient: WebSocket | null;

  // --- TTS Pipeline ---
  tts: {
    generation: number;
    clientTimeout: ReturnType<typeof setTimeout> | null;
    inProgress: boolean;
    activeGen: number;
    queue: string[];
    entryIdQueue: (number | null)[];
    retryCount: number;
    maxRetries: number;
    pregenPromises: Array<{ promise: Promise<Buffer | null>; gen: number }>;
    forceKokoroFallback: boolean;
  };

  // --- Conversation Entry Model ---
  entries: {
    list: ConversationEntry[];
    idCounter: number;
    currentTurn: number;
    currentTtsEntryId: number | null;
    ttsTimer: ReturnType<typeof setTimeout> | null;
    ttsCursor: Map<number, number>;
  };

  // --- Stream State Machine ---
  stream: {
    state: StreamState;
    watcher: ReturnType<typeof setInterval> | null;
    timeout: ReturnType<typeof setTimeout> | null;
    contentCheckTimer: ReturnType<typeof setTimeout> | null;
    promptCheckInterval: ReturnType<typeof setInterval> | null;
    fileOffset: number;
    lastActivity: number;
    lastBroadcastText: string;
    doneCheckTimer: ReturnType<typeof setTimeout> | null;
    reEngageWatcher: ReturnType<typeof setInterval> | null;
    preInputSnapshot: string;
    lastStreamEndTime: number;
  };

  // --- Voice Queue ---
  pendingVoiceInput: QueuedVoiceInput[];
  voiceQueueDraining: boolean;

  // --- User Input & Polling ---
  lastUserInput: string;
  pollStartTime: number;
  sawActivity: boolean;
  lastSpokenText: string;
  interactivePromptActive: boolean;

  // --- System Context ---
  contextSent: boolean;
  contextTimer: ReturnType<typeof setTimeout> | null;
  isSystemContext: boolean;

  // --- Passive Watcher ---
  passiveWatcher: ReturnType<typeof setInterval> | null;
  lastPassiveSnapshot: string;

  // --- VoiceMode ---
  vm: VmState;
  currentCycleHadTts: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;

  // --- WebSocket Clients ---
  clients: Set<WebSocket>;

  // --- Settings ---
  settingsFile: string;

  // --- Paths ---
  tempDir: string;
  whisperUrl: string;
  kokoroUrl: string;
}

/** Create a fresh server context with default values */
export function createServerContext(opts: {
  terminal: TerminalManager;
  settingsFile: string;
  tempDir: string;
  whisperUrl: string;
  kokoroUrl: string;
}): ServerContext {
  return {
    terminal: opts.terminal,
    serviceStatus: { whisper: false, kokoro: false, piper: false },
    lastServiceCheckAt: 0,
    activeAudioClient: null,

    tts: {
      generation: 0,
      clientTimeout: null,
      inProgress: false,
      activeGen: 0,
      queue: [],
      entryIdQueue: [],
      retryCount: 0,
      maxRetries: 3,
      pregenPromises: [],
      forceKokoroFallback: false,
    },

    entries: {
      list: [],
      idCounter: 0,
      currentTurn: 0,
      currentTtsEntryId: null,
      ttsTimer: null,
      ttsCursor: new Map(),
    },

    stream: {
      state: "IDLE",
      watcher: null,
      timeout: null,
      contentCheckTimer: null,
      promptCheckInterval: null,
      fileOffset: 0,
      lastActivity: 0,
      lastBroadcastText: "",
      doneCheckTimer: null,
      reEngageWatcher: null,
      preInputSnapshot: "",
      lastStreamEndTime: 0,
    },

    pendingVoiceInput: [],
    voiceQueueDraining: false,

    lastUserInput: "",
    pollStartTime: 0,
    sawActivity: false,
    lastSpokenText: "",
    interactivePromptActive: false,

    contextSent: false,
    contextTimer: null,
    isSystemContext: false,

    passiveWatcher: null,
    lastPassiveSnapshot: "",

    vm: { ttsPlaying: false, micActive: false, conversationActive: false, phase: "" },
    currentCycleHadTts: false,
    idleTimer: null,

    clients: new Set(),
    settingsFile: opts.settingsFile,
    tempDir: opts.tempDir,
    whisperUrl: opts.whisperUrl,
    kokoroUrl: opts.kokoroUrl,
  };
}
