/**
 * Murmur — voice interface for Claude Code
 *
 * Express + WebSocket bridge between the panel UI and Claude Code.
 * Uses TerminalManager abstraction (tmux on macOS, node-pty on Windows).
 * VoiceMode MCP handles all audio (TTS + STT). This server:
 * - Manages the terminal session running Claude Code
 * - Watches VoiceMode event log for real-time status (recording, TTS, STT)
 * - Watches VoiceMode exchanges log for conversation transcriptions
 * - Writes control signal files (speed, voice, mute, mic device)
 * - Sends /conversation to terminal on panel button click
 */

import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import { createServer as createHttpsServer } from "https";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  existsSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  readdirSync,
  unlinkSync,
} from "fs";
import { execSync, execFileSync, execFile, spawn } from "child_process";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { homedir, tmpdir } from "os";
import chokidar from "chokidar";
import { createTerminalManager, type TerminalManager } from "./terminal/interface.js";

// --- Modular imports (gradual migration from monolith) ---
// These modules contain extracted, typed versions of functions and types.
// server.ts still uses its own local implementations for now — the modules
// serve as the canonical typed definitions that new code should import from.
// As migration progresses, local definitions will be replaced by module imports.
import {
  // Validation (used directly — no local conflict)
  validateVoice,
  safeInt,
  safeJsonParse,
  shellEscape,
  escHtml as escHtmlServer,
  // Re-exports for reference
  type ServiceStatus as ServiceStatusType,
} from "./server/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3457;
const HTTPS_PORT = 3458;
// Auto-detect Tailscale hostname from cert, or use env var, or placeholder
const TS_HOSTNAME = process.env.TS_HOSTNAME || (() => {
  try {
    const certPath = join(__dirname, "tailscale-cert.pem");
    if (!existsSync(certPath)) return "";
    const out = execSync(`openssl x509 -in "${certPath}" -noout -subject`, { encoding: "utf-8", timeout: 3000 });
    const match = out.match(/CN\s*=\s*([^\s,]+)/);
    return match ? match[1] : "";
  } catch { return ""; }
})();
const HOME = homedir();
const SETTINGS_FILE = join(__dirname, "settings.json");

// Cross-platform temp directories
const TEMP_DIR = join(tmpdir(), "murmur");
mkdirSync(TEMP_DIR, { recursive: true });
// VoiceMode signal files — /tmp on macOS for backward compatibility
const SIGNAL_DIR = process.platform === "darwin" ? "/tmp" : TEMP_DIR;

// Terminal manager — abstracts tmux (macOS) vs node-pty (Windows)
let terminal: TerminalManager;

const WHISPER_URL = "http://127.0.0.1:2022";
const KOKORO_URL = "http://127.0.0.1:8880";
const PIPER_BIN = "/Users/happythakkar/.pyenv/versions/3.13.5/bin/piper";
const PIPER_MODEL = "/tmp/piper-models/en_US-lessac-medium.onnx";

// ElevenLabs default voices (voice_id → display name)
const ELEVENLABS_VOICES: Record<string, string> = {
  "21m00Tcm4TlvDq8ikWAM": "Rachel",
  "29vD33N1CtxCmqQRPOHJ": "Drew",
  "2EiwWnXFnvU5JabPnv8n": "Clyde",
  "ThT5KcBeYPX3keUQqHPh": "Dorothy",
  "MF3mGyEYCl7XYWbV9V6O": "Elli",
  "TxGEqnHWrfWFTfGW9XjX": "Josh",
  "VR6AewLTigWG4xSOukaG": "Arnold",
  "pNInz6obpgDQGcFmaJgB": "Adam",
  "yoZ06aMxZJJ28mfd3POQ": "Sam",
};
const ELEVENLABS_API_URL = "https://api.elevenlabs.io/v1/text-to-speech";

// Valid Kokoro TTS voice names
const VALID_VOICES = new Set([
  // American English female
  "af_heart", "af_bella", "af_nicole", "af_sky", "af_nova",
  "af_alloy", "af_aoede", "af_kore", "af_sarah", "af_jessica", "af_river",
  // American English male
  "am_fenrir", "am_michael", "am_puck", "am_echo", "am_eric", "am_liam", "am_onyx", "am_adam",
  // British English female
  "bf_emma", "bf_isabella", "bf_alice", "bf_lily",
  // British English male
  "bm_fable", "bm_george", "bm_daniel", "bm_lewis",
  // French / Spanish
  "ff_siwis", "ef_dora", "em_alex",
  // Hindi
  "hf_alpha", "hf_beta", "hm_omega", "hm_psi",
  // Italian
  "if_sara", "im_nicola",
  // Japanese
  "jf_alpha", "jf_gongitsune", "jf_nezumi", "jf_tebukuro", "jm_kumo",
  // Portuguese
  "pf_dora", "pm_alex", "pm_santa",
  // Chinese
  "zf_xiaoxiao", "zf_xiaobei", "zf_xiaoni", "zf_xiaoyi",
  "zm_yunjian", "zm_yunxi", "zm_yunxia", "zm_yunyang",
  // Piper voices
  "piper:lessac-medium",
]);

// Valid ElevenLabs voice names (xi:DisplayName)
const VALID_XI_VOICES = new Set(
  Object.values(ELEVENLABS_VOICES).map(name => `xi:${name}`)
);

/** Resolve voice name to TTS engine: "kokoro" | "piper" | "elevenlabs" | "local" */
function resolveVoiceEngine(voice: string): "kokoro" | "piper" | "elevenlabs" | "local" {
  if (voice.startsWith("_local:")) return "local";
  if (voice.startsWith("piper:")) return "piper";
  if (voice.startsWith("xi:")) return "elevenlabs";
  return "kokoro";
}

/** Look up ElevenLabs voice_id from xi:DisplayName */
function resolveElevenLabsVoiceId(voice: string): string | null {
  const displayName = voice.slice(3); // strip "xi:"
  for (const [id, name] of Object.entries(ELEVENLABS_VOICES)) {
    if (name === displayName) return id;
  }
  return null;
}

// --- Service Health Checks ---

async function checkService(name: string, url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    // Any response (even 404) means the service is running
    console.log(`  ✓ ${name} is running (${url})`);
    return true;
  } catch {
    console.warn(`  ✗ ${name} is NOT reachable (${url})`);
    return false;
  }
}

function checkPiper(): boolean {
  try {
    const hasBin = existsSync(PIPER_BIN);
    const hasModel = existsSync(PIPER_MODEL);
    if (hasBin && hasModel) {
      console.log(`  ✓ Piper TTS is available (${PIPER_BIN})`);
      return true;
    }
    if (!hasBin) console.warn(`  ✗ Piper binary not found (${PIPER_BIN})`);
    if (!hasModel) console.warn(`  ✗ Piper model not found (${PIPER_MODEL})`);
    return false;
  } catch {
    console.warn("  ✗ Piper TTS check failed");
    return false;
  }
}

async function checkAllServices(): Promise<{ whisper: boolean; kokoro: boolean; piper: boolean }> {
  console.log("Checking services...");
  const [whisper, kokoro] = await Promise.all([
    checkService("Whisper STT", WHISPER_URL),
    checkService("Kokoro TTS", KOKORO_URL),
  ]);
  const piper = checkPiper();
  if (!whisper) console.warn("  → Transcription will fail until Whisper is started");
  if (!kokoro) console.warn("  → TTS will fail until Kokoro is started");
  if (!piper) console.warn("  → Piper TTS unavailable (local subprocess)");
  return { whisper, kokoro, piper };
}

let serviceStatus = { whisper: false, kokoro: false, piper: false };
let lastServiceCheckAt = 0;

// --- Primary Audio Client ---
// Only the active audio client receives TTS audio (binary or local_tts).
// Last connected real client auto-claims. Client can send "claim:audio" to take control.
let activeAudioClient: WebSocket | null = null;

function setAudioClient(ws: WebSocket | null, reason: string) {
  if (activeAudioClient === ws) return;
  const hadClient = activeAudioClient !== null;
  activeAudioClient = ws;
  console.log(`[audio] Audio control → ${ws ? "new client" : "none"} (${reason})`);
  // Notify all clients of their new audio control state
  for (const client of Array.from(clients)) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(JSON.stringify({ type: "audio_control", hasControl: client === ws })); } catch {}
    }
  }
  // Bug U2: When a new audio client connects and jobs are queued, drain immediately.
  // Previously, jobs queued while no client was connected sat idle until the next event.
  if (ws && !hadClient && ttsJobQueue.length > 0 && !ttsCurrentlyPlaying) {
    console.log(`[audio] New audio client connected with ${ttsJobQueue.length} pending TTS jobs — draining`);
    drainAudioBuffer();
  }
}

// Send audio (binary or JSON) only to the active audio client.
// Falls back to first available client if no active client is set (single-client mode).
// Bug U2: Returns false if no client was available (caller can handle retry/skip).
function sendToAudioClient(data: Buffer | object): boolean {
  let target = activeAudioClient && activeAudioClient.readyState === WebSocket.OPEN
    ? activeAudioClient : null;
  if (!target) {
    // Fallback: pick first open non-test client (handles first-connect race)
    for (const c of Array.from(clients)) {
      if (c.readyState === WebSocket.OPEN && !(c as any)._isTestClient) { target = c; break; }
    }
  }
  if (!target) {
    console.warn(`[audio] No audio client available — dropping ${Buffer.isBuffer(data) ? data.length + "B audio" : "JSON message"}`);
    return false;
  }
  try {
    if (Buffer.isBuffer(data)) {
      target.send(data);
    } else {
      const json = JSON.stringify(data);
      target.send(json);
      // Log JSON messages for debugging (tts_play, local_tts, etc.)
      wslog("out", (data as Record<string, unknown>).type as string || "audio_json", json.length);
    }
    return true;
  } catch { clients.delete(target); if (activeAudioClient === target) activeAudioClient = null; return false; }
}

// --- Pipeline Instrumentation ---
// Timestamped event log for debugging TTS/transcription timing issues.
// Available via /debug/pipeline and broadcast as pipeline_trace on cycle end.

interface PipelineEvent {
  ts: number;
  event: string;
  detail?: string;
}

let pipelineLog: PipelineEvent[] = [];

function plog(event: string, detail?: string) {
  pipelineLog.push({ ts: Date.now(), event, detail });
  if (pipelineLog.length > 1000) pipelineLog.shift();
}

function resetPipelineLog() {
  pipelineLog = [];
}

function broadcastPipelineTrace() {
  if (pipelineLog.length > 0) {
    broadcast({ type: "pipeline_trace", events: pipelineLog });
  }
}

// --- Structured Server Log ---
// Ring buffer of structured events, available via /debug/log and SSE /debug/log/stream.

interface ServerLogEntry {
  ts: number;
  cat: string;
  event: string;
  detail?: Record<string, unknown>;
}

const _serverLog: ServerLogEntry[] = [];
const _sseClients = new Set<import("http").ServerResponse>();

function slog(cat: string, event: string, detail?: Record<string, unknown>) {
  const entry: ServerLogEntry = { ts: Date.now(), cat, event, detail };
  _serverLog.push(entry);
  if (_serverLog.length > 500) _serverLog.shift();
  const line = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of Array.from(_sseClients)) {
    try { res.write(line); } catch { _sseClients.delete(res); }
  }
}

// --- WebSocket Message Log ---
// Ring buffer of WS messages (both directions), available via /debug/ws-log.

interface WsLogEntry {
  ts: number;
  dir: "in" | "out";
  type: string;
  size?: number;
  clientId?: number;
}

const _serverWsLog: WsLogEntry[] = [];

function wslog(dir: "in" | "out", type: string, size?: number, clientId?: number) {
  _serverWsLog.push({ ts: Date.now(), dir, type, size, clientId });
  if (_serverWsLog.length > 200) _serverWsLog.shift();
}

// --- Mic Persistence Test ---
// Tracks audio chunk arrival times for iOS background mic investigation.
interface MicPersistenceEntry {
  ts: number;
  type: "audio_chunk" | "rms_report" | "visibility" | "marker";
  size?: number;
  rms?: number;
  note?: string;
}
const _micPersistenceLog: MicPersistenceEntry[] = [];
let _micPersistenceActive = false;

// --- Debug Ring Buffers ---
// Specialized ring buffers for automated monitoring of TTS, highlight, and entry bugs.

interface TtsHistoryEntry {
  ts: number;
  entryId: number | null;
  textSnippet: string;
  speakableText: string;
  generation: number;
  source: string; // "queueTts" | "sentence" | "final" | "replay"
  window: string;
  chunkCount: number;
  chunkWordCounts: number[];
}
const _ttsHistory: TtsHistoryEntry[] = [];
function ttslog(entryId: number | null, text: string, generation: number, source: string,
  speakableText = "", chunkCount = 0, chunkWordCounts: number[] = []) {
  _ttsHistory.push({
    ts: Date.now(), entryId, textSnippet: text.slice(0, 120),
    speakableText: speakableText.slice(0, 120), generation, source,
    window: getWindowKey(),
    chunkCount, chunkWordCounts,
  });
  if (_ttsHistory.length > 50) _ttsHistory.shift();
}

interface EntryLogEntry {
  ts: number;
  id: number;
  role: string;
  sourceTag: string;
  textSnippet: string;
}
const _entryLog: EntryLogEntry[] = [];
function elog(id: number, role: string, sourceTag: string, text: string) {
  _entryLog.push({ ts: Date.now(), id, role, sourceTag, textSnippet: text.slice(0, 120) });
  if (_entryLog.length > 50) _entryLog.shift();
}

// ── 3-tier parse pipeline trace ──
// Tier 1: Raw tmux input snapshot (last capture)
let _parseRawSnapshot = "";
let _parseRawSnapshotTs = 0;
// Tier 2: Pre-filter discards (lines thrown away before paragraph formation)
interface ParseDiscardEntry {
  ts: number;
  text: string;       // 120-char snippet
  reason: string;     // which filter matched
}
const _parseDiscards: ParseDiscardEntry[] = [];
// Tier 3: Paragraph classification (formed paragraphs with speakable/non-speakable)
interface ParseParagraphEntry {
  ts: number;
  text: string;       // 120-char snippet
  speakable: boolean;
  reason: string;     // filter rule or "speakable"
}
const _parseParagraphs: ParseParagraphEntry[] = [];

function parselog(text: string, action: "skip" | "nonspeakable" | "speakable", reason: string) {
  if (action === "skip") {
    _parseDiscards.push({ ts: Date.now(), text: text.slice(0, 120), reason });
    if (_parseDiscards.length > 200) _parseDiscards.shift();
  } else {
    _parseParagraphs.push({ ts: Date.now(), text: text.slice(0, 120), speakable: action === "speakable", reason });
    if (_parseParagraphs.length > 100) _parseParagraphs.shift();
  }
}

interface HighlightLogEntry {
  ts: number;
  entryId: number;
  chunkIndex: number;
  event: string; // "word_highlight_start" | "word_highlighted" | "word_highlight_end"
  wordIndex: number;
  totalWords: number;
  flowWordPos: number;
  spanCount: number;
}
const _highlightLog: HighlightLogEntry[] = []; // ring buffer, last 100
function hlog(entryId: number, chunkIndex: number, event: string, wordIndex: number,
  totalWords: number, flowWordPos: number, spanCount: number) {
  _highlightLog.push({ ts: Date.now(), entryId, chunkIndex, event, wordIndex, totalWords, flowWordPos, spanCount });
  if (_highlightLog.length > 100) _highlightLog.shift();
}

// ── Additional ring buffers for Monitor dashboard ──
const RING_CAP = 200;

// Entry mutations: text/speakable/spoken changes AFTER creation
interface EntryMutationLog {
  ts: number;
  entryId: number;
  field: "text" | "speakable" | "spoken";
  from: unknown;
  to: unknown;
  source: string; // caller function name
}
const _entryMutationLog: EntryMutationLog[] = [];
function mlog(entryId: number, field: "text" | "speakable" | "spoken", from: unknown, to: unknown, source: string) {
  _entryMutationLog.push({ ts: Date.now(), entryId, field, from, to, source });
  if (_entryMutationLog.length > RING_CAP) _entryMutationLog.shift();
}

// Dedup rejections: every isDuplicateEntry() rejection
interface DedupLogEntry {
  ts: number;
  rejectedText: string;
  rejectedRole: string;
  matchedEntryId: number;
  tier: 1 | 2; // Tier 1 = exact text, Tier 2 = normalized + window
}
const _dedupLog: DedupLogEntry[] = [];

// Window switches
interface WindowLogEntry {
  ts: number;
  fromWindow: string;
  toWindow: string;
  entriesLoaded: number;
  entriesUnloaded: number;
  snapshotReset: boolean;
}
const _windowLog: WindowLogEntry[] = [];

// Client connections/disconnections
interface ClientLogEntry {
  ts: number;
  event: "connect" | "disconnect" | "audio_claim" | "reconnect";
  clientCount: number;
  isTestMode: boolean;
  payloadBytes?: number;
  note?: string;
}
const _clientLog: ClientLogEntry[] = [];
let _clientConnectCount = 0; // total connections since start

// TTS queue depth samples (sampled on queueTts/drainAudioBuffer)
interface QueueHistoryEntry {
  ts: number;
  event: "enqueue" | "drain_start" | "drain_done" | "cancel";
  queueDepth: number;
  jobId?: number;
  entryId?: number | null;
}
const _queueHistory: QueueHistoryEntry[] = [];

// Client-reported render timing (accepted via WS render_timing message)
interface RenderLogEntry {
  ts: number; // server receive ts
  clientTs: number; // client-reported ts
  entryId: number;
  renderMs: number;
  entryCount: number;
  viewportHeight?: number;
}
const _renderLog: RenderLogEntry[] = [];

// VoiceMode log paths
const VM_LOGS = join(HOME, ".voicemode", "logs");
const VM_EVENTS_DIR = join(VM_LOGS, "events");
const VM_EXCHANGES_DIR = join(VM_LOGS, "conversations");

const app = express();

// BUG-056: Restrict CORS to localhost origins only
app.use((_req, res, next) => {
  const origin = _req.headers.origin;
  if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  if (_req.method === "OPTIONS") { res.status(204).end(); return; }
  next();
});

const server = createServer(app);
const wss = new WebSocketServer({ server });

// --- Terminal Session Management (via TerminalManager abstraction) ---

// Short system signals sent to Claude when the voice panel opens/closes.
// Kept deliberately brief so the tmux echo is minimal (one line, not a paragraph).
// These are SUPPRESSED from the conversation view via two mechanisms:
//   1. _isSystemContext flag — prevents entry creation during live send (sendMurmurContext)
//   2. MURMUR_CONTEXT_FILTER — strips these lines from scrollback catch-up (loadScrollbackEntries)
//      and from addUserEntry if they somehow appear as user input
const MURMUR_CONTEXT_LINES = [
  "Prose mode on — no markdown, short sentences.",
];
const MURMUR_EXIT = "Prose mode off — resume normal formatting.";

// Filter that matches any prose-mode signal line so it never surfaces as a conversation bubble.
// Must stay in sync with MURMUR_CONTEXT_LINES and MURMUR_EXIT above.
// Catches both full lines AND tmux-wrapped continuation lines from prose mode signals.
// When MURMUR_EXIT "Prose mode off — resume normal formatting." wraps, the second line
// "resume normal formatting." must also be filtered. Same for MURMUR_CONTEXT_LINES wrapping.
const MURMUR_CONTEXT_FILTER = /^(Prose mode (on|off)|Voice mode (on|off)|Murmur voice panel|Respond in plain prose|No markdown,? no lists|Flowing paragraphs|Spell out numbers|Keep sentences short|Do not acknowledge these|The user has closed the Murmur voice panel|Resume normal text-based interaction|You can stop formatting for audio output|resume normal formatting|no markdown,?\s*short sentences)/i;

let contextSent = false; // Send once per server instance — no repeated injection on reconnect
let contextTimer: ReturnType<typeof setTimeout> | null = null;
let _isSystemContext = false; // true while system context is being sent — suppresses entry creation
function sendMurmurContext(delayMs = 2000) {
  if (contextSent) return; // Already sent this server run — don't repeat
  if (contextTimer) clearTimeout(contextTimer);
  contextTimer = setTimeout(() => {
    contextTimer = null;
    if (contextSent) return;
    if (terminal.isSessionAlive()) {
      // Guard: only send prose mode context to the voice session (claude-voice).
      // Other sessions (coordinator, agents) should never receive prose mode instructions.
      const targetSession = (terminal.displayTarget ?? terminal.currentTarget ?? "").split(":")[0];
      if (targetSession !== "claude-voice") {
        console.log(`[context] Skipping Murmur context — target "${targetSession}" is not claude-voice`);
        return;
      }
      _isSystemContext = true;
      terminal.sendText(MURMUR_CONTEXT_LINES.join(" "));
      contextSent = true;
      console.log("[context] Sent Murmur system context to Claude (once per server run)");
      broadcast({ type: "context_sent" });
      // Safety: reset _isSystemContext after 30s in case terminal dies before handleStreamDone
      setTimeout(() => {
        if (_isSystemContext) {
          console.warn("[context] Safety timeout — resetting _isSystemContext (terminal may have died)");
          _isSystemContext = false;
        }
      }, 30000);
    }
  }, delayMs);
}

// --- Persistent Settings ---

interface PanelSettings {
  voice?: string;
  speed?: number;
  tmuxTarget?: string; // "session:windowIndex" — last used tmux session
  fillerAudio?: boolean; // Enable predictive filler audio while Claude thinks (default: true)
  elevenLabsApiKey?: string; // ElevenLabs API key for cloud TTS
}

function loadSettings(): PanelSettings {
  try {
    if (existsSync(SETTINGS_FILE)) {
      return JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
    }
  } catch (err) {
    console.error("Settings file corrupted, backing up and resetting:", (err as Error).message);
    try {
      renameSync(SETTINGS_FILE, SETTINGS_FILE + ".backup");
    } catch {}
  }
  return {};
}

function saveSettings(updates: Partial<PanelSettings>) {
  const current = loadSettings();
  const merged = { ...current, ...updates };
  // Atomic write: write to temp file then rename to prevent corruption on crash
  const tmpFile = SETTINGS_FILE + ".tmp";
  try {
    writeFileSync(tmpFile, JSON.stringify(merged, null, 2));
    renameSync(tmpFile, SETTINGS_FILE);
  } catch (err) {
    // BUG-110 fix: Log error but re-throw so callers know save failed
    console.error("Failed to save settings:", (err as Error).message);
    throw err;
  }
}

// On startup, write persisted settings to signal files so VoiceMode picks them up
function initSignalFiles() {
  const settings = loadSettings();
  if (settings.voice) {
    writeFileSync(join(SIGNAL_DIR, "claude-tts-voice"), settings.voice);
    console.log(`  Restored voice: ${settings.voice}`);
  }
  if (settings.speed) {
    writeFileSync(join(SIGNAL_DIR, "claude-tts-speed"), settings.speed.toString());
    console.log(`  Restored speed: ${settings.speed}`);
  }
}

// --- TTS Control ---

function stopTts() {
  stopClientPlayback2("user_stop");
  if (process.platform !== "win32") {
    try {
      execSync("pkill -x afplay 2>/dev/null; pkill -x say 2>/dev/null", { stdio: "ignore", timeout: 3000 });
    } catch {}
  }
}

// --- Audio Pre-Buffer Combination ---

function combineAudioBuffers(preBuffer: Buffer, mainAudio: Buffer): Buffer {
  const uid = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  const preFile = join(TEMP_DIR, `murmur-prebuf-${uid}.wav`);
  const mainFile = join(TEMP_DIR, `murmur-main-${uid}.webm`);
  const outFile = join(TEMP_DIR, `murmur-combined-${uid}.webm`);
  writeFileSync(preFile, preBuffer);
  writeFileSync(mainFile, mainAudio);

  // Use ffmpeg to concatenate: convert both to same format, then combine
  execFileSync("ffmpeg", [
    "-y", "-i", preFile, "-i", mainFile,
    "-filter_complex",
    "[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono[a0];" +
    "[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono[a1];" +
    "[a0][a1]concat=n=2:v=0:a=1[out]",
    "-map", "[out]", "-c:a", "libopus", outFile,
  ], { stdio: "ignore", timeout: 10000 });
  try {
    return Buffer.from(readFileSync(outFile));
  } finally {
    for (const f of [preFile, mainFile, outFile]) {
      try { unlinkSync(f); } catch {}
    }
  }
}

// --- Direct Voice Input: Transcribe + Type into tmux ---

/** Detect audio format from magic bytes — iOS sends mp4, desktop sends webm */
function detectAudioExt(data: Buffer): string {
  if (data.length > 12) {
    // WAV: "RIFF" at 0, "WAVE" at 8
    if (data.slice(0, 4).toString("ascii") === "RIFF" && data.slice(8, 12).toString("ascii") === "WAVE") return "wav";
    // WebM/MKV: EBML header 0x1A45DFA3
    if (data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) return "webm";
    // MP4: "ftyp" box at offset 4
    if (data.slice(4, 8).toString("ascii") === "ftyp") return "mp4";
    // OGG: "OggS"
    if (data.slice(0, 4).toString("ascii") === "OggS") return "ogg";
  }
  return "webm"; // default
}

const STT_PROMPT = "Claude, Murmur, tmux, TypeScript, JavaScript, npm, npx, Python, Git, terminal, code, function, variable, component, server, error, install, run, test.";
const EXT_TO_MIME: Record<string, string> = { wav: "audio/wav", webm: "audio/webm", mp4: "audio/mp4", ogg: "audio/ogg" };

/** Send audio to Whisper via async fetch (non-blocking, replaces execFileSync curl). */
async function whisperFetch(audioData: Buffer, audioExt: string): Promise<any> {
  const mime = EXT_TO_MIME[audioExt] || "application/octet-stream";
  const boundary = "----MurmurBoundary" + Date.now();
  const fields = [
    { name: "model", value: "whisper-1" },
    { name: "language", value: "en" },
    { name: "response_format", value: "verbose_json" },
    { name: "prompt", value: STT_PROMPT },
  ];
  const parts: Buffer[] = [];
  for (const f of fields) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"\r\n\r\n${f.value}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${audioExt}"\r\nContent-Type: ${mime}\r\n\r\n`));
  parts.push(audioData);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  const body = Buffer.concat(parts);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(`${WHISPER_URL}/v1/audio/transcriptions`, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body,
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`Whisper HTTP ${resp.status}: ${await resp.text()}`);
    return await resp.json();
  } finally {
    clearTimeout(timeout);
  }
}

interface WhisperLogEntry {
  ts: number;
  inputId?: string;
  transcriptionStartTs: number;
  transcriptionEndTs: number;
  durationMs: number;
  audioSizeBytes: number;
  transcribedText: string;
  noSpeechProb: number;
  isRetry: boolean;
  wasFiltered: boolean;
  status: "success" | "failed" | "filtered";
}
const _whisperLog: WhisperLogEntry[] = []; // ring buffer, last 200

async function transcribeAudio(audioData: Buffer, inputId?: string): Promise<string> {
  if (!serviceStatus.whisper) {
    serviceStatus.whisper = await checkService("Whisper STT", WHISPER_URL);
    if (!serviceStatus.whisper) {
      console.error("Whisper is not running — cannot transcribe");
      broadcast({ type: "voice_status", state: "error", message: "Whisper STT not running" });
      return "";
    }
  }

  const audioExt = detectAudioExt(audioData);
  const sttStartTs = Date.now();

  try {
    plog("transcribe_start");
    slog("stt", "start", { bytes: audioData.length, ext: audioExt });

    const json = await whisperFetch(audioData, audioExt);
    const noSpeechProb = json.segments?.[0]?.no_speech_prob ?? 0;
    const endTs = Date.now();
    if (noSpeechProb >= 0.6) {
      console.log(`[stt] Discarded — no_speech_prob=${noSpeechProb.toFixed(2)} (likely hallucination)`);
      _whisperLog.push({ ts: endTs, inputId, transcriptionStartTs: sttStartTs, transcriptionEndTs: endTs,
        durationMs: endTs - sttStartTs, audioSizeBytes: audioData.length, transcribedText: "",
        noSpeechProb, isRetry: false, wasFiltered: true, status: "filtered" });
      if (_whisperLog.length > RING_CAP) _whisperLog.shift();
      return "";
    }
    const text = json.text?.trim() || "";
    plog("transcribe_done", text ? `"${text.slice(0, 100)}"` : "(empty)");
    slog("stt", "done", { text: text.slice(0, 100), durationMs: endTs - sttStartTs });
    _whisperLog.push({ ts: endTs, inputId, transcriptionStartTs: sttStartTs, transcriptionEndTs: endTs,
      durationMs: endTs - sttStartTs, audioSizeBytes: audioData.length, transcribedText: text.slice(0, 80),
      noSpeechProb, isRetry: false, wasFiltered: false, status: "success" });
    if (_whisperLog.length > RING_CAP) _whisperLog.shift();
    return text;
  } catch (err) {
    console.warn("[stt] First attempt failed, retrying:", (err as Error).message);
    const retryStartTs = Date.now();
    try {
      const retryJson = await whisperFetch(audioData, audioExt);
      const retryNoSpeech = retryJson.segments?.[0]?.no_speech_prob ?? 0;
      const retryEndTs = Date.now();
      if (retryNoSpeech >= 0.6) {
        console.log(`[stt] Retry discarded — no_speech_prob=${retryNoSpeech.toFixed(2)} (likely hallucination)`);
        _whisperLog.push({ ts: retryEndTs, inputId, transcriptionStartTs: retryStartTs, transcriptionEndTs: retryEndTs,
          durationMs: retryEndTs - retryStartTs, audioSizeBytes: audioData.length, transcribedText: "",
          noSpeechProb: retryNoSpeech, isRetry: true, wasFiltered: true, status: "filtered" });
        if (_whisperLog.length > RING_CAP) _whisperLog.shift();
        return "";
      }
      const text = retryJson.text?.trim() || "";
      console.log(`[stt] Retry succeeded: "${text.slice(0, 60)}"`);
      _whisperLog.push({ ts: retryEndTs, inputId, transcriptionStartTs: retryStartTs, transcriptionEndTs: retryEndTs,
        durationMs: retryEndTs - retryStartTs, audioSizeBytes: audioData.length, transcribedText: text.slice(0, 80),
        noSpeechProb: retryNoSpeech, isRetry: true, wasFiltered: false, status: "success" });
      if (_whisperLog.length > RING_CAP) _whisperLog.shift();
      return text;
    } catch (retryErr) {
      const retryEndTs = Date.now();
      console.error("Whisper transcription failed (after retry):", (retryErr as Error).message);
      plog("transcribe_error", (retryErr as Error).message);
      slog("stt", "error", { error: (retryErr as Error).message });
      serviceStatus.whisper = false;
      broadcast({ type: "voice_status", state: "error", message: "Whisper STT failed" });
      _whisperLog.push({ ts: retryEndTs, inputId, transcriptionStartTs: retryStartTs, transcriptionEndTs: retryEndTs,
        durationMs: retryEndTs - retryStartTs, audioSizeBytes: audioData.length, transcribedText: "",
        noSpeechProb: 0, isRetry: true, wasFiltered: false, status: "failed" });
      if (_whisperLog.length > RING_CAP) _whisperLog.shift();
      return "";
    }
  }
}

// --- TTS Text Cleaning ---

let ttsGeneration = 0; // Bumped ONLY via bumpGeneration()
let _lastBumpReason: GenerationEvent["reason"] = "user_stop"; // Reason for last gen bump

// User-initiated reasons that SHOULD cancel all queued TTS
const USER_INITIATED_BUMP_REASONS = new Set<GenerationEvent["reason"]>([
  "user_stop", "voice_change", "barge_in", "session_switch", "client_disconnect",
]);

interface GenerationEvent {
  gen: number;
  reason: "user_stop" | "voice_change" | "new_input" | "passive_redetect" | "session_switch" | "client_disconnect" | "barge_in";
  ts: number;
  entryId?: number;
}

const ttsGenerationLog: GenerationEvent[] = []; // ring buffer, last 20

function bumpGeneration(reason: GenerationEvent["reason"], entryId?: number): void {
  ttsGeneration++;
  _lastBumpReason = reason;
  const event: GenerationEvent = { gen: ttsGeneration, reason, ts: Date.now(), entryId };
  ttsGenerationLog.push(event);
  if (ttsGenerationLog.length > 20) ttsGenerationLog.shift();
  console.log(`[tts2] generation bumped to ${ttsGeneration} reason=${reason} entryId=${entryId ?? "none"}`);
}

/** Check if a TTS job is stale. Only user-initiated bumps invalidate jobs.
 *  new_input bumps are deferred — old-turn jobs are cancelled later when new
 *  response content actually arrives (see cancelOldTurnJobs). */
function isJobStale(job: TtsJob): boolean {
  if (job.generation === ttsGeneration) return false;
  // User-initiated bumps always cancel
  if (USER_INITIATED_BUMP_REASONS.has(_lastBumpReason)) return true;
  // new_input: job is stale only if it's from an old turn AND new content has arrived
  // (cancelOldTurnJobs handles the actual cancellation when new content appears)
  return false;
}

let _lastOldTurnCancelledAt = 0; // Prevent redundant cancel calls within same turn

/** Cancel TTS jobs from previous turns. Called when broadcastCurrentOutput detects
 *  the first new assistant content in the current turn — the new response is actually
 *  arriving, so old response audio should stop. Idempotent within a turn. */
function cancelOldTurnJobs(): void {
  if (_lastOldTurnCancelledAt === currentTurn) return; // Already cancelled for this turn
  _lastOldTurnCancelledAt = currentTurn;

  const oldJobs = ttsJobQueue.filter(j => j.turn < currentTurn && j.state !== "done" && j.state !== "failed");
  if (oldJobs.length === 0) return;

  console.log(`[tts2] New response arriving (turn ${currentTurn}) — cancelling ${oldJobs.length} old-turn TTS jobs`);

  for (const job of oldJobs) {
    // Abort in-flight fetches
    for (const chunk of job.chunks) {
      if (chunk.abortController) {
        try { chunk.abortController.abort(); } catch {}
        chunk.abortController = null;
      }
      chunk.audioBuf = null;
    }
    job.state = "failed";
  }

  // If currently playing job is from old turn, stop client playback with transition signal
  if (ttsCurrentlyPlaying && ttsCurrentlyPlaying.turn < currentTurn) {
    ttsCurrentlyPlaying = null;
    if (ttsPlaybackTimeout2) { clearTimeout(ttsPlaybackTimeout2); ttsPlaybackTimeout2 = null; }
    broadcast({ type: "tts_stop", reason: "turn_transition" });
  } else {
    // Even if nothing was actively playing, signal the transition so client plays tone
    // (old queued jobs were cancelled — user should hear the "moving on" signal)
    broadcast({ type: "tts_stop", reason: "turn_transition" });
  }

  // Remove failed old-turn jobs from queue
  for (let i = ttsJobQueue.length - 1; i >= 0; i--) {
    if (ttsJobQueue[i].turn < currentTurn && ttsJobQueue[i].state === "failed") {
      ttsJobQueue.splice(i, 1);
    }
  }
}

// --- Debug Pipeline Observability ---

interface TtsFetchLog {
  ts: number;
  engine: "kokoro" | "piper" | "elevenlabs";
  entryId: number | null;
  chunkIndex: number;
  text: string;
  fetchStartTs: number;
  fetchEndTs: number;
  durationMs: number;
  audioSizeBytes: number;
  status: "success" | "failed" | "aborted" | "retry";
  error?: string;
}
const _ttsFetchLog: TtsFetchLog[] = []; // ring buffer, last 50
// Backwards compat alias for debug endpoints
const _kokoroLog = _ttsFetchLog;

interface ChunkFlowLog {
  ts: number;
  event: "chunk_sent" | "chunk_done" | "tts_play_sent" | "tts_done_received";
  entryId: number | null;
  chunkIndex: number;
  generation: number;
  timeSinceLastEvent?: number;
}
const _chunkFlowLog: ChunkFlowLog[] = []; // ring buffer, last 100
let _lastChunkFlowTs: Map<number, number> = new Map(); // entryId → last event ts
const CHUNK_FLOW_TS_MAX_SIZE = 200; // Prune when map exceeds this size
const CHUNK_FLOW_TS_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

interface ClientPlaybackState {
  currentEntryId: number | null;
  currentChunkIndex: number | null;
  lastChunkDoneTs: number | null;
  lastTtsDoneTs: number | null;
  chunksPlayed: number;
  entriesCompleted: number;
}
const _clientPlayback: ClientPlaybackState = {
  currentEntryId: null, currentChunkIndex: null,
  lastChunkDoneTs: null, lastTtsDoneTs: null,
  chunksPlayed: 0, entriesCompleted: 0,
};

interface InputLog {
  ts: number;
  inputId: string;
  source: "voice" | "text-input" | "terminal";
  userEntryId: number;
  responseEntryIds: number[];
  ttsEntryIds: number[];
}
const _inputLog: InputLog[] = []; // ring buffer, last 20

function logChunkFlow(event: ChunkFlowLog["event"], entryId: number | null, chunkIndex: number): void {
  const now = Date.now();
  const key = entryId ?? -1;
  const lastTs = _lastChunkFlowTs.get(key);
  const entry: ChunkFlowLog = {
    ts: now, event, entryId, chunkIndex, generation: ttsGeneration,
    timeSinceLastEvent: lastTs ? now - lastTs : undefined,
  };
  _chunkFlowLog.push(entry);
  if (_chunkFlowLog.length > 100) _chunkFlowLog.shift();
  _lastChunkFlowTs.set(key, now);
  // Prune stale entries to prevent unbounded growth (Audit M1)
  if (_lastChunkFlowTs.size > CHUNK_FLOW_TS_MAX_SIZE) {
    const cutoff = now - CHUNK_FLOW_TS_MAX_AGE_MS;
    for (const [k, ts] of _lastChunkFlowTs) {
      if (ts < cutoff) _lastChunkFlowTs.delete(k);
    }
  }
}

function logTtsFetch(engine: TtsFetchLog["engine"], entryId: number | null, chunkIndex: number, text: string,
  startTs: number, audioSizeBytes: number, status: TtsFetchLog["status"], error?: string): void {
  const now = Date.now();
  const entry: TtsFetchLog = {
    ts: now, engine, entryId, chunkIndex, text: text.slice(0, 50),
    fetchStartTs: startTs, fetchEndTs: now, durationMs: now - startTs,
    audioSizeBytes, status, error,
  };
  _ttsFetchLog.push(entry);
  if (_ttsFetchLog.length > 50) _ttsFetchLog.shift();
}
// Backwards compat — existing callers use this name
function logKokoroFetch(entryId: number | null, chunkIndex: number, text: string,
  startTs: number, audioSizeBytes: number, status: TtsFetchLog["status"], error?: string): void {
  logTtsFetch("kokoro", entryId, chunkIndex, text, startTs, audioSizeBytes, status, error);
}

function logInput(inputId: string, source: InputLog["source"], userEntryId: number): void {
  _inputLog.push({
    ts: Date.now(), inputId, source, userEntryId,
    responseEntryIds: [], ttsEntryIds: [],
  });
  if (_inputLog.length > 20) _inputLog.shift();
}

// Clean raw text for TTS — strips code, URLs, markdown, etc.
function cleanTtsText(text: string): string {
  return text
    // M12: Strip ANSI escape sequences (CSI, OSC, charset, and other escapes)
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")   // CSI sequences (colors, cursor, DEC private modes)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")  // OSC sequences (title, hyperlinks)
    .replace(/\x1b[()][A-B0-2]/g, "")         // Charset selection (e.g. \x1b(B, \x1b)0)
    .replace(/\x1b[#%][A-Za-z0-9]/g, "")      // Line attrs & charset designators
    .replace(/\x1b[78DMEHNOcn><=]/g, "")      // Single-character escape commands
    // M4: Strip HTML tags, then decode common HTML entities
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    // M13: Horizontal rules (---, ***, ___)
    .replace(/^[-*_]{3,}\s*$/gm, "")
    // M14: Heading markers (# through ######)
    .replace(/^#{1,6}\s+/gm, "")
    // Sources/citations section
    .replace(/\n*(?:Sources?|Citations?|References?|Further [Rr]eading):[\s\S]*/i, "")
    // Fenced code blocks
    .replace(/```[\s\S]*?```/g, "... code block omitted ...")
    // Inline code
    .replace(/`[^`]+`/g, (m) => m.slice(1, -1))
    // URLs and bare domains
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\b\S+\.(com|org|net|io|dev|ai|co)\b/gi, "")
    // Deep file paths
    .replace(/(\/[\w.~-]+){3,}/g, "that path")
    // M8: Hex fragments — lowered threshold from 8 to 6 chars
    .replace(/[a-f0-9]{6,}/gi, "")
    // Markdown links [text](url) → text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // M7: Footnote markers [1] [^2]
    .replace(/\[\^?\d+\]/g, "")
    // M3: Strikethrough ~~text~~ → text
    .replace(/~~([^~]+)~~/g, "$1")
    // Bold/emphasis markers (** __ ## etc.)
    .replace(/[#*_]{2,}/g, "")
    // M2: Single asterisk italic *text* → text (after bold ** already stripped)
    .replace(/\*([^*]+)\*/g, "$1")
    // M6: Blockquote markers — strip leading >
    .replace(/^>\s?/gm, "")
    // M5: Table formatting — strip pipe characters
    .replace(/\|/g, " ")
    // M9: Escaped chars outside code — strip common escapes
    .replace(/\\[nrt]/g, " ")
    // Empty bullet/list lines
    .replace(/^[-*•]\s*[,.;)]*\s*$/gm, "")
    .split(/\n\n+/)
    .map(paragraph => {
      const lines = paragraph.split("\n").map(l => l.trim()).filter(Boolean);
      const joined = lines
        .map(l => l.replace(/^[-*•]\s+/, "").replace(/^\d+[.)]\s+/, ""))
        .map(l => l.replace(/\*\*([^*]+)\*\*/g, "$1"))
        .join(" ");
      if (joined && !/[.!?:;,—]$/.test(joined)) return joined + ".";
      return joined;
    })
    .filter(Boolean)
    .join(" ")
    // M1: Strip Unicode emojis (emoji blocks, variation selectors, ZWJ, skin tones)
    .replace(/[\u{1F600}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}\u{2702}-\u{27B0}\u{E0020}-\u{E007F}\u{1F1E0}-\u{1F1FF}]/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function broadcastBinary(data: Buffer) {
  sendToAudioClient(data);
}

