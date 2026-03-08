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
]);

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

async function checkAllServices(): Promise<{ whisper: boolean; kokoro: boolean }> {
  console.log("Checking services...");
  const [whisper, kokoro] = await Promise.all([
    checkService("Whisper STT", WHISPER_URL),
    checkService("Kokoro TTS", KOKORO_URL),
  ]);
  if (!whisper) console.warn("  → Transcription will fail until Whisper is started");
  if (!kokoro) console.warn("  → TTS will fail until Kokoro is started");
  return { whisper, kokoro };
}

let serviceStatus = { whisper: false, kokoro: false };
let lastServiceCheckAt = 0;

// --- Primary Audio Client ---
// Only the active audio client receives TTS audio (binary or local_tts).
// Last connected real client auto-claims. Client can send "claim:audio" to take control.
let activeAudioClient: WebSocket | null = null;

function setAudioClient(ws: WebSocket | null, reason: string) {
  if (activeAudioClient === ws) return;
  activeAudioClient = ws;
  console.log(`[audio] Audio control → ${ws ? "new client" : "none"} (${reason})`);
  // Notify all clients of their new audio control state
  for (const client of Array.from(clients)) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(JSON.stringify({ type: "audio_control", hasControl: client === ws })); } catch {}
    }
  }
}

// Send audio (binary or JSON) only to the active audio client.
// Falls back to first available client if no active client is set (single-client mode).
function sendToAudioClient(data: Buffer | object) {
  let target = activeAudioClient && activeAudioClient.readyState === WebSocket.OPEN
    ? activeAudioClient : null;
  if (!target) {
    // Fallback: pick first open non-test client (handles first-connect race)
    for (const c of Array.from(clients)) {
      if (c.readyState === WebSocket.OPEN && !(c as any)._isTestClient) { target = c; break; }
    }
  }
  if (!target) return;
  try {
    if (Buffer.isBuffer(data)) target.send(data);
    else target.send(JSON.stringify(data));
  } catch { clients.delete(target); if (activeAudioClient === target) activeAudioClient = null; }
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
}

const _serverWsLog: WsLogEntry[] = [];

function wslog(dir: "in" | "out", type: string, size?: number) {
  _serverWsLog.push({ ts: Date.now(), dir, type, size });
  if (_serverWsLog.length > 200) _serverWsLog.shift();
}

// --- Debug Ring Buffers ---
// Specialized ring buffers for automated monitoring of TTS, highlight, and entry bugs.

interface TtsHistoryEntry {
  ts: number;
  entryId: number | null;
  textSnippet: string;
  generation: number;
  source: string; // "queueTts" | "sentence" | "final" | "replay"
}
const _ttsHistory: TtsHistoryEntry[] = [];
function ttslog(entryId: number | null, text: string, generation: number, source: string) {
  _ttsHistory.push({ ts: Date.now(), entryId, textSnippet: text.slice(0, 120), generation, source });
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

// VoiceMode log paths
const VM_LOGS = join(HOME, ".voicemode", "logs");
const VM_EVENTS_DIR = join(VM_LOGS, "events");
const VM_EXCHANGES_DIR = join(VM_LOGS, "conversations");

const app = express();
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
  writeFileSync(tmpFile, JSON.stringify(merged, null, 2));
  renameSync(tmpFile, SETTINGS_FILE);
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
  stopClientPlayback2();
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
  execSync(
    `ffmpeg -y -i "${preFile}" -i "${mainFile}" ` +
      `-filter_complex "[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono[a0];` +
      `[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono[a1];` +
      `[a0][a1]concat=n=2:v=0:a=1[out]" ` +
      `-map "[out]" -c:a libopus "${outFile}"`,
    { stdio: "ignore", timeout: 10000 }
  );
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

async function transcribeAudio(audioData: Buffer): Promise<string> {
  if (!serviceStatus.whisper) {
    serviceStatus.whisper = await checkService("Whisper STT", WHISPER_URL);
    if (!serviceStatus.whisper) {
      console.error("Whisper is not running — cannot transcribe");
      broadcast({ type: "voice_status", state: "error", message: "Whisper STT not running" });
      return "";
    }
  }

  const audioExt = detectAudioExt(audioData);

  try {
    plog("transcribe_start");
    const sttStart = Date.now();
    slog("stt", "start", { bytes: audioData.length, ext: audioExt });

    const json = await whisperFetch(audioData, audioExt);
    const noSpeechProb = json.segments?.[0]?.no_speech_prob ?? 0;
    if (noSpeechProb >= 0.6) {
      console.log(`[stt] Discarded — no_speech_prob=${noSpeechProb.toFixed(2)} (likely hallucination)`);
      return "";
    }
    const text = json.text?.trim() || "";
    plog("transcribe_done", text ? `"${text.slice(0, 100)}"` : "(empty)");
    slog("stt", "done", { text: text.slice(0, 100), durationMs: Date.now() - sttStart });
    return text;
  } catch (err) {
    console.warn("[stt] First attempt failed, retrying:", (err as Error).message);
    try {
      const retryJson = await whisperFetch(audioData, audioExt);
      const retryNoSpeech = retryJson.segments?.[0]?.no_speech_prob ?? 0;
      if (retryNoSpeech >= 0.6) {
        console.log(`[stt] Retry discarded — no_speech_prob=${retryNoSpeech.toFixed(2)} (likely hallucination)`);
        return "";
      }
      const text = retryJson.text?.trim() || "";
      console.log(`[stt] Retry succeeded: "${text.slice(0, 60)}"`);
      return text;
    } catch (retryErr) {
      console.error("Whisper transcription failed (after retry):", (retryErr as Error).message);
      plog("transcribe_error", (retryErr as Error).message);
      slog("stt", "error", { error: (retryErr as Error).message });
      serviceStatus.whisper = false;
      broadcast({ type: "voice_status", state: "error", message: "Whisper STT failed" });
      return "";
    }
  }
}

// --- TTS Text Cleaning ---

let ttsGeneration = 0; // Bumped ONLY by stopClientPlayback2 on user interruption

// Clean raw text for TTS — strips code, URLs, markdown, etc.
function cleanTtsText(text: string): string {
  return text
    // M12: Strip ANSI escape sequences
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
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
  mode: "kokoro" | "local";
  generation: number;      // ttsGeneration when job was created
}

// --- New TTS state (v2) ---
let ttsJobQueue: TtsJob[] = [];                   // Ordered queue of jobs to play
let ttsCurrentlyPlaying: TtsJob | null = null;    // Job whose audio is on the client right now
let ttsJobIdCounter = 0;                          // Monotonic job ID
let ttsPlaybackTimeout2: ReturnType<typeof setTimeout> | null = null; // Fallback timeout for client tts_done
let _activeFetchCount = 0;                        // In-flight Kokoro fetch count (for TTS_MAX_PARALLEL)

const TTS_MAX_PARALLEL = 10;
const TTS_CHUNK_MAX_CHARS = 200;
const TTS_MAX_QUEUE = 50;

/** Split text into chunks at word boundaries, each ≤ maxChars. */
function splitIntoChunks(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }
    // Find last space within maxChars window
    let splitAt = remaining.lastIndexOf(" ", maxChars);
    if (splitAt <= 0) splitAt = maxChars; // No space found — hard split
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

/** Fetch audio from Kokoro for a single chunk. Respects TTS_MAX_PARALLEL. */
async function fetchKokoroAudio(job: TtsJob, chunkIndex: number): Promise<void> {
  const chunk = job.chunks[chunkIndex];
  if (!chunk || chunk.state !== "pending") return;

  // Wait for a parallel slot
  while (_activeFetchCount >= TTS_MAX_PARALLEL) {
    await new Promise(r => setTimeout(r, 50));
  }

  // Stale check — job may have been cancelled while waiting for slot
  if (job.generation !== ttsGeneration) {
    chunk.state = "failed";
    return;
  }

  chunk.state = "fetching";
  chunk.abortController = new AbortController();
  _activeFetchCount++;

  const settings = loadSettings();
  const voice = settings.voice || "af_heart";
  const kokoroVoice = voice.startsWith("_local") ? "af_heart" : voice;
  const speed = settings.speed || 1;

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
    if (job.generation !== ttsGeneration) {
      chunk.state = "failed";
      return;
    }

    chunk.audioBuf = buf;
    chunk.state = "ready";
    plog("tts_chunk_ready", `job=${job.jobId} chunk=${chunkIndex} ${buf.length}B`);

    // If all chunks ready, mark job ready
    if (job.chunks.every(c => c.state === "ready")) {
      job.state = "ready";
    }
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      chunk.state = "failed";
      return;
    }
    console.error(`[tts2] Kokoro fetch failed (job=${job.jobId} chunk=${chunkIndex}):`, (err as Error).message);
    chunk.state = "failed";
    // If any chunk fails, mark the whole job failed
    job.state = "failed";
  } finally {
    _activeFetchCount--;
    chunk.abortController = null;
  }
}

