/**
 * Server module barrel export.
 * Import from "server/" to access all shared types, utilities, and state.
 */

// Types
export type {
  PipelineEvent,
  ServerLogEntry,
  WsLogEntry,
  ExtractedParagraph,
  ConversationEntry,
  PanelSettings,
  StreamState,
  VmState,
  QueuedVoiceInput,
  TtsState,
  EntryState,
  BroadcastFn,
  SendToAudioClientFn,
  ServiceStatus,
} from "./types.js";

// Context (shared mutable state)
export { createServerContext } from "./context.js";
export type { ServerContext } from "./context.js";

// Logging
export { plog, slog, wslog, resetPipelineLog, broadcastPipelineTrace, getPipelineLog, getServerLog, getWsLog, addSseClient, removeSseClient } from "./logging.js";

// Validation
export { VALID_VOICES, validateVoice, sanitizeForTerminal, safeInt, isValidPathComponent, shellEscape, safeJsonParse, escHtml } from "./validation.js";

// Settings
export { loadSettings, saveSettings, initSignalFiles } from "./settings.js";

// STT
export { transcribeAudio, detectAudioExt } from "./stt.js";