// --- TTS Pipeline ---
// Entry-labeled, parallel-fetch system with chunk-level tracking.

interface TtsChunk {
  chunkIndex: number;
  text: string;
  wordCount: number;
  state: "pending" | "fetching" | "ready" | "failed";
  audioBuf: Buffer | null;
  abortController: AbortController | null;
}

interface TtsJob {
  jobId: number;           // Unique per job (monotonic)
  entryId: number | null;  // Conversation entry this job speaks for
  fullText: string;        // Original text before cleaning
  speakableText: string;   // Cleaned text that was split into chunks
  chunks: TtsChunk[];
  state: "fetching" | "ready" | "playing" | "done" | "failed";
  mode: "kokoro" | "local" | "piper" | "elevenlabs";
  generation: number;      // ttsGeneration when job was created
  turn: number;            // conversation turn when job was created
  window: string;          // tmux window key when job was created
  currentChunkIndex: number; // Index of chunk currently being played (chunk-level ack)
  playingSince: number;    // Timestamp when state became "playing" (0 if not playing)
  createdAt: number;       // Timestamp when job was created — for sweep age-based recovery
}

// --- New TTS state (v2) ---
let ttsJobQueue: TtsJob[] = [];                   // Ordered queue of jobs to play
let ttsCurrentlyPlaying: TtsJob | null = null;    // Job whose audio is on the client right now
let ttsJobIdCounter = 0;                          // Monotonic job ID
let ttsPlaybackTimeout2: ReturnType<typeof setTimeout> | null = null; // Fallback timeout for client tts_done
let _activeFetchCount = 0;                        // In-flight Kokoro fetch count (for TTS_MAX_PARALLEL)

const TTS_MAX_PARALLEL = 10;
const TTS_CHUNK_MIN_CHARS = 50;  // Floor — don't send tiny fragments to Kokoro
const TTS_CHUNK_MAX_CHARS = 250;
const TTS_FIRST_CHUNK_MAX = 120; // Smaller first chunk → faster initial audio from Kokoro
const TTS_MAX_QUEUE = 50;
const TTS_QUEUE_TRIM_THRESHOLD = 15; // BUG-047: Trim oldest non-playing jobs when queue exceeds this
const TTS_PLAYING_TIMEOUT_MS = 8000; // Max time a job can stay in "playing" without client ack

/** Split text into chunks at word boundaries, each ≤ maxChars.
 *  Optional firstChunkMax allows a smaller first chunk for faster initial audio. */
function splitIntoChunks(text: string, maxChars: number, firstChunkMax?: number): string[] {
  if (text.length <= (firstChunkMax ?? maxChars)) return [text];

  // Step 1: Split at sentence boundaries (.!? followed by space or end)
  const sentences: string[] = [];
  const sentenceRe = /[^.!?]*[.!?]+(?:\s+|$)/g;
  let match: RegExpExecArray | null;
  let lastEnd = 0;
  while ((match = sentenceRe.exec(text)) !== null) {
    sentences.push(match[0]);
    lastEnd = match.index + match[0].length;
  }
  // Capture any trailing text without sentence-ending punctuation
  if (lastEnd < text.length) {
    sentences.push(text.slice(lastEnd));
  }
  if (sentences.length === 0) sentences.push(text);

  // Step 2: Group sentences into chunks respecting max chars
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const limit = chunks.length === 0 && firstChunkMax ? firstChunkMax : maxChars;
    const trimmedSentence = sentence.trimStart();

    // If adding this sentence would exceed limit AND current meets minimum, flush
    if (current.length > 0 && current.length + trimmedSentence.length > limit && current.length >= TTS_CHUNK_MIN_CHARS) {
      chunks.push(current.trimEnd());
      current = "";
    }

    // If a single sentence exceeds max chars, split it at space boundaries
    const sentenceLimit = chunks.length === 0 && !current && firstChunkMax ? firstChunkMax : maxChars;
    if (trimmedSentence.length > sentenceLimit && !current) {
      let rem = trimmedSentence;
      while (rem.length > 0) {
        const lim = chunks.length === 0 && firstChunkMax ? firstChunkMax : maxChars;
        if (rem.length <= lim) {
          current = rem;
          break;
        }
        let splitAt = rem.lastIndexOf(" ", lim);
        if (splitAt <= 0) splitAt = lim;
        chunks.push(rem.slice(0, splitAt).trimEnd());
        rem = rem.slice(splitAt).trimStart();
      }
    } else {
      current += (current ? "" : "") + trimmedSentence;
    }
  }
  if (current.trim()) chunks.push(current.trimEnd());
  return chunks;
}

/** Fetch audio from Kokoro for a single chunk. Respects TTS_MAX_PARALLEL.
 *  BUG-050: Retries once on connection error (Kokoro restart). */
async function fetchKokoroAudio(job: TtsJob, chunkIndex: number, _retryCount = 0): Promise<void> {
  const chunk = job.chunks[chunkIndex];
  if (!chunk || chunk.state !== "pending") return;

  // Wait for a parallel slot
  while (_activeFetchCount >= TTS_MAX_PARALLEL) {
    await new Promise(r => setTimeout(r, 50));
  }

  // Stale check — job may have been cancelled while waiting for slot
  if (isJobStale(job)) {
    chunk.state = "failed";
    return;
  }

  chunk.state = "fetching";
  chunk.abortController = new AbortController();
  _activeFetchCount++;
  const fetchStartTs = Date.now();

  const settings = loadSettings();
  const voice = settings.voice || "af_heart";
  const kokoroVoice = voice.startsWith("_local") ? "af_heart" : voice;
  const speed = settings.speed || 1;

  // Timeout: abort fetch after 15s to prevent queue stall when Kokoro hangs
  const fetchTimeout = setTimeout(() => chunk.abortController?.abort(), 15000);

  try {
    const resp = await fetch(`${KOKORO_URL}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "kokoro", input: chunk.text, voice: kokoroVoice, speed }),
      signal: chunk.abortController.signal,
    });
    if (!resp.ok) throw new Error(`Kokoro returned ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length < 100) throw new Error("Kokoro returned empty audio");

    // Stale check after async — generation may have changed
    if (isJobStale(job)) {
      chunk.state = "failed";
      logKokoroFetch(job.entryId, chunkIndex, chunk.text, fetchStartTs, 0, "aborted");
      return;
    }

    chunk.audioBuf = buf;
    chunk.state = "ready";
    logKokoroFetch(job.entryId, chunkIndex, chunk.text, fetchStartTs, buf.length, "success");
    plog("tts_chunk_ready", `job=${job.jobId} chunk=${chunkIndex} ${buf.length}B`);

    // If this chunk is the one the playing job is waiting for, send it now
    if (ttsCurrentlyPlaying === job && job.state === "playing" && job.currentChunkIndex === chunkIndex) {
      console.log(`[tts2] Chunk ${chunkIndex} ready — sending to waiting client`);
      if (ttsPlaybackTimeout2) { clearTimeout(ttsPlaybackTimeout2); ttsPlaybackTimeout2 = null; }
      sendChunk(job, chunkIndex);
    } else if (job.state === "fetching") {
      // Not playing yet — check if chunk 0 is ready so drainAudioBuffer can start
      if (chunkIndex === 0 || job.chunks.every(c => c.state === "ready")) {
        job.state = "ready";
      }
    }
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      chunk.state = "failed";
      logKokoroFetch(job.entryId, chunkIndex, chunk.text, fetchStartTs, 0, "aborted");
      return;
    }
    // BUG-050: Retry once on connection error (Kokoro may be restarting)
    const isConnectionError = (err as Error).message?.includes("ECONNREFUSED") ||
      (err as Error).message?.includes("fetch failed") ||
      (err as Error).message?.includes("ECONNRESET");
    if (isConnectionError && _retryCount < 1 && !isJobStale(job)) {
      console.warn(`[tts2] Kokoro connection error (job=${job.jobId} chunk=${chunkIndex}), retrying in 2s...`);
      logKokoroFetch(job.entryId, chunkIndex, chunk.text, fetchStartTs, 0, "retry", (err as Error).message);
      // Clean up before retry — finally block still runs, so don't double-decrement
      clearTimeout(fetchTimeout);
      _activeFetchCount--;
      chunk.abortController = null;
      chunk.state = "pending"; // Reset to pending for retry
      await new Promise(r => setTimeout(r, 2000));
      // fetchKokoroAudio will re-increment _activeFetchCount
      fetchKokoroAudio(job, chunkIndex, _retryCount + 1).then(() => drainAudioBuffer()).catch(() => drainAudioBuffer());
      return; // Skip finally's decrement — we already decremented
    }
    console.error(`[tts2] Kokoro fetch failed (job=${job.jobId} chunk=${chunkIndex}):`, (err as Error).message);
    chunk.state = "failed";
    // If any chunk fails, mark the whole job failed
    job.state = "failed";
    logKokoroFetch(job.entryId, chunkIndex, chunk.text, fetchStartTs, 0, "failed", (err as Error).message);
  } finally {
    clearTimeout(fetchTimeout);
    // Guard against double-decrement when retry path already decremented
    if (chunk.state !== "pending") {
      _activeFetchCount--;
    }
    chunk.abortController = null;
  }
}

/**
 * Fetch audio from Piper TTS via subprocess. Produces WAV output.
 * Same contract as fetchKokoroAudio — fills chunk.audioBuf or marks failed.
 */
async function fetchPiperAudio(job: TtsJob, chunkIndex: number): Promise<void> {
  const chunk = job.chunks[chunkIndex];
  if (!chunk || chunk.state !== "pending") return;

  while (_activeFetchCount >= TTS_MAX_PARALLEL) {
    await new Promise(r => setTimeout(r, 50));
  }
  if (isJobStale(job)) { chunk.state = "failed"; return; }

  chunk.state = "fetching";
  _activeFetchCount++;
  const fetchStartTs = Date.now();

  try {
    const buf = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const proc = spawn("python3", ["-c", `
import sys, io, wave
from piper import PiperVoice
voice = PiperVoice.load('${PIPER_MODEL}', '${PIPER_MODEL}.json')
pcm = b''
sr = None
for audio in voice.synthesize(sys.stdin.read()):
    pcm += audio.audio_int16_bytes
    sr = audio.sample_rate
buf = io.BytesIO()
with wave.open(buf, 'wb') as wf:
    wf.setnchannels(1)
    wf.setsampwidth(2)
    wf.setframerate(sr)
    wf.writeframes(pcm)
sys.stdout.buffer.write(buf.getvalue())
`], { stdio: ["pipe", "pipe", "pipe"], timeout: 30000 });
      proc.stdout.on("data", (d: Buffer) => chunks.push(d));
      proc.stderr.on("data", () => {}); // suppress stderr
      proc.on("close", (code) => {
        if (code === 0) resolve(Buffer.concat(chunks));
        else reject(new Error(`Piper exited with code ${code}`));
      });
      proc.on("error", reject);
      proc.stdin.write(chunk.text);
      proc.stdin.end();
    });

    if (isJobStale(job)) {
      chunk.state = "failed";
      logTtsFetch("piper", job.entryId, chunkIndex, chunk.text, fetchStartTs, 0, "aborted");
      return;
    }
    if (buf.length < 100) throw new Error("Piper returned empty audio");

    chunk.audioBuf = buf;
    chunk.state = "ready";
    logTtsFetch("piper", job.entryId, chunkIndex, chunk.text, fetchStartTs, buf.length, "success");
    plog("tts_chunk_ready", `job=${job.jobId} chunk=${chunkIndex} ${buf.length}B piper`);

    if (ttsCurrentlyPlaying === job && job.state === "playing" && job.currentChunkIndex === chunkIndex) {
      if (ttsPlaybackTimeout2) { clearTimeout(ttsPlaybackTimeout2); ttsPlaybackTimeout2 = null; }
      sendChunk(job, chunkIndex);
    } else if (job.state === "fetching") {
      if (chunkIndex === 0 || job.chunks.every(c => c.state === "ready")) {
        job.state = "ready";
      }
    }
  } catch (err) {
    console.error(`[tts2] Piper fetch failed (job=${job.jobId} chunk=${chunkIndex}):`, (err as Error).message);
    chunk.state = "failed";
    job.state = "failed";
    logTtsFetch("piper", job.entryId, chunkIndex, chunk.text, fetchStartTs, 0, "failed", (err as Error).message);
  } finally {
    _activeFetchCount--;
  }
}

/**
 * Fetch audio from ElevenLabs API. Produces MP3 output which the client handles.
 * Same contract as fetchKokoroAudio — fills chunk.audioBuf or marks failed.
 */
async function fetchElevenLabsAudio(job: TtsJob, chunkIndex: number): Promise<void> {
  const chunk = job.chunks[chunkIndex];
  if (!chunk || chunk.state !== "pending") return;

  while (_activeFetchCount >= TTS_MAX_PARALLEL) {
    await new Promise(r => setTimeout(r, 50));
  }
  if (isJobStale(job)) { chunk.state = "failed"; return; }

  chunk.state = "fetching";
  chunk.abortController = new AbortController();
  _activeFetchCount++;
  const fetchStartTs = Date.now();

  const settings = loadSettings();
  const apiKey = settings.elevenLabsApiKey;
  if (!apiKey) {
    chunk.state = "failed";
    job.state = "failed";
    _activeFetchCount--;
    chunk.abortController = null;
    return;
  }

  const voiceId = resolveElevenLabsVoiceId(settings.voice || "");
  if (!voiceId) {
    console.error(`[tts2] Unknown ElevenLabs voice: ${settings.voice}`);
    chunk.state = "failed";
    job.state = "failed";
    _activeFetchCount--;
    chunk.abortController = null;
    return;
  }

  // Timeout: abort fetch after 15s to prevent queue stall
  const fetchTimeout = setTimeout(() => chunk.abortController?.abort(), 15000);

  try {
    const resp = await fetch(`${ELEVENLABS_API_URL}/${voiceId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": apiKey,
      },
      body: JSON.stringify({
        text: chunk.text,
        model_id: "eleven_monolingual_v1",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
      signal: chunk.abortController.signal,
    });
    if (!resp.ok) throw new Error(`ElevenLabs returned ${resp.status}: ${await resp.text().catch(() => "")}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length < 100) throw new Error("ElevenLabs returned empty audio");

    if (isJobStale(job)) {
      chunk.state = "failed";
      logTtsFetch("elevenlabs", job.entryId, chunkIndex, chunk.text, fetchStartTs, 0, "aborted");
      return;
    }

    chunk.audioBuf = buf;
    chunk.state = "ready";
    logTtsFetch("elevenlabs", job.entryId, chunkIndex, chunk.text, fetchStartTs, buf.length, "success");
    plog("tts_chunk_ready", `job=${job.jobId} chunk=${chunkIndex} ${buf.length}B elevenlabs`);

    if (ttsCurrentlyPlaying === job && job.state === "playing" && job.currentChunkIndex === chunkIndex) {
      if (ttsPlaybackTimeout2) { clearTimeout(ttsPlaybackTimeout2); ttsPlaybackTimeout2 = null; }
      sendChunk(job, chunkIndex);
    } else if (job.state === "fetching") {
      if (chunkIndex === 0 || job.chunks.every(c => c.state === "ready")) {
        job.state = "ready";
      }
    }
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      chunk.state = "failed";
      logTtsFetch("elevenlabs", job.entryId, chunkIndex, chunk.text, fetchStartTs, 0, "aborted");
      return;
    }
    console.error(`[tts2] ElevenLabs fetch failed (job=${job.jobId} chunk=${chunkIndex}):`, (err as Error).message);
    chunk.state = "failed";
    job.state = "failed";
    logTtsFetch("elevenlabs", job.entryId, chunkIndex, chunk.text, fetchStartTs, 0, "failed", (err as Error).message);
  } finally {
    clearTimeout(fetchTimeout);
    _activeFetchCount--;
    chunk.abortController = null;
  }
}

/**
 * Queue text for TTS playback, labeled with an entry ID.
 */
function queueTts(entryId: number | null, text: string, source = "queueTts"): void {
  // Per-window guard: if the entry belongs to a different window, skip TTS
  if (entryId != null) {
    const entry = conversationEntries.find(e => e.id === entryId);
    if (entry?.window && entry.window !== getWindowKey()) {
      console.log(`[tts2] Skipping TTS for entry ${entryId} — belongs to window ${entry.window}, current is ${getWindowKey()}`);
      return;
    }
  }

  // Stop filler audio when real response audio is queued (not another filler)
  if (entryId != null && entryId !== FILLER_ENTRY_ID && entryId !== _fillerEntryId) {
    stopFillerIfActive();
  }

  // Clean text for TTS
  const speakableText = cleanTtsText(text);

  if (!speakableText) {
    // Mark entry spoken even though text was empty — it was processed
    if (entryId != null) {
      const entry = conversationEntries.find(e => e.id === entryId);
      if (entry && !entry.spoken) {
        mlog(entry.id, "spoken", false, true, "queueTts:alreadyQueued");
        entry.spoken = true;
        broadcast({ type: "entry", entries: conversationEntries, partial: false });
      }
    }
    return;
  }

  // Dedup: skip if this entryId already has a pending/playing job in CURRENT generation
  if (entryId != null) {
    const existing = ttsJobQueue.find(
      j => j.entryId === entryId && j.state !== "done" && j.state !== "failed" && !isJobStale(j)
    );
    if (existing) {
      // If the new text is longer than what's already queued, the entry grew.
      // Update the existing job's text so final audio covers the complete text.
      if (speakableText.length > existing.speakableText.length) {
        console.log(`[tts2] Entry ${entryId} text grew (${existing.speakableText.length}→${speakableText.length} chars) — updating job=${existing.jobId}`);
        ttslog(entryId, text, ttsGeneration, `${source}_update`, speakableText);
        existing.fullText = text;
        existing.speakableText = speakableText;
        // If still pending/fetching, re-chunk and re-fetch
        if (existing.state === "fetching") {
          // Abort existing fetches
          for (const chunk of existing.chunks) {
            if (chunk.abortController) {
              try { chunk.abortController.abort(); } catch {}
              chunk.abortController = null;
            }
          }
          const newChunkTexts = splitIntoChunks(speakableText, TTS_CHUNK_MAX_CHARS, TTS_FIRST_CHUNK_MAX);
          existing.chunks = newChunkTexts.map((t, i) => ({
            chunkIndex: i,
            text: t,
            wordCount: t.trim().split(/\s+/).length,
            state: existing.mode === "local" ? "ready" as const : "pending" as const,
            audioBuf: null,
            abortController: null,
          }));
          existing.state = existing.mode === "local" ? "ready" : "fetching";
          // Re-fire audio fetches for new chunks
          if (existing.mode === "kokoro") {
            for (const chunk of existing.chunks) {
              fetchKokoroAudio(existing, chunk.chunkIndex).then(() => drainAudioBuffer()).catch(err => {
                drainAudioBuffer(); // Drain queue even on re-fetch failure
              });
            }
          } else if (existing.mode === "piper") {
            for (const chunk of existing.chunks) {
              fetchPiperAudio(existing, chunk.chunkIndex).then(() => drainAudioBuffer()).catch(err => {
                drainAudioBuffer(); // Drain queue even on piper re-fetch failure
              });
            }
          } else if (existing.mode === "elevenlabs") {
            for (const chunk of existing.chunks) {
              fetchElevenLabsAudio(existing, chunk.chunkIndex).then(() => drainAudioBuffer()).catch(err => {
                drainAudioBuffer(); // Drain queue even on elevenlabs re-fetch failure
              });
            }
          }
        }
      } else {
        console.log(`[tts2] Skipping duplicate queue for entry ${entryId} (job=${existing.jobId})`);
      }
      return;
    }
    if (ttsCurrentlyPlaying?.entryId === entryId) {
      console.log(`[tts2] Skipping — entry ${entryId} is currently playing`);
      return;
    }
  }

  // BUG-047: Trim oldest non-playing jobs when queue grows too large
  if (ttsJobQueue.length >= TTS_QUEUE_TRIM_THRESHOLD) {
    let trimmed = 0;
    const now = Date.now();
    // Remove old jobs from the back of the queue (oldest first, skip currently playing)
    for (let i = 0; i < ttsJobQueue.length && ttsJobQueue.length >= TTS_QUEUE_TRIM_THRESHOLD; i++) {
      const job = ttsJobQueue[i];
      if (ttsCurrentlyPlaying === job) continue; // Don't trim currently playing
      if (job.state === "playing") continue;
      // Trim jobs older than 30s or if we're at hard max
      if ((job.createdAt > 0 && now - job.createdAt > 30000) || ttsJobQueue.length >= TTS_MAX_QUEUE) {
        // Abort any in-flight fetches
        for (const chunk of job.chunks) {
          if (chunk.abortController) { try { chunk.abortController.abort(); } catch {} }
        }
        job.state = "failed";
        ttsJobQueue.splice(i, 1);
        i--; // Adjust index after splice
        trimmed++;
      }
    }
    if (trimmed > 0) {
      console.warn(`[tts2] Queue trimmed: removed ${trimmed} stale jobs (queue now ${ttsJobQueue.length})`);
    }
  }

  // Enforce max queue size (fallback after trim)
  if (ttsJobQueue.length >= TTS_MAX_QUEUE) {
    console.warn(`[tts2] Queue still full after trim (${TTS_MAX_QUEUE}), dropping new item`);
    return;
  }

  // Determine mode based on voice prefix
  const settings = loadSettings();
  const voice = settings.voice || "af_heart";
  const engine = resolveVoiceEngine(voice);

  let mode: "kokoro" | "local" | "piper" | "elevenlabs";
  if (engine === "local") {
    const localName = voice.slice(7);
    const audioClient = activeAudioClient && activeAudioClient.readyState === WebSocket.OPEN
      ? activeAudioClient
      : Array.from(clients).find((c) => c.readyState === WebSocket.OPEN && !(c as any)._isTestClient) || null;
    const useLocal = localName === "default" ||
      (audioClient != null && (audioClient as any)._localVoices?.has(localName));
    mode = useLocal ? "local" : "kokoro"; // Fallback to Kokoro if local voice unavailable
  } else if (engine === "elevenlabs") {
    const apiKey = settings.elevenLabsApiKey;
    if (!apiKey) {
      console.warn("[tts2] ElevenLabs voice selected but no API key — falling back to Kokoro");
      mode = "kokoro";
    } else {
      mode = "elevenlabs";
    }
  } else {
    mode = engine; // "kokoro" or "piper"
  }

  // Split into chunks (first chunk smaller for faster initial audio)
  const chunkTexts = splitIntoChunks(speakableText, TTS_CHUNK_MAX_CHARS, TTS_FIRST_CHUNK_MAX);
  // Compute word counts per chunk, ensuring sum matches total speakableText word count.
  // This is critical for client-side karaoke — DOM spans are created from the full
  // speakableText, so the sum of chunkWordCounts must equal the total span count.
  const totalWords = speakableText.trim().split(/\s+/).filter(Boolean).length;
  const rawCounts = chunkTexts.map(t => t.trim().split(/\s+/).filter(Boolean).length);
  const rawSum = rawCounts.reduce((a, b) => a + b, 0);
  // If raw counts don't sum to total (due to trimStart in splitIntoChunks), adjust last chunk
  if (rawSum !== totalWords && rawCounts.length > 0) {
    rawCounts[rawCounts.length - 1] += totalWords - rawSum;
  }
  const chunks: TtsChunk[] = chunkTexts.map((t, i) => ({
    chunkIndex: i,
    text: t,
    wordCount: rawCounts[i],
    state: mode === "local" ? "ready" as const : "pending" as const,
    audioBuf: null,
    abortController: null,
  }));

  const job: TtsJob = {
    jobId: ++ttsJobIdCounter,
    entryId,
    fullText: text,
    speakableText,
    chunks,
    state: mode === "local" ? "ready" : "fetching",
    mode,
    generation: ttsGeneration,
    turn: currentTurn,
    window: getWindowKey(),
    currentChunkIndex: 0,
    playingSince: 0,
    createdAt: Date.now(),
  };

  ttsJobQueue.push(job);
  _queueHistory.push({ ts: Date.now(), event: "enqueue", queueDepth: ttsJobQueue.length, jobId: job.jobId, entryId });
  if (_queueHistory.length > RING_CAP) _queueHistory.shift();
  // Track which entries got TTS in input log
  if (entryId != null) {
    const entry = conversationEntries.find(e => e.id === entryId);
    const pid = entry?.parentInputId;
    if (pid) {
      const il = _inputLog.find(l => l.inputId === pid);
      if (il && !il.ttsEntryIds.includes(entryId)) il.ttsEntryIds.push(entryId);
    }
  }
  ttslog(entryId, text, ttsGeneration, source, speakableText, chunks.length, rawCounts);
  plog("tts2_queued", `job=${job.jobId} entry=${entryId} mode=${mode} chunks=${chunks.length} (${speakableText.length} chars)`);
  console.log(`[tts2] Queued job=${job.jobId} entry=${entryId} mode=${mode} chunks=${chunks.length} queue=${ttsJobQueue.length}`);

  // Fire parallel audio fetches (local jobs skip this — already "ready")
  if (mode === "kokoro") {
    // Check Kokoro availability before firing fetches
    if (!serviceStatus.kokoro) {
      checkService("Kokoro TTS", KOKORO_URL).then(ok => {
        serviceStatus.kokoro = ok;
        if (!ok) {
          console.error("[tts2] Kokoro not running — marking job failed");
          job.state = "failed";
          if (entryId != null) {
            const entry = conversationEntries.find(e => e.id === entryId);
            if (entry && !entry.spoken) { mlog(entry.id, "spoken", false, true, "fetchKokoroAudio:noService"); entry.spoken = true; }
          }
          drainAudioBuffer();
          return;
        }
        // Kokoro came back up — fire fetches
        for (const chunk of chunks) {
          fetchKokoroAudio(job, chunk.chunkIndex).then(() => drainAudioBuffer()).catch(err => {
            drainAudioBuffer(); // Drain queue even on kokoro fetch failure
          });
        }
      }).catch(err => {
        job.state = "failed";
        drainAudioBuffer();
      });
    } else {
      for (const chunk of chunks) {
        fetchKokoroAudio(job, chunk.chunkIndex).then(() => drainAudioBuffer()).catch(err => {
          drainAudioBuffer(); // Drain queue even on kokoro fetch failure
        });
      }
    }
  } else if (mode === "piper") {
    for (const chunk of chunks) {
      fetchPiperAudio(job, chunk.chunkIndex).then(() => drainAudioBuffer()).catch(err => {
        drainAudioBuffer(); // Drain queue even on piper fetch failure
      });
    }
  } else if (mode === "elevenlabs") {
    for (const chunk of chunks) {
      fetchElevenLabsAudio(job, chunk.chunkIndex).then(() => drainAudioBuffer()).catch(err => {
        drainAudioBuffer(); // Drain queue even on elevenlabs fetch failure
      });
    }
  }

  // Try to drain immediately (local jobs are already ready)
  drainAudioBuffer();
}

// --- Predictive Filler Audio ---
// Play a contextual filler phrase while Claude thinks, so there's no dead silence.
// Pattern-matches user transcription to pick a natural, conversational acknowledgement.