/**
 * Queue text for TTS playback, labeled with an entry ID.
 */
function queueTts(entryId: number | null, text: string): void {
  // Clean text for TTS
  const speakableText = cleanTtsText(text);

  if (!speakableText) {
    // Mark entry spoken even though text was empty — it was processed
    if (entryId != null) {
      const entry = conversationEntries.find(e => e.id === entryId);
      if (entry && !entry.spoken) {
        entry.spoken = true;
        broadcast({ type: "entry", entries: conversationEntries, partial: false });
      }
    }
    return;
  }

  // Dedup: skip if this entryId already has a pending/playing job
  if (entryId != null) {
    const existing = ttsJobQueue.find(
      j => j.entryId === entryId && j.state !== "done" && j.state !== "failed"
    );
    if (existing) {
      console.log(`[tts2] Skipping duplicate queue for entry ${entryId} (job=${existing.jobId})`);
      return;
    }
    if (ttsCurrentlyPlaying?.entryId === entryId) {
      console.log(`[tts2] Skipping — entry ${entryId} is currently playing`);
      return;
    }
  }

  // Enforce max queue size
  if (ttsJobQueue.length >= TTS_MAX_QUEUE) {
    console.warn(`[tts2] Queue full (${TTS_MAX_QUEUE}), dropping`);
    return;
  }

  // Determine mode: local voice or Kokoro
  const settings = loadSettings();
  const voice = settings.voice || "af_heart";
  const isLocal = voice.startsWith("_local");

  // For local voices, check if audio client has the voice
  let useLocal = false;
  if (isLocal) {
    const localName = voice.slice(7);
    const audioClient = activeAudioClient && activeAudioClient.readyState === WebSocket.OPEN
      ? activeAudioClient
      : Array.from(clients).find((c) => c.readyState === WebSocket.OPEN && !(c as any)._isTestClient) || null;
    useLocal = localName === "default" ||
      (audioClient != null && (audioClient as any)._localVoices?.has(localName));
  }
  const mode: "kokoro" | "local" = useLocal ? "local" : "kokoro";

  // Split into chunks
  const chunkTexts = splitIntoChunks(speakableText, TTS_CHUNK_MAX_CHARS);
  const chunks: TtsChunk[] = chunkTexts.map((t, i) => ({
    chunkIndex: i,
    text: t,
    wordCount: t.trim().split(/\s+/).length,
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
  };

  ttsJobQueue.push(job);
  ttslog(entryId, text, ttsGeneration, "queueTts");
  plog("tts2_queued", `job=${job.jobId} entry=${entryId} mode=${mode} chunks=${chunks.length} (${speakableText.length} chars)`);
  console.log(`[tts2] Queued job=${job.jobId} entry=${entryId} mode=${mode} chunks=${chunks.length} queue=${ttsJobQueue.length}`);

  // Fire parallel Kokoro fetches (local jobs skip this — already "ready")
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
            if (entry && !entry.spoken) entry.spoken = true;
          }
          drainAudioBuffer();
          return;
        }
        // Kokoro came back up — fire fetches
        for (const chunk of chunks) {
          fetchKokoroAudio(job, chunk.chunkIndex).then(() => drainAudioBuffer()).catch(err => {
            console.error(`[tts2] drainAudioBuffer error after fetch: ${(err as Error).message}`);
          });
        }
      }).catch(err => {
        console.error(`[tts2] checkService error: ${(err as Error).message}`);
        job.state = "failed";
        drainAudioBuffer();
      });
    } else {
      for (const chunk of chunks) {
        fetchKokoroAudio(job, chunk.chunkIndex).then(() => drainAudioBuffer()).catch(err => {
          console.error(`[tts2] drainAudioBuffer error after fetch: ${(err as Error).message}`);
        });
      }
    }
  }

  // Try to drain immediately (local jobs are already ready)
  drainAudioBuffer();
}

/**
 * Send the next ready job's audio to the client.
 * Called after each chunk fetch completes and after handleTtsDone.
 */
function drainAudioBuffer(): void {
  // Already playing — wait for client tts_done
  if (ttsCurrentlyPlaying) return;

  // Evict completed/failed jobs from the front of the queue
  while (ttsJobQueue.length > 0 && (ttsJobQueue[0].state === "done" || ttsJobQueue[0].state === "failed")) {
    ttsJobQueue.shift();
  }

  if (ttsJobQueue.length === 0) {
    // Nothing left — broadcast idle if stream isn't active
    broadcastIdleIfSafe();
    return;
  }

  // Find first job that's ready to play (all chunks fetched)
  const job = ttsJobQueue[0];
  if (job.state !== "ready") return; // Still fetching — will be called again when chunks complete

  // Stale generation check
  if (job.generation !== ttsGeneration) {
    job.state = "failed";
    drainAudioBuffer(); // Recurse to skip this job
    return;
  }

  // Mark playing
  job.state = "playing";
  ttsCurrentlyPlaying = job;

  console.log(`[tts2] Playing job=${job.jobId} entry=${job.entryId} mode=${job.mode} chunks=${job.chunks.length}`);
  plog("tts2_play", `job=${job.jobId} entry=${job.entryId} ${job.speakableText.slice(0, 80)}`);

  if (job.mode === "local") {
    // Local TTS: send text to client for Web Speech API
    sendToAudioClient({
      type: "tts_play",
      entryId: job.entryId,
      fullText: job.fullText,
      speakableText: job.speakableText,
      chunkCount: 1,
      chunkWordCounts: [job.speakableText.trim().split(/\s+/).length],
      localTts: true,
    });
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
    // Kokoro: send tts_play metadata, then all binary chunks
    const chunkWordCounts = job.chunks.map(c => c.wordCount);
    sendToAudioClient({
      type: "tts_play",
      entryId: job.entryId,
      fullText: job.fullText,
      speakableText: job.speakableText,
      chunkCount: job.chunks.length,
      chunkWordCounts,
    });

    // Send binary chunks sequentially
    let totalBytes = 0;
    for (const chunk of job.chunks) {
      if (chunk.audioBuf) {
        sendToAudioClient(chunk.audioBuf);
        totalBytes += chunk.audioBuf.length;
      }
    }

    broadcast({ type: "voice_status", state: "speaking" });
    slog("tts", "sent", { bytes: totalBytes, entry: job.entryId, chunks: job.chunks.length });
    console.log(`[tts2] Sent ${totalBytes} bytes (${job.chunks.length} chunks) for entry=${job.entryId}`);

    // Safety timeout — estimate from total audio size (~12KB/s for Kokoro MP3)
    const estimatedMs = Math.max(5000, (totalBytes / 12000) * 1000 + 2000);
    ttsPlaybackTimeout2 = setTimeout(() => {
      if (ttsCurrentlyPlaying === job) {
        console.warn(`[tts2] Playback timeout (${(estimatedMs / 1000).toFixed(1)}s) — assuming done`);
        handleTtsDone2(job.entryId);
      }
    }, estimatedMs);
  }

  // Free chunk buffers after sending (no longer needed server-side)
  for (const chunk of job.chunks) {
    chunk.audioBuf = null;
  }
}