const FILLER_CATEGORIES: { patterns: RegExp[]; phrases: string[] }[] = [
  {
    // Greetings — match first so "hey how are you" gets greeting, not question
    patterns: [/^(hi|hello|hey|howdy|good morning|good afternoon|good evening|what'?s up)\b/],
    phrases: [
      "Hey there, good to hear from you.",
      "Hi! Give me just a moment.",
      "Hey, what's going on.",
    ],
  },
  {
    // Gratitude
    patterns: [/\b(thank|thanks|appreciate|great job|nice work|well done)\b/],
    phrases: [
      "Happy to help, anytime!",
      "Of course, glad that was useful.",
      "You're welcome! Let me know if there's anything else.",
    ],
  },
  {
    // Jokes/humor
    patterns: [/\b(joke|funny|laugh|humor|tell me a)\b/],
    phrases: [
      "Oh, I think I've got a good one for this.",
      "Alright, let me think of something fun.",
      "Ha, okay, give me just a second.",
    ],
  },
  {
    // Complaints/problems — match before generic requests
    patterns: [/\b(broken|bug|wrong|error|not working|issue|problem|fix|crash|fail)\b/],
    phrases: [
      "Okay, let me take a closer look at that.",
      "Got it, let me see what's going on here.",
      "Alright, let me dig into that for you.",
    ],
  },
  {
    // Opinions
    patterns: [/\b(what do you think|your opinion|your take|do you agree|thoughts on|what are your)\b/],
    phrases: [
      "That's a really interesting question, let me think about that.",
      "Hmm, good one. Give me a moment to consider.",
      "Oh, I actually have some thoughts on that.",
    ],
  },
  {
    // Requests — "can you", "please", "help me", etc.
    patterns: [/\b(can you|could you|please|help me|i need|i want|make me|write me|show me|give me|create|build|set up)\b/],
    phrases: [
      "Sure thing, let me pull that together for you.",
      "Absolutely, working on that right now.",
      "On it, give me just a moment.",
      "Sure, let me get that set up.",
    ],
  },
  {
    // Questions — broad catch after specific categories
    patterns: [/\?/, /^(who|what|where|when|why|how|can|do|does|is|are|will|would|could|should)\b/],
    phrases: [
      "That's a great question, let me think about that.",
      "Hmm, let me look into that for you.",
      "Good question, give me a second to check.",
      "Let me see what I can find on that.",
    ],
  },
  {
    // Continuation
    patterns: [/^(and |also |another |one more|what about|how about|okay |ok )/],
    phrases: [
      "Sure, let me keep going.",
      "Alright, coming right up.",
      "Got it, one more moment.",
    ],
  },
];

const FILLER_DEFAULT_PHRASES = [
  "Alright, give me just a moment.",
  "Sure, let me work on that for you.",
  "One moment, I'm on it.",
  "Let me think about that.",
  "Okay, working on it now.",
];

const FILLER_ENTRY_ID = -999; // Legacy sentinel (kept for stopFillerIfActive compatibility)
let _fillerActive = false;
let _fillerEntryId: number | null = null; // Real entry ID of current filler
const _recentFillers: string[] = []; // Track last 3 to avoid repeats
const FILLER_RECENT_MAX = 3;

/** Pick a contextual filler phrase based on user's transcribed text. */
function pickFillerPhrase(userText: string): string {
  const lower = userText.toLowerCase().trim();

  // Find first matching category
  let pool = FILLER_DEFAULT_PHRASES;
  for (const cat of FILLER_CATEGORIES) {
    if (cat.patterns.some(p => p.test(lower))) {
      pool = cat.phrases;
      break;
    }
  }

  // Filter out recently used phrases
  const available = pool.filter(p => !_recentFillers.includes(p));
  const choices = available.length > 0 ? available : pool;

  const phrase = choices[Math.floor(Math.random() * choices.length)];

  // Track recent usage
  _recentFillers.push(phrase);
  if (_recentFillers.length > FILLER_RECENT_MAX) _recentFillers.shift();

  return phrase;
}

/** Queue a contextual filler phrase for playback while Claude processes input.
 *  Creates a proper assistant entry so the filler appears in conversation view. */
function queueFillerAudio(userText = ""): void {
  const settings = loadSettings();
  // fillerAudio defaults to true if unset
  if (settings.fillerAudio === false) return;

  // Don't play filler if TTS is already playing or queued
  if (ttsCurrentlyPlaying || ttsJobQueue.length > 0) return;

  const phrase = pickFillerPhrase(userText);
  console.log(`[tts2] Queueing filler: "${phrase}" (input: "${userText.slice(0, 40)}")`);

  // Create a real assistant entry so the filler shows in conversation view
  const fillerEntryId = ++entryIdCounter;
  const fillerEntry: ConversationEntry = {
    id: fillerEntryId,
    role: "assistant",
    text: phrase,
    speakable: true,
    spoken: true, // Will be spoken immediately
    ts: Date.now(),
    turn: currentTurn,
    filler: true, // Tag so UI can style differently if desired
    sourceTag: "filler", // Guard in broadcastCurrentOutput checks this to prevent clobber
    ...(_currentInputId ? { parentInputId: _currentInputId } : {}),
  };
  pushEntry(fillerEntry);
  elog(fillerEntryId, "assistant", "filler", phrase);
  broadcast({ type: "entry", entries: conversationEntries, partial: true });

  ttslog(fillerEntryId, phrase, ttsGeneration, "filler");
  _fillerActive = true;
  _fillerEntryId = fillerEntryId;
  queueTts(fillerEntryId, phrase);
}

/** Stop filler playback when real response audio arrives. */
function stopFillerIfActive(): void {
  if (!_fillerActive) return;
  _fillerActive = false;
  const fid = _fillerEntryId;
  _fillerEntryId = null;

  // Check if filler job is still in queue or playing (match by real entry ID or legacy sentinel)
  const fillerIdx = ttsJobQueue.findIndex(j =>
    (j.entryId === fid || j.entryId === FILLER_ENTRY_ID) && j.state !== "done" && j.state !== "failed"
  );
  if (fillerIdx >= 0) {
    const fillerJob = ttsJobQueue[fillerIdx];
    for (const chunk of fillerJob.chunks) {
      if (chunk.abortController) {
        try { chunk.abortController.abort(); } catch {}
        chunk.abortController = null;
      }
      chunk.audioBuf = null;
    }
    ttsJobQueue.splice(fillerIdx, 1);
    console.log("[tts2] Filler removed from queue (real audio arriving)");
  }

  const isFillerPlaying = ttsCurrentlyPlaying &&
    (ttsCurrentlyPlaying.entryId === fid || ttsCurrentlyPlaying.entryId === FILLER_ENTRY_ID);
  if (isFillerPlaying) {
    // Filler is currently playing — stop it
    ttsCurrentlyPlaying = null;
    if (ttsPlaybackTimeout2) { clearTimeout(ttsPlaybackTimeout2); ttsPlaybackTimeout2 = null; }
    broadcast({ type: "tts_stop" });
    console.log("[tts2] Filler playback stopped (real audio arriving)");
    ttslog(fid ?? FILLER_ENTRY_ID, "", ttsGeneration, "filler_replaced");
  }
}

/**
 * Send the next ready job's audio to the client.
 * Uses chunk-level ack protocol: sends ONE chunk at a time, waits for chunk_done.
 * Called after each chunk fetch completes, after chunk_done, and after handleTtsDone.
 */
function drainAudioBuffer(): void {
  // Already playing — wait for client chunk_done/tts_done
  if (ttsCurrentlyPlaying) return;

  // Evict completed/failed/orphaned jobs from the front of the queue
  while (ttsJobQueue.length > 0) {
    const front = ttsJobQueue[0];
    if (front.state === "done" || front.state === "failed") {
      ttsJobQueue.shift();
      continue;
    }
    // Orphan recovery: job stuck in "playing" but ttsCurrentlyPlaying is null (or different).
    // This happens when handleTtsDone2 receives a stale tts_done for a different entryId.
    if (front.state === "playing" && ttsCurrentlyPlaying !== front) {
      console.warn(`[tts2] Orphan recovery: job=${front.jobId} entry=${front.entryId} stuck in playing — marking failed`);
      front.state = "failed";
      ttsJobQueue.shift();
      continue;
    }
    break;
  }

  if (ttsJobQueue.length === 0) {
    // Nothing left — broadcast idle if stream isn't active
    broadcastIdleIfSafe();
    return;
  }

  const job = ttsJobQueue[0];

  // For server-side TTS jobs, start as soon as chunk 0 is ready (don't wait for all chunks)
  if (job.state === "fetching" && (job.mode === "kokoro" || job.mode === "piper" || job.mode === "elevenlabs")) {
    if (job.chunks[0]?.state === "ready") {
      job.state = "ready"; // Promote — remaining chunks may still be fetching
    }
  }
  if (job.state !== "ready") return; // Still fetching — will be called again when chunks complete

  // Stale generation check — only user-initiated bumps cancel
  if (isJobStale(job)) {
    job.state = "failed";
    drainAudioBuffer(); // Recurse to skip this job
    return;
  }

  // Mark playing
  job.state = "playing";
  job.playingSince = Date.now();
  job.currentChunkIndex = 0;
  ttsCurrentlyPlaying = job;
  _queueHistory.push({ ts: Date.now(), event: "drain_start", queueDepth: ttsJobQueue.length, jobId: job.jobId, entryId: job.entryId });
  if (_queueHistory.length > RING_CAP) _queueHistory.shift();

  console.log(`[tts2] Playing job=${job.jobId} entry=${job.entryId} mode=${job.mode} chunks=${job.chunks.length}`);
  plog("tts2_play", `job=${job.jobId} entry=${job.entryId} ${job.speakableText.slice(0, 80)}`);

  // Unify state: set _clientPlayback atomically with ttsCurrentlyPlaying
  _clientPlayback.currentEntryId = job.entryId;
  _clientPlayback.currentChunkIndex = 0;

  if (job.mode === "local") {
    // Local TTS: send text to client for Web Speech API (single chunk, no ack needed)
    const ttsPlayMsg = {
      type: "tts_play",
      entryId: job.entryId,
      fullText: job.fullText,
      speakableText: job.speakableText,
      chunkCount: 1,
      chunkWordCounts: [job.speakableText.trim().split(/\s+/).length],
      localTts: true,
    };
    broadcast(ttsPlayMsg); // Send to ALL clients for highlight
    sendToAudioClient({ type: "local_tts", text: job.speakableText, entryId: job.entryId });
    broadcast({ type: "voice_status", state: "speaking" });

    // Safety timeout for local TTS — proportional to word count
    const wordCount = job.speakableText.trim().split(/\s+/).length;
    const timeoutMs = Math.max(8000, wordCount * 400 + 5000);
    ttsPlaybackTimeout2 = setTimeout(() => {
      if (ttsCurrentlyPlaying === job) {
        console.warn(`[tts2] Local TTS timeout (${(timeoutMs / 1000).toFixed(0)}s) — assuming done`);
        handleTtsDone2(job.entryId);
      }
    }, timeoutMs);
  } else {
    // Server-side TTS: broadcast tts_play to ALL clients for highlight + send chunk 0 binary to audio client
    const chunkWordCounts = job.chunks.map(c => c.wordCount);
    broadcast({
      type: "tts_play",
      entryId: job.entryId,
      fullText: job.fullText,
      speakableText: job.speakableText,
      chunkCount: job.chunks.length,
      chunkWordCounts,
    });
    logChunkFlow("tts_play_sent", job.entryId, 0);

    sendChunk(job, 0);
    broadcast({ type: "voice_status", state: "speaking" });
  }
}

/** Send a single chunk's binary audio to the client with a per-chunk safety timeout. */
function sendChunk(job: TtsJob, chunkIndex: number): void {
  const chunk = job.chunks[chunkIndex];
  if (!chunk || !chunk.audioBuf) {
    console.warn(`[tts2] sendChunk: no audio for job=${job.jobId} chunk=${chunkIndex} — advancing`);
    // Don't silently return — advance to next chunk or complete the job
    // to prevent ttsCurrentlyPlaying from being stuck with no timeout
    handleChunkDone(job.entryId, chunkIndex);
    return;
  }
  const bytes = chunk.audioBuf.length;
  sendToAudioClient(chunk.audioBuf);
  chunk.audioBuf = null; // Free after sending
  slog("tts", "chunk_sent", { bytes, entry: job.entryId, chunk: chunkIndex, of: job.chunks.length });
  logChunkFlow("chunk_sent", job.entryId, chunkIndex);
  // currentEntryId is set atomically in drainAudioBuffer; only update chunk index here
  _clientPlayback.currentChunkIndex = chunkIndex;
  console.log(`[tts2] Sent chunk ${chunkIndex}/${job.chunks.length - 1} (${bytes}B) for entry=${job.entryId}`);

  // Per-chunk safety timeout (~12KB/s for Kokoro audio)
  if (ttsPlaybackTimeout2) clearTimeout(ttsPlaybackTimeout2);
  const estimatedMs = Math.max(5000, (bytes / 12000) * 1000 + 3000);
  ttsPlaybackTimeout2 = setTimeout(() => {
    if (ttsCurrentlyPlaying === job && job.currentChunkIndex === chunkIndex) {
      console.warn(`[tts2] Chunk ${chunkIndex} timeout (${(estimatedMs / 1000).toFixed(1)}s) — assuming done`);
      handleChunkDone(job.entryId, chunkIndex);
    }
  }, estimatedMs);
}

/**
 * Handle chunk_done from client — send next chunk or wait for tts_done.
 */
function handleChunkDone(entryId: number | null, chunkIndex: number): void {
  if (ttsPlaybackTimeout2) { clearTimeout(ttsPlaybackTimeout2); ttsPlaybackTimeout2 = null; }
  logChunkFlow("chunk_done", entryId, chunkIndex);
  _clientPlayback.lastChunkDoneTs = Date.now();
  _clientPlayback.chunksPlayed++;

  const job = ttsCurrentlyPlaying;
  if (!job || job.entryId !== entryId) {
    console.warn(`[tts2] chunk_done for unknown entry=${entryId} chunk=${chunkIndex}`);
    return;
  }

  // Stale generation check — only user-initiated bumps cancel
  if (isJobStale(job)) {
    console.log(`[tts2] chunk_done stale (gen ${job.generation} vs ${ttsGeneration}, reason=${_lastBumpReason}) — dropping job`);
    job.state = "failed";
    ttsCurrentlyPlaying = null;
    drainAudioBuffer();
    return;
  }

  const nextIndex = chunkIndex + 1;
  if (nextIndex >= job.chunks.length) {
    // All chunks sent and played — wait for tts_done from client
    // (tts_done triggers handleTtsDone2 which cleans up)
    console.log(`[tts2] All ${job.chunks.length} chunks played for entry=${entryId}, awaiting tts_done`);
    // BUG-123 fix: Set safety timeout for tts_done — if client never sends it,
    // force-complete instead of waiting up to 25s for the sweep to catch it.
    ttsPlaybackTimeout2 = setTimeout(() => {
      if (ttsCurrentlyPlaying === job && job.currentChunkIndex === chunkIndex) {
        console.warn(`[tts2] tts_done timeout after all chunks played — forcing done for entry=${entryId}`);
        handleTtsDone2(entryId);
      }
    }, 5000); // 5s is generous — client should send tts_done within ~100ms of last chunk finishing
    return;
  }

  // Advance to next chunk
  job.currentChunkIndex = nextIndex;
  const nextChunk = job.chunks[nextIndex];

  if (nextChunk.state === "ready" && nextChunk.audioBuf) {
    // Next chunk already fetched — send immediately
    sendChunk(job, nextIndex);
  } else if (nextChunk.state === "failed") {
    // Chunk fetch failed — skip to tts_done
    console.warn(`[tts2] Chunk ${nextIndex} failed — ending entry ${entryId} early`);
    handleTtsDone2(entryId);
  } else {
    // Chunk still fetching — it will be sent when fetchKokoroAudio completes
    console.log(`[tts2] Chunk ${nextIndex} still fetching — waiting for fetch to complete`);
    // Set a longer timeout while waiting for fetch
    ttsPlaybackTimeout2 = setTimeout(() => {
      if (ttsCurrentlyPlaying === job && job.currentChunkIndex === nextIndex) {
        console.warn(`[tts2] Chunk ${nextIndex} fetch timeout — ending entry ${entryId}`);
        handleTtsDone2(entryId);
      }
    }, 15000);
  }
}

/**
 * Called when client finishes playing all audio for an entry.
 * Marks the job done, marks conversation entry spoken, drains next.
 */
function handleTtsDone2(entryId: number | null): void {
  plog("tts2_done", `entry=${entryId}`);
  logChunkFlow("tts_done_received", entryId, ttsCurrentlyPlaying?.currentChunkIndex ?? -1);
  _clientPlayback.lastTtsDoneTs = Date.now();
  _clientPlayback.entriesCompleted++;
  _clientPlayback.currentEntryId = null;
  _clientPlayback.currentChunkIndex = null;
  if (ttsPlaybackTimeout2) { clearTimeout(ttsPlaybackTimeout2); ttsPlaybackTimeout2 = null; }

  // Find the matching job — prefer currently-playing, fall back to queue search
  let job = ttsCurrentlyPlaying;
  if (!job || job.entryId !== entryId) {
    job = ttsJobQueue.find(j => j.entryId === entryId && j.state === "playing") ?? null;
  }

  if (job) {
    job.state = "done";
    // Only null ttsCurrentlyPlaying if the matched job IS the currently playing one
    if (ttsCurrentlyPlaying === job) {
      ttsCurrentlyPlaying = null;
    }
    console.log(`[tts2] Done job=${job.jobId} entry=${entryId}`);
    _queueHistory.push({ ts: Date.now(), event: "drain_done", queueDepth: ttsJobQueue.length, jobId: job.jobId, entryId: job.entryId });
    if (_queueHistory.length > RING_CAP) _queueHistory.shift();
  } else {
    // No matching job — stale tts_done. Do NOT null ttsCurrentlyPlaying,
    // as the real playing job may still be active with a different entryId.
    console.log(`[tts2] handleTtsDone2 — no matching job for entry=${entryId} (stale?) — NOT clearing ttsCurrentlyPlaying (current=${ttsCurrentlyPlaying?.entryId})`);
  }

  // Mark conversation entry as spoken
  if (entryId != null) {
    const entry = conversationEntries.find(e => e.id === entryId);
    if (entry && !entry.spoken) {
      mlog(entry.id, "spoken", false, true, "handleTtsDone2");
      entry.spoken = true;
      console.log(`[tts2] Marked entry ${entryId} as spoken`);
      broadcast({ type: "entry", entries: conversationEntries, partial: false });
    }
  }

  // Drain next job
  drainAudioBuffer();
}

/**
 * Periodic sweep for stuck TTS jobs. Catches orphaned jobs that the per-chunk timeout
 * missed (e.g., ttsCurrentlyPlaying was nulled by a stale tts_done for a different entry).
 * Runs every 10 seconds.
 */
function sweepStaleTtsJobs(): void {
  const now = Date.now();
  const TTS_JOB_MAX_AGE_MS = 30000; // Max age for any job in queue before forced cleanup
  let recovered = 0;

  // Check currently playing job for timeout
  if (ttsCurrentlyPlaying && ttsCurrentlyPlaying.playingSince > 0) {
    const elapsed = now - ttsCurrentlyPlaying.playingSince;
    if (elapsed > TTS_PLAYING_TIMEOUT_MS) {
      console.warn(`[tts2] Sweep: currently playing job=${ttsCurrentlyPlaying.jobId} entry=${ttsCurrentlyPlaying.entryId} stuck for ${(elapsed / 1000).toFixed(0)}s — forcing done`);
      ttsCurrentlyPlaying.state = "failed";
      ttsCurrentlyPlaying = null;
      if (ttsPlaybackTimeout2) { clearTimeout(ttsPlaybackTimeout2); ttsPlaybackTimeout2 = null; }
      broadcast({ type: "tts_stop", reason: "stall_recovery" });
      recovered++;
      // Don't return — continue sweep to clean up other stuck jobs too
    }
  }

  // Check for orphaned playing jobs in the queue (ttsCurrentlyPlaying is null or different)
  for (const job of ttsJobQueue) {
    if (job.state === "playing" && ttsCurrentlyPlaying !== job) {
      console.warn(`[tts2] Sweep: orphaned job=${job.jobId} entry=${job.entryId} in playing state — marking failed`);
      job.state = "failed";
      recovered++;
    }
  }

  // Check for jobs stuck in "fetching" state — all chunks failed or timed out.
  for (const job of ttsJobQueue) {
    if (job.state === "fetching") {
      const allChunksDone = job.chunks.every(c => c.state === "ready" || c.state === "failed");
      const allFailed = job.chunks.every(c => c.state === "failed");
      if (allFailed) {
        console.warn(`[tts2] Sweep: job=${job.jobId} entry=${job.entryId} all chunks failed — marking job failed`);
        job.state = "failed";
        recovered++;
      } else if (allChunksDone && job.chunks[0]?.state === "ready") {
        // Chunks ready but job stuck in fetching — promote to ready
        console.log(`[tts2] Sweep: job=${job.jobId} entry=${job.entryId} chunks ready but job stuck in fetching — promoting`);
        job.state = "ready";
        recovered++;
      } else if (job.createdAt > 0 && (now - job.createdAt) > TTS_JOB_MAX_AGE_MS) {
        // Job has been fetching for too long — some chunks may be permanently hung
        const pendingCount = job.chunks.filter(c => c.state === "pending" || c.state === "fetching").length;
        console.warn(`[tts2] Sweep: job=${job.jobId} entry=${job.entryId} stuck in fetching for ${((now - job.createdAt) / 1000).toFixed(0)}s (${pendingCount} chunks still pending) — marking failed`);
        // Abort any in-flight fetches
        for (const chunk of job.chunks) {
          if (chunk.abortController) {
            try { chunk.abortController.abort(); } catch {}
            chunk.abortController = null;
          }
        }
        job.state = "failed";
        recovered++;
      }
    }
  }

  // Age-based cleanup: any non-terminal job older than TTS_JOB_MAX_AGE_MS gets failed
  for (const job of ttsJobQueue) {
    if (job.state !== "done" && job.state !== "failed" && job.createdAt > 0) {
      const age = now - job.createdAt;
      if (age > TTS_JOB_MAX_AGE_MS && ttsCurrentlyPlaying !== job) {
        console.warn(`[tts2] Sweep: job=${job.jobId} entry=${job.entryId} state=${job.state} aged out (${(age / 1000).toFixed(0)}s) — marking failed`);
        job.state = "failed";
        recovered++;
      }
    }
  }

  // Log sweep status for Monitor to verify sweeps are running
  if (ttsJobQueue.length > 0 || ttsCurrentlyPlaying) {
    console.log(`[tts2] Sweep: queue=${ttsJobQueue.length} playing=${ttsCurrentlyPlaying?.jobId ?? "none"} recovered=${recovered}`);
  }

  // Always try drain if queue has items or we recovered anything
  if (recovered > 0 || (ttsJobQueue.length > 0 && !ttsCurrentlyPlaying)) {
    drainAudioBuffer();
  }
}

/**
 * Stop all TTS playback — called on user interruption (stop button, new input).
 * Generation is bumped via bumpGeneration() with a tagged reason.
 */
function stopClientPlayback2(reason: GenerationEvent["reason"] = "user_stop", entryId?: number): void {
  // Task #37: passive_redetect should NOT bump generation — it's the passive watcher
  // re-detecting an idle prompt, not actual new input. Bumping gen causes dedup drift.
  if (reason === "passive_redetect") {
    console.log(`[tts2] Passive redetect — skipping gen bump, preserving ${ttsJobQueue.length} queued jobs`);
    ttsGenerationLog.push({ gen: ttsGeneration, reason, ts: Date.now(), entryId });
    if (ttsGenerationLog.length > 20) ttsGenerationLog.shift();
    return; // No TTS disruption at all for passive redetects
  }

  bumpGeneration(reason, entryId);

  // For user-initiated interruptions, cancel everything.
  // For new_input, preserve queued jobs from the previous response — they should finish playing.
  const shouldCancelQueue = USER_INITIATED_BUMP_REASONS.has(reason);

  if (shouldCancelQueue) {
    // Abort all in-flight Kokoro fetches
    for (const job of ttsJobQueue) {
      for (const chunk of job.chunks) {
        if (chunk.abortController) {
          try { chunk.abortController.abort(); } catch {}
          chunk.abortController = null;
        }
        chunk.audioBuf = null;
      }
    }
    // Clear queue and playing state
    ttsJobQueue.length = 0;
    ttsCurrentlyPlaying = null;
    if (ttsPlaybackTimeout2) { clearTimeout(ttsPlaybackTimeout2); ttsPlaybackTimeout2 = null; }
    // Tell client to stop playback
    broadcast({ type: "tts_stop" });
  } else {
    // new_input: let existing queue drain naturally. Don't abort fetches or clear queue.
    // The gen bump prevents NEW stale callbacks from old async paths, but existing jobs play through.
    // HOWEVER: if the currently playing job is stuck (playing for >10s on a new_input bump),
    // force-clear it so the queue can advance. This prevents stale playing jobs from blocking
    // new content indefinitely.
    if (ttsCurrentlyPlaying && ttsCurrentlyPlaying.playingSince > 0) {
      const elapsed = Date.now() - ttsCurrentlyPlaying.playingSince;
      if (elapsed > 10000) {
        console.warn(`[tts2] new_input bump: currently playing job=${ttsCurrentlyPlaying.jobId} stuck for ${(elapsed / 1000).toFixed(0)}s — force-clearing`);
        ttsCurrentlyPlaying.state = "failed";
        ttsCurrentlyPlaying = null;
        if (ttsPlaybackTimeout2) { clearTimeout(ttsPlaybackTimeout2); ttsPlaybackTimeout2 = null; }
        broadcast({ type: "tts_stop", reason: "stall_recovery" });
      }
    }
    console.log(`[tts2] Soft gen bump (reason=${reason}) — preserving ${ttsJobQueue.length} queued jobs`);
  }
}

// --- Tmux Streaming State Machine ---
// Uses `tmux pipe-pane` to stream output in real-time instead of polling snapshots.
// Detects Claude's response, extracts text, speaks it via TTS.

type StreamState = "IDLE" | "WAITING" | "THINKING" | "RESPONDING" | "FINALIZING" | "DONE";

let streamState: StreamState = "IDLE";
let _cleanMode = true; // Client clean/verbose mode: true = clean (only speakable), false = verbose (all entries)

/** Should this entry be queued for TTS? In clean mode, only speakable entries. In verbose mode, all assistant entries. */
function shouldTtsEntry(entry: ConversationEntry): boolean {
  if (_cleanMode) return entry.speakable;
  // Always respect speakable flag — tool output, file paths, etc. must never be spoken.
  // Verbose mode controls display (showing non-speakable entries), not TTS.
  return entry.speakable;
}

// Broadcast idle only when stream is not active (prevents mic button glow flicker)
function broadcastIdleIfSafe() {
  if (streamState === "WAITING" || streamState === "THINKING" || streamState === "RESPONDING" || streamState === "FINALIZING") {
    const voiceState = streamState === "RESPONDING" || streamState === "FINALIZING" ? "responding" : "thinking";
    broadcast({ type: "voice_status", state: voiceState });
  } else {
    broadcast({ type: "voice_status", state: "idle" });
  }
}
// ── Push-based streaming architecture ──
// The always-on pipe (tmux pipe-pane / pty onData) pushes output chunks to handlePipeOutput().
// No more polling intervals — state detection is push-triggered.
let streamTimeout: ReturnType<typeof setTimeout> | null = null;
let doneCheckTimer: ReturnType<typeof setTimeout> | null = null;
let _parseTimer: ReturnType<typeof setTimeout> | null = null; // Debounced parse/update
let _quietTimer: ReturnType<typeof setTimeout> | null = null; // Quiet detection (no output → done?)
let _idleCheckTimer: ReturnType<typeof setTimeout> | null = null; // Debounced idle activity check
let lastStreamActivity = 0;
let lastBroadcastText = "";
const DONE_QUIET_MS = 600; // 600ms quiet + prompt visible = done
const PARSE_DEBOUNCE_MS = 200; // Debounce pane capture + parse
const IDLE_CHECK_DEBOUNCE_MS = 500; // Debounce idle activity check
const STREAM_TIMEOUT_MS = 300000; // 5 minutes max
let preInputSnapshot: string = "";
let pendingVoiceInput: Array<{ text: string; entryId: number; target: string }> = []; // Queued voice while Claude is active
let _voiceQueueDraining = false; // Drain lock — prevents concurrent drains
let sawActivity = false;
let lastStreamEndTime = 0; // Cooldown: don't re-trigger right after streaming ends
const PASSIVE_COOLDOWN_MS = 10000; // 10 seconds after last stream ends
let _cooldownThinking = false; // Track if we sent thinking state during cooldown

// Legacy lists kept for reference — detection now uses SPINNER_REGEX pattern

// Delegate pane capture to terminal manager (with 100ms TTL cache to avoid concurrent captures)
function captureVisiblePane(): string { return terminal.capturePane(); }
function captureTerminalPane(): string { return terminal.capturePaneAnsi(); }

let _scrollbackCache: { text: string; ts: number } = { text: "", ts: 0 };
const CAPTURE_CACHE_TTL = 100; // ms
function captureTmuxPane(): string {
  const now = Date.now();
  if (now - _scrollbackCache.ts < CAPTURE_CACHE_TTL && _scrollbackCache.text) {
    return _scrollbackCache.text;
  }
  const text = terminal.capturePaneScrollback();
  _scrollbackCache = { text, ts: now };
  return text;
}

// Pattern-based spinner detection: Claude Code spinners look like "✶ Roosting…" or "· Shimmying… (3s · ↓ 85 tokens)"
// Pattern: <symbol> <SingleWord>… [optional timing info]
// The regex is specific enough (requires single word before …) to avoid false positives.
// Allow up to 120 chars to accommodate timing info like "(13m 26s · ↓ 10.6k tokens · thought for 15s)"
const SPINNER_REGEX = /^[^\w\d\s]\s+\w+…/;

function isSpinnerLine(trimmed: string): boolean {
  return trimmed.length < 120 && SPINNER_REGEX.test(trimmed);
}

function hasSpinnerChars(pane: string): boolean {
  // Claude Code TUI layout: content area → separator (─────) → ❯ → separator → status bar
  // The spinner appears in the CONTENT AREA above the separator, not after ❯.
  // ❯ is always visible (it's the TUI input field), so we check for spinners
  // between the user's input line and the bottom TUI chrome.
  const lines = pane.split("\n");

  // Find bottom TUI chrome: separator line above the always-present ❯
  let bottomPromptIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^❯\s*$/.test(lines[i].trim())) { bottomPromptIdx = i; break; }
  }

  // Find the separator just above ❯ (within 3 lines)
  let contentEnd = bottomPromptIdx >= 0 ? bottomPromptIdx : lines.length;
  if (bottomPromptIdx > 0) {
    for (let i = bottomPromptIdx - 1; i >= Math.max(0, bottomPromptIdx - 3); i--) {
      if (/^[─━═]{3,}/.test(lines[i].trim())) { contentEnd = i; break; }
    }
  }

  // Find user input line to limit search scope
  const inputIdx = findUserInputLine(lines, lastUserInput);
  const startIdx = inputIdx >= 0 ? inputIdx + 1 : Math.max(0, contentEnd - 30);

  // Check content area for spinner lines
  for (let i = startIdx; i < contentEnd; i++) {
    if (isSpinnerLine(lines[i].trim())) return true;
  }
  return false;
}

function hasResponseMarkers(pane: string): boolean {
  // Only check for NEW response markers not present in pre-input snapshot
  const preMarkerCount = (preInputSnapshot.match(/⏺/g) || []).length;
  const curMarkerCount = (pane.match(/⏺/g) || []).length;
  return curMarkerCount > preMarkerCount;
}

function findUserInputLine(lines: string[], userInput: string): number {
  // Match the start of the input (first line, first 35 chars) to handle tmux line wrapping
  // Use only the first line since voice transcriptions can be multi-line
  const firstLine = userInput.trim().split("\n")[0].trim();
  const inputStart = firstLine.slice(0, 35);
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("❯ ") && trimmed.slice(2).trim().startsWith(inputStart)) {
      return i;
    }
  }
  return -1;
}

// Detect interactive prompts (plan approval, permission requests) and notify client
let interactivePromptActive = false;
let _feedbackDismissed = false; // Prevent auto-dismiss loop for feedback prompt
function detectInteractivePrompt(pane: string): boolean {
  const lines = pane.split("\n");
  const tail = lines.slice(-15).join("\n");

  // Plan approval: "❯ 1. Yes" style numbered menus, "1: Bad  2: Fine" style choices
  // Permission prompts, confirmation dialogs
  const hasNumberedMenu = /❯\s+\d+\.\s+/i.test(tail);
  const hasNumberedChoices = /\d+:\s+\w+.*\d+:\s+\w+/.test(tail); // "1: Bad  2: Fine  3: Good"
  const hasQuestion = /(Would you like to proceed|Do you want to)/i.test(tail);

  if (hasNumberedMenu || hasNumberedChoices || hasQuestion) {
    // Auto-dismiss Claude's session feedback prompt ("1: Bad  2: Fine  3: Good  0: Dismiss")
    if (/\b0:\s*Dismiss\b/i.test(tail)) {
      if (!_feedbackDismissed) {
        _feedbackDismissed = true;
        console.log("[interactive] Auto-dismissing session feedback prompt");
        // Send raw keystroke "0" (not sendText which uses -l literal mode)
        try {
          execFileSync("tmux", ["send-keys", "-t", terminal.currentTarget!, "0"], { stdio: "ignore", timeout: 3000 });
        } catch {}
      }
      return true;
    }
    _feedbackDismissed = false; // Reset for non-feedback prompts
    if (!interactivePromptActive) {
      interactivePromptActive = true;
      console.log("[interactive] Prompt detected — notifying client");

      // Extract structured options for flow mode display
      const options: { num: string; title: string; desc: string }[] = [];
      const optionRe = /(?:❯\s+)?(\d+)\.\s+(.+)/g;
      let m: RegExpExecArray | null;
      const tailLines = tail.split("\n");
      for (let li = 0; li < tailLines.length; li++) {
        m = optionRe.exec(tailLines[li]);
        if (m) {
          const num = m[1];
          const title = m[2].trim();
          // Next line might be an indented description
          let desc = "";
          if (li + 1 < tailLines.length) {
            const nextLine = tailLines[li + 1].trim();
            // Description lines are indented and don't start with a number+dot
            if (nextLine && !/^\d+\./.test(nextLine) && !/^❯/.test(nextLine) && !/^Enter/.test(nextLine)) {
              desc = nextLine;
            }
          }
          options.push({ num, title, desc });
        }
        optionRe.lastIndex = 0; // Reset for next line
      }

      // Extract question text (lines before the options, after horizontal rules)
      let question = "";
      const ruledLines = tail.split(/─{5,}/);
      if (ruledLines.length >= 2) {
        // Question is between the rules
        const qBlock = ruledLines[1].trim().split("\n").filter(l => l.trim() && !/^[☐☑]/.test(l.trim()));
        question = qBlock.join(" ").trim();
      }

      broadcast({ type: "interactive_prompt", active: true, question, options });
    }
    return true;
  }
  if (interactivePromptActive) {
    interactivePromptActive = false;
    broadcast({ type: "interactive_prompt", active: false });
  }
  return false;
}

function hasPromptReady(pane: string): boolean {
  // Claude Code TUI always shows ❯ at the bottom (it's the input field).
  // "Prompt ready" means: ❯ is visible AND no spinner in the content area.
  // The spinner disappears only when Claude's turn is fully complete.
  const lines = pane.split("\n");

  // Find the bottom TUI ❯ prompt
  let bottomPromptIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^❯\s*$/.test(lines[i].trim())) { bottomPromptIdx = i; break; }
  }
  if (bottomPromptIdx < 0) return false;

  // Find separator above ❯
  let contentEnd = bottomPromptIdx;
  for (let i = bottomPromptIdx - 1; i >= Math.max(0, bottomPromptIdx - 3); i--) {
    if (/^[─━═]{3,}/.test(lines[i].trim())) { contentEnd = i; break; }
  }

  // Find user input line (may have scrolled off for long responses)
  const inputIdx = findUserInputLine(lines, lastUserInput);
  // If input scrolled off, check last 30 lines before separator for spinners
  const checkStart = inputIdx >= 0 ? inputIdx + 1 : Math.max(0, contentEnd - 30);

  // Check that NO spinner exists in content area
  for (let i = checkStart; i < contentEnd; i++) {
    if (isSpinnerLine(lines[i].trim())) return false;
  }

  return true; // ❯ exists and no spinner → Claude is done
}

// Get lines after user's input from the tmux pane
function getLinesAfterInput(postSnapshot: string, preSnapshot: string, userInput: string): string[] {
  const postLines = postSnapshot.split("\n");
  const inputLineIdx = findUserInputLine(postLines, userInput);

  let newLines: string[];
  if (inputLineIdx >= 0) {
    newLines = postLines.slice(inputLineIdx);
  } else {
    const preLines = preSnapshot.split("\n");
    let diffStart = 0;
    for (let i = 0; i < Math.min(preLines.length, postLines.length); i++) {
      if (preLines[i] !== postLines[i]) { diffStart = i; break; }
      diffStart = i + 1;
    }
    newLines = postLines.slice(diffStart);
  }

  // Skip user's input lines (which may wrap across many tmux lines)
  const inputNorm = userInput.trim().toLowerCase().replace(/\s+/g, " ");
  let startIdx = 0;
  let consumedLen = 0;
  for (let i = 0; i < newLines.length; i++) {
    const t = newLines[i].trim();
    if (!t) continue;
    if (t.startsWith("❯")) {
      // Track how much of userInput appeared on this prompt line so that
      // short tail fragments on the NEXT line can be matched correctly.
      const lineContent = t.replace(/^❯\s*/, "").toLowerCase().replace(/\s+/g, " ").trim();
      if (lineContent) {
        const idx = inputNorm.indexOf(lineContent, consumedLen);
        if (idx >= 0) consumedLen = idx + lineContent.length;
      }
      startIdx = i + 1;
      continue;
    }
    const tNorm = t.toLowerCase().replace(/\s+/g, " ");
    // Only try to skip lines as user-input echo while inputNorm not fully consumed
    if (consumedLen < inputNorm.length) {
      const remaining = inputNorm.slice(consumedLen).trimStart();
      // Primary: sequential continuation (handles tmux-wrapped tail fragments)
      if (remaining.startsWith(tNorm)) {
        const idx = inputNorm.indexOf(tNorm, consumedLen);
        consumedLen = (idx >= 0 ? idx : consumedLen) + tNorm.length;
        startIdx = i + 1;
        continue;
      }
      // Fallback 1: tmux may break mid-word causing off-by-one at the seam.
      // Check if tNorm appears anywhere in the remaining unconsumed input.
      if (tNorm.length >= 3) {
        const posInRemaining = remaining.indexOf(tNorm);
        if (posInRemaining >= 0 && posInRemaining < 15) {
          consumedLen += posInRemaining + tNorm.length;
          startIdx = i + 1;
          continue;
        }
      }
      // Fallback 2: check if tNorm is a substring of the full input (handles edge wraps)
      if (tNorm.length >= 5) {
        const posInFull = inputNorm.indexOf(tNorm, Math.max(0, consumedLen - 5));
        if (posInFull >= 0 && posInFull < consumedLen + 15) {
          consumedLen = posInFull + tNorm.length;
          startIdx = i + 1;
          continue;
        }
      }
    }
    break;
  }
  return newLines.slice(startIdx);
}


// =============================================
// Conversation entry model — single source of truth for display + TTS
// =============================================

interface ExtractedParagraph {
  text: string;
  speakable: boolean;
}

interface ConversationEntry {
  id: number;
  role: "user" | "assistant";
  text: string;
  speakable: boolean;
  spoken: boolean;
  ts: number;
  turn: number;
  window?: string;           // tmux window key — isolates entries per window
  sourceTag?: string;        // origin: "voice", "text-input", "terminal", "text-input-test"
  queued?: boolean; // true = pending while Claude is active, not yet sent
  filler?: boolean; // true = auto-filler phrase ("Got it, let me look into that")
  inputId?: string;          // Unique ID for this voice/text input (user entries)
  parentInputId?: string;    // Links assistant responses to the user input that triggered them
}

let conversationEntries: ConversationEntry[] = [];
let entryIdCounter = 0;
let currentTurn = 0;
let entryTtsTimer: ReturnType<typeof setTimeout> | null = null;
// Tracks how many chars of each entry have already been queued for TTS.
// Allows sentence-level TTS: speak complete sentences as they arrive mid-stream.
let entryTtsCursor: Map<number, number> = new Map();

// --- Per-window conversation arrays ---
// Each tmux window gets its own conversation entries array.
// Prevents test entries and CLI output from leaking across windows.
const WINDOW_ENTRIES_FILE = join(__dirname, "window-entries.json");
const windowEntries = new Map<string, ConversationEntry[]>();
let currentWindowKey = "_unset"; // Sentinel: no window selected until client sends window_preference

// Load persisted window entries from disk on startup
try {
  if (existsSync(WINDOW_ENTRIES_FILE)) {
    const raw = JSON.parse(readFileSync(WINDOW_ENTRIES_FILE, "utf-8"));
    if (raw && typeof raw === "object") {
      for (const [key, entries] of Object.entries(raw)) {
        if (Array.isArray(entries)) windowEntries.set(key, entries as ConversationEntry[]);
      }
      console.log(`[startup] Loaded ${windowEntries.size} window entry caches from disk`);
    }
  }
} catch (err) {
  console.error("[startup] Failed to load window entries from disk:", (err as Error).message);
}

// Own-pane detection removed — server scrapes any window the user switches to

/** Get the window key for the currently active tmux window.
 *  Uses displayTarget (session:windowIdx) rather than currentTarget (pane ID)
 *  because pane IDs change when agents spawn/close panes in the same window,
 *  causing cache misses and lost conversation entries on switch-back. */
function getWindowKey(): string {
  return terminal?.displayTarget ?? currentWindowKey ?? "_default";
}

/** Check if the current target is a voice session (claude-voice).
 *  Non-voice sessions (coordinator, agents) should never have speakable entries. */
function isVoiceSession(): boolean {
  const target = terminal?.displayTarget ?? terminal?.currentTarget ?? currentWindowKey ?? "";
  const session = target.split(":")[0];
  return session === "claude-voice" || session === "" || session === "_default";
}

/** Check if a client window has been selected (not still in _unset sentinel state).
 *  Until a client sends window_preference, the server should not scrape/broadcast. */
function isWindowActive(): boolean {
  return currentWindowKey !== "_unset" && currentWindowKey !== "";
}

/** Activate a window — switch target, load entries, reset status.
 *  Called from window_preference handler and fallback timer.
 *  @param target - "session:windowIdx" format
 *  @param ws - the requesting WebSocket client (entries sent to this client) */
/** Shared core for activateWindow and _executeWindowSwitch (Audit I2 unification).
 *  Handles: state reset, entry loading, broadcasts, passive watcher init. */
function _activateWindowCore(session: string, windowIdx: number, opts: {
  isFirst?: boolean;
  sendToWs?: import("ws").WebSocket;  // if set, send entries to this client only (first activation)
  stopStreaming?: boolean;             // if true, call stopTmuxStreaming before switch
}): void {
  if (!terminal.switchTarget) return;
  const target = `${session}:${windowIdx}`;
  const prevWindow = currentWindowKey || "_unset";
  const prevEntryCount = conversationEntries.length;
  console.log(`[window] ${opts.isFirst ? "First activation" : "Switching"} to: ${target}`);

  // Save current window state (skip on first activation)
  if (!opts.isFirst) saveCurrentWindowEntries();
  if (opts.stopStreaming) stopTmuxStreaming();
  terminal.switchTarget(session, windowIdx);

  saveSettings({ tmuxTarget: `${session}:${windowIdx}` });
  currentWindowKey = getWindowKey();

  // Stop TTS + reset all state
  stopClientPlayback2("session_switch");
  _cooldownThinking = false;
  lastStreamEndTime = 0;
  preInputSnapshot = "";
  _scrollbackCache = { text: "", ts: 0 };
  lastTerminalText = ""; // Force terminal panel to re-broadcast after window switch
  _lastWindowSwitchTs = Date.now();
  if (streamState !== "IDLE") streamState = "IDLE";
  entryTtsCursor.clear();

  // Load entries for this window
  const cached = loadWindowEntries(currentWindowKey);
  // Filter test entries only — cache key already scopes to the correct window.
  // The old `e.window === currentWindowKey` filter was too strict: entries persisted
  // from a previous server session or loaded from scrollback could have a stale window
  // tag (e.g. different pane format), causing ALL cached entries to be discarded.
  const realCached = cached?.filter(e => !isTestEntry(e));
  if (realCached && realCached.length > 0) {
    // Re-tag entries to current window key (fixes stale window tags from persistence)
    for (const e of realCached) e.window = currentWindowKey;
    if (realCached.length < (cached?.length ?? 0)) {
      console.log(`[window] Cleaned ${(cached?.length ?? 0) - realCached.length} test entries from cache`);
    }
    setConversationEntries(realCached);
    console.log(`[window] Loaded ${realCached.length} cached entries for ${currentWindowKey}`);
  } else {
    const scrollback = loadScrollbackEntries();
    setConversationEntries(scrollback);
    console.log(`[window] Parsed ${scrollback.length} entries from scrollback for ${currentWindowKey}`);
  }
  for (const e of conversationEntries) e.spoken = true;
  if (conversationEntries.length > 0) {
    entryIdCounter = Math.max(entryIdCounter, ...conversationEntries.map(e => e.id));
  }

  // Send entries — either to requesting client or broadcast to all
  let recentEntries = [...conversationEntries];
  if (recentEntries.length > 80) recentEntries = recentEntries.slice(-80);
  if (opts.sendToWs) {
    if (!(opts.sendToWs as any)._isTestMode) {
      // Bug U4 fix: filter ALL test entries, not just text-input-test
      recentEntries = recentEntries.filter(e => !isTestEntry(e));
    }
    opts.sendToWs.send(JSON.stringify({ type: "entry", entries: recentEntries, partial: false }));
  } else {
    broadcast({ type: "entry", entries: recentEntries, partial: false });
  }

  // Reset status indicators
  broadcast({ type: "voice_status", state: "idle" });
  broadcast({ type: "status", phase: "idle", micActive: false, ttsPlaying: false, conversationActive: false });
  broadcast({ type: "tmux", session, window: windowIdx, alive: terminal.isSessionAlive(), current: terminal.displayTarget ?? terminal.currentTarget });

  // Initialize pre-input snapshot for new window
  try {
    preInputSnapshot = captureTmuxPane();
  } catch {}
  // Immediately broadcast terminal panel content from the new window
  try {
    const text = captureTerminalPane();
    if (text) {
      lastTerminalText = text;
      broadcast({ type: "terminal", text });
    }
  } catch {}

  // On first activation, send Murmur context to voice session
  if (opts.isFirst) sendMurmurContext(3000);

  // Log window switch for Monitor dashboard
  _windowLog.push({
    ts: Date.now(), fromWindow: prevWindow, toWindow: target,
    entriesLoaded: conversationEntries.length, entriesUnloaded: prevEntryCount,
    snapshotReset: true,
  });
  if (_windowLog.length > RING_CAP) _windowLog.shift();

  console.log(`[window] Activated ${target}, ${recentEntries.length} entries + idle status`);
}

function activateWindow(target: string, ws: import("ws").WebSocket): void {
  const lastColon = target.lastIndexOf(":");
  if (lastColon === -1 || !terminal.switchTarget) return;
  const session = target.slice(0, lastColon);
  const windowIdx = parseInt(target.slice(lastColon + 1));
  if (isNaN(windowIdx)) return;
  const isFirst = !isWindowActive();
  _activateWindowCore(session, windowIdx, { isFirst, sendToWs: ws });
}

/** Debounced persistence of windowEntries to disk. Called after map updates. */
let _persistTimer: ReturnType<typeof setTimeout> | null = null;
function persistWindowEntries(): void {
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    try {
      const obj: Record<string, ConversationEntry[]> = {};
      // Filter test entries from persistence — they should never pollute the cache
      for (const [key, entries] of windowEntries) obj[key] = entries.filter(e => !isTestEntry(e));
      const tmpFile = WINDOW_ENTRIES_FILE + ".tmp";
      writeFileSync(tmpFile, JSON.stringify(obj));
      renameSync(tmpFile, WINDOW_ENTRIES_FILE);
    } catch (err) {
      console.error("[window] Failed to persist window entries:", (err as Error).message);
    }
  }, 2000); // 2s debounce — fast enough for switches, avoids thrashing during streaming
}

/** Update conversationEntries and sync to the per-window map.
 *  Uses currentWindowKey (cached from last activation) — NOT getWindowKey() which
 *  re-derives from terminal.displayTarget and could drift if tmux state changed. */
function setConversationEntries(entries: ConversationEntry[]): void {
  conversationEntries = entries;
  const key = currentWindowKey && currentWindowKey !== "_unset" ? currentWindowKey : getWindowKey();
  if (key) windowEntries.set(key, entries);
  persistWindowEntries();
}

/** Save current entries to the per-window map (call before switching windows).
 *  Uses currentWindowKey (snapshot from last activation) — NOT getWindowKey() which
 *  would re-derive from terminal state and could mismatch if _window changed. */
function saveCurrentWindowEntries(): void {
  const key = currentWindowKey;
  if (key && key !== "_unset") {
    windowEntries.set(key, conversationEntries);
    console.log(`[window] Saved ${conversationEntries.length} entries under key "${key}"`);
    persistWindowEntries();
  }
}

/** Load entries for a window key from the map, or empty array if not cached */
function loadWindowEntries(windowKey: string): ConversationEntry[] | null {
  return windowEntries.get(windowKey) ?? null;
}

/** Debounce timer for rapid window switches — only the last one executes */
let _switchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

/** Execute the actual window switch (called after debounce from tmux:switch: handler) */
function _executeWindowSwitch(session: string, windowIdx: number, _ws: import("ws").WebSocket): void {
  // Broadcast to ALL clients (not just requesting ws) so every connected device updates.
  _activateWindowCore(session, windowIdx, { stopStreaming: true });
}

/** Returns true if entry looks like test injection garbage that should not be persisted or cached.
 *  Bug U4 fix: checks BOTH "text-input-test" (addUserEntry) AND "test-" (test:entries-*) prefixes. */
function isTestEntry(e: ConversationEntry): boolean {
  const t = e.text;
  return /^dedup-test-|^test-paste-|^reply to dedup-test-/.test(t)
    || e.sourceTag?.startsWith("text-input-test") === true
    || e.sourceTag?.startsWith("test-") === true;
}

/** Central dedup check: returns true if an entry with same role + normalized text
 *  already exists in conversationEntries within the dedup window.
 *  This is the FINAL guard — catches duplicates that slip through caller-level dedup. */
function isDuplicateEntry(entry: ConversationEntry): boolean {
  const DEDUP_WINDOW_MS = 60000; // 60s for user entries, turn-based for assistant
  const norm = entry.text.trim().toLowerCase().replace(/\s+/g, " ");
  if (norm.length === 0) return false;
  const normNoSpaces = norm.replace(/\s/g, "");
  const cutoff = Date.now() - DEDUP_WINDOW_MS;

  if (entry.role === "user") {
    // User entries: check within last 60s by normalized text
    const match = conversationEntries.find(e => {
      if (e.role !== "user" || e.ts < cutoff) return false;
      const eNorm = e.text.trim().toLowerCase().replace(/\s+/g, " ");
      if (eNorm === norm) return true;
      return eNorm.replace(/\s/g, "") === normNoSpaces;
    });
    if (match) {
      _dedupLog.push({ ts: Date.now(), rejectedText: entry.text.slice(0, 120), rejectedRole: "user", matchedEntryId: match.id, tier: 2 });
      if (_dedupLog.length > RING_CAP) _dedupLog.shift();
      return true;
    }
    return false;
  } else {
    // Assistant entries: two-tier dedup
    for (const e of conversationEntries) {
      if (e.role !== "assistant") continue;
      // Tier 1: exact text match — stale content resurfacing from scrollback reparse
      if (e.text === entry.text) {
        _dedupLog.push({ ts: Date.now(), rejectedText: entry.text.slice(0, 120), rejectedRole: "assistant", matchedEntryId: e.id, tier: 1 });
        if (_dedupLog.length > RING_CAP) _dedupLog.shift();
        return true;
      }
      // Tier 2: normalized match with turn+time window
      if (e.ts < cutoff) continue;
      if (Math.abs((e.turn ?? 0) - (entry.turn ?? 0)) > 3) continue;
      const eNorm = e.text.trim().toLowerCase().replace(/\s+/g, " ");
      if (eNorm === norm) {
        _dedupLog.push({ ts: Date.now(), rejectedText: entry.text.slice(0, 120), rejectedRole: "assistant", matchedEntryId: e.id, tier: 2 });
        if (_dedupLog.length > RING_CAP) _dedupLog.shift();
        return true;
      }
    }
    return false;
  }
}

/** Push an entry into conversationEntries with window tag automatically set */
function pushEntry(entry: ConversationEntry): boolean {
  // Central dedup guard — catches duplicates from any code path
  if (isDuplicateEntry(entry)) {
    console.log(`[DEDUP-CENTRAL] Blocked duplicate ${entry.role} entry: "${entry.text.slice(0, 60)}" (turn=${entry.turn})`);
    return false;
  }

  const wk = getWindowKey();
  entry.window = wk;
  // Non-voice sessions (coordinator, agents): suppress TTS playback but keep speakable=true
  // so clean mode still shows the entry. speakable = "this is prose content" (display flag),
  // spoken = "TTS completed or skipped" (audio flag).
  if (!isVoiceSession() && entry.speakable) {
    mlog(entry.id, "spoken", false, true, "pushEntry:windowTtsGuard");
    entry.spoken = true; // Skip TTS — mark as already spoken so TTS queue ignores it
    console.log(`[WINDOW-TTS-GUARD] Suppressed TTS for entry ${entry.id} — non-voice session (window=${wk}), speakable preserved`);
  }
  // Non-speakable entries should be marked spoken immediately to prevent false "dropped TTS" alerts
  if (!entry.speakable && !entry.spoken) {
    mlog(entry.id, "spoken", false, true, "pushEntry:nonSpeakable");
    entry.spoken = true;
  }
  // Safety: if conversationEntries somehow has entries from a different window, log it
  if (conversationEntries.length > 0) {
    const lastEntry = conversationEntries[conversationEntries.length - 1];
    if (lastEntry.window && wk && lastEntry.window !== wk && lastEntry.window !== "_default") {
      console.warn(`[WINDOW-LEAK] Entry window mismatch! Last entry window=${lastEntry.window}, current window=${wk}. conversationEntries may have cross-window pollution.`);
    }
  }
  conversationEntries.push(entry);
  // Enforce cap on every push — prevents overflow during rapid gen bumps
  // where dedicated trimEntriesToCap call sites may be skipped.
  trimEntriesToCap();
  return true;
}