/**
 * Called when client finishes playing all audio for an entry.
 * Marks the job done, marks conversation entry spoken, drains next.
 */
function handleTtsDone2(entryId: number | null): void {
  plog("tts2_done", `entry=${entryId}`);
  if (ttsPlaybackTimeout2) { clearTimeout(ttsPlaybackTimeout2); ttsPlaybackTimeout2 = null; }

  // Find the matching job — prefer currently-playing, fall back to queue search
  let job = ttsCurrentlyPlaying;
  if (!job || job.entryId !== entryId) {
    job = ttsJobQueue.find(j => j.entryId === entryId && j.state === "playing") ?? null;
  }

  if (job) {
    job.state = "done";
    console.log(`[tts2] Done job=${job.jobId} entry=${entryId}`);
  } else {
    console.log(`[tts2] handleTtsDone2 — no matching job for entry=${entryId} (stale?)`);
  }

  ttsCurrentlyPlaying = null;

  // Mark conversation entry as spoken
  if (entryId != null) {
    const entry = conversationEntries.find(e => e.id === entryId);
    if (entry && !entry.spoken) {
      entry.spoken = true;
      console.log(`[tts2] Marked entry ${entryId} as spoken`);
      broadcast({ type: "entry", entries: conversationEntries, partial: false });
    }
  }

  // Drain next job
  drainAudioBuffer();
}

/**
 * Stop all TTS playback — called on user interruption (stop button, new input).
 * This is the ONLY place ttsGeneration is bumped.
 */
function stopClientPlayback2(): void {
  ttsGeneration++;
  console.log(`[tts2] stopClientPlayback2 — generation now ${ttsGeneration}`);

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
}

// --- Tmux Streaming State Machine ---
// Uses `tmux pipe-pane` to stream output in real-time instead of polling snapshots.
// Detects Claude's response, extracts text, speaks it via TTS.

type StreamState = "IDLE" | "WAITING" | "THINKING" | "RESPONDING" | "FINALIZING" | "DONE";

let streamState: StreamState = "IDLE";

// Broadcast idle only when stream is not active (prevents mic button glow flicker)
function broadcastIdleIfSafe() {
  if (streamState === "WAITING" || streamState === "THINKING" || streamState === "RESPONDING" || streamState === "FINALIZING") {
    const voiceState = streamState === "RESPONDING" || streamState === "FINALIZING" ? "responding" : "thinking";
    broadcast({ type: "voice_status", state: voiceState });
  } else {
    broadcast({ type: "voice_status", state: "idle" });
  }
}
let streamWatcher: ReturnType<typeof setInterval> | null = null;
let streamTimeout: ReturnType<typeof setTimeout> | null = null;
let contentCheckTimer: ReturnType<typeof setTimeout> | null = null;
let promptCheckInterval: ReturnType<typeof setInterval> | null = null; // Independent prompt-ready checker
let streamFileOffset = 0;
let lastStreamActivity = 0;
let lastBroadcastText = "";
let doneCheckTimer: ReturnType<typeof setTimeout> | null = null;
let reEngageWatcher: ReturnType<typeof setInterval> | null = null;
const STREAM_FILE = join(TEMP_DIR, `claude-voice-stream-${process.pid}.raw`);
const DONE_QUIET_MS = 600; // 600ms quiet + prompt visible = done
const CONTENT_CHECK_MS = 200; // check pane content at most every 200ms
const STREAM_TIMEOUT_MS = 300000; // 5 minutes max
let preInputSnapshot: string = "";
let pendingVoiceInput: Array<{ text: string; entryId: number; target: string }> = []; // Queued voice while Claude is active
let _voiceQueueDraining = false; // Drain lock — prevents concurrent drains

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
  queued?: boolean; // true = pending while Claude is active, not yet sent
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
  // Use time-based window (30s) instead of turn-based — turn counter can jump during
  // concurrent activity, causing the dedup to miss duplicates across turn boundaries.
  const normalized = text.trim().toLowerCase().replace(/[\s]+/g, " ");
  const normalizedNoSpaces = normalized.replace(/\s/g, "");
  const dedupeWindowMs = 30000;
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
  console.log(`[DEDUP-TRACE] CREATING NEW entry from="${_source}" text="${text.slice(0, 60)}"`);

  const entry: ConversationEntry = {
    id: ++entryIdCounter,
    role: "user",
    text,
    speakable: false,
    spoken: false,
    ts: Date.now(),
    turn: currentTurn,
    queued,
    ...(inputId ? { inputId } : {}),
  };
  conversationEntries.push(entry);
  elog(entry.id, "user", _source, text);
  broadcast({ type: "entry", entries: conversationEntries, partial: false });
  return entry;
}