// Add a user entry and broadcast the updated entry list
function addUserEntry(text: string, queued = false, _source = "unknown", inputId?: string) {
  console.log(`[DEDUP-TRACE] addUserEntry called from="${_source}" text="${text.slice(0, 80)}" queued=${queued} ts=${Date.now()} turn=${currentTurn} streamState=${streamState}`);
  // Suppress voice panel instruction messages from appearing in the conversation view
  if (MURMUR_CONTEXT_FILTER.test(text.trim())) {
    if (/prose mode/i.test(text)) console.log(`[PROSE-LEAK-TRACE] addUserEntry FILTERED from="${_source}": "${text.slice(0, 80)}"`);
    return { id: -1, role: "user" as const, text, speakable: false, spoken: false, ts: Date.now(), turn: currentTurn } as ConversationEntry;
  }
  // Suppress Claude Code team/agent messages
  if (/^<\/?teammate-message|^\{"type":"idle_notification"|^\{"type":"shutdown|^\{"type":"teammate_terminated"|^<\/?task-notification/.test(text.trim())) {
    return { id: -1, role: "user" as const, text, speakable: false, spoken: false, ts: Date.now(), turn: currentTurn } as ConversationEntry;
  }
  // Filter agent infrastructure commands (tmux send-keys, test runners, etc.)
  if (isAgentInfraCommand(text)) {
    console.log(`[addUserEntry] Filtered agent command from="${_source}": "${text.slice(0, 80)}"`);
    return { id: -1, role: "user" as const, text, speakable: false, spoken: false, ts: Date.now(), turn: currentTurn } as ConversationEntry;
  }
  // Bug U3: Filter tool output markers that passive watcher scrapes from agent panes
  // (⎿, Read(...), Bash(...), ⏺ Bash, Running…, ctrl+o to expand, etc.)
  if (isToolOutputLine(text)) {
    console.log(`[addUserEntry] Filtered tool output from="${_source}": "${text.slice(0, 80)}"`);
    return { id: -1, role: "user" as const, text, speakable: false, spoken: false, ts: Date.now(), turn: currentTurn } as ConversationEntry;
  }
  // Filter status line text that passive watcher may scrape near the prompt
  if (/^[✻✶✢✽·]/.test(text.trim()) || /^(Compacting conversation|Crunched for |Background command)/i.test(text.trim()) || /^\d+\s+background\s+task/i.test(text.trim())) {
    console.log(`[addUserEntry] Filtered status line from="${_source}": "${text.slice(0, 80)}"`);
    return { id: -1, role: "user" as const, text, speakable: false, spoken: false, ts: Date.now(), turn: currentTurn } as ConversationEntry;
  }
  // Dedup by inputId: if an entry with same inputId already exists, return it
  if (inputId) {
    const existing = conversationEntries.find(e => e.inputId === inputId);
    if (existing) {
      console.log(`[DEDUP-TRACE] DEDUP by inputId="${inputId}" → existing id=${existing.id}`);
      return existing;
    }
  }

  // Dedup: skip if an identical user entry already exists recently
  // (prevents passive watcher re-adding text that was already added by text:/voice handler)
  //
  // Two-level normalization:
  //   Level 1 (strict): collapse whitespace to single space — catches most duplicates
  //   Level 2 (fuzzy):  strip ALL spaces — catches tmux wrap boundary mismatches
  //     When passive watcher reconstructs text from tmux pane, it joins wrapped lines
  //     with " ". If the wrap splits mid-word ("bro" + "wn"), the reconstructed text
  //     has a spurious space ("bro wn" vs original "brown"). Stripping all spaces
  //     makes both "bro wn fox" and "brown fox" → "brownfox" → match.
  //
  // Use time-based window (60s) instead of turn-based — turn counter can jump during
  // concurrent activity, causing the dedup to miss duplicates across turn boundaries.
  const normalized = text.trim().toLowerCase().replace(/[\s]+/g, " ");
  const normalizedNoSpaces = normalized.replace(/\s/g, "");
  const dedupeWindowMs = 60000;
  const cutoff = Date.now() - dedupeWindowMs;
  const recent = conversationEntries.filter(e => e.role === "user" && e.ts >= cutoff);
  console.log(`[DEDUP-TRACE] dedup check: normalized="${normalized.slice(0, 60)}" noSpaces="${normalizedNoSpaces.slice(0, 40)}" recent=${recent.length} total=${conversationEntries.length}`);
  for (const e of recent) {
    const eNorm = e.text.trim().toLowerCase().replace(/[\s]+/g, " ");
    const eNoSpaces = eNorm.replace(/\s/g, "");
    const strictMatch = eNorm === normalized;
    const fuzzyMatch = eNoSpaces === normalizedNoSpaces;
    console.log(`[DEDUP-TRACE]   compare id=${e.id} ts=${e.ts} strict=${strictMatch} fuzzy=${fuzzyMatch} eNorm="${eNorm.slice(0, 60)}"`);
  }
  const dup = recent.find(e => {
    const eNorm = e.text.trim().toLowerCase().replace(/[\s]+/g, " ");
    if (eNorm === normalized) return true; // Strict match
    // Fuzzy match: same text modulo all whitespace (tmux wrap boundary mismatch)
    return eNorm.replace(/\s/g, "") === normalizedNoSpaces;
  });
  if (dup) {
    console.log(`[DEDUP-TRACE] DEDUP HIT: Skipping duplicate from="${_source}" text="${text.slice(0, 60)}" (matches id=${dup.id})`);
    return dup;
  }
  // Cross-check: reject if text substantially matches a recent assistant entry (role misattribution).
  // Passive watcher can mistake Claude's response text near the ❯ prompt as user input.
  const assistantRecent = conversationEntries.filter(e => e.role === "assistant" && e.ts >= cutoff);
  const prefix40 = normalized.slice(0, 40);
  if (prefix40.length >= 20) {
    const assistantMatch = assistantRecent.find(e => {
      const aNorm = e.text.trim().toLowerCase().replace(/[\s]+/g, " ");
      return aNorm.startsWith(prefix40) || prefix40.startsWith(aNorm.slice(0, 40));
    });
    if (assistantMatch) {
      console.log(`[DEDUP-TRACE] ROLE-GUARD: Rejected user entry matching assistant id=${assistantMatch.id} from="${_source}": "${text.slice(0, 60)}"`);
      return { id: -1, role: "user" as const, text, speakable: false, spoken: false, ts: Date.now(), turn: currentTurn } as ConversationEntry;
    }
  }

  // Length guard: passive watcher inputs > 300 chars are suspicious — real voice/type inputs are short.
  // Log a warning but still create the entry (don't block legitimate long pastes).
  if (_source === "terminal" && text.length > 300) {
    console.warn(`[DEDUP-TRACE] LONG-INPUT-WARN: Passive watcher detected ${text.length}-char input (suspicious): "${text.slice(0, 80)}"`);
  }

  console.log(`[DEDUP-TRACE] CREATING NEW entry from="${_source}" text="${text.slice(0, 60)}"`);

  const entry: ConversationEntry = {
    id: ++entryIdCounter,
    role: "user",
    text,
    speakable: true, // User entries are always prose — speakable for clean mode visibility + TTS
    spoken: false,
    ts: Date.now(),
    turn: currentTurn,
    sourceTag: _source,
    queued,
    ...(inputId ? { inputId } : {}),
  };
  pushEntry(entry);
  elog(entry.id, "user", _source, text);
  if (inputId) {
    const source = _source.startsWith("voice") ? "voice" as const : _source.startsWith("terminal") ? "terminal" as const : "text-input" as const;
    logInput(inputId, source, entry.id);
  }
  broadcast({ type: "entry", entries: conversationEntries, partial: false });
  return entry;
}

/** Returns true if text looks like transient tool output that should NOT become a conversation entry.
 *  These are tool chrome lines that flash briefly during streaming then disappear. */
function isToolOutputLine(text: string): boolean {
  const t = text.trim();
  if (/^⏺\s*(Bash|Read|Write|Edit|Glob|Grep|Searched|Reading|Update|Agent|WebFetch|WebSearch|NotebookEdit)\b/i.test(t)) return true;
  if (/^Bash\(/i.test(t)) return true;
  if (/^⎿/.test(t)) return true;
  if (/^(Read|Edit|Write|Grep|Glob|Agent|WebFetch|WebSearch|NotebookEdit)\s*\(/i.test(t)) return true;
  if (/ctrl\+o\s+to\s+expand/i.test(t)) return true;
  if (/^Running…/i.test(t)) return true;
  if (/^\+\d+ lines/.test(t)) return true;
  if (/^… \+\d+/.test(t)) return true;
  if (/^Ran /i.test(t) && t.length < 60) return true;
  if (/^Read \d+ files?/i.test(t)) return true;
  if (/^Searched for \d+/i.test(t)) return true;
  if (/^Wrote \d+/i.test(t)) return true;
  if (/^Edited \d+/i.test(t)) return true;
  if (/^Background command/i.test(t)) return true; // Task #36: background task notifications
  if (/^\d+\s+background\s+task/i.test(t)) return true; // Task #36: "2 background tasks"
  return false;
}

/** Detect agent infrastructure commands that should NOT become user conversation entries.
 *  These are commands agents run in their CLI (tmux send-keys, test runners, etc.)
 *  that the passive watcher might scrape from the ❯ prompt line. */
function isAgentInfraCommand(text: string): boolean {
  const t = text.trim();
  if (/^tmux\s+send-keys\b/i.test(t)) return true;
  if (/\s-t\s+(test-runner|murmur-test)/i.test(t)) return true;
  if (/^node\s+--import\s+tsx/i.test(t)) return true;
  if (/^npx\s+tsx\b/i.test(t)) return true;
  if (/^npm\s+(run\s+)?test/i.test(t)) return true;
  if (/^echo\s+.*>>\s*\/tmp\//i.test(t)) return true;  // pipeline logging commands
  if (/^(cat|tail|head|grep)\s+.*\/tmp\//i.test(t)) return true;  // pipeline file access (excludes capitalized Read which is a user prompt)
  if (/^tmux\s+(capture-pane|list-windows|list-sessions|display-message)\b/i.test(t)) return true;
  if (/^(cp|mv|git|curl)\s+/i.test(t) && t.split(/\s+/).length >= 3) return true;  // shell ops with args (not short user messages like "git help")
  return false;
}

// ── State machine for extractStructuredOutput (BUG-116 redesign) ──
// States: PROSE (capture as speakable), TOOL_BLOCK (skip — entered on tool marker,
// exited on ⏺-prose / empty line / prompt), AGENT_BLOCK (skip — XML tags),
// STATUS (skip — spinner/chrome). Each line transitions state based on markers.
// No line evaluated in isolation — block context determines classification.
type ParserState = "PROSE" | "TOOL_BLOCK" | "AGENT_BLOCK" | "STATUS";

// Returns true if line is TUI chrome that should be skipped in ANY state
function isChromeSkip(trimmed: string): string {
  if (/^[─━═]{3,}/.test(trimmed)) return "separator";
  if (/^❯/.test(trimmed)) return "prompt";
  if (/bypass\s+permissions/i.test(trimmed)) return "bypass_permissions";
  if (/^⏵/.test(trimmed)) return "arrow_marker";
  if (isSpinnerLine(trimmed)) return "spinner_line";
  if (/context left until/i.test(trimmed)) return "context_left";
  if (/auto-compact/i.test(trimmed)) return "auto_compact";
  if (MURMUR_CONTEXT_FILTER.test(trimmed)) {
    if (/prose mode/i.test(trimmed)) console.log(`[PROSE-LEAK-TRACE] extractStructuredOutput FILTERED: "${trimmed.slice(0, 80)}"`);
    return "murmur_context";
  }
  if (/^\{"type":"idle_notification"|^\{"type":"shutdown|^\{"type":"teammate_terminated"/.test(trimmed)) return "json_notification";
  if (/^Background command/i.test(trimmed)) return "bg_task_notification";
  if (/^\d+\s+background\s+task/i.test(trimmed)) return "bg_task_count";
  // NOTE: Tool markers (⏺ Bash, ⎿, Read(...), ctrl+o expand, etc.) are NOT filtered here.
  // They are handled by the state machine's TOOL_BLOCK transitions so that continuation
  // lines are properly captured. Filtering them here would prevent state transitions
  // and cause continuation lines to leak as prose (BUG-116).
  if (/expand\s+permiss/i.test(trimmed)) return "expand_permissions";
  if (/^[↓↑←→▶▷▸▹►▼▽▾▿◀◁◂◃◄]\s*(to\b|select|navigate|more|back|next|prev)/i.test(trimmed)) return "nav_hint";
  if (/^(yes|no|allow|deny|always allow|don't allow)\s*$/i.test(trimmed)) return "permission_choice";
  if (/^[│┃┆┇┊┋╎╏║┌┐└┘├┤┬┴┼╔╗╚╝╠╣╦╩╬╭╮╯╰─━═╌╍╴╵╶╷↑↓←→↖↗↘↙⇐⇒⇑⇓▲▼◀▶►◄△▽◁▷▸▹◂◃☰☱☲☳⬆⬇⬅➡\s]+$/.test(trimmed)) return "box_drawing";
  // Table data rows: start with │/║ and contain 2+ │/║ separators (e.g. "│ Passed │ 603 │ +5 │")
  if (/^[│║]/.test(trimmed) && (trimmed.match(/[│║]/g) || []).length >= 3) return "table_data_row";
  if (/^\d+\s+(team|tasks|plan|tools|model|mode|mcp|memory|permissions)\b/i.test(trimmed) && trimmed.length < 50) return "menu_fragment";
  if (/^(team|tasks|plan|tools|model|mode)\s*$/i.test(trimmed)) return "menu_label";
  if (/^(bad|poor|fine|good|great|dismiss)\s*$/i.test(trimmed) && trimmed.length < 20) return "feedback_prompt";
  if (/^[✻✶✢✽·]/.test(trimmed)) return "status_cooking";
  if (/^Compacting conversation/i.test(trimmed)) return "status_compacting";
  if (/^Crunched for /i.test(trimmed)) return "status_crunched";
  if (/@(code|ma)\b/.test(trimmed)) return "ink_tui";
  if (/→\s*·/.test(trimmed)) return "arrow_dot";
  if ((trimmed.match(/\s{3,}/g) || []).length >= 2 && trimmed.length < 120) return "garbled_tui";
  if (trimmed.length > 0 && trimmed.length < 100) {
    const alphaCount = (trimmed.match(/[a-zA-Z0-9]/g) || []).length;
    if (alphaCount / trimmed.length < 0.4) return "low_alpha_ratio";
  }
  const tuiKws = ["expand", "bypass", "permiss", "interrupt", "tasks", "team", "@code", "@ma", "ions"];
  const hits = tuiKws.filter(k => trimmed.toLowerCase().includes(k));
  if (hits.length >= 2) return "multi_tui_keywords";
  return "";
}

// Returns non-speakable reason if line should be kept for display but not TTS
function isNonSpeakableLine(trimmed: string): string {
  if (/^[^\w\d\s]\s+\S+.*\d+[sm]/.test(trimmed) && trimmed.length < 60) return "timing_summary";
  if (/^(ctrl|⌃|esc to|press)/i.test(trimmed)) return "ctrl_hint";
  if (/\bctrl\+[a-z]\b/i.test(trimmed)) return "ctrl_shortcut";
  if (/^⏸\s+plan mode/i.test(trimmed)) return "plan_mode";
  if (/⏵⏵\s+bypass/i.test(trimmed)) return "bypass_mode";
  if (/shift\+tab to cycle/i.test(trimmed)) return "shift_tab";
  if (/^[├└│⎿]/.test(trimmed)) return "tree_output";
  if (/^\d+\s+Explore\s+agents?\s+finished/i.test(trimmed)) return "agent_summary";
  if (/Explore\s+.*finished.*ctrl/i.test(trimmed)) return "agent_summary";
  if (/^Read \d+ files?/i.test(trimmed)) return "tool_read";
  if (/^Searched for \d+/i.test(trimmed)) return "tool_search";
  if (/^Wrote \d+/i.test(trimmed)) return "tool_write";
  if (/^Edited \d+/i.test(trimmed)) return "tool_edit";
  if (/^Ran /i.test(trimmed) && trimmed.length < 60) return "tool_ran";
  if (/Interrupted/.test(trimmed)) return "interrupted";
  if (/Running…/.test(trimmed)) return "running";
  if (/^[◻◼☐☑✓✗●○■□▪▫]\s/.test(trimmed)) return "todo_item";
  if (/ctrl\+o/i.test(trimmed)) return "expand_hint";
  if (/^\+\d+ lines/.test(trimmed)) return "expand_lines";
  if (/^… \+\d+/.test(trimmed)) return "expand_ellipsis";
  if (/^\s*(\/[\w.~/-]+){2,}/.test(trimmed) && trimmed.length < 100 && trimmed.split(/\s+/).length <= 3) return "file_path";
  if (/^\d+:\s+\w+.*\d+:\s+\w+/.test(trimmed)) return "choice_menu";
  if (/permission/i.test(trimmed) && /allow|deny|grant|expand/i.test(trimmed)) return "permission_fragment";
  if (/[↓↑←→]{2,}/.test(trimmed)) return "arrow_nav";
  if (/\b(opus|sonnet|haiku|auto|compact|context)\b/i.test(trimmed) && trimmed.length < 40) return "status_bar";
  return "";
}

// Returns true if line is a tool block entry marker (⏺ ToolName( or ⏺ ToolName, ⎿, Bash(...), etc.)
function isToolMarker(trimmed: string): boolean {
  if (/^⏺\s+\w+\(/.test(trimmed)) return true;   // ⏺ Bash(...)
  if (/^⏺\s+\w+$/.test(trimmed)) return true;     // ⏺ Read (standalone)
  if (/^⎿/.test(trimmed)) return true;              // ⎿ output continuation
  if (/^(Bash|Read|Edit|Write|Grep|Glob|Agent|WebFetch|WebSearch|NotebookEdit)\s*\(/i.test(trimmed)) return true;
  // Tool summary lines: ⏺ Searched for N, ⏺ Ran X, ⏺ Read N files, ⏺ Edited N, ⏺ Wrote N (Task #36)
  if (/^⏺\s+(Searched|Ran |Read \d|Edited|Wrote|Running)/i.test(trimmed)) return true;
  return false;
}

// Returns true if line is ⏺ followed by prose (not a tool name) — exits TOOL_BLOCK to PROSE
function isProseMarker(trimmed: string): boolean {
  return /^⏺\s+/.test(trimmed) && !/^⏺\s+\w+[\s(]?$/.test(trimmed);
}

// Unified extraction: state-machine parser. Returns tagged paragraphs (speakable vs non-speakable).
// State machine approach (BUG-116 redesign): each line is classified based on block context,
// not in isolation. Tool continuation lines that lack markers are captured by TOOL_BLOCK state.
function extractStructuredOutput(preSnapshot: string, postSnapshot: string, userInput: string): ExtractedParagraph[] {
  const lines = getLinesAfterInput(postSnapshot, preSnapshot, userInput);
  // Tier 1: capture raw input snapshot (truncate to 4KB for reasonable size)
  _parseRawSnapshot = lines.join("\n").slice(0, 4096);
  _parseRawSnapshotTs = Date.now();
  const result: ExtractedParagraph[] = [];
  let currentLines: string[] = [];
  let currentSpeakable = true;
  let foundContent = false;
  let state: ParserState = "PROSE";
  let toolBlockEmptyLines = 0; // Count consecutive empty lines in TOOL_BLOCK

  function flushParagraph() {
    const text = reflowText(currentLines.join("\n").trim());
    if (text) {
      result.push({ text, speakable: currentSpeakable });
    }
    currentLines = [];
    currentSpeakable = true;
  }

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip blank lines before any content found
    if (!foundContent && !trimmed) continue;

    // ── State transitions ──

    // AGENT_BLOCK: XML block tags (<teammate-message>, etc.) — swallow everything inside
    if (/^<teammate-message|^<task-notification|^<system-reminder/.test(trimmed)) {
      if (currentLines.length > 0) flushParagraph();
      state = "AGENT_BLOCK";
      parselog(trimmed, "skip", "agent_block_open");
      continue;
    }
    if (/^<\/teammate-message|^<\/task-notification|^<\/system-reminder/.test(trimmed)) {
      state = "PROSE";
      parselog(trimmed, "skip", "agent_block_close");
      continue;
    }
    if (state === "AGENT_BLOCK") {
      parselog(trimmed, "skip", "inside_agent_block");
      continue;
    }

    // Chrome skip — applies in any state, always discarded.
    // Tool markers (⏺ Bash, ⎿, etc.) are NOT in isChromeSkip — they are handled
    // by the TOOL_BLOCK state transitions below so continuation lines are captured.
    const chromeReason = isChromeSkip(trimmed);
    if (chromeReason) {
      parselog(trimmed, "skip", chromeReason);
      continue;
    }

    // ── TOOL_BLOCK state: swallow all continuation lines ──
    if (state === "TOOL_BLOCK") {
      // Exit conditions:
      // 1. ⏺ followed by prose → transition to PROSE
      if (isProseMarker(trimmed)) {
        toolBlockEmptyLines = 0;
        if (currentLines.length > 0) flushParagraph();
        state = "PROSE";
        currentSpeakable = true;
        // Fall through to PROSE processing below for this line
      }
      // 2. Empty line — tool output can contain single blank lines (e.g. between
      //    sections). Only exit TOOL_BLOCK after 2+ consecutive empty lines (paragraph
      //    break), which indicates the tool output section has ended. Single blank lines
      //    inside tool output caused premature exit and continuation line leaks (Bug 1).
      else if (!trimmed) {
        toolBlockEmptyLines++;
        if (toolBlockEmptyLines >= 2) {
          if (currentLines.length > 0) flushParagraph();
          state = "PROSE";
          currentSpeakable = true;
          toolBlockEmptyLines = 0;
        }
        continue;
      }
      // 3. New tool marker → flush and stay in TOOL_BLOCK
      else if (isToolMarker(trimmed)) {
        toolBlockEmptyLines = 0;
        if (currentLines.length > 0) flushParagraph();
        currentSpeakable = false;
        currentLines.push(line.replace(/^\s*⏺\s*/, "").replace(/\s*⏺\s*$/, ""));
        foundContent = true;
        parselog(trimmed, "nonspeakable", "tool_block_new_marker");
        continue;
      }
      // 4. Continuation line — stay in TOOL_BLOCK, capture as non-speakable
      else {
        toolBlockEmptyLines = 0;
        currentLines.push(line);
        foundContent = true;
        parselog(trimmed, "nonspeakable", "tool_block_continuation");
        continue;
      }
    }

    // ── Transition INTO TOOL_BLOCK from PROSE ──
    if (isToolMarker(trimmed)) {
      if (currentLines.length > 0) flushParagraph();
      state = "TOOL_BLOCK";
      toolBlockEmptyLines = 0;
      currentSpeakable = false;
      currentLines.push(line.replace(/^\s*⏺\s*/, "").replace(/\s*⏺\s*$/, ""));
      foundContent = true;
      parselog(trimmed, "nonspeakable", "tool_block_enter");
      continue;
    }

    // ── PROSE state: normal text processing ──

    // Strip ⏺ markers from prose lines
    const clean = line.replace(/^\s*⏺\s*/, "").replace(/\s*⏺\s*$/, "");
    const cleanTrimmed = clean.trim();

    if (!cleanTrimmed) {
      // Empty line = paragraph break
      if (foundContent && currentLines.length > 0) {
        flushParagraph();
      }
      continue;
    }

    foundContent = true;

    // Non-speakable check (kept for display, not TTS)
    const nonSpeakableReason = isNonSpeakableLine(trimmed);
    if (nonSpeakableReason) {
      if (currentLines.length > 0 && currentSpeakable) flushParagraph();
      currentSpeakable = false;
      currentLines.push(clean);
      parselog(trimmed, "nonspeakable", nonSpeakableReason);
      continue;
    }

    // Normal speakable prose line — passed all filters
    parselog(trimmed, "speakable", "speakable");
    if (!currentSpeakable && currentLines.length > 0) {
      flushParagraph();
      currentSpeakable = true;
    }
    currentLines.push(clean);
  }

  // Flush remaining
  if (currentLines.length > 0) flushParagraph();

  return result;
}

let lastUserInput = "";
let _currentInputId: string | undefined; // Input ID for current turn (links assistant entries)
let pollStartTime = 0;
let lastSpokenText = "";  // Track what we've already spoken to avoid repeats

// Strip tmux/Claude Code chrome from visible pane lines
function stripChrome(lines: string[]): string[] {
  const cleaned: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) { if (cleaned.length > 0) cleaned.push(""); continue; }
    if (/^[▐▝▘]/.test(t)) continue;
    if (/Claude Code v/.test(t)) continue;
    if (/Opus \d|Claude Max/.test(t)) continue;
    if (/~\//.test(t) && t.length < 60 && !t.includes(" ")) continue;
    if (/^[─━═]{3,}/.test(t)) continue;
    if (/bypass\s+permissions/i.test(t)) continue;
    if (/^⏵/.test(t)) continue;
    if (/^❯\s*$/.test(t)) continue;
    if (/ctrl\+[a-z]/i.test(t) && t.length < 60) continue;
    if (/shift\+tab/i.test(t)) continue;
    cleaned.push(line);
  }
  while (cleaned.length > 0 && !cleaned[0].trim()) cleaned.shift();
  while (cleaned.length > 0 && !cleaned[cleaned.length - 1].trim()) cleaned.pop();
  return cleaned;
}

// Parse tmux scrollback into historical conversation entries.
// Splits on ❯ input markers, extracts user inputs and assistant responses.
// All entries are marked spoken=true so they appear silently (no auto-TTS).
function loadScrollbackEntries(): ConversationEntry[] {
  let scrollback: string;
  try { scrollback = terminal.capturePaneScrollback(); } catch { return []; }
  if (!scrollback.trim()) return [];

  const lines = scrollback.split("\n");
  // Debug: log first few lines to understand scrollback format
  console.log(`[scrollback] target=${terminal.currentTarget} lines=${lines.length} sample:`, lines.slice(0, 5).map(l => JSON.stringify(l)));

  const turnStarts: { lineIdx: number; input: string }[] = [];

  // Find user input lines: ❯ followed by actual content
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimEnd();
    const m = trimmed.match(/^❯\s+(.+)$/);
    if (m && m[1].trim()) {
      turnStarts.push({ lineIdx: i, input: m[1].trim() });
    }
  }
  console.log(`[scrollback] found ${turnStarts.length} ❯ turns`);
  if (turnStarts.length === 0) return [];

  // Only load the last 10 turns to avoid flooding the view
  const recentTurns = turnStarts.slice(-10);
  const entries: ConversationEntry[] = [];
  const totalTurns = recentTurns.length;

  for (let t = 0; t < totalTurns; t++) {
    const start = recentTurns[t];
    const endLineIdx = t + 1 < totalTurns ? recentTurns[t + 1].lineIdx : lines.length;
    const turnNum = -(totalTurns - t); // negative so they precede live turns

    // Skip voice panel instruction turns entirely
    if (MURMUR_CONTEXT_FILTER.test(start.input)) continue;
    // Skip agent infrastructure commands (tmux send-keys, test runners, etc.)
    if (isAgentInfraCommand(start.input)) continue;

    // Dedup: skip if this exact user input already exists in entries
    const normalizedInput = start.input.trim().toLowerCase().replace(/\s+/g, " ");
    if (entries.some(e => e.role === "user" && e.text.trim().toLowerCase().replace(/\s+/g, " ") === normalizedInput)) {
      console.log(`[scrollback] Skipping duplicate user entry: "${start.input.slice(0, 60)}"`);
      continue;
    }

    // User entry
    entries.push({
      id: ++entryIdCounter,
      role: "user",
      text: start.input,
      speakable: true, // User entries are prose — speakable for clean mode visibility
      spoken: true,
      ts: Date.now() - (totalTurns - t) * 300000,
      turn: turnNum,
      window: getWindowKey(),
    });

    // Collect and filter assistant response lines
    const responseLines: string[] = [];
    let inAgentBlock2 = false;
    for (let i = start.lineIdx + 1; i < endLineIdx; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed) { if (!inAgentBlock2) responseLines.push(""); continue; }
      if (/^[─━═]{3,}/.test(trimmed)) continue;
      if (/^❯/.test(trimmed)) continue;
      if (isSpinnerLine(trimmed)) continue;
      if (MURMUR_CONTEXT_FILTER.test(trimmed)) continue;
      // Stateful agent block filter
      if (/^<teammate-message|^<task-notification|^<system-reminder/.test(trimmed)) { inAgentBlock2 = true; continue; }
      if (/^<\/teammate-message|^<\/task-notification|^<\/system-reminder/.test(trimmed)) { inAgentBlock2 = false; continue; }
      if (inAgentBlock2) continue;
      if (/^\{"type":"idle_notification"|^\{"type":"shutdown|^\{"type":"teammate_terminated"/.test(trimmed)) continue;
      if (/bypass\s+permissions/i.test(trimmed)) continue;
      if (/context left until/i.test(trimmed)) continue;
      if (/auto-compact/i.test(trimmed)) continue;
      if (/^(Tokens?:|Session:|esc to|ctrl\+)/i.test(trimmed)) continue;
      if (/^Background command/i.test(trimmed)) continue;
      if (/^\d+\s+background\s+task/i.test(trimmed)) continue;
      if (/^[✻✶✢✽]/.test(trimmed)) continue;
      // Table data rows: box-drawing + content (e.g. │ Passed │ 603 │)
      if (/^[│║┌┐└┘├┤┬┴┼╔╗╚╝╠╣╦╩╬╭╮╯╰]/.test(trimmed) && (trimmed.match(/[│║┌┐└┘├┤┬┴┼╔╗╚╝╠╣╦╩╬╭╮╯╰─━═]/g) || []).length >= 3) continue;
      responseLines.push(lines[i]);
    }

    // Classify response lines into speakable (prose) vs non-speakable (tool) paragraphs
    // using the same state machine logic as extractStructuredOutput.
    const paragraphs: ExtractedParagraph[] = [];
    {
      let pLines: string[] = [];
      let pSpeakable = true;
      let pState: "PROSE" | "TOOL_BLOCK" = "PROSE";
      let toolEmptyCount = 0;

      const flush = () => {
        const t2 = reflowText(pLines.join("\n").trim());
        if (t2) paragraphs.push({ text: t2, speakable: pSpeakable });
        pLines = [];
        pSpeakable = true;
      };

      for (const rl of responseLines) {
        const tr = rl.trim();

        if (pState === "TOOL_BLOCK") {
          if (isProseMarker(tr)) {
            toolEmptyCount = 0;
            if (pLines.length > 0) flush();
            pState = "PROSE";
            pSpeakable = true;
            // fall through to PROSE processing
          } else if (!tr) {
            toolEmptyCount++;
            if (toolEmptyCount >= 2) {
              if (pLines.length > 0) flush();
              pState = "PROSE";
              pSpeakable = true;
              toolEmptyCount = 0;
            }
            continue;
          } else if (isToolMarker(tr)) {
            toolEmptyCount = 0;
            if (pLines.length > 0) flush();
            pSpeakable = false;
            pLines.push(rl.replace(/^\s*⏺\s*/, "").replace(/\s*⏺\s*$/, ""));
            continue;
          } else {
            toolEmptyCount = 0;
            pLines.push(rl);
            continue;
          }
        }

        if (isToolMarker(tr)) {
          if (pLines.length > 0) flush();
          pState = "TOOL_BLOCK";
          toolEmptyCount = 0;
          pSpeakable = false;
          pLines.push(rl.replace(/^\s*⏺\s*/, "").replace(/\s*⏺\s*$/, ""));
          continue;
        }

        // PROSE: empty line = paragraph break
        if (!tr) {
          if (pLines.length > 0) flush();
          continue;
        }

        // Strip ⏺ from prose lines
        const clean = rl.replace(/^\s*⏺\s*/, "").replace(/\s*⏺\s*$/, "");
        if (clean.trim()) {
          pLines.push(clean);
        }
      }
      if (pLines.length > 0) flush();
    }

    if (paragraphs.length > 0) {
      let addedCount = 0;
      for (const para of paragraphs) {
        const normalizedText = para.text.trim().toLowerCase().replace(/\s+/g, " ");
        if (entries.some(e => e.role === "assistant" && e.text.trim().toLowerCase().replace(/\s+/g, " ") === normalizedText)) {
          continue; // Dedup
        }
        entries.push({
          id: ++entryIdCounter,
          role: "assistant",
          text: para.text,
          speakable: para.speakable,
          spoken: true,
          ts: Date.now() - (totalTurns - t) * 300000 + 1000,
          turn: turnNum,
          window: getWindowKey(),
        });
        addedCount++;
      }
      console.log(`[scrollback] Turn ${t}: user="${start.input.slice(0, 60)}" → ${paragraphs.length} paragraphs (${paragraphs.filter(p => p.speakable).length} speakable), ${addedCount} entries added`);
    } else {
      console.log(`[scrollback] Turn ${t}: user="${start.input.slice(0, 60)}" → NO assistant text (${responseLines.length} response lines, all empty after filter)`);
    }
  }

  const userCount = entries.filter(e => e.role === "user").length;
  const assistantCount = entries.filter(e => e.role === "assistant").length;
  console.log(`[scrollback] Result: ${entries.length} entries (${userCount} user, ${assistantCount} assistant) for window=${getWindowKey()}`);
  return entries;
}

// Reflow tmux-wrapped lines into natural paragraphs.
// Tmux hard-wraps at terminal width (120 cols), which looks broken in the UI.
// Join consecutive non-empty lines into paragraphs, preserving intentional breaks.
function reflowText(text: string): string {
  const lines = text.split("\n");
  const paragraphs: string[] = [];
  let current = "";

  for (const line of lines) {
    const trimmed = line.trim();

    // Empty line = paragraph break
    if (!trimmed) {
      if (current) { paragraphs.push(current); current = ""; }
      continue;
    }

    // Lines starting with structural markers get their own line
    if (/^[-*•]\s/.test(trimmed) || /^\d+[.)]\s/.test(trimmed) ||
        /^⏺/.test(trimmed) || /^⎿/.test(trimmed) || /^>/.test(trimmed)) {
      if (current) { paragraphs.push(current); current = ""; }
      current = trimmed;
      continue;
    }

    // Otherwise join with previous line (reflow tmux wrap)
    if (current) {
      current += " " + trimmed;
    } else {
      current = trimmed;
    }
  }
  if (current) paragraphs.push(current);

  return paragraphs.join("\n\n");
}

// Normalize spinner chars so overlap detection isn't broken by changing spinner glyphs
function normalizeSpinners(text: string): string {
  return text.replace(/[✻✳✢✽✶·⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, "•");
}

// Entry-based TTS: delay before speaking a new completed entry
const ENTRY_TTS_DELAY_MS = 200;

// ── Push-based output handler ──
// Called by the always-on pipe (tmux pipe-pane / pty onData) for each new chunk.
// Replaces ALL polling intervals: passive watcher, stream watcher, prompt checker.
const SPINNER_CHARS_RE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✻✶]/;

// Ring buffer: raw pipe-pane output for /debug/pipe-input traceability
const _pipeInputLog: Array<{ ts: number; len: number; text: string; state: string }> = [];
const PIPE_INPUT_LOG_CAP = 200;

function handlePipeOutput(_chunk: string) {
  const now = Date.now();
  lastStreamActivity = now;

  // Log raw chunk to ring buffer (truncate long chunks for readability)
  _pipeInputLog.push({
    ts: now,
    len: _chunk.length,
    text: _chunk.length > 500 ? _chunk.slice(0, 500) + `…[${_chunk.length - 500} more]` : _chunk,
    state: streamState,
  });
  if (_pipeInputLog.length > PIPE_INPUT_LOG_CAP) _pipeInputLog.shift();

  if (streamState === "IDLE" || streamState === "DONE") {
    // Activity while idle/done — check if Claude is working (spinner in output)
    if (SPINNER_CHARS_RE.test(_chunk)) {
      // Cooldown check: don't re-trigger right after streaming ends
      if (now - lastStreamEndTime < PASSIVE_COOLDOWN_MS) {
        if (!_cooldownThinking) {
          _cooldownThinking = true;
          broadcast({ type: "voice_status", state: "thinking" });
        }
        return;
      }
      // Re-engage: spinner while DONE → Claude doing follow-up work
      if (streamState === "DONE") {
        console.log("[push] Re-engaging — spinner detected after done");
        reEngageFromPush();
        return;
      }
      // Spinner while IDLE → native CLI input detected
      scheduleIdleActivityCheck();
    } else if (_cooldownThinking) {
      // During cooldown, non-spinner output → system task finished
      _cooldownThinking = false;
      broadcast({ type: "voice_status", state: "idle" });
      broadcast({ type: "tool_status", text: "" });
    }
    return;
  }

  // During streaming: activity signal
  sawActivity = true;

  // Cancel done check — new output means not done
  cancelDoneCheck();

  // State transitions from raw output
  if (streamState === "WAITING" || streamState === "THINKING") {
    if (SPINNER_CHARS_RE.test(_chunk)) {
      if (streamState !== "THINKING") {
        streamState = "THINKING";
        broadcast({ type: "voice_status", state: "thinking" });
      }
    }
  }

  // Schedule debounced pane check (state detection + content parsing)
  schedulePaneCheck();

  // Reset quiet timer — will fire when output stops
  resetQuietTimer();
}

/** Schedule a debounced pane capture + parse + state detection */
function schedulePaneCheck() {
  if (_parseTimer) return;
  _parseTimer = setTimeout(() => {
    _parseTimer = null;
    performPaneCheck();
  }, PARSE_DEBOUNCE_MS);
}

/** Capture pane, detect state transitions, update entries */
function performPaneCheck() {
  if (streamState === "IDLE") return;

  const pane = captureTmuxPane();
  if (!pane) return;

  // Check for interrupt prompt (may set streamState to IDLE)
  checkForInterruptPrompt(pane);
  if ((streamState as string) === "IDLE") return;

  // Auto-accept interactive prompts
  if (detectInteractivePrompt(pane)) return;

  const spinner = hasSpinnerChars(pane);
  const response = hasResponseMarkers(pane);
  const prompt = hasPromptReady(pane);

  // State transitions
  if (streamState === "WAITING" || streamState === "THINKING") {
    if (spinner && streamState !== "THINKING") {
      streamState = "THINKING";
      broadcast({ type: "voice_status", state: "thinking" });
    }
    if (response) {
      streamState = "RESPONDING";
      broadcast({ type: "voice_status", state: "responding" });
    }
  }

  // Broadcast content when responding
  if (streamState === "RESPONDING" || response) {
    broadcastCurrentOutput();
  }

  // Done check when prompt visible + no spinner + had activity
  if (prompt && !spinner && sawActivity) {
    scheduleDoneCheck();
  }
}

/** Reset quiet timer — fires when output stops for DONE_QUIET_MS */
function resetQuietTimer() {
  if (_quietTimer) { clearTimeout(_quietTimer); _quietTimer = null; }
  _quietTimer = setTimeout(() => {
    _quietTimer = null;
    if (streamState === "IDLE" || streamState === "DONE") return;
    // No output for DONE_QUIET_MS — check if done
    scheduleDoneCheck();
  }, DONE_QUIET_MS);
}

/** Debounced check for native CLI input (spinner detected while idle) */
function scheduleIdleActivityCheck() {
  if (_idleCheckTimer) return;
  _idleCheckTimer = setTimeout(() => {
    _idleCheckTimer = null;
    handleNativeInputDetected();
  }, IDLE_CHECK_DEBOUNCE_MS);
}

/** Handle native CLI input: extract user text, start streaming */
function handleNativeInputDetected() {
  if (streamState !== "IDLE" && streamState !== "DONE") return;

  const pane = captureTmuxPane();
  if (!pane) return;

  // Confirm spinner is still present
  if (!hasSpinnerChars(pane)) return;

  console.log("[push] Spinner detected — native CLI input");

  // Detect interactive prompts first
  if (detectInteractivePrompt(pane)) return;

  // Extract user input from prompt line (Method 1: prompt parsing)
  const lines = pane.split("\n");
  let userInput = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("❯ ") && trimmed.length > 3) {
      const parts = [trimmed.slice(2).trim()];
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j].trim();
        if (!next) break;
        if (next.startsWith("❯")) break;
        if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✻✶⏺]/.test(next)) break;
        if (/^[─━═]{3,}/.test(next)) break;
        if (/^(Tokens?:|Session:|esc to|ctrl\+)/i.test(next)) break;
        if (/^Press (up|down|esc|enter|tab)/i.test(next)) break;
        parts.push(next);
      }
      userInput = parts.join(" ");
      break;
    }
  }

  // Filter agent infrastructure commands
  if (userInput && isAgentInfraCommand(userInput)) {
    console.log(`[push] Filtered agent infrastructure command: "${userInput.slice(0, 80)}"`);
    userInput = "";
  }
  // Filter tool output markers
  if (userInput && isToolOutputLine(userInput)) {
    console.log(`[push] Filtered tool output as user input: "${userInput.slice(0, 80)}"`);
    userInput = "";
  }

  // Skip if this text was sent programmatically
  if (userInput && terminal.wasRecentlySent?.(userInput)) {
    console.log(`[push] Skipping programmatically-sent input: "${userInput.slice(0, 60)}"`);
    // Still start streaming — spinner is active, Claude is processing
  }

  // Start streaming
  if (streamState === "DONE" || streamState === "IDLE") {
    currentTurn++;
    if (entryTtsTimer) { clearTimeout(entryTtsTimer); entryTtsTimer = null; }
    lastBroadcastText = "";

    // Only create user entry if NOT already sent programmatically
    if (userInput && !_isSystemContext && !terminal.wasRecentlySent?.(userInput)) {
      const normalizedNew = userInput.trim().toLowerCase().replace(/\s+/g, "");
      const alreadyExists = conversationEntries.some(
        e => e.role === "user" && e.text.trim().toLowerCase().replace(/\s+/g, "") === normalizedNew
      );
      if (!alreadyExists) {
        addUserEntry(userInput, false, "terminal");
      }
    }
    trimEntriesToCap();

    preInputSnapshot = pane; // Use current pane as pre-snapshot (spinner just appeared)
    lastUserInput = userInput || "(native input)";
    pollStartTime = Date.now();
    lastStreamActivity = Date.now();
    sawActivity = true;
    stopClientPlayback2("new_input");

    streamState = "THINKING";
    broadcast({ type: "voice_status", state: "thinking" });

    // Set stream timeout
    streamTimeout = setTimeout(() => {
      const p = captureTmuxPane();
      const paragraphs = extractStructuredOutput(preInputSnapshot, p, lastUserInput);
      if (paragraphs.length > 0) {
        handleStreamDone();
      } else {
        stopTmuxStreaming();
        broadcast({ type: "voice_status", state: "idle" });
      }
    }, STREAM_TIMEOUT_MS);

    console.log(`[push] Started streaming for native CLI input: "${userInput.slice(0, 60)}"`);
  }
}

/** Re-engage streaming when spinner detected after DONE (Claude doing follow-up) */
function reEngageFromPush() {
  if (streamState !== "DONE") return;

  preInputSnapshot = preInputSnapshot; // Keep existing snapshot for continuation
  pollStartTime = Date.now();
  lastStreamActivity = Date.now();
  sawActivity = true;
  lastBroadcastText = "";

  streamState = "THINKING";
  broadcast({ type: "voice_status", state: "thinking" });

  streamTimeout = setTimeout(() => {
    console.log(`[stream] Re-engage timeout after ${STREAM_TIMEOUT_MS / 1000}s`);
    const pane = captureTmuxPane();
    const paragraphs = extractStructuredOutput(preInputSnapshot, pane, lastUserInput);
    if (paragraphs.length > 0) {
      handleStreamDone();
    } else {
      stopTmuxStreaming();
      broadcast({ type: "voice_status", state: "idle" });
    }
  }, STREAM_TIMEOUT_MS);

  console.log("[push] Re-engaged streaming for continuation");
}

// Broadcast current response content to app via entry model.
// Diffs extractStructuredOutput() against conversationEntries, creates/updates entries,
// broadcasts { type: "entry" }, and triggers TTS for completed speakable entries.
// In push architecture: called ONLY from performPaneCheck() via debounced timer — single parse path.
function broadcastCurrentOutput() {
  if (_isSystemContext) return; // Suppress UI during system context
  const pane = captureTmuxPane();
  if (!pane) return;

  const paragraphs = extractStructuredOutput(preInputSnapshot, pane, lastUserInput);
  if (paragraphs.length === 0) return;
  const speakableCount = paragraphs.filter(p => p.speakable).length;
  if (paragraphs.length > 1) {
    console.log(`[stream] Extracted ${paragraphs.length} paragraphs (${speakableCount} speakable): ${paragraphs.map(p => `[${p.speakable ? "S" : "N"}:${p.text.length}]`).join(" ")}`);
  }

  // Normalize for change detection
  const normalized = normalizeSpinners(paragraphs.map(p => p.text).join("\n"));
  if (normalized === lastBroadcastText) return;
  lastBroadcastText = normalized;

  // Cancel old-turn TTS as soon as we detect new content (idempotent per-turn).
  // Previously this was only called when creating NEW entries, which missed the case
  // where all paragraphs matched existing entries — old TTS kept playing. (Task #35)
  cancelOldTurnJobs();

  // Match paragraphs to existing entries by TEXT SIMILARITY, not positional index.
  // This prevents gen bumps (which re-parse tmux content with shifted positions)
  // from overwriting entries with wrong text.
  const assistantEntries = conversationEntries.filter(e => e.role === "assistant" && e.turn === currentTurn);
  const matchedEntryIds = new Set<number>(); // Track which entries were matched this cycle
  const createdNorms = new Set<string>(); // Bug U1: track texts created THIS cycle to prevent intra-loop dupes

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];

    // Find best matching existing entry by text similarity (first 30 chars prefix match)
    // Prefer exact matches, then prefix/growth matches, then positional fallback
    let matched: ConversationEntry | null = null;
    const paraPrefix = para.text.slice(0, 30).toLowerCase();

    // Pass 1: exact text match
    for (const e of assistantEntries) {
      if (matchedEntryIds.has(e.id)) continue;
      if (e.text === para.text) { matched = e; break; }
    }
    // Pass 2: prefix match (text growth — same start, paragraph grew)
    if (!matched && paraPrefix.length >= 10) {
      for (const e of assistantEntries) {
        if (matchedEntryIds.has(e.id)) continue;
        const ePrefix = e.text.slice(0, 30).toLowerCase();
        if (ePrefix === paraPrefix || para.text.startsWith(e.text.slice(0, 20)) || e.text.startsWith(para.text.slice(0, 20))) {
          matched = e;
          break;
        }
      }
    }
    // Pass 3: positional fallback ONLY if not mid-stream (final extraction is trustworthy)
    if (!matched && streamState !== "RESPONDING" && i < assistantEntries.length && !matchedEntryIds.has(assistantEntries[i].id)) {
      matched = assistantEntries[i];
    }

    if (matched) {
      matchedEntryIds.add(matched.id);
      // Filler clobber guard: never overwrite filler entries with parsed output.
      // Fillers have their own text ("One moment...", "Let me think...") that should
      // be preserved until naturally replaced by the next filler or cleared on done.
      if (matched.text !== para.text && matched.sourceTag !== "filler") {
        if (matched.text !== para.text) mlog(matched.id, "text", matched.text.slice(0, 80), para.text.slice(0, 80), "broadcastCurrentOutput");
        if (matched.speakable !== para.speakable) mlog(matched.id, "speakable", matched.speakable, para.speakable, "broadcastCurrentOutput");
        matched.text = para.text;
        matched.speakable = para.speakable;
      }
    } else {
      // During RESPONDING/FINALIZING, skip transient tool output — these lines flash briefly
      // then vanish when the tool finishes. Creating entries for them causes visible flash. (Task #36)
      if ((streamState === "RESPONDING" || streamState === "FINALIZING") && isToolOutputLine(para.text)) {
        console.log(`[stream] Skipping transient tool output entry: "${para.text.slice(0, 80)}"`);
        continue;
      }

      // New paragraph — create entry (skip if identical text exists in recent entries that
      // were NOT already matched to a different paragraph this cycle). This allows entries
      // with identical text (e.g., repeated list items) to each get their own entry.
      // Use normalized comparison to catch duplicates across gen bumps (BUG-A pattern).
      const recentEntries = conversationEntries.slice(-30);
      const paraNorm = para.text.trim().toLowerCase().replace(/\s+/g, " ");
      const isDup = recentEntries.some(e => {
        if (e.role !== "assistant" || matchedEntryIds.has(e.id)) return false;
        // Exact text match — no turn restriction (gen bumps can jump turns arbitrarily)
        if (e.text === para.text) return true;
        // Normalized match across gen bumps — catches re-created entries with identical content
        const eNorm = e.text.trim().toLowerCase().replace(/\s+/g, " ");
        return eNorm === paraNorm;
      });
      if (!isDup && !createdNorms.has(paraNorm)) {
        createdNorms.add(paraNorm); // Bug U1: prevent same text creating multiple entries in one cycle
        // cancelOldTurnJobs() already called above (Task #35 — fires on any new content, not just new entries)
        const entry: ConversationEntry = {
          id: ++entryIdCounter,
          role: "assistant",
          text: para.text,
          speakable: para.speakable,
          spoken: false,
          ts: Date.now(),
          turn: currentTurn,
          ...(_currentInputId ? { parentInputId: _currentInputId } : {}),
        };
        pushEntry(entry);
        elog(entry.id, "assistant", "broadcastCurrentOutput", para.text);
        if (_currentInputId) {
          const il = _inputLog.find(l => l.inputId === _currentInputId);
          if (il) il.responseEntryIds.push(entry.id);
        }
        // Diagnostic: trace any entry containing prose mode text
        if (/prose mode/i.test(para.text)) {
          console.log(`[PROSE-LEAK-TRACE] Assistant entry created with prose mode text: "${para.text.slice(0, 120)}" turn=${currentTurn} id=${entry.id}`);
        }
      }
    }
  }

  // Remove stale assistant entries if paragraphs shrunk (rare reparse)
  // But never remove entries that were already spoken — they're real content
  // Only trim when NOT actively responding (avoids losing content mid-stream)
  // Guard: never remove current-turn entries — paragraph count fluctuates during parsing
  if (paragraphs.length < assistantEntries.length && streamState !== "RESPONDING") {
    const staleEntries = assistantEntries.slice(paragraphs.length);
    const staleIds = new Set(staleEntries.filter(e => !e.spoken && e.turn !== currentTurn).map(e => e.id));
    if (staleIds.size > 0) {
      console.log(`[stream] Removing ${staleIds.size} stale entries (not spoken, not current turn)`);
      setConversationEntries(conversationEntries.filter(e => !staleIds.has(e.id)));
    }
  }

  // Broadcast all entries
  broadcast({
    type: "entry",
    entries: conversationEntries,
    partial: true,
  });

  // Extract current tool call for status line (e.g. "⏺ Bash(npm test)" → "Bash · npm test")
  const toolMatch = pane.match(/⏺\s+(\w+)\(([^)]{0,60})\)/);
  if (toolMatch) {
    const toolName = toolMatch[1];
    const toolArg = toolMatch[2].trim().replace(/\s+/g, " ");
    broadcast({ type: "tool_status", text: `${toolName} · ${toolArg}` });
  } else {
    // Detect activity status messages (compacting, updating, etc.)
    const activityMatch = pane.match(/(Compacting conversation|Updating memory|Checking for updates|Searching|Indexing)[….]*/i);
    if (activityMatch) {
      broadcast({ type: "tool_status", text: activityMatch[1] + "…" });
    } else {
      broadcast({ type: "tool_status", text: "" });
    }
  }

  // Trigger TTS for completed speakable entries (not the last one, which may still be growing)
  const currentAssistant = conversationEntries.filter(e => e.role === "assistant" && e.turn === currentTurn);
  for (let i = 0; i < currentAssistant.length - 1; i++) {
    const entry = currentAssistant[i];
    if (shouldTtsEntry(entry) && !entry.spoken) {
      // Check if sentence TTS already partially spoke this entry
      const cursor = entryTtsCursor.get(entry.id) ?? 0;
      if (cursor > 0) {
        // Sentence TTS already spoke part of this entry — only speak the remaining tail
        const tail = entry.text.slice(cursor).trim();
        entry.spoken = true;
        if (tail.length > 0) {
          console.log(`[stream] Entry tail TTS (id=${entry.id}, cursor=${cursor}, tail=${tail.length} chars): "${tail.slice(0, 80)}"`);
          plog("entry_tts_tail", `id=${entry.id} "${tail.slice(0, 80)}" (${tail.length} chars)`);
          queueTts(entry.id, tail);
        } else {
          console.log(`[stream] Entry fully spoken by sentence TTS (id=${entry.id})`);
        }
      } else {
        entry.spoken = true;
        console.log(`[stream] Entry TTS (id=${entry.id}, ${entry.text.length} chars): "${entry.text.slice(0, 80)}..."`);
        plog("entry_tts", `id=${entry.id} "${entry.text.slice(0, 80)}" (${entry.text.length} chars)`);
        queueTts(entry.id, entry.text);
      }
    }
  }

  // Speculative TTS: during streaming, speculatively queue the last (growing) entry
  // so Kokoro starts generating audio before the entry is finalized. The dedup in
  // queueTts prevents double-generation; the re-queue logic handles text growth.
  const lastEntry = currentAssistant[currentAssistant.length - 1];
  if (streamState === "RESPONDING" && lastEntry && shouldTtsEntry(lastEntry) && !lastEntry.spoken) {
    const speakable = cleanTtsText(lastEntry.text);
    if (speakable && speakable.length >= 50) {
      // queueTts dedup will skip if already queued; re-queue logic handles text growth
      console.log(`[stream] Speculative TTS queue (id=${lastEntry.id}, ${speakable.length} chars)`);
      queueTts(lastEntry.id, lastEntry.text, "speculative");
    }
  }

  // Sentence-level TTS for the last (still-growing) entry.
  // Speak each complete sentence as it arrives rather than waiting for the full entry.
  // A sentence boundary is: [.!?] followed by whitespace + uppercase, or [.!?] + end of text.
  if (lastEntry && shouldTtsEntry(lastEntry) && !lastEntry.spoken) {
    const cursor = entryTtsCursor.get(lastEntry.id) ?? 0;
    const remaining = lastEntry.text.slice(cursor);
    // Match sentences: text ending in .!? followed by space+capital (mid-text) or end-of-string
    const sentenceEnd = /[.!?](?=\s+[A-Z])/g;
    let lastMatchEnd = 0;
    let match: RegExpExecArray | null;
    while ((match = sentenceEnd.exec(remaining)) !== null) {
      lastMatchEnd = match.index + 1; // include the punctuation
    }
    if (lastMatchEnd > 0) {
      const sentence = remaining.slice(0, lastMatchEnd).trim();
      if (sentence.length > 10) { // skip trivially short fragments
        const newCursor = cursor + lastMatchEnd;
        entryTtsCursor.set(lastEntry.id, newCursor);
        console.log(`[stream] Sentence TTS (id=${lastEntry.id}, cursor=${newCursor}): "${sentence.slice(0, 80)}"`);
        plog("sentence_tts", `id=${lastEntry.id} "${sentence.slice(0, 80)}" (${sentence.length} chars)`);
        queueTts(lastEntry.id, sentence);
      }
    }

    // Also debounce-speak the tail once the entry stabilises (catches final sentence without trailing space)
    if (entryTtsTimer) clearTimeout(entryTtsTimer);
    entryTtsTimer = setTimeout(() => {
      entryTtsTimer = null;
      const freshAssistant = conversationEntries.filter(e => e.role === "assistant" && e.turn === currentTurn);
      const freshLast = freshAssistant[freshAssistant.length - 1];
      if (freshLast && freshLast.id === lastEntry.id && !freshLast.spoken) {
        const spokenSoFar = entryTtsCursor.get(freshLast.id) ?? 0;
        const tail = freshLast.text.slice(spokenSoFar).trim();
        if (tail.length > 0) {
          // Don't mark spoken=true here — handleStreamDone will catch any remaining text
          // that arrives between now and stream end. Only update the cursor.
          entryTtsCursor.set(freshLast.id, freshLast.text.length);
          console.log(`[stream] Entry tail TTS (id=${freshLast.id}, tail=${tail.length} chars): "${tail.slice(0, 80)}"`);
          plog("entry_tts_tail", `id=${freshLast.id} "${tail.slice(0, 80)}" (${tail.length} chars)`);
          queueTts(freshLast.id, tail);
        }
        // Don't mark spoken=true — text may still grow during streaming
      }
    }, ENTRY_TTS_DELAY_MS);
  }

  // Enforce entry cap on every cycle (not just startTmuxStreaming)
  trimEntriesToCap();
}

// onStreamActivity and checkPaneState removed — replaced by push-based handlePipeOutput + performPaneCheck

function cancelDoneCheck() {
  if (doneCheckTimer) {
    clearTimeout(doneCheckTimer);
    doneCheckTimer = null;
  }
}

function scheduleDoneCheck() {
  cancelDoneCheck();
  doneCheckTimer = setTimeout(() => {
    // Confirm with a single capture-pane snapshot
    const pane = captureTmuxPane();
    if (hasPromptReady(pane)) {
      handleStreamDone();
    } else {
      // Not actually done, retry
      scheduleDoneCheck();
    }
  }, DONE_QUIET_MS);
}

const ENTRY_CAP = 200;

/** Cap conversationEntries at ENTRY_CAP by trimming oldest entries. Safe to call frequently.
 *  Two-phase trim: first try turn-based (remove entire old turns), then hard-cap if still over. */
function trimEntriesToCap() {
  if (conversationEntries.length <= ENTRY_CAP) return;

  console.log(`[entries] trimEntriesToCap fired: ${conversationEntries.length} entries (cap=${ENTRY_CAP})`);

  // Phase 1: Turn-based trim — remove entire old turns (preserves turn boundaries)
  const oldestTurnToKeep = conversationEntries[conversationEntries.length - 100].turn;
  let trimCount = 0;
  for (let i = 0; i < conversationEntries.length; i++) {
    if (conversationEntries[i].turn >= oldestTurnToKeep) break;
    trimCount++;
  }
  if (trimCount > 0 && trimCount < conversationEntries.length) {
    const trimmedIds = conversationEntries.slice(0, trimCount).map(e => e.id);
    conversationEntries.splice(0, trimCount);
    for (const id of trimmedIds) entryTtsCursor.delete(id);
    console.log(`[entries] Turn-based trim: removed ${trimCount} entries from ${oldestTurnToKeep - 1} old turns, ${conversationEntries.length} remaining`);
  }

  // Phase 2: Hard-cap — if still over ENTRY_CAP (entries from same/recent turns), force-trim from front
  if (conversationEntries.length > ENTRY_CAP) {
    const hardTrim = conversationEntries.length - ENTRY_CAP;
    const trimmedIds = conversationEntries.slice(0, hardTrim).map(e => e.id);
    conversationEntries.splice(0, hardTrim);
    for (const id of trimmedIds) entryTtsCursor.delete(id);
    console.log(`[entries] Hard-cap trim: removed ${hardTrim} entries, ${conversationEntries.length} remaining`);
  }
}

function startTmuxStreaming(userInput: string, inputId?: string) {
  if (streamState !== "IDLE") {
    stopTmuxStreaming();
  }
  plog("text_sent_to_terminal", `"${userInput.slice(0, 80)}"`);
  plog("stream_poll_start");
  slog("terminal", "send", { text: userInput.slice(0, 80) });
  slog("stream", "state", { from: streamState, to: "WAITING" });

  lastUserInput = userInput;
  _currentInputId = inputId;
  pollStartTime = Date.now();
  lastStreamActivity = Date.now();
  sawActivity = false;
  lastBroadcastText = "";
  // Start a new conversation turn — keep old entries for history
  currentTurn++;
  trimEntriesToCap();
  if (entryTtsTimer) { clearTimeout(entryTtsTimer); entryTtsTimer = null; }
  stopClientPlayback2("new_input"); // Stop any current TTS before new input
  entryTtsCursor.clear(); // Reset sentence cursor AFTER TTS stop to avoid re-speaking tail

  // Take snapshot BEFORE terminal.sendText is called — captures the clean prompt state
  preInputSnapshot = captureTmuxPane();
  console.log(`[stream] Pre-snapshot: ${(preInputSnapshot.match(/^❯/gm) || []).length} prompts`);

  // Push architecture: no pipe management needed — always-on pipe handles activity detection.
  // No polling timers — handlePipeOutput triggers state detection + parsing.

  streamState = "WAITING";
  broadcast({ type: "voice_status", state: "thinking" });

  // Overall timeout (safety net)
  streamTimeout = setTimeout(() => {
    console.log(`[stream] Timeout after ${STREAM_TIMEOUT_MS / 1000}s`);
    const pane = captureTmuxPane();
    const paragraphs = extractStructuredOutput(preInputSnapshot, pane, lastUserInput);
    if (paragraphs.length > 0) {
      handleStreamDone();
    } else {
      stopTmuxStreaming();
      broadcast({ type: "voice_status", state: "idle" });
    }
  }, STREAM_TIMEOUT_MS);

  console.log("[stream] Started streaming (push-based)");
}

function handleStreamDone() {
  streamState = "FINALIZING";
  const elapsed = Date.now() - pollStartTime;
  slog("stream", "state", { from: "RESPONDING", to: "FINALIZING", elapsedMs: elapsed });
  stopTmuxStreaming();
  plog("stream_done", `${(elapsed / 1000).toFixed(1)}s`);

  console.log(`[stream] Done after ${(elapsed / 1000).toFixed(1)}s`);

  // System context response — suppress only system-context entries, keep user's real entries
  if (_isSystemContext) {
    _isSystemContext = false;
    const beforeCount = conversationEntries.length;
    // Only remove entries created during this system context turn that match context patterns
    // or have no meaningful user content. Preserve entries from other turns entirely.
    setConversationEntries(conversationEntries.filter(e => {
      if (e.turn !== currentTurn) return true; // Keep entries from other turns
      if (e.role === "user" && !MURMUR_CONTEXT_FILTER.test(e.text.trim())) return true; // Keep real user entries
      return false; // Remove system context user entry + its assistant response
    }));
    const removed = beforeCount - conversationEntries.length;
    broadcast({ type: "entry", entries: conversationEntries, partial: false });
    broadcast({ type: "voice_status", state: "idle" });
    broadcastPipelineTrace();
    console.log(`[stream] System context response suppressed (removed ${removed} entries, kept ${conversationEntries.length})`);
    streamState = "DONE";
    return;
  }

  // Final extraction into entry model
  const pane = captureTmuxPane();
  const paragraphs = extractStructuredOutput(preInputSnapshot, pane, lastUserInput);

  // Update entries from final paragraphs (current turn only)
  const assistantEntries = conversationEntries.filter(e => e.role === "assistant" && e.turn === currentTurn);
  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];
    if (i < assistantEntries.length) {
      assistantEntries[i].text = para.text;
      assistantEntries[i].speakable = para.speakable;
    } else {
      // Skip if identical text exists in recent entries (cross-turn dedup for gen bumps)
      // Bug U1: widened from slice(-20)/±2turns to slice(-30)/no turn restriction — matches broadcastCurrentOutput
      const recentEntries = conversationEntries.slice(-30);
      const paraNorm = para.text.trim().toLowerCase().replace(/\s+/g, " ");
      const isDup = recentEntries.some(e => {
        if (e.role !== "assistant") return false;
        if (e.text === para.text) return true; // Exact match — no turn restriction
        const eNorm = e.text.trim().toLowerCase().replace(/\s+/g, " ");
        return eNorm === paraNorm;
      });
      if (!isDup) {
        const newId = ++entryIdCounter;
        pushEntry({
          id: newId,
          role: "assistant",
          text: para.text,
          speakable: para.speakable,
          spoken: false,
          ts: Date.now(),
          turn: currentTurn,
          ...(_currentInputId ? { parentInputId: _currentInputId } : {}),
        });
        if (_currentInputId) {
          const il = _inputLog.find(l => l.inputId === _currentInputId);
          if (il) il.responseEntryIds.push(newId);
        }
      }
    }
  }

  // Clear tool status line when stream completes
  broadcast({ type: "tool_status", text: "" });

  const totalEntries = conversationEntries.filter(e => e.role === "assistant" && e.turn === currentTurn).length;
  console.log(`[stream] Final: ${totalEntries} assistant entries (turn ${currentTurn})`);

  // Queue unspoken entries for TTS but do NOT mark spoken=true yet.
  // Entries are marked spoken in handleTtsDone when audio actually completes,
  // then re-broadcast so the client sees accurate spoken flags.
  let spokeAnything = false;
  for (const entry of conversationEntries) {
    if (entry.role === "assistant" && entry.turn === currentTurn && shouldTtsEntry(entry) && !entry.spoken) {
      // Check if sentence TTS already partially spoke this entry during streaming
      const cursor = entryTtsCursor.get(entry.id) ?? 0;
      if (cursor > 0) {
        const tail = entry.text.slice(cursor).trim();
        if (tail.length > 0) {
          console.log(`[stream] Final tail TTS (id=${entry.id}, cursor=${cursor}, tail=${tail.length} chars): "${tail.slice(0, 80)}"`);
          plog("final_entry_tts_tail", `id=${entry.id} "${tail.slice(0, 80)}" (${tail.length} chars)`);
          // Mark cursor as fully covered so handleTtsDone2 knows this entry is complete
          entryTtsCursor.set(entry.id, entry.text.length);
          queueTts(entry.id, tail);
        } else {
          console.log(`[stream] Entry fully spoken by sentence TTS (id=${entry.id})`);
          entry.spoken = true; // All sentences already spoken — mark immediately
        }
      } else {
        console.log(`[stream] Final TTS (id=${entry.id}, ${entry.text.length} chars): "${entry.text.slice(0, 80)}..."`);
        plog("final_entry_tts", `id=${entry.id} "${entry.text.slice(0, 80)}" (${entry.text.length} chars)`);
        queueTts(entry.id, entry.text);
      }
      spokeAnything = true;
    }
  }

  // Enforce entry cap before final broadcast
  trimEntriesToCap();

  // Broadcast final entries — spoken flags reflect actual TTS state (not preemptive)
  broadcast({
    type: "entry",
    entries: conversationEntries,
    partial: false,
  });

  if (!spokeAnything) {
    const hasSpeakable = conversationEntries.some(e => e.role === "assistant" && e.turn === currentTurn && e.speakable);
    if (hasSpeakable) {
      console.log("[stream] All speakable entries already spoken");
    } else {
      console.log("[stream] No speakable entries found");
    }
    if (!ttsCurrentlyPlaying && ttsJobQueue.length === 0) {
      plog("cycle_idle", spokeAnything ? "all spoken" : "nothing speakable");
      broadcastPipelineTrace();
      broadcast({ type: "voice_status", state: "idle" });
    }
  }

  // Finalization complete — transition to DONE
  streamState = "DONE";
  slog("stream", "state", { from: "FINALIZING", to: "DONE" });

  // Push architecture: re-engagement handled by handlePipeOutput detecting spinner during DONE state
  // No polling watcher needed — the always-on pipe will trigger reEngageFromPush() automatically
}

// startReEngageWatcher and reEngageStreaming removed — replaced by push-based reEngageFromPush()

function stopTmuxStreaming() {
  // Push architecture: don't stop the always-on pipe — it runs continuously.
  // Only cancel timers and reset state.

  if (streamTimeout) {
    clearTimeout(streamTimeout);
    streamTimeout = null;
  }
  cancelDoneCheck();
  if (entryTtsTimer) { clearTimeout(entryTtsTimer); entryTtsTimer = null; }
  if (_parseTimer) { clearTimeout(_parseTimer); _parseTimer = null; }
  if (_quietTimer) { clearTimeout(_quietTimer); _quietTimer = null; }
  if (_idleCheckTimer) { clearTimeout(_idleCheckTimer); _idleCheckTimer = null; }
  streamState = "IDLE";
  lastStreamEndTime = Date.now();

  // Drain pending queued voice input (lock prevents concurrent drains)
  if (pendingVoiceInput.length > 0 && !_voiceQueueDraining) {
    _voiceQueueDraining = true;
    const next = pendingVoiceInput.shift()!;
    const remaining = pendingVoiceInput.length;
    console.log(`[voice] Draining queued input: "${next.text.slice(0, 60)}" — ${remaining} remaining`);
    setTimeout(() => {
      try {
      // Mark the queued entry as sent (remove queued flag) before starting stream
      const queuedEntry = conversationEntries.find(e => e.id === next.entryId);
      if (queuedEntry) {
        queuedEntry.queued = false;
        broadcast({ type: "entry", entries: conversationEntries, partial: false });
      }
      // Switch to the session that was active when the message was queued
      const savedTarget = terminal.currentTarget;
      if (next.target && next.target !== savedTarget && terminal.switchTarget) {
        console.log(`[voice] Restoring queued target: ${next.target} (current: ${savedTarget})`);
        const lastColon = next.target.lastIndexOf(":");
        if (lastColon !== -1) {
          const session = next.target.slice(0, lastColon);
          const windowIdx = parseInt(next.target.slice(lastColon + 1));
          terminal.switchTarget(session, windowIdx);
        }
      }
      startTmuxStreaming(next.text);
      if (!queuedEntry) addUserEntry(next.text, false, "queue-drain-fallback"); // Fallback if entry was lost
      terminal.sendText(next.text);
      broadcast({ type: "voice_queue", count: remaining });
      } finally { _voiceQueueDraining = false; }
    }, 500);
  }
}

// --- Passive watcher removed — replaced by push-based handlePipeOutput() ---
// Native CLI input detection now handled by always-on pipe + handleNativeInputDetected().
// Passive watcher variables removed — replaced by push-based architecture
// startPassiveWatcher removed — push-based architecture.
// Keeping stub functions for call sites that haven't been updated yet.
function startPassiveWatcher() {
  // Push architecture: the always-on pipe handles idle detection.
  // Set up the pipe output callback if not already done.
  if (terminal.onOutput) {
    terminal.onOutput(handlePipeOutput);
    console.log("[push] Always-on pipe output handler registered");
  } else {
    console.warn("[push] Terminal backend does not support onOutput — falling back to stub");
  }
}

// Original passive watcher body removed (was ~300 lines of polling/scraping).
// REPLACED BY: handlePipeOutput(), handleNativeInputDetected(), reEngageFromPush()

function stopPassiveWatcher() {
  // Push architecture: no-op — the always-on pipe runs continuously
}

/** Check for interrupt prompt in pane content */
function checkForInterruptPrompt(pane: string): void {
  if (/Interrupted\s*.{0,3}\s*What should Claude do/i.test(pane)) {
    console.log("[push] Detected interrupt prompt in pane");
    if (streamState !== "IDLE" && streamState !== "DONE") {
      console.log("[push] Interrupted prompt detected — ending stream");
      streamState = "IDLE";
      lastStreamEndTime = Date.now();
      stopClientPlayback2("passive_redetect");
      broadcast({ type: "voice_status", state: "idle" });
    }
  }
}

// --- VoiceMode Event Log Watching ---
// Watches ~/.voicemode/logs/events/*.jsonl for real-time status

let eventsLogSize = 0;
let currentEventsFile = "";

function findTodayEventsFile(): string {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return join(VM_EVENTS_DIR, `voicemode_events_${today}.jsonl`);
}

function initEventsLog() {
  currentEventsFile = findTodayEventsFile();
  try {
    if (existsSync(currentEventsFile)) {
      eventsLogSize = statSync(currentEventsFile).size;
    }
  } catch {}
}

function readNewEvents() {
  // Check if day rolled over
  const todayFile = findTodayEventsFile();
  if (todayFile !== currentEventsFile) {
    currentEventsFile = todayFile;
    eventsLogSize = 0;
  }

  if (!existsSync(currentEventsFile)) return;

  try {
    const newSize = statSync(currentEventsFile).size;
    if (newSize <= eventsLogSize) {
      eventsLogSize = newSize;
      return;
    }
    const buf = Buffer.alloc(newSize - eventsLogSize);
    let fd: number | null = null;
    try {
      fd = openSync(currentEventsFile, "r");
      readSync(fd, buf, 0, buf.length, eventsLogSize);
    } finally {
      if (fd !== null) closeSync(fd);
    }
    eventsLogSize = newSize;

    const lines = buf.toString().trim().split("\n");
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        handleVoiceModeEvent(event);
      } catch {}
    }
  } catch {
    eventsLogSize = 0;
  }
}

// --- VoiceMode Exchanges Log Watching ---
// Watches ~/.voicemode/logs/conversations/*.jsonl for transcriptions

let exchangesLogSize = 0;
let currentExchangesFile = "";

function findTodayExchangesFile(): string {
  const today = new Date().toISOString().slice(0, 10);
  return join(VM_EXCHANGES_DIR, `exchanges_${today}.jsonl`);
}

function initExchangesLog() {
  currentExchangesFile = findTodayExchangesFile();
  try {
    if (existsSync(currentExchangesFile)) {
      exchangesLogSize = statSync(currentExchangesFile).size;
    }
  } catch {}
}

function readNewExchanges() {
  const todayFile = findTodayExchangesFile();
  if (todayFile !== currentExchangesFile) {
    currentExchangesFile = todayFile;
    exchangesLogSize = 0;
  }

  if (!existsSync(currentExchangesFile)) return;

  try {
    const newSize = statSync(currentExchangesFile).size;
    if (newSize <= exchangesLogSize) {
      exchangesLogSize = newSize;
      return;
    }
    const buf = Buffer.alloc(newSize - exchangesLogSize);
    let fd: number | null = null;
    try {
      fd = openSync(currentExchangesFile, "r");
      readSync(fd, buf, 0, buf.length, exchangesLogSize);
    } finally {
      if (fd !== null) closeSync(fd);
    }
    exchangesLogSize = newSize;

    const lines = buf.toString().trim().split("\n");
    for (const line of lines) {
      try {
        const exchange = JSON.parse(line);
        handleVoiceModeExchange(exchange);
      } catch {}
    }
  } catch {
    exchangesLogSize = 0;
  }
}

// --- VoiceMode Event Handler ---

// Phase tracks the detailed conversation state:
// "idle" | "standby" | "speaking" | "listening" | "recording" | "transcribing" | "thinking" | "responding"
let vmState = {
  ttsPlaying: false,
  micActive: false,
  conversationActive: false,
  phase: "idle" as string,
};

// Track whether the current converse() cycle had TTS (to detect standby mode)
let currentCycleHadTts = false;

// Timer to reset to idle after TOOL_REQUEST_END if no new events come
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleIdleReset(delayMs = 15000) {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if ((vmState.phase === "thinking" || vmState.phase === "standby" || vmState.phase === "listening") && !vmState.ttsPlaying && !vmState.micActive) {
      // If the last cycle had no TTS, it was standby — go to standby, not idle
      // The conversation skill will keep looping, so stay in standby
      if (!currentCycleHadTts && vmState.conversationActive) {
        vmState.phase = "standby";
      } else {
        vmState.phase = "idle";
        vmState.conversationActive = false;
      }
      broadcast({ type: "status", ...vmState });
    }
  }, delayMs);
}

function cancelIdleReset() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function handleVoiceModeEvent(event: { event_type: string; data?: Record<string, unknown> }) {
  const prev = { ...vmState, phase: vmState.phase };

  switch (event.event_type) {
    case "TTS_START":
      cancelIdleReset();
      currentCycleHadTts = true;
      vmState.conversationActive = true;
      vmState.phase = "responding";
      // Emit assistant message
      if (event.data?.message) {
        broadcast({
          type: "transcription",
          role: "assistant",
          text: event.data.message as string,
          ts: Date.now(),
        });
      }
      break;
    case "TTS_PLAYBACK_START":
      cancelIdleReset();
      vmState.ttsPlaying = true;
      vmState.conversationActive = true;
      vmState.phase = "speaking";
      break;
    case "TTS_PLAYBACK_END":
      vmState.ttsPlaying = false;
      vmState.phase = "listening";
      // Auto-reset to idle if no recording starts within 15s
      scheduleIdleReset(15000);
      break;
    case "RECORDING_START":
      cancelIdleReset();
      vmState.micActive = true;
      vmState.conversationActive = true;
      // If no TTS happened this cycle, we're in standby (passive listen)
      vmState.phase = currentCycleHadTts ? "recording" : "standby";
      break;
    case "RECORDING_END":
      vmState.micActive = false;
      vmState.phase = "transcribing";
      break;
    case "STT_START":
      vmState.micActive = false;
      vmState.phase = "transcribing";
      break;
    case "STT_COMPLETE":
      vmState.micActive = false;
      vmState.phase = "thinking";
      // Emit user transcription
      if (event.data?.text) {
        broadcast({
          type: "transcription",
          role: "user",
          text: event.data.text as string,
          ts: Date.now(),
        });
      }
      break;
    case "SESSION_END":
    case "TOOL_REQUEST_END":
      vmState.ttsPlaying = false;
      vmState.micActive = false;
      vmState.phase = "thinking";
      // If no new events arrive within 15s, assume conversation ended
      scheduleIdleReset(15000);
      break;
    case "SESSION_START":
    case "TOOL_REQUEST_START":
      cancelIdleReset();
      currentCycleHadTts = false; // Reset TTS tracker for new cycle
      vmState.conversationActive = true;
      if (vmState.phase === "thinking" || vmState.phase === "idle" || vmState.phase === "standby") {
        // Don't assume "responding" — could be standby (skip_tts) listen
        // If TTS_START follows, it'll set "responding"; if RECORDING_START follows, it's standby
        vmState.phase = "responding";
      }
      break;
    case "CONCH_ACQUIRE":
      cancelIdleReset();
      if (vmState.phase === "thinking" || vmState.phase === "idle") {
        vmState.phase = "responding";
      }
      break;
    case "CONCH_RELEASE":
      break;
    default:
      return;
  }

  // Broadcast if anything changed
  if (
    vmState.ttsPlaying !== prev.ttsPlaying ||
    vmState.micActive !== prev.micActive ||
    vmState.conversationActive !== prev.conversationActive ||
    vmState.phase !== prev.phase
  ) {
    broadcast({ type: "status", ...vmState });
  }
}

function handleVoiceModeExchange(exchange: {
  type: string;
  text: string;
  timestamp: string;
}) {
  const role = exchange.type === "stt" ? "user" : "assistant";
  const ts = new Date(exchange.timestamp).getTime();

  // Create a proper conversation entry so it appears in the UI
  // (frontend ignores live `transcription` broadcasts — only entries are rendered)
  if (role === "user") {
    // New turn for each voice exchange cycle
    currentTurn++;
    addUserEntry(exchange.text, false, "voice-exchange");
  } else {
    const entry: ConversationEntry = {
      id: ++entryIdCounter,
      role: "assistant",
      text: exchange.text,
      speakable: true,
      spoken: true, // Already spoken via VoiceMode TTS
      ts,
      turn: currentTurn,
    };
    pushEntry(entry);
    elog(entry.id, "assistant", "voicemode", exchange.text);
    broadcast({ type: "entry", entries: conversationEntries, partial: false });
  }
}

// --- File Watching ---

// Watch VoiceMode log directories
const watchPaths: string[] = [];
if (existsSync(VM_EVENTS_DIR)) watchPaths.push(VM_EVENTS_DIR);
if (existsSync(VM_EXCHANGES_DIR)) watchPaths.push(VM_EXCHANGES_DIR);

if (!existsSync(VM_EVENTS_DIR)) {
  console.warn(`⚠ VoiceMode events dir not found: ${VM_EVENTS_DIR}`);
  console.warn("  VoiceMode may not be installed or has not run yet.");
}
if (!existsSync(VM_EXCHANGES_DIR)) {
  console.warn(`⚠ VoiceMode exchanges dir not found: ${VM_EXCHANGES_DIR}`);
}
if (watchPaths.length === 0) {
  console.warn("⚠ No VoiceMode log dirs found — real-time status updates will be unavailable.");
  console.warn("  Install VoiceMode and run it once to create the log directories.");
}

const watcher = chokidar.watch(watchPaths, {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: false,
  usePolling: false,
});

watcher.on("change", (filePath: string) => {
  const name = filePath.replace(/^.*[/\\]/, "");
  if (name.startsWith("voicemode_events_")) {
    readNewEvents();
  } else if (name.startsWith("exchanges_")) {
    readNewExchanges();
  }
});

// Also watch for new files (day rollover)
watcher.on("add", (filePath: string) => {
  const name = filePath.replace(/^.*[/\\]/, "");
  if (name.startsWith("voicemode_events_")) {
    currentEventsFile = filePath;
    eventsLogSize = 0;
    readNewEvents();
  } else if (name.startsWith("exchanges_")) {
    currentExchangesFile = filePath;
    exchangesLogSize = 0;
    readNewExchanges();
  }
});

// Initialize log positions (skip existing content)
initEventsLog();
initExchangesLog();


// --- WebSocket Handling ---

const clients = new Set<WebSocket>();

function broadcast(msg: Record<string, unknown>) {
  // Automatically attach pending TTS entry IDs to entry broadcasts so the client
  // knows which entries have in-flight TTS (and shouldn't be marked as dropped/red).
  if (msg.type === "entry" && !msg.ttsPendingIds) {
    const pendingIds = ttsJobQueue
      .filter(j => j.entryId != null && j.entryId !== FILLER_ENTRY_ID && j.state !== "done" && j.state !== "failed")
      .map(j => j.entryId);
    if (ttsCurrentlyPlaying && ttsCurrentlyPlaying.entryId != null && ttsCurrentlyPlaying.entryId !== FILLER_ENTRY_ID) {
      pendingIds.push(ttsCurrentlyPlaying.entryId);
    }
    msg.ttsPendingIds = pendingIds;
  }
  wslog("out", (msg.type as string) || "unknown", JSON.stringify(msg).length);

  // For entry broadcasts: filter by current window AND test isolation.
  // Window filtering prevents entries from other tmux windows leaking into the view.
  // Test entries (sourceTag starts with "text-input-test") should NOT appear in the
  // user's conversation view. Filter by sourceTag on the entry itself (not by ID set)
  // to avoid timing race where addUserEntry broadcasts before caller registers the ID.
  let dataForReal: string | null = null;
  let dataForTest: string | null = null;
  const isEntryMsg = msg.type === "entry" && Array.isArray(msg.entries);
  if (isEntryMsg) {
    let entries = msg.entries as ConversationEntry[];
    // Window-scope filter: only send entries belonging to the current window.
    // Entries with no window tag (legacy) are allowed through.
    const wk = getWindowKey();
    if (wk && wk !== "_default") {
      const before = entries.length;
      entries = entries.filter(e => !e.window || e.window === wk);
      if (entries.length < before) {
        console.log(`[broadcast] Window filter: ${before} → ${entries.length} entries (kept window=${wk})`);
      }
      msg.entries = entries;
    }
    // Bug U4: Filter ALL test entries — both "text-input-test" (from addUserEntry) and "test-*" (from test:entries-*)
    const isTestEntry = (e: ConversationEntry) => e.sourceTag?.startsWith("test-") || e.sourceTag?.startsWith("text-input-test");
    const hasTestEntries = entries.some(isTestEntry);
    if (hasTestEntries) {
      const realEntries = entries.filter(e => !isTestEntry(e));
      dataForReal = JSON.stringify({ ...msg, entries: realEntries });
      dataForTest = JSON.stringify(msg); // test clients see all entries
    }
  }
  const data = dataForTest ?? JSON.stringify(msg);

  let sent = 0;
  for (const ws of Array.from(clients)) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        // Non-test clients get filtered entries (no test entries)
        const payload = (isEntryMsg && dataForReal && !(ws as any)._isTestMode) ? dataForReal : data;
        ws.send(payload);
        sent++;
      } catch {
        clients.delete(ws);
      }
    } else {
      clients.delete(ws);
    }
  }
  if (msg.type === "transcription" || (msg.type === "voice_status" && msg.state !== "idle")) {
    console.log(`[broadcast] ${msg.type}${msg.type === "transcription" ? ` (${(msg as any).role})` : ` (${(msg as any).state})`} → ${sent}/${clients.size} clients`);
  }
}

// BUG-046: Ping/pong keepalive with stale connection cleanup
const WS_PONG_TIMEOUT_MS = 60000; // Remove clients that haven't ponged in 60s
setInterval(() => {
  const now = Date.now();
  for (const ws of Array.from(clients)) {
    if (ws.readyState !== WebSocket.OPEN) {
      clients.delete(ws);
      continue;
    }
    // Terminate connections that haven't responded to ping in 60s
    const lastPong = (ws as any)._lastPong as number | undefined;
    if (lastPong && now - lastPong > WS_PONG_TIMEOUT_MS) {
      console.warn(`[ws] Terminating stale client (no pong for ${((now - lastPong) / 1000).toFixed(0)}s)`);
      ws.terminate();
      clients.delete(ws);
      if (activeAudioClient === ws) activeAudioClient = null;
      continue;
    }
    ws.ping();
  }
}, 10000);

let exitTimer: ReturnType<typeof setTimeout> | null = null;
let exitSentAt = 0;