// Unified extraction: returns tagged paragraphs (speakable vs non-speakable)
function extractStructuredOutput(preSnapshot: string, postSnapshot: string, userInput: string): ExtractedParagraph[] {
  const lines = getLinesAfterInput(postSnapshot, preSnapshot, userInput);
  const result: ExtractedParagraph[] = [];
  let currentLines: string[] = [];
  let currentSpeakable = true;
  let inToolBlock = false;
  let foundContent = false;
  let inAgentBlock = false; // true while inside <teammate-message>, <task-notification>, <system-reminder> blocks

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

    // Skip blank lines before content
    if (!foundContent && !trimmed) continue;

    // ── Shared chrome filters (from both extractRawOutput + extractSpeakableText) ──
    if (/^[─━═]{3,}/.test(trimmed)) continue;
    if (/^❯/.test(trimmed)) continue;
    if (/bypass\s+permissions/i.test(trimmed)) continue;
    if (/^⏵/.test(trimmed)) continue;
    if (isSpinnerLine(trimmed)) continue;
    if (/context left until/i.test(trimmed)) continue;
    if (/auto-compact/i.test(trimmed)) continue;
    // Filter leaked system context lines (wrapped tmux continuation lines)
    if (MURMUR_CONTEXT_FILTER.test(trimmed)) {
      if (/prose mode/i.test(trimmed)) console.log(`[PROSE-LEAK-TRACE] extractStructuredOutput FILTERED: "${trimmed.slice(0, 80)}"`);
      continue;
    }
    // Filter Claude Code team/agent messages — stateful block filter
    // Skips ALL lines between opening and closing tags, not just the tags themselves
    if (/^<teammate-message|^<task-notification|^<system-reminder/.test(trimmed)) { inAgentBlock = true; continue; }
    if (/^<\/teammate-message|^<\/task-notification|^<\/system-reminder/.test(trimmed)) { inAgentBlock = false; continue; }
    if (inAgentBlock) continue;
    if (/^\{"type":"idle_notification"|^\{"type":"shutdown|^\{"type":"teammate_terminated"/.test(trimmed)) continue;
    // Claude Code TUI chrome — status bar, menus, navigation hints, permission prompts
    if (/expand\s+permiss/i.test(trimmed)) continue;
    if (/^[↓↑←→▶▷▸▹►▼▽▾▿◀◁◂◃◄]\s*(to\b|select|navigate|more|back|next|prev)/i.test(trimmed)) continue;
    if (/^(yes|no|allow|deny|always allow|don't allow)\s*$/i.test(trimmed)) continue;
    // Lines that are mostly Unicode box-drawing / arrow / UI decoration (not prose)
    if (/^[│┃┆┇┊┋╎╏║┌┐└┘├┤┬┴┼╔╗╚╝╠╣╦╩╬╭╮╯╰─━═╌╍╴╵╶╷↑↓←→↖↗↘↙⇐⇒⇑⇓▲▼◀▶►◄△▽◁▷▸▹◂◃☰☱☲☳⬆⬇⬅➡\s]+$/.test(trimmed)) continue;
    // Claude Code menu/status fragments — short lines with navigation chrome
    if (/^\d+\s+(team|tasks|plan|tools|model|mode|mcp|memory|permissions)\b/i.test(trimmed) && trimmed.length < 50) continue;
    if (/^(team|tasks|plan|tools|model|mode)\s*$/i.test(trimmed)) continue;
    // Session feedback prompts
    if (/^(bad|poor|fine|good|great|dismiss)\s*$/i.test(trimmed) && trimmed.length < 20) continue;
    // Claude Code ink TUI status indicators (garbled tmux capture of redrawn regions)
    if (/@(code|ma)\b/.test(trimmed)) continue;
    if (/→\s*·/.test(trimmed)) continue;
    // Garbled TUI text detector: multiple 3+ space runs between short fragments = partial frame capture
    if ((trimmed.match(/\s{3,}/g) || []).length >= 2 && trimmed.length < 120) continue;
    // High non-alpha ratio: >50% non-alphanumeric+space on short lines = UI chrome, not prose
    if (trimmed.length > 0 && trimmed.length < 100) {
      const alphaCount = (trimmed.match(/[a-zA-Z0-9]/g) || []).length;
      if (alphaCount / trimmed.length < 0.4) continue;
    }
    // Lines containing multiple TUI keywords mashed together (garbled ink redraws)
    { const tuiKws = ["expand", "bypass", "permiss", "interrupt", "tasks", "team", "@code", "@ma", "ions"]; const hits = tuiKws.filter(k => trimmed.toLowerCase().includes(k)); if (hits.length >= 2) continue; }

    // ── Non-speakable filters (from extractSpeakableText) ──
    // These lines are kept for display (verbose mode) but marked non-speakable
    const isNonSpeakable =
      // Timing summaries
      (/^[^\w\d\s]\s+\S+.*\d+[sm]/.test(trimmed) && trimmed.length < 60) ||
      // Ctrl hints
      /^(ctrl|⌃|esc to|press)/i.test(trimmed) ||
      /\bctrl\+[a-z]\b/i.test(trimmed) ||
      // Mode indicators (plan mode, bypass permissions)
      /^⏸\s+plan mode/i.test(trimmed) ||
      /⏵⏵\s+bypass/i.test(trimmed) ||
      /shift\+tab to cycle/i.test(trimmed) ||
      // Tree-style agent output (├─, └─, │, ⎿)
      /^[├└│⎿]/.test(trimmed) ||
      // Agent completion summaries
      /^\d+\s+Explore\s+agents?\s+finished/i.test(trimmed) ||
      /Explore\s+.*finished.*ctrl/i.test(trimmed) ||
      // Tool summaries
      /^Read \d+ files?/i.test(trimmed) ||
      /^Searched for \d+/i.test(trimmed) ||
      /^Wrote \d+/i.test(trimmed) ||
      /^Edited \d+/i.test(trimmed) ||
      (/^Ran /i.test(trimmed) && trimmed.length < 60) ||
      /Interrupted/.test(trimmed) ||
      /Running…/.test(trimmed) ||
      // Todo items
      /^[◻◼☐☑✓✗●○■□▪▫]\s/.test(trimmed) ||
      // Expand hints
      /ctrl\+o/i.test(trimmed) ||
      /^\+\d+ lines/.test(trimmed) ||
      /^… \+\d+/.test(trimmed) ||
      // File paths
      (/^\s*(\/[\w.~/-]+){2,}/.test(trimmed) && trimmed.length < 100) ||
      // Numbered choice menus (e.g. "1: Bad  2: Fine  3: Good  0: Dismiss")
      /^\d+:\s+\w+.*\d+:\s+\w+/.test(trimmed) ||
      // Claude Code TUI fragments that slip through skip filters (partial lines, wrapped)
      /permission/i.test(trimmed) && /allow|deny|grant|expand/i.test(trimmed) ||
      // Arrow-heavy navigation hints
      /[↓↑←→]{2,}/.test(trimmed) ||
      // Status bar fragments (e.g. "Opus  Auto  >" or "compact  12% context")
      (/\b(opus|sonnet|haiku|auto|compact|context)\b/i.test(trimmed) && trimmed.length < 40);

    // ── Tool block tracking ──
    if (/^⏺\s+\w+\(/.test(trimmed) || /^⏺\s+\w+$/.test(trimmed)) {
      // Tool call start — flush any prose, start non-speakable block
      if (currentLines.length > 0) flushParagraph();
      inToolBlock = true;
      currentSpeakable = false;
      currentLines.push(line.replace(/^\s*⏺\s*/, "").replace(/\s*⏺\s*$/, ""));
      foundContent = true;
      continue;
    }
    if (/^⎿/.test(trimmed)) {
      // Tool output line
      if (currentLines.length > 0 && currentSpeakable) flushParagraph();
      inToolBlock = true;
      currentSpeakable = false;
      currentLines.push(line);
      foundContent = true;
      continue;
    }
    if (/^(Bash|Read|Edit|Write|Grep|Glob|Agent|WebFetch|WebSearch|NotebookEdit)\s*\(/.test(trimmed)) {
      if (currentLines.length > 0 && currentSpeakable) flushParagraph();
      inToolBlock = true;
      currentSpeakable = false;
      currentLines.push(line);
      foundContent = true;
      continue;
    }

    // ⏺ followed by prose = new prose paragraph, exit tool block
    if (/^⏺\s+/.test(trimmed) && !/^⏺\s+\w+[\s(]?$/.test(trimmed)) {
      if (currentLines.length > 0) flushParagraph();
      inToolBlock = false;
      currentSpeakable = true;
    }

    // Indented lines in tool block = still tool output
    if (inToolBlock) {
      if (/^\s{2,}/.test(line) || /^[^a-zA-Z⏺]/.test(trimmed)) {
        currentLines.push(line);
        foundContent = true;
        continue;
      }
      // Non-indented prose = tool block ended
      if (currentLines.length > 0) flushParagraph();
      inToolBlock = false;
      currentSpeakable = true;
    }

    // Strip ⏺ markers
    let clean = line.replace(/^\s*⏺\s*/, "").replace(/\s*⏺\s*$/, "");
    const cleanTrimmed = clean.trim();

    if (!cleanTrimmed) {
      // Empty line = paragraph break
      if (foundContent && currentLines.length > 0) {
        flushParagraph();
      }
      continue;
    }

    foundContent = true;

    // Mark non-speakable lines
    if (isNonSpeakable) {
      if (currentLines.length > 0 && currentSpeakable) flushParagraph();
      currentSpeakable = false;
      currentLines.push(clean);
      continue;
    }

    // Normal prose line
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
let sawActivity = false;
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

    // User entry
    entries.push({
      id: ++entryIdCounter,
      role: "user",
      text: start.input,
      speakable: false,
      spoken: true,
      ts: Date.now() - (totalTurns - t) * 300000,
      turn: turnNum,
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
      responseLines.push(lines[i]);
    }

    const text = reflowText(responseLines.join("\n")).trim();
    if (text) {
      entries.push({
        id: ++entryIdCounter,
        role: "assistant",
        text,
        speakable: true,
        spoken: true, // silent — user replays on demand
        ts: Date.now() - (totalTurns - t) * 300000 + 1000,
        turn: turnNum,
      });
    }
  }

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

// Broadcast current response content to app via entry model.
// Diffs extractStructuredOutput() against conversationEntries, creates/updates entries,
// broadcasts { type: "entry" }, and triggers TTS for completed speakable entries.
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

  // Diff paragraphs against current turn's assistant entries only
  const assistantEntries = conversationEntries.filter(e => e.role === "assistant" && e.turn === currentTurn);

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];
    if (i < assistantEntries.length) {
      // Existing entry — update text if changed
      const existing = assistantEntries[i];
      if (existing.text !== para.text) {
        // During streaming, if paragraphs shrunk (content scrolled off tmux top),
        // positional matching shifts — don't overwrite entries with unrelated text.
        // Only update if the new text is a growth/continuation of the existing text
        // (shares at least the first 20 chars), or if we're not mid-stream.
        const minLen = Math.min(20, existing.text.length, para.text.length);
        const isGrowth = minLen === 0 ||
          para.text.slice(0, minLen) === existing.text.slice(0, minLen);
        if (streamState !== "RESPONDING" || isGrowth || paragraphs.length >= assistantEntries.length) {
          existing.text = para.text;
          existing.speakable = para.speakable;
        }
      }
    } else {
      // New paragraph — create entry (but skip if identical text already exists in ANY turn,
      // including scrollback entries from loadScrollbackEntries which have negative turns)
      const isDup = conversationEntries.some(e => e.role === "assistant" && e.text === para.text);
      if (!isDup) {
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
        conversationEntries.push(entry);
        elog(entry.id, "assistant", "broadcastCurrentOutput", para.text);
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
  if (paragraphs.length < assistantEntries.length && streamState !== "RESPONDING") {
    const staleEntries = assistantEntries.slice(paragraphs.length);
    const staleIds = new Set(staleEntries.filter(e => !e.spoken).map(e => e.id));
    if (staleIds.size > 0) {
      conversationEntries = conversationEntries.filter(e => !staleIds.has(e.id));
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
    if (entry.speakable && !entry.spoken) {
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

  // Sentence-level TTS for the last (still-growing) entry.
  // Speak each complete sentence as it arrives rather than waiting for the full entry.
  // A sentence boundary is: [.!?] followed by whitespace + uppercase, or [.!?] + end of text.
  const lastEntry = currentAssistant[currentAssistant.length - 1];
  if (lastEntry && lastEntry.speakable && !lastEntry.spoken) {
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
          freshLast.spoken = true;
          console.log(`[stream] Entry tail TTS (id=${freshLast.id}, tail=${tail.length} chars): "${tail.slice(0, 80)}"`);
          plog("entry_tts_tail", `id=${freshLast.id} "${tail.slice(0, 80)}" (${tail.length} chars)`);
          queueTts(freshLast.id, tail);
        } else {
          freshLast.spoken = true; // All sentences already spoken mid-stream
        }
      }
    }, ENTRY_TTS_DELAY_MS);
  }
}

// Called when new pipe-pane bytes arrive — schedules a capture-pane content check.
// The pipe data is used purely as an activity signal; actual content detection
// uses captureTmuxPane() for clean, reliable output.
function onStreamActivity() {
  lastStreamActivity = Date.now();
  sawActivity = true;

  // Cancel any pending done-check — new output means not done yet
  cancelDoneCheck();

  // Schedule a content check (throttled to every CONTENT_CHECK_MS)
  if (!contentCheckTimer) {
    contentCheckTimer = setTimeout(() => {
      contentCheckTimer = null;
      checkPaneState();
    }, CONTENT_CHECK_MS);
  }
}

// Check the tmux pane for state transitions and content updates.
function checkPaneState() {
  if (streamState === "IDLE" || streamState === "DONE") return;

  const pane = captureTmuxPane();
  if (!pane) return;

  // Auto-accept interactive prompts (plan approval, permission dialogs)
  if (detectInteractivePrompt(pane)) return;

  const elapsed = Date.now() - pollStartTime;
  const spinner = hasSpinnerChars(pane);
  const response = hasResponseMarkers(pane);
  const prompt = hasPromptReady(pane);

  // State transitions
  if (streamState === "WAITING") {
    if (spinner) {
      slog("stream", "state", { from: "WAITING", to: "THINKING", elapsedMs: elapsed });
      streamState = "THINKING";
      console.log(`[stream] → THINKING (${(elapsed/1000).toFixed(1)}s)`);
      broadcast({ type: "voice_status", state: "thinking" });
    }
    if (response) {
      slog("stream", "state", { from: "WAITING", to: "RESPONDING", elapsedMs: elapsed });
      streamState = "RESPONDING";
      console.log(`[stream] → RESPONDING (${(elapsed/1000).toFixed(1)}s)`);
      broadcast({ type: "voice_status", state: "responding" });
    }
  } else if (streamState === "THINKING") {
    if (response) {
      slog("stream", "state", { from: "THINKING", to: "RESPONDING", elapsedMs: elapsed });
      streamState = "RESPONDING";
      console.log(`[stream] → RESPONDING (${(elapsed/1000).toFixed(1)}s)`);
      broadcast({ type: "voice_status", state: "responding" });
    }
  }

  // Broadcast content when we have response markers
  if (streamState === "RESPONDING" || response) {
    broadcastCurrentOutput();
  }

  // Schedule done check when prompt appears without spinner and we've seen activity
  if (prompt && !spinner && sawActivity) {
    scheduleDoneCheck();
  }
}

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
  // Reset sentence cursor for new turn (after stopClientPlayback drains stale TTS)
  // Start a new conversation turn — keep old entries for history
  currentTurn++;
  // Cap at ~200 entries to prevent unbounded memory growth (trim oldest turns)
  if (conversationEntries.length > 200) {
    const oldestTurnToKeep = conversationEntries[conversationEntries.length - 100].turn;
    conversationEntries = conversationEntries.filter(e => e.turn >= oldestTurnToKeep);
    // Clean up entryTtsCursor for trimmed entries to prevent memory leak
    const liveIds = new Set(conversationEntries.map(e => e.id));
    entryTtsCursor.forEach((_, id) => { if (!liveIds.has(id)) entryTtsCursor.delete(id); });
  }
  if (entryTtsTimer) { clearTimeout(entryTtsTimer); entryTtsTimer = null; }
  streamFileOffset = 0;
  stopClientPlayback2(); // Stop any current TTS before new input
  entryTtsCursor.clear(); // Reset sentence cursor AFTER TTS stop to avoid re-speaking tail

  // Take snapshot BEFORE terminal.sendText is called — captures the clean prompt state
  preInputSnapshot = captureTmuxPane();
  console.log(`[stream] Pre-snapshot: ${(preInputSnapshot.match(/^❯/gm) || []).length} prompts`);

  // Truncate stream file and set up pipe streaming
  try { writeFileSync(STREAM_FILE, ""); } catch {}
  terminal.startPipeStream(STREAM_FILE);

  streamState = "WAITING";
  broadcast({ type: "voice_status", state: "thinking" });

  // 50ms file watcher — detects new pipe output as activity signal
  streamWatcher = setInterval(() => {
    try {
      const stat = statSync(STREAM_FILE);
      if (stat.size > streamFileOffset) {
        streamFileOffset = stat.size;
        onStreamActivity();
      } else {
        // No new data — if quiet long enough after activity, schedule done check
        const quietMs = Date.now() - lastStreamActivity;
        if (quietMs >= DONE_QUIET_MS && sawActivity && streamState !== "WAITING" && !doneCheckTimer) {
          scheduleDoneCheck();
        }
      }
    } catch {}
  }, 50);

  // Independent checker — runs every 1s to:
  // 1. Catch completion when pipe activity keeps canceling the done-check timer
  // 2. Trigger incremental TTS for text that appeared between tool calls
  promptCheckInterval = setInterval(() => {
    if (streamState !== "RESPONDING" && streamState !== "THINKING") return;
    if (!sawActivity) return;
    const pane = captureTmuxPane();
    if (hasPromptReady(pane) && !hasSpinnerChars(pane)) {
      console.log("[stream] Prompt-ready detected by independent checker");
      handleStreamDone();
    } else if (streamState === "RESPONDING") {
      // Not done yet — but broadcast content and trigger incremental TTS
      broadcastCurrentOutput();
    }
  }, 1000);

  // Overall timeout
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

  console.log(`[stream] Started pipe-pane → ${STREAM_FILE}`);
}

function handleStreamDone() {
  streamState = "FINALIZING";
  const elapsed = Date.now() - pollStartTime;
  slog("stream", "state", { from: "RESPONDING", to: "FINALIZING", elapsedMs: elapsed });
  stopTmuxStreaming();
  plog("stream_done", `${(elapsed / 1000).toFixed(1)}s`);

  console.log(`[stream] Done after ${(elapsed / 1000).toFixed(1)}s`);

  // System context response — suppress current turn entries and TTS, keep old turns
  if (_isSystemContext) {
    _isSystemContext = false;
    conversationEntries = conversationEntries.filter(e => e.turn !== currentTurn);
    broadcast({ type: "entry", entries: conversationEntries, partial: false });
    broadcast({ type: "voice_status", state: "idle" });
    broadcastPipelineTrace();
    console.log("[stream] System context response suppressed from UI");
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
      // Skip if identical text already exists in ANY turn (cross-turn dedup with scrollback)
      const isDup = conversationEntries.some(e => e.role === "assistant" && e.text === para.text);
      if (!isDup) {
        conversationEntries.push({
          id: ++entryIdCounter,
          role: "assistant",
          text: para.text,
          speakable: para.speakable,
          spoken: false,
          ts: Date.now(),
          turn: currentTurn,
          ...(_currentInputId ? { parentInputId: _currentInputId } : {}),
        });
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
    if (entry.role === "assistant" && entry.turn === currentTurn && entry.speakable && !entry.spoken) {
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

  // Re-engagement: watch for Claude starting new work (tool calls, follow-ups)
  startReEngageWatcher();
}

function startReEngageWatcher() {
  if (reEngageWatcher) { clearInterval(reEngageWatcher); reEngageWatcher = null; }
  const savedSnapshot = preInputSnapshot;
  const savedInput = lastUserInput;
  let checks = 0;
  reEngageWatcher = setInterval(() => {
    checks++;
    if (checks > 20) { // 10 seconds (20 * 500ms)
      clearInterval(reEngageWatcher!);
      reEngageWatcher = null;
      return;
    }
    const pane = captureTmuxPane();
    if (!pane) return;
    if (hasSpinnerChars(pane)) {
      console.log(`[stream] Re-engaging — spinner detected after done (check #${checks})`);
      clearInterval(reEngageWatcher!);
      reEngageWatcher = null;
      // Re-start streaming with same context so incremental TTS continues
      reEngageStreaming(savedSnapshot, savedInput);
    }
  }, 500);
}

function reEngageStreaming(savedSnapshot: string, savedInput: string) {
  if (streamState !== "IDLE" && streamState !== "DONE") return;

  preInputSnapshot = savedSnapshot;
  lastUserInput = savedInput;
  pollStartTime = Date.now();
  lastStreamActivity = Date.now();
  sawActivity = true; // We know there's activity (spinner)
  lastBroadcastText = "";
  // Don't reset conversationEntries — we want to continue from where we left off for entry-based TTS
  streamFileOffset = 0;

  try { writeFileSync(STREAM_FILE, ""); } catch {}
  terminal.startPipeStream(STREAM_FILE);

  streamState = "THINKING";
  broadcast({ type: "voice_status", state: "thinking" });

  // Same watchers as startTmuxStreaming
  streamWatcher = setInterval(() => {
    try {
      const stat = statSync(STREAM_FILE);
      if (stat.size > streamFileOffset) {
        streamFileOffset = stat.size;
        onStreamActivity();
      } else {
        const quietMs = Date.now() - lastStreamActivity;
        if (quietMs >= DONE_QUIET_MS && sawActivity && streamState !== "WAITING" && !doneCheckTimer) {
          scheduleDoneCheck();
        }
      }
    } catch {}
  }, 50);

  promptCheckInterval = setInterval(() => {
    if (streamState !== "RESPONDING" && streamState !== "THINKING") return;
    if (!sawActivity) return;
    const pane = captureTmuxPane();
    if (hasPromptReady(pane) && !hasSpinnerChars(pane)) {
      console.log("[stream] Prompt-ready detected by re-engage checker");
      handleStreamDone();
    } else if (streamState === "RESPONDING") {
      broadcastCurrentOutput();
    }
  }, 1000);

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

  console.log("[stream] Re-engaged streaming for continuation");
}

function stopTmuxStreaming() {
  terminal.stopPipeStream();

  if (streamWatcher) {
    clearInterval(streamWatcher);
    streamWatcher = null;
  }
  if (streamTimeout) {
    clearTimeout(streamTimeout);
    streamTimeout = null;
  }
  if (contentCheckTimer) {
    clearTimeout(contentCheckTimer);
    contentCheckTimer = null;
  }
  cancelDoneCheck();
  if (entryTtsTimer) { clearTimeout(entryTtsTimer); entryTtsTimer = null; }
  if (promptCheckInterval) { clearInterval(promptCheckInterval); promptCheckInterval = null; }
  if (reEngageWatcher) { clearInterval(reEngageWatcher); reEngageWatcher = null; }
  streamState = "IDLE";
  lastStreamEndTime = Date.now();

  // Clean up stream file
  try { unlinkSync(STREAM_FILE); } catch {}

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

// --- Passive Pane Watcher ---
// Detects when user types directly into the CLI (not through Murmur).
// Polls tmux pane every 2s while IDLE. If spinner detected, starts streaming.
let passiveWatcher: ReturnType<typeof setInterval> | null = null;
let lastPassiveSnapshot: string = "";
let _cooldownThinking = false; // Track if we sent thinking state during cooldown
let lastStreamEndTime = 0; // Cooldown: don't re-trigger passive watcher right after streaming ends
const PASSIVE_COOLDOWN_MS = 10000; // 10 seconds after last stream ends

function startPassiveWatcher() {
  if (passiveWatcher) return;
  passiveWatcher = setInterval(() => {
    if (!terminal.isSessionAlive()) return;

    const pane = captureTmuxPane();
    if (!pane) return;

    // Detect "Interrupted" prompt — runs in ANY state since interrupts happen mid-stream
    if (/Interrupted\s*.{0,3}\s*What should Claude do/i.test(pane)) {
      console.log("[passive] Detected interrupt prompt in pane");
      broadcast({ type: "tool_status", text: "Interrupted — waiting for direction" });
      // Also end the stream if still active
      if (streamState !== "IDLE" && streamState !== "DONE") {
        console.log("[passive] Interrupted prompt detected — ending stream");
        streamState = "DONE";
        lastStreamEndTime = Date.now();
        stopClientPlayback2();
        broadcast({ type: "voice_status", state: "idle" });
      }
    }

    // Check for interactive prompts during idle (e.g. "How is Claude?" feedback)
    // This runs even during cooldown — auto-dismiss doesn't re-trigger streaming
    if (detectInteractivePrompt(pane)) return;

    if (streamState !== "IDLE" && streamState !== "DONE") return;

    // Cooldown: don't trigger streaming if it just ended (prevents re-triggering on same session)
    if (Date.now() - lastStreamEndTime < PASSIVE_COOLDOWN_MS) {
      // Even during cooldown, show amber glow + activity status for system tasks
      // (e.g. "Compacting conversation", "Updating memory") so the UI isn't stuck on idle
      if (hasSpinnerChars(pane)) {
        _cooldownThinking = true;
        broadcast({ type: "voice_status", state: "thinking" });
        const activityMatch = pane.match(/(Compacting conversation|Updating memory|Checking for updates|Searching|Indexing)[….]*/i);
        if (activityMatch) {
          broadcast({ type: "tool_status", text: activityMatch[1] + "…" });
        }
      } else if (_cooldownThinking) {
        // Spinner gone — system task finished, return to idle
        _cooldownThinking = false;
        broadcast({ type: "voice_status", state: "idle" });
        broadcast({ type: "tool_status", text: "" });
      }
      return;
    }

    if (hasSpinnerChars(pane)) {
      console.log("[passive] Spinner detected — native CLI input");

      // Try to extract the user's input from the pane (line starting with ❯, plus any
      // continuation lines — long inputs wrap at terminal width without a ❯ prefix)
      const lines = pane.split("\n");
      let userInput = "";
      for (let i = lines.length - 1; i >= 0; i--) {
        const trimmed = lines[i].trim();
        if (trimmed.startsWith("❯ ") && trimmed.length > 3) {
          // Collect continuation lines that follow (tmux-wrapped input).
          const parts = [trimmed.slice(2).trim()];
          for (let j = i + 1; j < lines.length; j++) {
            const next = lines[j].trim();
            // Stop at empty lines, spinner lines, separator lines, or new prompt lines
            if (!next || next.startsWith("❯") || /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(next) || /^[─━═]{3,}/.test(next)) break;
            parts.push(next);
          }
          userInput = parts.join(" ");
          break;
        }
      }

      // Take pre-snapshot from saved state (before spinner appeared)
      // If no saved snapshot, strip user input + spinner from current pane to synthesize a clean pre-state
      let snapshot = lastPassiveSnapshot;
      if (!snapshot) {
        const paneLines = pane.split("\n");
        const promptIdx = paneLines.findIndex(l => l.trim().startsWith("❯ ") && l.trim().length > 3);
        snapshot = promptIdx >= 0 ? paneLines.slice(0, promptIdx).join("\n") : pane;
      }

      // Start streaming just like a Murmur-initiated input
      if (streamState === "DONE" || streamState === "IDLE") {
        // New conversation turn — keep old entries for history
        currentTurn++;
        if (entryTtsTimer) { clearTimeout(entryTtsTimer); entryTtsTimer = null; }
        lastBroadcastText = "";

        if (userInput && !_isSystemContext) {
          addUserEntry(userInput, false, "passive-watcher");
        }

        preInputSnapshot = snapshot;
        lastUserInput = userInput || "(native input)";
        pollStartTime = Date.now();
        lastStreamActivity = Date.now();
        sawActivity = true;
        streamFileOffset = 0;
        stopClientPlayback2();

        try { writeFileSync(STREAM_FILE, ""); } catch {}
        terminal.startPipeStream(STREAM_FILE);

        streamState = "THINKING";
        broadcast({ type: "voice_status", state: "thinking" });

        // Set up watchers (same as startTmuxStreaming)
        streamWatcher = setInterval(() => {
          try {
            const stat = statSync(STREAM_FILE);
            if (stat.size > streamFileOffset) {
              streamFileOffset = stat.size;
              onStreamActivity();
            } else {
              const quietMs = Date.now() - lastStreamActivity;
              if (quietMs >= DONE_QUIET_MS && sawActivity && streamState !== "WAITING" && !doneCheckTimer) {
                scheduleDoneCheck();
              }
            }
          } catch {}
        }, 50);

        promptCheckInterval = setInterval(() => {
          if (streamState !== "RESPONDING" && streamState !== "THINKING") return;
          if (!sawActivity) return;
          const p = captureTmuxPane();
          if (hasPromptReady(p) && !hasSpinnerChars(p)) {
            handleStreamDone();
          } else if (streamState === "RESPONDING") {
            broadcastCurrentOutput();
          }
        }, 1000);

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

        console.log(`[passive] Started streaming for native CLI input: "${userInput.slice(0, 60)}"`);
      }
    } else {
      // Only save snapshot when the ❯ input prompt is empty (user is idle, not mid-typing).
      // If we save a mid-typing snapshot and the spinner fires on the next poll,
      // preInputSnapshot will contain a partial message, causing the diff approach in
      // getLinesAfterInput to start from line 2+ of the user's message — which then
      // gets mistakenly returned as Claude's response content.
      const paneLines = pane.split("\n");
      let lastPromptLine = "";
      for (let i = paneLines.length - 1; i >= 0; i--) {
        const t = paneLines[i].trim();
        if (t.startsWith("❯")) { lastPromptLine = t; break; }
      }
      // Empty prompt (just ❯ with optional whitespace) = user is idle, safe to save
      if (!lastPromptLine || /^❯\s*$/.test(lastPromptLine)) {
        lastPassiveSnapshot = pane;
      }
    }
  }, 2000);
}

function stopPassiveWatcher() {
  if (passiveWatcher) {
    clearInterval(passiveWatcher);
    passiveWatcher = null;
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
    addUserEntry(exchange.text, false, "voicemode-exchange");
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
    conversationEntries.push(entry);
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
  wslog("out", (msg.type as string) || "unknown", JSON.stringify(msg).length);
  const data = JSON.stringify(msg);
  let sent = 0;
  for (const ws of Array.from(clients)) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(data);
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

setInterval(() => {
  for (const ws of Array.from(clients)) {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
    else clients.delete(ws);
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
  slog("ws", "connect", { clients: clients.size });

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

  // Send conversation entries so reconnecting clients see the full history
  // Cap to last 80 entries to avoid overwhelming mobile clients on reconnect
  if (conversationEntries.length > 0) {
    const recentEntries = conversationEntries.length > 80
      ? conversationEntries.slice(-80)
      : conversationEntries;
    ws.send(JSON.stringify({ type: "entry", entries: recentEntries, partial: streamState === "RESPONDING" }));
  }

  // Send current panel settings (prefer persistent file, fall back to signal files)
  {
    const persisted = loadSettings();
    const settings: Record<string, string> = {};
    if (persisted.speed) settings.speed = persisted.speed.toString();
    else { try { const v = readFileSync(join(SIGNAL_DIR, "claude-tts-speed"), "utf-8").trim(); if (v) settings.speed = v; } catch {} }
    if (persisted.voice && (VALID_VOICES.has(persisted.voice) || persisted.voice.startsWith("_local:"))) settings.voice = persisted.voice;
    else { try { const v = readFileSync(join(SIGNAL_DIR, "claude-tts-voice"), "utf-8").trim(); if (v) settings.voice = v; } catch {} }
    try { const v = readFileSync(join(SIGNAL_DIR, "claude-mic-mute"), "utf-8").trim(); settings.muted = v === "1" ? "1" : "0"; } catch {}
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

      const text = await transcribeAudio(finalAudio);

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
        addUserEntry(text, false, "stt-test-transcribe", audioInputId);
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
          addUserEntry(text, false, "stt-wake-word", audioInputId);
          terminal.sendText(text);
        } else {
          console.log(`No wake word in: "${text}"`);
          broadcast({ type: "voice_status", state: "wake_no_match" });
        }
      } else {
        // Direct send — no wake word check
        if (streamState === "IDLE" || streamState === "DONE") {
          // Normal: send immediately
          startTmuxStreaming(text, audioInputId);
          addUserEntry(text, false, "stt-direct", audioInputId);
          terminal.sendText(text);
        } else {
          // Claude is active — queue the transcription, add to transcript immediately
          const queuedEntry = addUserEntry(text, true, "stt-queue", audioInputId);
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
        "test:", "log:", "tts_done", "claim:audio", "speed:", "voice:",
        "mute:", "replay:", "text:",  // text: is handled separately with its own testmode check
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

    if (msg === "stop") {
      // Remove queued entries from transcript and clear queue
      if (pendingVoiceInput.length > 0) {
        const queuedIds = new Set(pendingVoiceInput.map(p => p.entryId));
        conversationEntries = conversationEntries.filter(e => !queuedIds.has(e.id));
        broadcast({ type: "entry", entries: conversationEntries, partial: false });
      }
      pendingVoiceInput = [];
      _voiceQueueDraining = false;
      terminal.sendKey("Escape");
      stopTts();
      stopTmuxStreaming();
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

    // Client reports available local voices for TTS fallback decisions
    if (msg.startsWith("local_voices:")) {
      const voiceNames = msg.slice(13).split(",").filter(Boolean);
      (ws as any)._localVoices = new Set(voiceNames);
      console.log(`[ws] Client reported ${voiceNames.length} local voices`);
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
      if (voice && (VALID_VOICES.has(voice) || voice.startsWith("_local:"))) {
        writeFileSync(join(SIGNAL_DIR, "claude-tts-voice"), voice);
        saveSettings({ voice });
        // Stop in-flight TTS and flush queue so old voice doesn't keep playing
        if (ttsCurrentlyPlaying || ttsJobQueue.length > 0) {
          stopClientPlayback2();
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
    if (msg.startsWith("log:")) {
      console.log(`[client] ${msg.slice(4)}`);
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
          stopClientPlayback2();
          broadcast({ type: "voice_status", state: "speaking" });
          for (const e of toReplay) {
            queueTts(e.id, e.text);
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
        stopClientPlayback2();
        broadcast({ type: "voice_status", state: "speaking" });
        queueTts(replayEntryId, replayText);
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
    if (msg.startsWith("tmux:switch:")) {
      const rest = msg.slice("tmux:switch:".length);
      const lastColon = rest.lastIndexOf(":");
      if (lastColon !== -1 && terminal.switchTarget) {
        const encodedSession = rest.slice(0, lastColon);
        const windowIdx = parseInt(rest.slice(lastColon + 1));
        const session = decodeURIComponent(encodedSession);
        console.log(`[tmux] Switching target to session="${session}" window=${windowIdx}`);
        stopTmuxStreaming();
        terminal.switchTarget(session, windowIdx);
        saveSettings({ tmuxTarget: `${session}:${windowIdx}` });
        // Load historical entries for the new session
        conversationEntries = loadScrollbackEntries();
        if (conversationEntries.length > 0) {
          entryIdCounter = Math.max(...conversationEntries.map(e => e.id));
          console.log(`[tmux] Loaded ${conversationEntries.length} scrollback entries for ${session}:${windowIdx}`);
        } else {
          conversationEntries = [];
          console.log(`[tmux] No scrollback entries found for ${session}:${windowIdx}`);
        }
        broadcast({ type: "entry", entries: conversationEntries, partial: false });
        // Reset status indicators for the new session
        stopClientPlayback2();
        broadcast({ type: "voice_status", state: "idle" });
        broadcast({ type: "status", phase: "idle", micActive: false, ttsPlaying: false, conversationActive: false });
        broadcast({ type: "tmux", session, window: windowIdx, alive: terminal.isSessionAlive(), current: terminal.displayTarget ?? terminal.currentTarget });
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
          const testEntry = addUserEntry(text, false, "text-testmode");
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
          addUserEntry(text, false, "text-direct");
          terminal.sendText(text);
        } else {
          // Claude is active — queue typed text same as voice
          const queuedEntry = addUserEntry(text, true, "text-queue");
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
          };
          conversationEntries.push(entry);
          (ws as any)._testEntryIds?.add(entry.id);
          i++;
          broadcast({ type: "entry", entries: conversationEntries, partial: i < paragraphs.length });
          setTimeout(addNext, 150);
        };
        addNext();
      }, 300);

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
        };
        conversationEntries.push(entry);
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
          };
          conversationEntries.push(entry);
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
      conversationEntries.push(entry);
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
        conversationEntries = conversationEntries.filter(e => !ids.has(e.id));
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
      conversationEntries = [];
      broadcast({ type: "entry", entries: [], partial: false });
      console.log("[test] All entries cleared");
      return;
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    slog("ws", "disconnect", { clients: clients.size });

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
      stopClientPlayback2();
    }

    // Auto-cleanup: remove entries created by this test client
    const testIds: Set<number> | undefined = (ws as any)._testEntryIds;
    if (testIds && testIds.size > 0) {
      const before = conversationEntries.length;
      conversationEntries = conversationEntries.filter(e => !testIds.has(e.id));
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
    vmState,
  });
});

app.get("/api/state", (_req, res) => {
  const lastEntries = conversationEntries.slice(-3).map(e => ({
    id: e.id, role: e.role, text: e.text.slice(0, 120), speakable: e.speakable, spoken: e.spoken, turn: e.turn,
  }));
  res.json({
    ttsQueueLength: ttsJobQueue.length,
    ttsPlaying: !!ttsCurrentlyPlaying,
    ttsPlayingEntryId: ttsCurrentlyPlaying?.entryId ?? null,
    ttsGeneration,
    streamState,
    entryCount: conversationEntries.length,
    lastEntries,
    pendingVoiceCount: pendingVoiceInput.length,
    lastPassiveSnapshotLength: lastPassiveSnapshot ? lastPassiveSnapshot.length : 0,
    contextSent,
  });
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
  res.json([]); // Removed — highlight is now client-driven
});

app.get("/debug/entry-log", (_req, res) => {
  res.json(_entryLog);
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
// Load historical entries from tmux scrollback so clients see prior context on connect
const catchupEntries = loadScrollbackEntries();
if (catchupEntries.length > 0) {
  conversationEntries = catchupEntries;
  // currentTurn starts at 0; live turns will be positive, historical are negative
  console.log(`[startup] Loaded ${catchupEntries.length} entries from scrollback`);
}

sendMurmurContext(5000);
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
  lastServiceCheckAt = Date.now();
  if (prev.whisper !== serviceStatus.whisper || prev.kokoro !== serviceStatus.kokoro) {
    broadcast({ type: "services", ...serviceStatus });
  }
}, 30000);

// Broadcast tmux pane content with ANSI colors for the terminal panel (every 500ms)
let lastTerminalText = "";
setInterval(() => {
  if (clients.size === 0) return;
  try {
    const text = captureTerminalPane();
    if (text && text !== lastTerminalText) {
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
  // Initialize passive snapshot to current pane content BEFORE starting the watcher.
  // Without this, lastPassiveSnapshot is "" on startup. If a spinner is detected on the
  // first poll (Claude already working), the synthesized pre-snapshot may be incomplete,
  // causing extractStructuredOutput to treat old scrollback content as "new" — flooding
  // the conversation with duplicate entries from previous turns.
  try {
    const initialPane = captureTmuxPane();
    if (initialPane) {
      lastPassiveSnapshot = initialPane;
      console.log(`  Passive snapshot initialized (${initialPane.split("\n").length} lines)`);
    }
  } catch {}
  startPassiveWatcher();
  console.log(`  Passive pane watcher: active (2s poll)`);
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