function handleWsConnection(ws: WebSocket, req?: import("http").IncomingMessage) {
  // Test mode: text messages render in UI but are NOT forwarded to the terminal.
  // Activated by connecting with ?testmode=1 in the WebSocket URL.
  const reqUrl = req?.url || "";
  const isTestMode = reqUrl.includes("testmode=1");
  if (isTestMode) (ws as any)._isTestMode = true;
  const wasEmpty = clients.size === 0;
  clients.add(ws);
  _clientConnectCount++;
  // BUG-046: Track pong timestamps for stale connection detection
  (ws as any)._lastPong = Date.now();
  (ws as any)._clientId = _clientConnectCount;
  ws.on("pong", () => { (ws as any)._lastPong = Date.now(); });
  slog("ws", "connect", { clients: clients.size });
  _clientLog.push({ ts: Date.now(), event: wasEmpty ? "reconnect" : "connect", clientCount: clients.size, isTestMode, note: `clientId=${_clientConnectCount}` });
  if (_clientLog.length > RING_CAP) _clientLog.shift();

  // Cancel pending exit — a client reconnected
  if (exitTimer) { clearTimeout(exitTimer); exitTimer = null; }

  // Last connected real client takes audio control (auto-claim)
  if (!(ws as any)._isTestClient) {
    setAudioClient(ws, "new-client");
  }

  // Context is sent once at server startup — no per-connection resend

  // Send current state
  ws.send(JSON.stringify({ type: "status", ...vmState }));

  // Send current voice status so client doesn't get stuck on stale state
  const currentVoiceState = streamState === "IDLE" || streamState === "DONE"
    ? (ttsCurrentlyPlaying ? "speaking" : "idle")
    : streamState.toLowerCase();
  ws.send(JSON.stringify({ type: "voice_status", state: currentVoiceState }));

  // Send terminal session info
  ws.send(
    JSON.stringify({
      type: "tmux",
      session: terminal.displayTarget ?? terminal.currentTarget ?? "claude-voice",
      alive: terminal.isSessionAlive(),
      current: terminal.displayTarget ?? terminal.currentTarget ?? "claude-voice",
    })
  );

  // Send audio control state
  ws.send(JSON.stringify({ type: "audio_control", hasControl: activeAudioClient === ws }));

  // Send service status — re-check if last check was > 30s ago to ensure accuracy for new clients
  ws.send(JSON.stringify({ type: "services", ...serviceStatus }));
  const timeSinceLastServiceCheck = Date.now() - lastServiceCheckAt;
  if (timeSinceLastServiceCheck > 30000) {
    checkAllServices().then(status => {
      serviceStatus = status;
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "services", ...status }));
    });
  }

  // Send conversation entries so reconnecting clients see the full history.
  // If window is not yet active (_unset), entries will be sent when client sends window_preference.
  if (isWindowActive() && conversationEntries.length > 0) {
    let recentEntries = [...conversationEntries];
    // Window-scope filter: only send entries for current window
    const wk = getWindowKey();
    if (wk && wk !== "_default") {
      recentEntries = recentEntries.filter(e => !e.window || e.window === wk);
    }
    if (recentEntries.length > 80) {
      recentEntries = recentEntries.slice(-80);
    }
    if (!(ws as any)._isTestMode) {
      // Bug U4 fix: filter ALL test entries, not just text-input-test
      recentEntries = recentEntries.filter(e => !isTestEntry(e));
    }
    ws.send(JSON.stringify({ type: "entry", entries: recentEntries, partial: streamState === "RESPONDING" }));
  }

  // Fallback: if no window_preference received within 5s and window is still _unset,
  // activate using saved settings (for clients without window_preference support).
  if (!isWindowActive()) {
    const fallbackTimer = setTimeout(() => {
      if (!isWindowActive() && ws.readyState === WebSocket.OPEN) {
        const saved = loadSettings();
        const target = saved.tmuxTarget || "claude-voice:0";
        console.log(`[ws] No window_preference received — falling back to saved target: ${target}`);
        activateWindow(target, ws);
      }
    }, 5000);
    ws.on("close", () => clearTimeout(fallbackTimer));
  }

  // Send current panel settings (prefer persistent file, fall back to signal files)
  {
    const persisted = loadSettings();
    const settings: Record<string, string> = {};
    if (persisted.speed) settings.speed = persisted.speed.toString();
    else { try { const v = readFileSync(join(SIGNAL_DIR, "claude-tts-speed"), "utf-8").trim(); if (v) settings.speed = v; } catch {} }
    if (persisted.voice && (VALID_VOICES.has(persisted.voice) || VALID_XI_VOICES.has(persisted.voice) || persisted.voice.startsWith("_local:"))) settings.voice = persisted.voice;
    else { try { const v = readFileSync(join(SIGNAL_DIR, "claude-tts-voice"), "utf-8").trim(); if (v) settings.voice = v; } catch {} }
    try { const v = readFileSync(join(SIGNAL_DIR, "claude-mic-mute"), "utf-8").trim(); settings.muted = v === "1" ? "1" : "0"; } catch {}
    if (persisted.elevenLabsApiKey) settings.hasElevenLabsKey = "1";
    ws.send(JSON.stringify({ type: "settings", ...settings }));
  }

  // Send recent transcriptions from today's event log
  // (exchanges log may lag, events log has STT_COMPLETE and TTS_START with text)
  try {
    const evFile = findTodayEventsFile();
    if (existsSync(evFile)) {
      const content = readFileSync(evFile, "utf-8").trim();
      if (content) {
        const lines = content.split("\n");
        const transcripts: { role: string; text: string; ts: number }[] = [];
        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            if (event.event_type === "STT_COMPLETE" && event.data?.text) {
              transcripts.push({
                role: "user",
                text: event.data.text,
                ts: new Date(event.timestamp).getTime(),
              });
            } else if (event.event_type === "TTS_START" && event.data?.message) {
              transcripts.push({
                role: "assistant",
                text: event.data.message,
                ts: new Date(event.timestamp).getTime(),
              });
            }
          } catch {}
        }
        // Send last 20
        for (const t of transcripts.slice(-20)) {
          ws.send(
            JSON.stringify({
              type: "transcription",
              historic: true,
              ...t,
            })
          );
        }
      }
    }
  } catch {}

  // Track whether next binary message is a wake-word check
  let pendingWakeCheck = false;
  // Pre-buffer: WAV audio captured before recording started (speech onset)
  let pendingPreBuffer: Buffer | null = null;

  // Rate limiting: max 100 text messages per second per client (binary audio exempt)
  let _rateMsgCount = 0;
  let _rateWindowStart = Date.now();
  const RATE_LIMIT_MAX = 100;
  const RATE_LIMIT_WINDOW_MS = 1000;

  ws.on("message", async (raw, isBinary) => {
    wslog("in", isBinary ? "binary" : (raw.toString().split(":")[0] || "unknown"), isBinary ? (raw as Buffer).length : raw.toString().length);

    // Rate limit text messages (binary audio is exempt)
    if (!isBinary) {
      const now = Date.now();
      if (now - _rateWindowStart > RATE_LIMIT_WINDOW_MS) {
        _rateMsgCount = 0;
        _rateWindowStart = now;
      }
      _rateMsgCount++;
      if (_rateMsgCount > RATE_LIMIT_MAX) {
        wslog("in", "rate-limited", _rateMsgCount);
        return;
      }
    }
    // Binary message = audio data to transcribe
    if (isBinary) {
      const audioData = raw as Buffer;

      // Mic persistence test: log every incoming audio chunk with timestamp
      if (_micPersistenceActive) {
        _micPersistenceLog.push({ ts: Date.now(), type: "audio_chunk", size: audioData.length });
        if (_micPersistenceLog.length > 500) _micPersistenceLog.shift();
      }

      // Streaming STT: partial transcription during recording (preview only)
      if ((ws as any)._expectPartial) {
        (ws as any)._expectPartial = false;
        // Don't block the main pipeline — transcribe async and send result to this client only
        transcribeAudio(audioData).then(text => {
          if (text && text.length > 1) {
            console.log(`[streaming-stt] Partial: "${text.slice(0, 80)}"`);
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "partial_transcription", text }));
          }
        }).catch(err => {
          console.warn("[streaming-stt] Partial transcription failed:", (err as Error).message);
        });
        return;
      }

      // If we're expecting a pre-buffer WAV, store it and wait for the main audio
      if (pendingPreBuffer === null && pendingWakeCheck === false && (ws as any)._expectPreBuffer) {
        pendingPreBuffer = audioData;
        (ws as any)._expectPreBuffer = false;
        console.log(`Received pre-buffer: ${audioData.length} bytes — waiting for main audio`);
        return;
      }

      const isWakeCheck = pendingWakeCheck;
      pendingWakeCheck = false;

      // Combine pre-buffer with main audio if available
      let finalAudio = audioData;
      if (pendingPreBuffer) {
        const preBuffer = pendingPreBuffer;
        pendingPreBuffer = null;
        try {
          finalAudio = combineAudioBuffers(preBuffer, audioData);
          console.log(`Combined pre-buffer (${preBuffer.length}b) + main audio (${audioData.length}b) = ${finalAudio.length}b`);
        } catch (err) {
          console.error("Failed to combine pre-buffer:", (err as Error).message);
          // Fall back to just the main audio
          finalAudio = audioData;
        }
      }

      // Capture and consume pending inputId
      const audioInputId: string | undefined = (ws as any)._pendingInputId;
      (ws as any)._pendingInputId = undefined;

      console.log(`Received audio: ${finalAudio.length} bytes (wake_check=${isWakeCheck}${audioInputId ? ` inputId=${audioInputId}` : ""})`);
      resetPipelineLog();
      plog("audio_received", `${finalAudio.length} bytes`);
      broadcast({ type: "voice_status", state: "transcribing" });

      const text = await transcribeAudio(finalAudio, audioInputId);

      if (!text || text.length <= 1) {
        console.log("Blank transcription");
        plog("blank_transcription");
        broadcastPipelineTrace();
        broadcast({ type: "voice_status", state: isWakeCheck ? "wake_no_match" : "blank" });
        return;
      }

      // Filter Whisper hallucinations — common artifacts from blank/noisy audio
      const lower = text.toLowerCase().trim();
      const WHISPER_NOISE = [
        /^\[.*\]$/,                          // [BLANK_AUDIO], [silence], [music], etc.
        /^\(.*\)$/,                          // (silence), (background noise), etc.
        /^(thank you\.?|thanks\.?|you\.?)$/i,  // Common Whisper hallucination
        /^(bye\.?|okay\.?|yeah\.?)$/i,       // Single-word noise (too short to be real)
        /^(hmm\.?|uh\.?|um\.?|ah\.?)$/i,    // Filler sounds
        /^\.+$/,                             // Just dots
      ];
      if (WHISPER_NOISE.some(re => re.test(lower))) {
        console.log(`Filtered Whisper noise: "${text}"`);
        broadcast({ type: "voice_status", state: isWakeCheck ? "wake_no_match" : "blank" });
        return;
      }

      console.log(`Transcription: "${text}"`);

      // Test mode: transcribe only, don't send to terminal
      if ((ws as any)._testTranscribeOnly) {
        (ws as any)._testTranscribeOnly = false;
        console.log(`[test] Transcribe-only mode — not sending to terminal`);
        plog("test_transcribe_only", `"${text.slice(0, 80)}"`);
        addUserEntry(text, false, "voice-test", audioInputId);
        broadcast({ type: "voice_status", state: "idle" });
        broadcastPipelineTrace();
        return;
      }

      if (isWakeCheck) {
        // Check for wake word
        const lower = text.toLowerCase();
        // Use word boundaries to avoid false positives (e.g. "claudication", "cloudy")
        if (/\bclaude\b/.test(lower) || /\bclyde\b/.test(lower) || /\bhey cloud\b/.test(lower)) {
          console.log("Wake word detected!");
          // Snapshot BEFORE sending, then send, then start polling
          startTmuxStreaming(text, audioInputId);
          addUserEntry(text, false, "voice", audioInputId);
          terminal.recordSentInput?.(text);
          terminal.sendText(text);
          queueFillerAudio(text);
        } else {
          console.log(`No wake word in: "${text}"`);
          broadcast({ type: "voice_status", state: "wake_no_match" });
        }
      } else {
        // Direct send — no wake word check
        if (streamState === "IDLE" || streamState === "DONE") {
          // Normal: send immediately
          startTmuxStreaming(text, audioInputId);
          addUserEntry(text, false, "voice", audioInputId);
          terminal.recordSentInput?.(text);
          terminal.sendText(text);
          queueFillerAudio(text);
        } else {
          // Claude is active — queue the transcription, add to transcript immediately
          const queuedEntry = addUserEntry(text, true, "voice", audioInputId);
          pendingVoiceInput.push({ text, entryId: queuedEntry.id, target: terminal.currentTarget ?? "" });
          const count = pendingVoiceInput.length;
          console.log(`[voice] Queued (state=${streamState}): "${text.slice(0, 60)}" — ${count} pending`);
          broadcast({ type: "voice_queue", count });
          // Return to current stream state so UI exits transcribing
          // WAITING also maps to "thinking" — Claude hasn't started yet but will
          const vsState = streamState === "RESPONDING" ? "responding" : "thinking";
          broadcast({ type: "voice_status", state: vsState });
        }
      }
      return;
    }

    const msg = raw.toString();

    // Testmode guard: block ALL messages that touch the terminal or interrupt Claude.
    // Only allow safe messages: test commands, logging, TTS feedback, audio control, settings.
    if ((ws as any)._isTestMode) {
      const safeTestPrefixes = [
        "test:", "log:", "tts_done", "chunk_done:", "claim:audio", "speed:", "voice:",
        "mute:", "replay", "replay:", "text:",  // text: is handled separately with its own testmode check
        "barge_in", "filler_audio:", "mictest:", "resend:", "elevenlabs_key:", "clean_mode:", "window_preference:",
        "tmux:switch:", "tmux:list",  // Window management — safe for testing (don't touch Claude session)
      ];
      const isSafe = safeTestPrefixes.some(p => msg.startsWith(p));
      if (!isSafe) {
        console.log(`[ws] Testmode blocked: "${msg.slice(0, 40)}"`);
        return;
      }
    }

    // Input ID marker — tags the next audio with a unique input ID for dedup
    if (msg.startsWith("voice:inputid:")) {
      (ws as any)._pendingInputId = msg.slice(14);
      return;
    }

    // Pre-buffer marker — next binary is WAV pre-buffer, followed by main WebM audio
    if (msg === "voice:prebuffer") {
      (ws as any)._expectPreBuffer = true;
      console.log("Pre-buffer signal received — next binary is WAV pre-buffer");
      return;
    }

    // Partial streaming STT — next binary is partial audio for preview transcription
    if (msg === "voice:partial") {
      (ws as any)._expectPartial = true;
      return;
    }

    // Wake check marker — next binary message will be checked for wake word
    if (msg === "voice:wake_check") {
      pendingWakeCheck = true;
      return;
    }

    // Start conversation — interrupt any current operation, then send /conversation
    if (msg === "conversation:start") {
      if (!terminal.isSessionAlive()) {
        terminal.createSession();
        sendMurmurContext(5000);
        setTimeout(() => {
          terminal.sendText("/conversation");
          vmState.conversationActive = true;
          broadcast({ type: "status", ...vmState });
          broadcast({ type: "conversation", state: "starting" });
        }, 3000);
        return;
      }
      // Interrupt any current operation, clear input line, then send
      terminal.sendKey("Escape");
      setTimeout(() => {
        terminal.sendKey("C-u");
        setTimeout(() => {
          terminal.sendText("/conversation");
          vmState.conversationActive = true;
          broadcast({ type: "status", ...vmState });
          broadcast({ type: "conversation", state: "starting" });
        }, 300);
      }, 500);
      return;
    }

    // Stop conversation — send Escape to interrupt
    if (msg === "conversation:stop") {
      cancelIdleReset();
      terminal.sendKey("Escape");
      stopTts();
      stopTmuxStreaming();
      // Also try to kill any active recording (Unix only)
      if (process.platform !== "win32") {
        try { execSync("pkill -f 'rec\\|sox\\|arecord' 2>/dev/null", { stdio: "ignore", timeout: 3000 }); } catch {}
      }
      vmState = { ttsPlaying: false, micActive: false, conversationActive: false, phase: "idle" };
      broadcast({ type: "status", ...vmState });
      broadcast({ type: "voice_status", state: "idle" });
      broadcast({ type: "conversation", state: "stopped" });
      return;
    }

    // Stop — interrupt Claude + kill TTS + stop polling
    // Terminal navigation keys for interactive prompts
    if (msg === "key:up") { terminal.sendKey("Up"); return; }
    if (msg === "key:down") { terminal.sendKey("Down"); return; }
    if (msg === "key:enter") { terminal.sendKey("Enter"); return; }
    if (msg === "key:escape") { terminal.sendKey("Escape"); return; }
    if (msg === "key:tab") { terminal.sendKey("Tab"); return; }

    // Barge-in: user started speaking over TTS. During playback-only (DONE),
    // pause TTS without bumping generation (client may resume if no real speech).
    // During active streaming (THINKING/RESPONDING), treat as full interrupt.
    if (msg === "barge_in") {
      console.log(`[barge-in] Received, streamState=${streamState}`);
      if (streamState === "THINKING" || streamState === "RESPONDING" || streamState === "WAITING") {
        // Full interrupt — same as stop
        terminal.sendKey("Escape");
        stopTts();
        stopTmuxStreaming();
        broadcast({ type: "voice_status", state: "idle" });
      } else {
        // Playback-only (DONE/IDLE) — soft pause, don't bump generation
        // Just stop client playback without invalidating pending chunks
        broadcast({ type: "tts_stop" });
        ttsCurrentlyPlaying = null;
        if (ttsPlaybackTimeout2) { clearTimeout(ttsPlaybackTimeout2); ttsPlaybackTimeout2 = null; }
        // Log for Monitor visibility
        ttsGenerationLog.push({ gen: ttsGeneration, reason: "barge_in", ts: Date.now() });
        if (ttsGenerationLog.length > 20) ttsGenerationLog.shift();
        console.log(`[barge-in] Soft pause (playback only, gen=${ttsGeneration} NOT bumped)`);
      }
      return;
    }

    if (msg === "stop") {
      // Remove queued entries from transcript and clear queue
      if (pendingVoiceInput.length > 0) {
        const queuedIds = new Set(pendingVoiceInput.map(p => p.entryId));
        setConversationEntries(conversationEntries.filter(e => !queuedIds.has(e.id)));
        broadcast({ type: "entry", entries: conversationEntries, partial: false });
      }
      pendingVoiceInput = [];
      _voiceQueueDraining = false;
      terminal.sendKey("Escape");
      stopTts();
      stopTmuxStreaming();
      if (streamState !== "IDLE") streamState = "IDLE";
      // Also kill VoiceMode's sounddevice playback and any recording (Unix only)
      if (process.platform !== "win32") {
        try { execSync("pkill -f 'sounddevice\\|rec\\|sox\\|arecord' 2>/dev/null", { stdio: "ignore", timeout: 3000 }); } catch {}
      }
      vmState.ttsPlaying = false;
      vmState.micActive = false;
      broadcast({ type: "status", ...vmState });
      broadcast({ type: "voice_status", state: "idle" });
      broadcast({ type: "signal", name: "voice-stop" });
      broadcast({ type: "voice_queue", count: 0 }); // Clear badge
      return;
    }

    // Interrupt — stop Claude immediately, then flush any pending queued voice
    if (msg === "interrupt") {
      terminal.sendKey("Escape");
      stopTts();
      stopTmuxStreaming(); // Sets IDLE and drains pendingVoiceInput (if any)
      if (process.platform !== "win32") {
        try { execSync("pkill -f 'sounddevice\\|rec\\|sox\\|arecord' 2>/dev/null", { stdio: "ignore", timeout: 3000 }); } catch {}
      }
      vmState.ttsPlaying = false;
      vmState.micActive = false;
      broadcast({ type: "status", ...vmState });
      broadcast({ type: "voice_status", state: "idle" });
      broadcast({ type: "signal", name: "voice-stop" });
      return;
    }

    // Flush queue — send all queued voice messages to Claude sequentially
    // Used when Claude is idle but queue has items (user pressed interrupt to flush)
    if (msg === "flush_queue") {
      if (pendingVoiceInput.length > 0 && streamState === "IDLE") {
        console.log(`[voice] Flushing ${pendingVoiceInput.length} queued messages`);
        stopTts();
        stopTmuxStreaming(); // Drains first item, cascade handles rest
      } else {
        console.log(`[voice] flush_queue: nothing to flush (queue=${pendingVoiceInput.length}, stream=${streamState})`);
        broadcast({ type: "voice_queue", count: 0 });
      }
      return;
    }

    // Chunk-level ack: client finished playing one chunk, send next
    // Format: "chunk_done:ENTRY_ID:CHUNK_INDEX"
    if (msg.startsWith("chunk_done:")) {
      const parts = msg.slice(11).split(":");
      const chunkEntryId = parseInt(parts[0], 10);
      const chunkIndex = parseInt(parts[1], 10);
      if (!isNaN(chunkEntryId) && !isNaN(chunkIndex)) {
        handleChunkDone(chunkEntryId, chunkIndex);
      }
      return;
    }

    // Client-reported render timing: "render_timing:ENTRY_ID:RENDER_MS:ENTRY_COUNT[:VIEWPORT_HEIGHT]"
    if (msg.startsWith("render_timing:")) {
      const parts = msg.slice(14).split(":");
      const rtEntryId = parseInt(parts[0], 10);
      const renderMs = parseFloat(parts[1]);
      const entryCount = parseInt(parts[2], 10);
      const viewportHeight = parts[3] ? parseInt(parts[3], 10) : undefined;
      if (!isNaN(rtEntryId) && !isNaN(renderMs)) {
        _renderLog.push({ ts: Date.now(), clientTs: Date.now(), entryId: rtEntryId, renderMs, entryCount: entryCount || 0, viewportHeight });
        if (_renderLog.length > RING_CAP) _renderLog.shift();
      }
      return;
    }

    // Mic persistence test — client reports RMS levels and visibility changes
    if (msg.startsWith("mictest:")) {
      const payload = msg.slice(8);
      if (payload === "start") {
        _micPersistenceActive = true;
        _micPersistenceLog.length = 0;
        _micPersistenceLog.push({ ts: Date.now(), type: "marker", note: "test_started" });
        console.log("[mictest] Persistence test started");
      } else if (payload === "stop") {
        _micPersistenceLog.push({ ts: Date.now(), type: "marker", note: "test_stopped" });
        _micPersistenceActive = false;
        console.log(`[mictest] Test stopped. ${_micPersistenceLog.length} entries logged.`);
      } else if (payload.startsWith("rms:")) {
        const rms = parseFloat(payload.slice(4));
        _micPersistenceLog.push({ ts: Date.now(), type: "rms_report", rms });
        if (_micPersistenceLog.length > 500) _micPersistenceLog.shift();
      } else if (payload.startsWith("vis:")) {
        const state = payload.slice(4); // "hidden" or "visible"
        _micPersistenceLog.push({ ts: Date.now(), type: "visibility", note: state });
        console.log(`[mictest] Visibility change: ${state}`);
      }
      return;
    }

    // TTS playback complete (from client)
    // Accepts both old "tts_done" and new "tts_done:ENTRY_ID" format
    if (msg === "tts_done" || msg.startsWith("tts_done:")) {
      // Ignore tts_done from non-audio clients to prevent double-drain,
      // BUT accept if audio client has disconnected (prevents deadlock)
      if (activeAudioClient && activeAudioClient !== ws && !(ws as any)._isTestClient
          && activeAudioClient.readyState === WebSocket.OPEN) {
        console.log("[tts] Ignoring tts_done from non-audio client");
        return;
      }
      // Parse entry ID from new format "tts_done:123", or null for legacy "tts_done"
      const doneEntryId = msg.startsWith("tts_done:") ? parseInt(msg.slice(9), 10) : null;
      console.log(`[tts2] Received tts_done from client (entryId=${doneEntryId} queue=${ttsJobQueue.length} playing=${ttsCurrentlyPlaying?.jobId ?? "none"})`);
      handleTtsDone2(doneEntryId);
      return;
    }

    // Explicit audio control claim
    if (msg === "claim:audio") {
      if (!(ws as any)._isTestClient) {
        setAudioClient(ws, "claim");
        console.log("[audio] Client explicitly claimed audio control");
      }
      return;
    }

    // Speed
    if (msg.startsWith("speed:")) {
      const speed = parseFloat(msg.slice(6));
      if (!isNaN(speed) && speed >= 0.5 && speed <= 3.0) {
        writeFileSync(join(SIGNAL_DIR, "claude-tts-speed"), speed.toString());
        saveSettings({ speed });
      }
      return;
    }

    // Filler audio toggle
    if (msg.startsWith("filler_audio:")) {
      const val = msg.slice(13).trim();
      const enabled = val !== "0" && val !== "false";
      saveSettings({ fillerAudio: enabled });
      console.log(`[settings] Filler audio: ${enabled}`);
      return;
    }

    // Client reports available local voices for TTS fallback decisions
    if (msg.startsWith("local_voices:")) {
      const voiceNames = msg.slice(13).split(",").filter(Boolean);
      (ws as any)._localVoices = new Set(voiceNames);
      console.log(`[ws] Client reported ${voiceNames.length} local voices`);
      return;
    }

    // Clean/Verbose mode toggle — controls which entries get TTS
    if (msg.startsWith("clean_mode:")) {
      _cleanMode = msg.slice(11) === "1";
      console.log(`[ws] Clean mode ${_cleanMode ? "on" : "off (verbose)"}`);
      return;
    }

    // Client-side window preference on reconnect — switch server to client's last-known window.
    // Mirrors tmux:switch: handler — must reset ALL status indicators, not just entries.
    // Client-side window preference — selects which tmux window to watch.
    // This is the PRIMARY activation trigger: no scraping/broadcasting happens until
    // a client sends this. Uses shared activateWindow() for all resets.
    if (msg.startsWith("window_preference:")) {
      let preferred = msg.slice(18).trim();
      if (!preferred) return;
      // Handle bare session names without window index (e.g. "claude-voice" → "claude-voice:0")
      // Client may send bare session name on first load before it knows the window index.
      if (!preferred.includes(":")) {
        // Try to use the saved target if it matches this session
        const saved = loadSettings().tmuxTarget;
        if (saved && saved.startsWith(preferred + ":")) {
          preferred = saved;
          console.log(`[ws] Bare session "${msg.slice(18)}" → using saved target "${preferred}"`);
        } else {
          preferred = preferred + ":0";
          console.log(`[ws] Bare session "${msg.slice(18)}" → defaulting to "${preferred}"`);
        }
      }
      const currentTarget = terminal?.displayTarget ?? terminal?.currentTarget ?? "";
      // If already on this window and window is active, nothing to do
      if (isWindowActive() && (currentTarget === preferred || getWindowKey() === preferred)) {
        console.log(`[ws] Window preference "${preferred}" already matches current target`);
        return;
      }
      activateWindow(preferred, ws);
      return;
    }

    // ElevenLabs API key
    if (msg.startsWith("elevenlabs_key:")) {
      const key = msg.slice(15).trim();
      if (key.length > 0 && key.length < 200 && /^[a-zA-Z0-9_-]+$/.test(key)) {
        saveSettings({ elevenLabsApiKey: key });
        console.log("[ws] ElevenLabs API key saved");
      } else if (key.length === 0) {
        saveSettings({ elevenLabsApiKey: undefined });
        console.log("[ws] ElevenLabs API key cleared");
      } else {
        console.warn("[ws] Rejected invalid ElevenLabs API key format");
      }
      return;
    }

    // BUG-048: Recording state sync across tabs
    if (msg.startsWith("rec_state:")) {
      const state = msg.slice(10).trim();
      if (state === "recording" || state === "idle") {
        for (const c of clients) {
          if (c !== ws && c.readyState === 1) {
            c.send(JSON.stringify({ type: "rec_state", state }));
          }
        }
      }
      return;
    }

    // Voice
    if (msg.startsWith("voice:")) {
      const voice = msg.slice(6).trim();
      const localVoiceName = voice.startsWith("_local:") ? voice.slice(7) : "";
      if (localVoiceName && !/^[a-zA-Z0-9 _\-().]+$/.test(localVoiceName)) {
        console.warn(`[voice] Rejected unsafe local voice name: "${localVoiceName}"`);
        return;
      }
      if (voice && (VALID_VOICES.has(voice) || VALID_XI_VOICES.has(voice) || voice.startsWith("_local:"))) {
        writeFileSync(join(SIGNAL_DIR, "claude-tts-voice"), voice);
        saveSettings({ voice });
        // Stop in-flight TTS and flush queue so old voice doesn't keep playing
        if (ttsCurrentlyPlaying || ttsJobQueue.length > 0) {
          stopClientPlayback2("voice_change");
          console.log(`[voice] Switched to ${voice} — stopped TTS and flushed queue`);
        }
      } else if (voice) {
        console.warn(`[voice] Rejected invalid voice name: "${voice}"`);
      }
      return;
    }

    // Mic device
    if (msg.startsWith("mic:")) {
      const deviceId = msg.slice(4).trim();
      writeFileSync(join(SIGNAL_DIR, "claude-mic-device"), deviceId);
      return;
    }

    // Mute
    if (msg.startsWith("mute:")) {
      const muted = msg.slice(5) === "1";
      writeFileSync(join(SIGNAL_DIR, "claude-mic-mute"), muted ? "1" : "0");
      return;
    }

    // Restart server
    if (msg === "restart") {
      console.log("[restart] Restart requested from UI");
      broadcast({ type: "restarting" });
      setTimeout(() => process.exit(0), 500);
      return;
    }

    // Client-side log relay
    if (msg.startsWith("log:highlight:")) {
      // Client karaoke events: log:highlight:ENTRY_ID:CHUNK_INDEX:WORD_INDEX:TOTAL_WORDS:FLOW_POS:SPAN_COUNT:EVENT
      const parts = msg.slice(14).split(":");
      if (parts.length >= 7) {
        hlog(parseInt(parts[0], 10), parseInt(parts[1], 10), parts[6],
          parseInt(parts[2], 10), parseInt(parts[3], 10),
          parseInt(parts[4], 10), parseInt(parts[5], 10));
      }
      return;
    }
    if (msg.startsWith("log:")) {
      console.log(`[client] ${msg.slice(4)}`);
      return;
    }

    // Resend: re-send a user message as fresh input
    if (msg.startsWith("resend:")) {
      const text = msg.slice(7);
      if (!text) { console.log("[resend] Empty text, ignoring"); return; }
      console.log(`[resend] Resending user message: "${text.slice(0, 60)}"`);
      if ((ws as any)._isTestMode) {
        // Test mode: create entry but do NOT forward to terminal
        console.log(`[resend] Test mode resend (not sent to Claude): "${text.slice(0, 60)}"`);
        const testEntry = addUserEntry(text, false, "text-input-resend");
        if (testEntry.id > 0) (ws as any)._testEntryIds?.add(testEntry.id);
      } else if (streamState === "IDLE" || streamState === "DONE") {
        startTmuxStreaming(text);
        addUserEntry(text, false, "text-input-resend");
        terminal.recordSentInput?.(text);
        terminal.sendText(text);
        queueFillerAudio(text);
      } else {
        // Claude is active — queue
        const queuedEntry = addUserEntry(text, true, "text-input-resend");
        pendingVoiceInput.push({ text, entryId: queuedEntry.id, target: terminal.currentTarget ?? "" });
        console.log(`[resend] Queued (state=${streamState}): ${pendingVoiceInput.length} pending`);
        broadcast({ type: "voice_queue", count: pendingVoiceInput.length });
      }
      return;
    }

    // Replay: replay specific entry by ID, or last spoken speakable entry
    if (msg === "replay" || msg === "replay:all" || msg.startsWith("replay:")) {
      // replay:all — replay every speakable assistant entry since the last user message
      if (msg === "replay:all") {
        // Find index of last user entry
        let lastUserIdx = -1;
        for (let i = conversationEntries.length - 1; i >= 0; i--) {
          if (conversationEntries[i].role === "user") { lastUserIdx = i; break; }
        }
        const toReplay = conversationEntries
          .slice(lastUserIdx + 1)
          .filter(e => e.role === "assistant" && e.speakable && e.text.trim());
        if (toReplay.length > 0) {
          console.log(`[replay:all] Replaying ${toReplay.length} assistant entries`);
          stopClientPlayback2("user_stop");
          broadcast({ type: "voice_status", state: "speaking" });
          for (const e of toReplay) {
            queueTts(e.id, e.text, "replay");
          }
        } else {
          console.log("[replay:all] Nothing to replay");
        }
        return;
      }

      let replayText = "";
      let replayEntryId: number | null = null;
      if (msg.startsWith("replay:")) {
        const idStr = msg.slice(7);
        const entryId = parseInt(idStr, 10);
        const entry = conversationEntries.find(e => e.id === entryId);
        if (entry) {
          replayText = entry.text;
          replayEntryId = entry.id;
        } else {
          // Fallback: treat as literal text
          replayText = idStr;
        }
      } else {
        // Find last spoken speakable assistant entry
        const spoken = conversationEntries.filter(e => e.role === "assistant" && e.speakable && e.spoken);
        if (spoken.length > 0) {
          const last = spoken[spoken.length - 1];
          replayText = last.text;
          replayEntryId = last.id;
        } else {
          replayText = lastSpokenText; // Fallback to old var
        }
      }
      if (replayText) {
        console.log(`[replay] Speaking (${replayText.length} chars): "${replayText.slice(0, 80)}..."`);
        stopClientPlayback2("user_stop");
        broadcast({ type: "voice_status", state: "speaking" });
        queueTts(replayEntryId, replayText, "replay");
      } else {
        console.log("[replay] No text to replay");
      }
      return;
    }

    // List tmux sessions and windows
    if (msg === "tmux:list") {
      const sessions = terminal.listTmuxSessions?.() ?? [];
      ws.send(JSON.stringify({ type: "tmux_sessions", sessions, current: terminal.displayTarget ?? terminal.currentTarget ?? "" }));
      return;
    }

    // Switch to a different tmux session/window
    // Format: tmux:switch:ENCODED_SESSION:WINDOW_INDEX
    // Debounced: rapid A→B→C switches only execute the final one
    // Uses displayTarget for client-facing labels (not pane IDs)
    if (msg.startsWith("tmux:switch:")) {
      const rest = msg.slice("tmux:switch:".length);
      const lastColon = rest.lastIndexOf(":");
      if (lastColon !== -1 && terminal.switchTarget) {
        const encodedSession = rest.slice(0, lastColon);
        const windowIdx = parseInt(rest.slice(lastColon + 1));
        const session = decodeURIComponent(encodedSession);
        // Cancel any pending switch — only the latest wins
        if (_switchDebounceTimer) clearTimeout(_switchDebounceTimer);
        _switchDebounceTimer = setTimeout(() => {
          _switchDebounceTimer = null;
          _executeWindowSwitch(session, windowIdx, ws);
        }, 150);
      }
      return;
    }

    // Text input from terminal panel
    if (msg.startsWith("text:")) {
      const text = msg.slice(5);
      if (text) {
        if ((ws as any)._isTestMode) {
          // Test mode: render user bubble in UI but do NOT forward to terminal
          console.log(`[terminal] Test mode text (not sent to Claude): "${text.slice(0, 60)}"`);
          const testEntry = addUserEntry(text, false, "text-input-test");
          // Track test-created entries so test:clear-entries can remove them
          if (testEntry.id > 0) (ws as any)._testEntryIds?.add(testEntry.id);
        } else if (interactivePromptActive) {
          // Interactive prompt — send keystroke directly
          console.log(`[terminal] Interactive response: "${text}"`);
          terminal.sendText(text);
        } else if (streamState === "IDLE" || streamState === "DONE") {
          // Normal: send immediately
          console.log(`[terminal] Text input: "${text}"`);
          startTmuxStreaming(text);
          addUserEntry(text, false, "text-input");
          terminal.recordSentInput?.(text);
          terminal.sendText(text);
          queueFillerAudio(text);
        } else {
          // Claude is active — queue typed text same as voice
          const queuedEntry = addUserEntry(text, true, "text-input");
          pendingVoiceInput.push({ text, entryId: queuedEntry.id, target: terminal.currentTarget ?? "" });
          const count = pendingVoiceInput.length;
          console.log(`[terminal] Text queued (state=${streamState}): "${text.slice(0, 60)}" — ${count} pending`);
          broadcast({ type: "voice_queue", count });
          const vsState = streamState === "RESPONDING" ? "responding" : "thinking";
          broadcast({ type: "voice_status", state: vsState });
        }
      }
      return;
    }

    // --- Test Mode ---
    // Simulates the full voice pipeline cycle without needing a live Claude session.
    // Exercises: transcription broadcast timing, TTS delivery, multi-paragraph handling.

    // test:cycle:RESPONSE_TEXT — simulate full cycle with canned response
    // Broadcasts user transcript (from prior audio transcription), then simulates
    // thinking → responding → assistant transcript → TTS, exactly like real flow.
    if (msg.startsWith("test:cycle:")) {
      const responseText = msg.slice(11);
      console.log(`[test] Simulating pipeline cycle (${responseText.length} chars)`);
      resetPipelineLog();
      plog("test_cycle_start", `"${responseText.slice(0, 80)}"`);

      // Simulate thinking phase
      broadcast({ type: "voice_status", state: "thinking" });
      plog("test_thinking");

      setTimeout(() => {
        // Simulate responding phase
        broadcast({ type: "voice_status", state: "responding" });
        plog("test_responding");

        setTimeout(() => {
          // Broadcast assistant transcription (final)
          plog("final_transcription_broadcast", `${responseText.length} chars`);
          broadcast({
            type: "transcription",
            role: "assistant",
            text: responseText,
            ts: Date.now(),
          });

          // TTS the response
          plog("final_tts", `"${responseText.slice(0, 100)}" (${responseText.length} chars)`);
          lastSpokenText = responseText;
          queueTts(null, responseText);
        }, 500); // 500ms "response generation"
      }, 300); // 300ms "thinking"

      return;
    }

    // test:tts:TEXT — directly trigger TTS delivery
    if (msg.startsWith("test:tts:")) {
      const text = msg.slice(9);
      console.log(`[test] Direct TTS (${text.length} chars)`);
      resetPipelineLog();
      plog("test_tts_direct", `"${text.slice(0, 80)}"`);
      broadcast({ type: "voice_status", state: "speaking" });
      lastSpokenText = text;
      queueTts(null, text);
      return;
    }

    // test:audio:FILENAME — read WAV from tests/test-audio/, transcribe, return result
    if (msg.startsWith("test:audio:")) {
      const file = msg.slice(11);
      const audioPath = join(__dirname, "tests", "test-audio", file + ".wav");
      try {
        const audio = readFileSync(audioPath);
        console.log(`[test] Audio file: ${file}.wav (${audio.length} bytes)`);
        const text = await transcribeAudio(audio);
        ws.send(JSON.stringify({ type: "test_result", test: "audio", file, text: text || null }));
      } catch (err) {
        ws.send(JSON.stringify({ type: "test_result", test: "audio", file, error: (err as Error).message }));
      }
      return;
    }

    // test:entries:JSON — simulate multi-paragraph assistant response via entry system
    // Input: JSON array of paragraph strings, e.g. ["First paragraph.", "Second paragraph."]
    // Broadcasts: thinking → responding → incremental entry broadcasts → idle
    if (msg.startsWith("test:entries:")) {
      let paragraphs: string[];
      try { paragraphs = JSON.parse(msg.slice(13)); } catch { console.warn("[test] Invalid JSON in test:entries"); return; }
      console.log(`[test] Simulating ${paragraphs.length} assistant entries`);

      broadcast({ type: "voice_status", state: "thinking" });

      setTimeout(() => {
        broadcast({ type: "voice_status", state: "responding" });

        // Add entries progressively with small delays between them
        let i = 0;
        const addNext = () => {
          if (i >= paragraphs.length) {
            broadcast({ type: "entry", entries: conversationEntries, partial: false });
            broadcast({ type: "voice_status", state: "idle" });
            return;
          }
          const entry: ConversationEntry = {
            id: ++entryIdCounter,
            role: "assistant",
            text: paragraphs[i],
            speakable: true,
            spoken: false,
            ts: Date.now(),
            turn: currentTurn,
            sourceTag: "test-entries", // Bug U4: tag for broadcast filter isolation
          };
          pushEntry(entry);
          (ws as any)._testEntryIds?.add(entry.id);
          i++;
          broadcast({ type: "entry", entries: conversationEntries, partial: i < paragraphs.length });
          setTimeout(addNext, 150);
        };
        addNext();
      }, 300);

      return;
    }

    // test:entries-full:JSON — create entries with full per-entry control (role, spoken, speakable)
    // Input: JSON array of { text, role?, spoken?, speakable? } objects
    // Broadcasts: entry list immediately (no TTS, no state transitions)
    if (msg.startsWith("test:entries-full:")) {
      let items: Array<{ text: string; role?: string; spoken?: boolean; speakable?: boolean }>;
      try { items = JSON.parse(msg.slice(18)); } catch { console.warn("[test] Invalid JSON in test:entries-full"); return; }
      console.log(`[test] Creating ${items.length} full entries`);

      for (const item of items) {
        const role = (item.role === "user" ? "user" : "assistant") as "user" | "assistant";
        const entry: ConversationEntry = {
          id: ++entryIdCounter,
          role,
          text: item.text,
          speakable: role === "user" ? false : item.speakable !== false,
          spoken: item.spoken === true,
          ts: Date.now(),
          turn: currentTurn,
          sourceTag: "test-entries-full", // Bug U4: tag for broadcast filter isolation
        };
        pushEntry(entry);
        (ws as any)._testEntryIds?.add(entry.id);
      }
      broadcast({ type: "entry", entries: conversationEntries, partial: false });
      return;
    }

    // test:entries-mixed:JSON — create entries with per-entry spoken/speakable control
    // Input: JSON array of { text, spoken?, speakable? } objects
    // Broadcasts: entry list immediately (no TTS, no state transitions)
    if (msg.startsWith("test:entries-mixed:")) {
      let items: Array<{ text: string; spoken?: boolean; speakable?: boolean }>;
      try { items = JSON.parse(msg.slice(19)); } catch { console.warn("[test] Invalid JSON in test:entries-mixed"); return; }
      console.log(`[test] Creating ${items.length} mixed entries`);

      for (const item of items) {
        const entry: ConversationEntry = {
          id: ++entryIdCounter,
          role: "assistant",
          text: item.text,
          speakable: item.speakable !== false, // default true
          spoken: item.spoken === true,         // default false
          ts: Date.now(),
          turn: currentTurn,
          sourceTag: "test-entries-mixed", // Bug U4: tag for broadcast filter isolation
        };
        pushEntry(entry);
        (ws as any)._testEntryIds?.add(entry.id);
      }
      broadcast({ type: "entry", entries: conversationEntries, partial: false });
      return;
    }

    // test:entries-tts:JSON — simulate multi-paragraph response WITH TTS for each entry
    // Like test:entries but also speaks each entry via queueTts.
    // This exercises the full entryId→tts_play→audio chain per paragraph.
    if (msg.startsWith("test:entries-tts:")) {
      let paragraphs: string[];
      try { paragraphs = JSON.parse(msg.slice(17)); } catch { console.warn("[test] Invalid JSON in test:entries-tts"); return; }
      console.log(`[test] Simulating ${paragraphs.length} entries with TTS`);

      broadcast({ type: "voice_status", state: "thinking" });

      setTimeout(() => {
        broadcast({ type: "voice_status", state: "responding" });

        // Create all entries first
        const newEntries: ConversationEntry[] = [];
        for (const text of paragraphs) {
          const entry: ConversationEntry = {
            id: ++entryIdCounter,
            role: "assistant",
            text,
            speakable: true,
            spoken: false,
            ts: Date.now(),
            turn: currentTurn,
            sourceTag: "test-entries-tts", // Bug U4: tag for broadcast filter isolation
          };
          pushEntry(entry);
          (ws as any)._testEntryIds?.add(entry.id);
          newEntries.push(entry);
        }
        broadcast({ type: "entry", entries: conversationEntries, partial: false });

        // Speak each entry in sequence via TTS queue
        for (const entry of newEntries) {
          queueTts(entry.id, entry.text);
        }
      }, 300);

      return;
    }

    // test:interactive:JSON — simulate Claude presenting numbered choices
    // Input: JSON object { question: "...", options: ["a", "b", "c"] }
    // Broadcasts: assistant entries with question + options, then interactive_prompt active
    if (msg.startsWith("test:interactive:")) {
      let question: string, options: string[];
      try { ({ question, options } = JSON.parse(msg.slice(17))); } catch { console.warn("[test] Invalid JSON in test:interactive"); return; }
      console.log(`[test] Simulating interactive prompt: "${question}" with ${options.length} options`);

      // Build text like Claude would render
      const optionLines = options.map((o: string, idx: number) => `❯ ${idx + 1}. ${o}`).join("\n");
      const fullText = question + "\n" + optionLines;

      // Add as assistant entry
      const entry: ConversationEntry = {
        id: ++entryIdCounter,
        role: "assistant",
        text: fullText,
        speakable: true,
        spoken: false,
        ts: Date.now(),
        turn: currentTurn,
      };
      pushEntry(entry);
      (ws as any)._testEntryIds?.add(entry.id);
      broadcast({ type: "entry", entries: conversationEntries, partial: false });

      // Broadcast interactive prompt
      interactivePromptActive = true;
      broadcast({ type: "interactive_prompt", active: true });

      return;
    }

    // test:client — mark this connection as a test client (skip context/exit messages)
    if (msg === "test:client") {
      (ws as any)._isTestClient = true;
      (ws as any)._testEntryIds = new Set<number>();
      console.log("[test] Client marked as test — skipping context/exit");
      // Yield audio control back to the main browser client
      if (activeAudioClient === ws) {
        const nonTest = Array.from(clients).find(
          (c) => c !== ws && c.readyState === WebSocket.OPEN && !(c as any)._isTestClient
        );
        setAudioClient(nonTest || null, "test-client-yield");
      }
      return;
    }

    // test:clear-entries — remove all entries created by this test client
    if (msg === "test:clear-entries") {
      const ids: Set<number> = (ws as any)._testEntryIds;
      if (ids && ids.size > 0) {
        const before = conversationEntries.length;
        setConversationEntries(conversationEntries.filter(e => !ids.has(e.id)));
        ids.clear();
        console.log(`[test] Cleared ${before - conversationEntries.length} test entries`);
        broadcast({ type: "entry", entries: conversationEntries, partial: false });
      }
      return;
    }

    // test:transcribe — next binary audio will be transcribed but NOT sent to terminal
    if (msg === "test:transcribe") {
      (ws as any)._testTranscribeOnly = true;
      console.log("[test] Next audio will be transcribed without terminal send");
      return;
    }

    // test:broadcast-json:JSON — broadcast arbitrary JSON to all connected clients
    // Used by E2E tests to inject server→client messages (voice_status, services, etc.)
    if (msg.startsWith("test:broadcast-json:")) {
      try {
        const payload = JSON.parse(msg.slice(20));
        broadcast(payload);
        console.log(`[test] broadcast-json: ${JSON.stringify(payload).slice(0, 80)}`);
      } catch {
        console.warn("[test] test:broadcast-json: invalid JSON");
      }
      return;
    }

    // test:reset-entries — clear ALL conversation entries and broadcast empty list
    if (msg === "test:reset-entries") {
      setConversationEntries([]);
      broadcast({ type: "entry", entries: [], partial: false });
      console.log("[test] All entries cleared");
      return;
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    slog("ws", "disconnect", { clients: clients.size });
    _clientLog.push({ ts: Date.now(), event: "disconnect", clientCount: clients.size, isTestMode: !!(ws as any)._isTestMode, note: `clientId=${(ws as any)._clientId}` });
    if (_clientLog.length > RING_CAP) _clientLog.shift();

    // Transfer audio control if the active client disconnected
    if (activeAudioClient === ws) {
      const remaining = Array.from(clients).filter(
        c => c.readyState === WebSocket.OPEN && !(c as any)._isTestClient
      );
      setAudioClient(remaining.length > 0 ? remaining[remaining.length - 1] : null, "client-left");
    }

    // Flush TTS queue when no clients remain — no point generating audio with nobody to play it.
    // Flush TTS queue when no clients remain — no point generating audio with nobody to play it.
    const realClientsRemaining = Array.from(clients).filter(
      c => c.readyState === WebSocket.OPEN && !(c as any)._isTestClient && !(c as any)._isTestMode
    );
    if (realClientsRemaining.length === 0 && (ttsJobQueue.length > 0 || ttsCurrentlyPlaying)) {
      console.log(`[tts2] Last client disconnected — flushing TTS queue (${ttsJobQueue.length} queued, playing=${!!ttsCurrentlyPlaying})`);
      stopClientPlayback2("client_disconnect");
    }

    // Auto-cleanup: remove entries created by this test client
    const testIds: Set<number> | undefined = (ws as any)._testEntryIds;
    if (testIds && testIds.size > 0) {
      const before = conversationEntries.length;
      setConversationEntries(conversationEntries.filter(e => !testIds.has(e.id)));
      console.log(`[test] Auto-cleaned ${before - conversationEntries.length} test entries on disconnect`);
      if (clients.size > 0) {
        broadcast({ type: "entry", entries: conversationEntries, partial: false });
      }
    }

    // Possibly last real client disconnected — debounce exit message.
    // Use 15s debounce to survive reconnect exponential backoff (starts ~1s, doubles to 30s max).
    // Don't check the LEAVING ws for test flags — the real leak happens when a non-test
    // client disconnects as a side effect of test activity. Let the debounce timer make
    // the real decision by checking remaining connected clients at fire time.
    if (terminal.isSessionAlive() && contextSent) {
      if (exitTimer) clearTimeout(exitTimer);
      exitTimer = setTimeout(() => {
        exitTimer = null;
        // Only send if no real (non-test) clients remain and not sent recently
        const realClients = Array.from(clients).filter(
          c => c.readyState === WebSocket.OPEN && !(c as any)._isTestMode && !(c as any)._isTestClient
        );
        if (realClients.length === 0 && Date.now() - exitSentAt > 30000) {
          // Guard: only send exit message to the voice session (claude-voice).
          // If the user switched to a coordinator/agent session (e.g. murmur:4),
          // sending MURMUR_EXIT would leak prose instructions into that session.
          const targetSession = (terminal.displayTarget ?? terminal.currentTarget ?? "").split(":")[0];
          if (targetSession !== "claude-voice") {
            console.log(`[context] Skipping Murmur exit — target "${targetSession}" is not claude-voice`);
          } else {
            terminal.sendText(MURMUR_EXIT);
            contextSent = false; // Allow context resend if server restarts fresh
            exitSentAt = Date.now();
            console.log("[context] Sent Murmur exit message to Claude");
          }
        }
      }, 15000);
    }
  });
}

wss.on("connection", (ws, req) => handleWsConnection(ws, req));

// --- Static Files ---
app.use("/js", express.static(join(__dirname, "public", "js"), {
  setHeaders: (res) => { res.set("Cache-Control", "no-store"); },
}));

// --- HTTP Endpoints ---

app.get("/", (_req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.sendFile(join(__dirname, "index.html"));
});

app.get("/manifest.json", (_req, res) => {
  res.sendFile(join(__dirname, "manifest.json"));
});

// Serve site assets (favicon, icons)
app.get("/favicon.ico", (_req, res) => {
  res.sendFile(join(__dirname, "site", "favicon.ico"));
});
app.get("/icon-180.png", (_req, res) => {
  res.sendFile(join(__dirname, "site", "icon-180.png"));
});
app.get("/icon-256.png", (_req, res) => {
  res.sendFile(join(__dirname, "site", "icon-256.png"));
});
app.get("/icon-512.png", (_req, res) => {
  res.sendFile(join(__dirname, "site", "icon-512.png"));
});
app.get("/favicon-16.png", (_req, res) => {
  res.sendFile(join(__dirname, "site", "favicon-16.png"));
});
// iOS auto-discovers these paths before checking <link> tags
app.get("/apple-touch-icon.png", (_req, res) => {
  res.sendFile(join(__dirname, "site", "icon-180.png"));
});
app.get("/apple-touch-icon-precomposed.png", (_req, res) => {
  res.sendFile(join(__dirname, "site", "icon-180.png"));
});

app.get("/version", (_req, res) => {
  res.json({ version: 75 });
});

app.get("/debug", (_req, res) => {
  res.json({
    wsClients: clients.size,
    streamState,
    ttsPlaying: !!ttsCurrentlyPlaying,
    ttsGeneration,
    ttsQueueLength: ttsJobQueue.length,
    playback: _clientPlayback,
    ttsFetchCount: _ttsFetchLog.length,
    kokoroFetchCount: _kokoroLog.length,
    chunkFlowCount: _chunkFlowLog.length,
    inputCount: _inputLog.length,
    vmState,
  });
});

app.get("/api/state", (_req, res) => {
  const lastEntries = conversationEntries.slice(-3).map(e => ({
    id: e.id, role: e.role, text: e.text.slice(0, 120), speakable: e.speakable, spoken: e.spoken, turn: e.turn, window: e.window,
  }));
  res.json({
    ttsQueueLength: ttsJobQueue.length,
    ttsPlaying: !!ttsCurrentlyPlaying,
    ttsPlayingEntryId: ttsCurrentlyPlaying?.entryId ?? null,
    ttsGeneration,
    streamState,
    entryCount: conversationEntries.length,
    currentWindow: getWindowKey(),
    windowCount: windowEntries.size,
    windows: Array.from(windowEntries.keys()),
    lastEntries,
    pendingVoiceCount: pendingVoiceInput.length,
    pushArchitecture: true,
    contextSent,
    services: serviceStatus,
    cleanMode: _cleanMode,
  });
});

// Debug: view conversation entries — supports ?window= filter
app.get("/debug/entries", (req, res) => {
  const windowFilter = req.query.window as string | undefined;
  if (windowFilter) {
    const entries = windowEntries.get(windowFilter) ?? [];
    res.json({ window: windowFilter, count: entries.length, entries });
  } else {
    res.json({ window: getWindowKey(), count: conversationEntries.length, entries: conversationEntries });
  }
});

app.get("/debug/pipeline", (_req, res) => {
  res.json({ events: pipelineLog });
});

app.get("/debug/log", (_req, res) => {
  res.json(_serverLog);
});

app.get("/debug/ws-log", (_req, res) => {
  res.json(_serverWsLog);
});

app.get("/debug/tts-history", (_req, res) => {
  res.json(_ttsHistory);
});

app.get("/debug/highlight-log", (_req, res) => {
  res.json(_highlightLog);
});

app.get("/debug/generation-log", (_req, res) => {
  res.json({ current: ttsGeneration, log: ttsGenerationLog });
});

app.get("/debug/entry-log", (_req, res) => {
  res.json(_entryLog);
});

app.get("/debug/parse-log", (_req, res) => {
  res.json({
    raw: { snapshot: _parseRawSnapshot, ts: _parseRawSnapshotTs },
    discards: _parseDiscards,
    paragraphs: _parseParagraphs,
  });
});

// Raw pipe-pane output — first hop in the traceability chain:
// /debug/pipe-input (raw terminal text) → /debug/parse-log (parser decisions)
// → /debug/entry-log (entries created) → /debug/tts-history (audio played)
app.get("/debug/pipe-input", (_req, res) => {
  res.json({
    count: _pipeInputLog.length,
    cap: PIPE_INPUT_LOG_CAP,
    entries: _pipeInputLog,
  });
});

app.get("/debug/kokoro-log", (_req, res) => {
  res.json(_kokoroLog);
});

// ── Monitor Dashboard Endpoints ──

app.get("/debug/stt-log", (_req, res) => {
  res.json({ count: _whisperLog.length, cap: RING_CAP, entries: _whisperLog });
});

app.get("/debug/entry-mutations", (_req, res) => {
  res.json({ count: _entryMutationLog.length, cap: RING_CAP, entries: _entryMutationLog });
});

app.get("/debug/dedup-log", (_req, res) => {
  res.json({ count: _dedupLog.length, cap: RING_CAP, entries: _dedupLog });
});

app.get("/debug/window-log", (_req, res) => {
  res.json({ count: _windowLog.length, cap: RING_CAP, entries: _windowLog });
});

app.get("/debug/client-log", (_req, res) => {
  res.json({ count: _clientLog.length, cap: RING_CAP, totalConnections: _clientConnectCount, entries: _clientLog });
});

app.get("/debug/queue-history", (_req, res) => {
  res.json({ count: _queueHistory.length, cap: RING_CAP, entries: _queueHistory });
});

app.get("/debug/render-log", (_req, res) => {
  res.json({ count: _renderLog.length, cap: RING_CAP, entries: _renderLog });
});

// ── Cross-reference endpoints for Monitor ──

/** /debug/trace/recent?count=N — bulk lifecycle traces for last N entries
 *  MUST be registered BEFORE /debug/trace/:entryId (Express matches :entryId wildcard first) */
app.get("/debug/trace/recent", (req, res) => {
  const count = Math.min(safeInt(req.query.count as string, 20), 50);
  const recentEntries = conversationEntries.slice(-count);
  const traces = recentEntries.map(entry => {
    const entryId = entry.id;
    const mutations = _entryMutationLog.filter(m => m.entryId === entryId);
    const dedupChecks = _dedupLog.filter(d => d.matchedEntryId === entryId);
    const ttsEntries = _ttsHistory.filter(t => t.entryId === entryId);
    const ttsFetches = _ttsFetchLog.filter(t => t.entryId === entryId);
    const highlights = _highlightLog.filter(h => h.entryId === entryId);
    const queueEvents = _queueHistory.filter(q => q.entryId === entryId);
    const renders = _renderLog.filter(r => r.entryId === entryId);
    const creation = _entryLog.find(e => e.id === entryId);

    const anomalies: string[] = [];
    if (entry.speakable && !entry.spoken && ttsEntries.length === 0) anomalies.push("no TTS");
    if (mutations.filter(m => m.field === "text").length > 3) anomalies.push("excessive text mutations");

    return {
      entryId,
      role: entry.role,
      text: entry.text.slice(0, 120),
      speakable: entry.speakable,
      spoken: entry.spoken,
      ts: entry.ts,
      creation_ts: creation?.ts ?? null,
      mutation_count: mutations.length,
      tts_count: ttsEntries.length,
      fetch_count: ttsFetches.length,
      highlight_count: highlights.length,
      render_count: renders.length,
      dedup_matches: dedupChecks.length,
      queue_events: queueEvents.length,
      anomalies,
    };
  });
  res.json({ count: traces.length, requested: count, traces });
});

/** /debug/trace/:entryId — full lifecycle trace across ALL ring buffers */
app.get("/debug/trace/:entryId", (req, res) => {
  const entryId = parseInt(req.params.entryId, 10);
  if (isNaN(entryId)) { res.status(400).json({ error: "Invalid entryId" }); return; }

  const entry = conversationEntries.find(e => e.id === entryId);
  const anomalies: string[] = [];

  // Pipe input: find chunks that led to this entry (by timestamp proximity)
  const entryTs = entry?.ts ?? 0;
  const pipeChunks = entryTs ? _pipeInputLog.filter(p => Math.abs(p.ts - entryTs) < 5000) : [];

  // Parse decisions around entry creation time
  const parseKept = _parseParagraphs.filter(p => entryTs && Math.abs(p.ts - entryTs) < 3000);
  const parseDiscarded = _parseDiscards.filter(p => entryTs && Math.abs(p.ts - entryTs) < 3000);

  // Entry creation log
  const creation = _entryLog.find(e => e.id === entryId);

  // Mutations
  const mutations = _entryMutationLog.filter(m => m.entryId === entryId);

  // Dedup checks that matched this entry
  const dedupChecks = _dedupLog.filter(d => d.matchedEntryId === entryId);

  // TTS history for this entry
  const ttsEntries = _ttsHistory.filter(t => t.entryId === entryId);

  // TTS fetch log
  const ttsFetches = _ttsFetchLog.filter(t => t.entryId === entryId);

  // Highlight events
  const highlights = _highlightLog.filter(h => h.entryId === entryId);

  // Queue events
  const queueEvents = _queueHistory.filter(q => q.entryId === entryId);

  // WS broadcasts around entry time (±2s)
  const wsBroadcasts = entryTs ? _serverWsLog.filter(w => w.dir === "out" && w.type === "entry" && Math.abs(w.ts - entryTs) < 2000) : [];

  // Render timing
  const renders = _renderLog.filter(r => r.entryId === entryId);

  // Anomaly detection
  if (entry && !entry.spoken && ttsEntries.length === 0 && entry.speakable) {
    anomalies.push("speakable entry never queued for TTS");
  }
  if (dedupChecks.length > 0) {
    anomalies.push(`text was rejected ${dedupChecks.length} time(s) as duplicate of this entry`);
  }
  if (mutations.filter(m => m.field === "text").length > 3) {
    anomalies.push(`text mutated ${mutations.filter(m => m.field === "text").length} times (excessive updates)`);
  }

  res.json({
    entryId,
    entry: entry ? { id: entry.id, role: entry.role, text: entry.text.slice(0, 200), speakable: entry.speakable, spoken: entry.spoken, ts: entry.ts, turn: entry.turn, window: entry.window, sourceTag: entry.sourceTag } : null,
    lifecycle: {
      pipe_input: pipeChunks.length > 0 ? { count: pipeChunks.length, first_ts: pipeChunks[0]?.ts, last_ts: pipeChunks[pipeChunks.length - 1]?.ts } : null,
      parse: { kept: parseKept.length, discarded: parseDiscarded.length, kept_entries: parseKept },
      creation: creation ?? null,
      mutations,
      dedup_checks: dedupChecks,
      tts: { queued: ttsEntries, fetches: ttsFetches, highlights, queue_events: queueEvents },
      ws_broadcast: { count: wsBroadcasts.length, entries: wsBroadcasts },
      render: renders,
    },
    anomalies,
  });
});

/** /debug/health — quick summary with anomaly detection for Monitor polling */
app.get("/debug/health", (_req, res) => {
  const now = Date.now();
  const window60s = now - 60000;

  // Entry stats
  const recentMutations = _entryMutationLog.filter(m => m.ts > window60s);
  const recentDedups = _dedupLog.filter(d => d.ts > window60s);

  // TTS stats
  const recentTtsFetches = _ttsFetchLog.filter(t => t.ts > window60s);
  const ttsFailed = recentTtsFetches.filter(t => t.status === "failed");
  const ttsAvgLatency = recentTtsFetches.length > 0
    ? Math.round(recentTtsFetches.reduce((s, t) => s + t.durationMs, 0) / recentTtsFetches.length) : 0;

  // WS stats
  const recentWs = _serverWsLog.filter(w => w.ts > window60s);
  const wsErrors = recentWs.filter(w => w.type === "error" || w.type === "rate-limited");

  // STT stats
  const recentStt = _whisperLog.filter(w => w.ts > window60s);
  const sttFailed = recentStt.filter(w => w.status === "failed");
  const sttAvgLatency = recentStt.length > 0
    ? Math.round(recentStt.reduce((s, w) => s + w.durationMs, 0) / recentStt.length) : 0;

  // Parser stats
  const recentParseKept = _parseParagraphs.filter(p => p.ts > window60s);
  const recentParseDiscarded = _parseDiscards.filter(p => p.ts > window60s);

  // Pipe stats
  const recentPipe = _pipeInputLog.filter(p => p.ts > window60s);
  const pipeBytes = recentPipe.reduce((s, p) => s + p.len, 0);

  // Window stats
  const recentWindowSwitches = _windowLog.filter(w => w.ts > window60s);

  // Anomaly detection
  const anomalies: string[] = [];
  // Speakable entries without TTS
  const unspoken = conversationEntries.filter(e => e.speakable && !e.spoken && (now - e.ts) > 10000);
  if (unspoken.length > 0) anomalies.push(`${unspoken.length} speakable entries without TTS (oldest: ${Math.round((now - Math.min(...unspoken.map(e => e.ts))) / 1000)}s ago)`);
  // High dedup rate
  if (recentDedups.length > 10) anomalies.push(`${recentDedups.length} dedup rejections in last 60s`);
  // TTS failures
  if (ttsFailed.length > 0) anomalies.push(`${ttsFailed.length} TTS fetch failures in last 60s`);
  // STT failures
  if (sttFailed.length > 0) anomalies.push(`${sttFailed.length} STT failures in last 60s`);
  // Excessive mutations
  const textMutations = recentMutations.filter(m => m.field === "text");
  if (textMutations.length > 20) anomalies.push(`${textMutations.length} text mutations in last 60s (possible parse churn)`);

  res.json({
    ts: now,
    entries: { count: conversationEntries.length, dupes_blocked: recentDedups.length, mutations: recentMutations.length, stale_blocked: recentDedups.filter(d => d.tier === 1).length },
    tts: { queue_depth: ttsJobQueue.length, jobs_active: ttsCurrentlyPlaying ? 1 : 0, jobs_failed: ttsFailed.length, avg_latency_ms: ttsAvgLatency },
    ws: { clients: clients.size, messages_in_last_60s: recentWs.length, errors: wsErrors.length },
    stt: { calls_last_60s: recentStt.length, avg_latency_ms: sttAvgLatency, failures: sttFailed.length },
    parser: { lines_in_last_60s: recentPipe.length, kept: recentParseKept.length, discarded: recentParseDiscarded.length },
    pipe: { bytes_last_60s: pipeBytes, lines_last_60s: recentPipe.length },
    windows: { current: currentWindowKey, switches_last_60s: recentWindowSwitches.length },
    stream: { state: streamState, lastActivity: lastStreamActivity },
    anomalies,
  });
});


// Diagnostic: test loadScrollbackEntries against a specific target without modifying state
// Usage: /debug/scrollback-parse?target=murmur:3
app.get("/debug/scrollback-parse", (req, res) => {
  const target = req.query.target as string | undefined;
  if (!target) {
    res.json({ error: "Missing ?target=session:window" });
    return;
  }
  try {
    const lastColon = target.lastIndexOf(":");
    if (lastColon === -1) { res.json({ error: "Target must be session:window" }); return; }
    const session = target.slice(0, lastColon);
    const windowIdx = parseInt(target.slice(lastColon + 1));
    if (isNaN(windowIdx)) { res.json({ error: "Invalid window index" }); return; }

    // Capture scrollback from the target without modifying terminal state
    const scrollback = execFileSync("tmux", [
      "capture-pane", "-t", `${session}:${windowIdx}`, "-p", "-S", "-2000"
    ], { encoding: "utf-8", timeout: 3000 });

    const lines = scrollback.split("\n");
    const turnStarts: { lineIdx: number; input: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trimEnd();
      const m = trimmed.match(/^❯\s+(.+)$/);
      if (m && m[1].trim()) {
        turnStarts.push({ lineIdx: i, input: m[1].trim() });
      }
    }

    const recentTurns = turnStarts.slice(-10);
    const turnResults: Array<{
      input: string;
      responseLineCount: number;
      filteredLineCount: number;
      assistantTextLength: number;
      assistantTextPreview: string;
      skippedAsContext: boolean;
    }> = [];

    for (let t = 0; t < recentTurns.length; t++) {
      const start = recentTurns[t];
      const endLineIdx = t + 1 < recentTurns.length ? recentTurns[t + 1].lineIdx : lines.length;
      const skippedAsContext = MURMUR_CONTEXT_FILTER.test(start.input);

      const responseLines: string[] = [];
      let filteredCount = 0;
      for (let i = start.lineIdx + 1; i < endLineIdx; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed) { responseLines.push(""); continue; }
        if (/^[─━═]{3,}/.test(trimmed)) { filteredCount++; continue; }
        if (/^❯/.test(trimmed)) { filteredCount++; continue; }
        if (isSpinnerLine(trimmed)) { filteredCount++; continue; }
        if (MURMUR_CONTEXT_FILTER.test(trimmed)) { filteredCount++; continue; }
        if (/^<teammate-message|^<task-notification|^<system-reminder/.test(trimmed)) { filteredCount++; continue; }
        if (/^<\/teammate-message|^<\/task-notification|^<\/system-reminder/.test(trimmed)) { filteredCount++; continue; }
        if (/^\{"type":"idle_notification"|^\{"type":"shutdown|^\{"type":"teammate_terminated"/.test(trimmed)) { filteredCount++; continue; }
        if (/bypass\s+permissions/i.test(trimmed)) { filteredCount++; continue; }
        if (/context left until/i.test(trimmed)) { filteredCount++; continue; }
        if (/auto-compact/i.test(trimmed)) { filteredCount++; continue; }
        if (/^(Tokens?:|Session:|esc to|ctrl\+)/i.test(trimmed)) { filteredCount++; continue; }
        if (/^Background command/i.test(trimmed)) { filteredCount++; continue; }
        if (/^\d+\s+background\s+task/i.test(trimmed)) { filteredCount++; continue; }
        if (/^[✻✶✢✽]/.test(trimmed)) { filteredCount++; continue; }
        responseLines.push(lines[i]);
      }

      const text = reflowText(responseLines.join("\n")).trim();
      turnResults.push({
        input: start.input.slice(0, 120),
        responseLineCount: endLineIdx - start.lineIdx - 1,
        filteredLineCount: filteredCount,
        assistantTextLength: text.length,
        assistantTextPreview: text.slice(0, 200),
        skippedAsContext: skippedAsContext,
      });
    }

    res.json({
      target,
      totalLines: lines.length,
      turnsFound: turnStarts.length,
      recentTurnsAnalyzed: recentTurns.length,
      turnResults,
      sampleLines: lines.slice(0, 10).map((l, i) => `[${i}] ${l.slice(0, 120)}`),
    });
  } catch (err) {
    res.json({ error: (err as Error).message });
  }
});

app.get("/debug/chunk-flow", (_req, res) => {
  res.json(_chunkFlowLog);
});

app.get("/debug/playback-state", (_req, res) => {
  res.json(_clientPlayback);
});

app.get("/debug/tts-jobs", (_req, res) => {
  const jobs = ttsJobQueue.map(j => ({
    jobId: j.jobId,
    entryId: j.entryId,
    state: j.state,
    mode: j.mode,
    generation: j.generation,
    currentChunkIndex: j.currentChunkIndex,
    chunkCount: j.chunks.length,
    chunks: j.chunks.map(c => ({ index: c.chunkIndex, state: c.state, wordCount: c.wordCount, hasAudio: !!c.audioBuf })),
    fullText: j.fullText.slice(0, 80),
    speakableText: j.speakableText.slice(0, 80),
  }));
  const playing = ttsCurrentlyPlaying ? {
    jobId: ttsCurrentlyPlaying.jobId,
    entryId: ttsCurrentlyPlaying.entryId,
    state: ttsCurrentlyPlaying.state,
    currentChunkIndex: ttsCurrentlyPlaying.currentChunkIndex,
    chunkCount: ttsCurrentlyPlaying.chunks.length,
  } : null;
  res.json({ playing, queued: jobs, queueLength: ttsJobQueue.length, generation: ttsGeneration });
});

app.get("/debug/input-log", (_req, res) => {
  res.json(_inputLog);
});

app.get("/debug/whisper-log", (_req, res) => {
  res.json(_whisperLog);
});

app.get("/debug/mic-persistence", (_req, res) => {
  // Analyze gaps in audio chunk arrivals
  const chunks = _micPersistenceLog.filter(e => e.type === "audio_chunk");
  const visEvents = _micPersistenceLog.filter(e => e.type === "visibility");
  const gaps: Array<{ afterTs: number; gapMs: number }> = [];
  for (let i = 1; i < chunks.length; i++) {
    const gap = chunks[i].ts - chunks[i - 1].ts;
    if (gap > 2000) gaps.push({ afterTs: chunks[i - 1].ts, gapMs: gap });
  }
  res.json({
    active: _micPersistenceActive,
    totalEntries: _micPersistenceLog.length,
    audioChunks: chunks.length,
    visibilityChanges: visEvents,
    largeGaps: gaps,
    log: _micPersistenceLog,
  });
});

app.get("/debug/state", (_req, res) => {
  res.json({
    currentWindowKey,
    displayTarget: terminal?.displayTarget ?? null,
    currentTarget: terminal?.currentTarget ?? null,
    pinnedPaneId: terminal?.pinnedPaneId ?? null,
    streamState,
    isWindowActive: isWindowActive(),
    pushArchitecture: true,
    lastTerminalTextLength: lastTerminalText.length,
    preInputSnapshotLength: preInputSnapshot.length,
    conversationEntryCount: conversationEntries.length,
    windowEntriesKeys: Object.fromEntries(
      Array.from(windowEntries.entries()).map(([k, v]) => [k, v.length])
    ),
    cooldown: {
      lastStreamEndTime,
      cooldownRemaining: Math.max(0, PASSIVE_COOLDOWN_MS - (Date.now() - lastStreamEndTime)),
      cooldownThinking: _cooldownThinking,
    },
    clients: clients.size,
    cleanMode: _cleanMode,
  });
});

app.get("/debug/log/stream", (_req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("data: {\"type\":\"connected\"}\n\n");
  _sseClients.add(res);
  res.on("error", () => _sseClients.delete(res));
  _req.on("close", () => { _sseClients.delete(res); res.end(); });
});

app.get("/info", (_req, res) => {
  const cli = {
    pid: null as number | null,
    cwd: null as string | null,
    version: null as string | null,
    tmuxSession: terminal.currentTarget ?? "claude-voice",
    tmuxAlive: terminal.isSessionAlive(),
  };
  try {
    const ps = execSync(
      "ps aux | grep -E '[c]laude' | grep -v 'murmur' | head -1",
      { encoding: "utf-8" }
    ).trim();
    if (ps) {
      const parts = ps.split(/\s+/);
      const pid = parseInt(parts[1]);
      if (pid) {
        cli.pid = pid;
        try {
          cli.cwd =
            execSync(
              `lsof -p ${parseInt(String(pid), 10)} 2>/dev/null | grep cwd | awk '{print $NF}'`,
              { encoding: "utf-8" }
            ).trim() || null;
        } catch {}
        try {
          cli.version =
            execSync("claude --version 2>/dev/null | head -1", {
              encoding: "utf-8",
            }).trim() || null;
        } catch {}
      }
    }
  } catch {}
  res.json(cli);
});

// --- Start ---

// Initialize terminal manager (async — tmux on macOS, node-pty on Windows)
terminal = await createTerminalManager();
terminal.createSession();
// Restore last used tmux session/window
const savedTarget = loadSettings().tmuxTarget;
if (savedTarget && terminal.switchTarget) {
  const lastColon = savedTarget.lastIndexOf(":");
  if (lastColon !== -1) {
    const session = savedTarget.slice(0, lastColon);
    const windowIdx = parseInt(savedTarget.slice(lastColon + 1));
    if (!isNaN(windowIdx)) {
      try { terminal.switchTarget(session, windowIdx); console.log(`[startup] Restored tmux target: ${savedTarget}`); } catch {}
    }
  }
}
// Per-window conversation tracking — DON'T load entries or scrape until a client
// sends window_preference.
currentWindowKey = "_unset";
setConversationEntries([]);
console.log(`[startup] Window key: _unset (waiting for client window_preference)`);
initSignalFiles();

// Clean up orphaned TTS temp files from previous/crashed sessions
try {
  const tmpFiles = readdirSync(TEMP_DIR).filter(f => f.startsWith("murmur-tts-") && f.endsWith(".mp3"));
  if (tmpFiles.length > 0) {
    for (const f of tmpFiles) {
      try { unlinkSync(join(TEMP_DIR, f)); } catch {}
    }
    console.log(`Cleaned up ${tmpFiles.length} orphaned TTS temp file(s)`);
  }
} catch {}

// Check services on startup
checkAllServices().then(status => {
  serviceStatus = status;
  lastServiceCheckAt = Date.now();
  broadcast({ type: "services", ...status });
});

// Re-check services periodically (every 30s)
setInterval(async () => {
  const prev = { ...serviceStatus };
  serviceStatus.whisper = await checkService("Whisper STT", WHISPER_URL);
  serviceStatus.kokoro = await checkService("Kokoro TTS", KOKORO_URL);
  serviceStatus.piper = checkPiper();
  lastServiceCheckAt = Date.now();
  if (prev.whisper !== serviceStatus.whisper || prev.kokoro !== serviceStatus.kokoro || prev.piper !== serviceStatus.piper) {
    broadcast({ type: "services", ...serviceStatus });
  }
  // BUG-050: When Kokoro comes back online, retry queued TTS jobs
  if (!prev.kokoro && serviceStatus.kokoro && ttsJobQueue.length > 0) {
    console.log(`[tts2] Kokoro back online — draining ${ttsJobQueue.length} queued TTS jobs`);
    drainAudioBuffer();
  }
}, 30000);

// Broadcast tmux pane content with ANSI colors for the terminal panel (every 500ms)
// BUG-045: Normalize trailing whitespace before comparison to avoid false-positive diffs
let lastTerminalText = "";
let _lastTerminalHash = "";
let _lastWindowSwitchTs = 0; // Track last switch for force-broadcast window
function _normalizeTerminalText(text: string): string {
  // Strip trailing whitespace per line and trailing newlines — cursor position / padding diffs
  return text.replace(/[ \t]+$/gm, "").trimEnd();
}
setInterval(() => {
  if (clients.size === 0) return;
  if (!isWindowActive()) return; // No window selected — don't broadcast stale pane content
  try {
    const text = captureTerminalPane();
    // After a window switch, force-broadcast for 3s even if text matches (prevents empty-string deadlock)
    const forceWindow = Date.now() - _lastWindowSwitchTs < 3000;
    const normalized = _normalizeTerminalText(text);
    if ((text && normalized !== _lastTerminalHash) || (forceWindow && text)) {
      _lastTerminalHash = normalized;
      lastTerminalText = text;
      broadcast({ type: "terminal", text });
    }
  } catch {}
}, 500);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Murmur: http://localhost:${PORT}`);
  console.log(`  Terminal backend: ${terminal.constructor.name}`);
  console.log(`  Watching: ${VM_EVENTS_DIR}`);
  console.log(`  Watching: ${VM_EXCHANGES_DIR}`);
  // Push-based output handler replaces the passive watcher.
  // Registers once — the always-on pipe detects all terminal activity.
  startPassiveWatcher(); // Now just registers the onOutput callback
  console.log(`  Push-based output handler: registered`);
  setInterval(sweepStaleTtsJobs, 10000); // Periodic sweep for stuck TTS jobs (10s)
});

// HTTPS server for remote access (Tailscale) — needed for mic permission on non-localhost
const certPath = join(__dirname, "tailscale-cert.pem");
const keyPath = join(__dirname, "tailscale-key.pem");
if (existsSync(certPath) && existsSync(keyPath)) {
  const httpsServer = createHttpsServer(
    { cert: readFileSync(certPath), key: readFileSync(keyPath) },
    app
  );
  const wssSecure = new WebSocketServer({ server: httpsServer });
  wssSecure.on("connection", (ws, req) => handleWsConnection(ws, req));
  httpsServer.listen(HTTPS_PORT, "0.0.0.0", () => {
    if (TS_HOSTNAME) {
      console.log(`  HTTPS: https://${TS_HOSTNAME}:${HTTPS_PORT}`);
      console.log(`  Open on iPhone: https://${TS_HOSTNAME}:${HTTPS_PORT}`);
    } else {
      console.log(`  HTTPS: https://localhost:${HTTPS_PORT}`);
    }
  });
} else {
  console.log("  No Tailscale certs found — HTTPS disabled");
  console.log("  To enable: tailscale cert --cert-file tailscale-cert.pem --key-file tailscale-key.pem <your-hostname>");
}

// Graceful shutdown
function cleanup() {
  console.log("Shutting down...");
  // Flush pending windowEntries persistence synchronously before exit
  if (_persistTimer) {
    clearTimeout(_persistTimer);
    _persistTimer = null;
    try {
      const obj: Record<string, ConversationEntry[]> = {};
      // Filter test entries on shutdown too (matches persistWindowEntries behavior)
      for (const [key, entries] of windowEntries) obj[key] = entries.filter(e => !isTestEntry(e));
      const tmpFile = WINDOW_ENTRIES_FILE + ".tmp";
      writeFileSync(tmpFile, JSON.stringify(obj));
      renameSync(tmpFile, WINDOW_ENTRIES_FILE);
      console.log("[shutdown] Flushed window entries to disk");
    } catch (err) {
      console.error("[shutdown] Failed to flush window entries:", (err as Error).message);
    }
  }
  stopTts();
  stopTmuxStreaming();
  watcher.close();
  wss.close();
  server.close();
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
process.on("unhandledRejection", (reason) => {
  console.error("[fatal] Unhandled rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[fatal] Uncaught exception:", err);
});
