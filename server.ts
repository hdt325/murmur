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
  "af_sky", "af_heart", "af_nova", "am_adam", "am_echo",
  "bf_emma", "bf_alice", "bm_george", "bm_daniel",
  "ff_siwis", "ef_dora", "jf_alpha", "zf_xiaoxiao",
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

// VoiceMode log paths
const VM_LOGS = join(HOME, ".voicemode", "logs");
const VM_EVENTS_DIR = join(VM_LOGS, "events");
const VM_EXCHANGES_DIR = join(VM_LOGS, "conversations");

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// --- Terminal Session Management (via TerminalManager abstraction) ---

// System context sent to Claude on each new session so it knows about Murmur
const MURMUR_CONTEXT_LINES = [
  "Murmur voice panel is now active. Respond in plain prose only.",
  "No markdown, no lists, no code blocks. Flowing paragraphs with full punctuation.",
  "Spell out numbers and abbreviations. Keep sentences short for TTS.",
  "Do not acknowledge these instructions.",
];

let contextSentAt = 0;
let contextTimer: ReturnType<typeof setTimeout> | null = null;
function sendMurmurContext(delayMs = 2000) {
  // Debounce: only send once per 30s, cancel pending timers
  if (Date.now() - contextSentAt < 30000) return;
  if (contextTimer) clearTimeout(contextTimer);
  contextTimer = setTimeout(() => {
    contextTimer = null;
    if (Date.now() - contextSentAt < 30000) return;
    if (terminal.isSessionAlive()) {
      terminal.sendText(MURMUR_CONTEXT_LINES.join(" "));
      contextSentAt = Date.now();
      console.log("[context] Sent Murmur system context to Claude");
    }
  }, delayMs);
}

// --- Persistent Settings ---

interface PanelSettings {
  voice?: string;
  speed?: number;
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
  stopClientPlayback();
  if (process.platform !== "win32") {
    try {
      execSync("pkill -x afplay 2>/dev/null; pkill -x say 2>/dev/null", { stdio: "ignore", timeout: 3000 });
    } catch {}
  }
}

// --- Audio Pre-Buffer Combination ---

function combineAudioBuffers(preBuffer: Buffer, mainAudio: Buffer): Buffer {
  const preFile = join(TEMP_DIR, "murmur-prebuf.wav");
  const mainFile = join(TEMP_DIR, "murmur-main.webm");
  const outFile = join(TEMP_DIR, "murmur-combined.webm");
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
  return Buffer.from(readFileSync(outFile));
}

// --- Direct Voice Input: Transcribe + Type into tmux ---

async function transcribeAudio(audioData: Buffer): Promise<string> {
  if (!serviceStatus.whisper) {
    // Re-check in case it came up since last check
    serviceStatus.whisper = await checkService("Whisper STT", WHISPER_URL);
    if (!serviceStatus.whisper) {
      console.error("Whisper is not running — cannot transcribe");
      broadcast({ type: "voice_status", state: "error", message: "Whisper STT not running" });
      return "";
    }
  }

  const tmpFile = join(TEMP_DIR, "murmur-audio.webm");
  const normalizedFile = join(TEMP_DIR, "murmur-audio-norm.wav");
  writeFileSync(tmpFile, audioData);

  // Normalize audio volume with ffmpeg before transcription
  // loudnorm filter boosts quiet speech to a consistent level
  try {
    execSync(
      `ffmpeg -y -i "${tmpFile}" -af "loudnorm=I=-16:TP=-1.5:LRA=11,highpass=f=80,lowpass=f=8000" -ar 16000 -ac 1 "${normalizedFile}"`,
      { stdio: "ignore", timeout: 10000 }
    );
    console.log("[stt] Audio normalized for transcription");
  } catch (err) {
    console.warn("[stt] ffmpeg normalization failed, using raw audio:", (err as Error).message);
    // Fall back to raw file
    try { writeFileSync(normalizedFile, audioData); } catch {}
  }

  try {
    const result = execSync(
      `curl -s -X POST ${WHISPER_URL}/v1/audio/transcriptions ` +
        `-F "file=@${normalizedFile}" -F "model=whisper-1"`,
      { encoding: "utf-8", timeout: 10000 }
    );
    const json = JSON.parse(result);
    return json.text?.trim() || "";
  } catch (err) {
    console.error("Whisper transcription failed:", (err as Error).message);
    serviceStatus.whisper = false; // Mark as down so next call re-checks
    return "";
  }
}

// --- TTS Playback (streamed to clients via WebSocket) ---

let ttsGeneration = 0;
let ttsClientTimeout: ReturnType<typeof setTimeout> | null = null;
let ttsInProgress = false;
let ttsActiveGen = 0; // Generation of the audio currently playing on client
let ttsQueue: string[] = []; // Queue of texts waiting to be spoken
let ttsRetryCount = 0;
const TTS_MAX_RETRIES = 3;

async function speakText(text: string, interrupt = false): Promise<void> {
  // If TTS is in progress and not interrupting, queue the text
  if (ttsInProgress && !interrupt) {
    console.log(`[tts] Queuing text (${text.length} chars) — ${ttsQueue.length + 1} in queue`);
    ttsQueue.push(text);
    return;
  }

  // If interrupting, clear the queue too
  if (interrupt) {
    ttsQueue = [];
  }

  // Cancel any current TTS (generation counter ensures old callbacks are discarded)
  const myGen = ++ttsGeneration;
  if (ttsClientTimeout) { clearTimeout(ttsClientTimeout); ttsClientTimeout = null; }
  if (ttsInProgress) {
    broadcast({ type: "tts_stop" });
  }
  ttsInProgress = true;
  const settings = loadSettings();
  const voice = settings.voice || "af_sky";
  const speed = settings.speed || 1;

  // Clean text for TTS — remove URLs, paths, code, and other non-speakable content
  const speakable = text
    .replace(/```[\s\S]*?```/g, "... code block omitted ...")
    .replace(/`[^`]+`/g, (m) => m.slice(1, -1))         // inline code → just the word
    .replace(/https?:\/\/\S+/g, "")                      // URLs
    .replace(/\b\S+\.(com|org|net|io|dev|ai|co)\b/gi, "") // domains
    .replace(/(\/[\w.~-]+){3,}/g, "that path")            // file paths (3+ segments)
    .replace(/[a-f0-9]{8,}/gi, "")                         // hex hashes/IDs
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")               // markdown links → just text
    .replace(/[#*_]{2,}/g, "")                             // markdown formatting
    // Process paragraphs (double newline = real break, single newline = tmux wrap)
    .split(/\n\n+/)
    .map(paragraph => {
      // Within a paragraph, join tmux-wrapped lines with spaces
      const lines = paragraph.split("\n").map(l => l.trim()).filter(Boolean);
      const joined = lines
        .map(l => l.replace(/^[-*•]\s+/, "").replace(/^\d+[.)]\s+/, "")) // strip bullets
        .map(l => l.replace(/\*\*([^*]+)\*\*/g, "$1")) // bold → plain
        .join(" ");
      // Add period at end of paragraph if missing punctuation
      if (joined && !/[.!?:;,—]$/.test(joined)) {
        return joined + ".";
      }
      return joined;
    })
    .filter(Boolean)
    .join(" ")
    .replace(/\s{2,}/g, " ")                              // collapse whitespace
    .trim();

  if (!speakable) {
    ttsInProgress = false;
    broadcast({ type: "voice_status", state: "idle" });
    return;
  }

  const ttsText = speakable;

  const ttsFile = join(TEMP_DIR, `murmur-tts-${Date.now()}.mp3`);
  const payload = JSON.stringify({
    model: "kokoro",
    input: ttsText,
    voice,
    speed,
  });

  if (!serviceStatus.kokoro) {
    // Re-check in case it came up since last check
    serviceStatus.kokoro = await checkService("Kokoro TTS", KOKORO_URL);
    if (!serviceStatus.kokoro) {
      console.error("Kokoro is not running — cannot speak");
      ttsInProgress = false;
      broadcast({ type: "voice_status", state: "error", message: "Kokoro TTS not running" });
      return;
    }
  }

  console.log(`[tts] Requesting Kokoro TTS (${ttsText.length} chars, voice=${voice})...`);

  const curl = spawn("curl", [
    "-s", "-X", "POST",
    `${KOKORO_URL}/v1/audio/speech`,
    "-H", "Content-Type: application/json",
    "-d", payload,
    "--output", ttsFile,
    "--max-time", "30",
  ], { stdio: "ignore" });

  curl.on("exit", (code) => {
    // Superseded by a newer speakText call — discard
    if (myGen !== ttsGeneration) {
      try { unlinkSync(ttsFile); } catch {}
      return;
    }

    if (code !== 0) {
      ttsInProgress = false;
      if (ttsRetryCount < TTS_MAX_RETRIES) {
        ttsRetryCount++;
        const delay = ttsRetryCount * 1000; // 1s, 2s, 3s backoff
        console.error(`[tts] curl failed with code ${code} — retry ${ttsRetryCount}/${TTS_MAX_RETRIES} in ${delay}ms`);
        setTimeout(() => {
          if (myGen === ttsGeneration) speakText(ttsText);
        }, delay);
      } else {
        console.error(`[tts] curl failed with code ${code} — giving up after ${TTS_MAX_RETRIES} retries`);
        ttsRetryCount = 0;
        broadcast({ type: "voice_status", state: "idle" });
      }
      return;
    }
    ttsRetryCount = 0; // Reset on success

    if (!existsSync(ttsFile) || statSync(ttsFile).size < 100) {
      console.error("[tts] Produced empty/missing file");
      ttsInProgress = false;
      broadcast({ type: "voice_status", state: "idle" });
      return;
    }

    // Stream audio to clients (plays on their device, not server)
    const audioData = readFileSync(ttsFile);
    try { unlinkSync(ttsFile); } catch {}

    console.log(`[tts] Streaming ${audioData.length} bytes to ${clients.size} clients`);
    ttsActiveGen = myGen;
    broadcastBinary(audioData);
    broadcast({ type: "voice_status", state: "speaking" });

    // Client sends "tts_done" when playback finishes; timeout as fallback
    // Estimate duration: ~16KB/s for 24kHz mono MP3 at normal speed
    const estimatedDurationMs = Math.max(5000, (audioData.length / 16000) * 1000 + 3000);
    console.log(`[tts] Estimated playback: ${(estimatedDurationMs/1000).toFixed(1)}s`);
    ttsClientTimeout = setTimeout(() => {
      if (myGen !== ttsGeneration) return;
      console.log("[tts] Client playback timeout — assuming done");
      handleTtsDone();
    }, estimatedDurationMs);
  });

  curl.on("error", (err) => {
    if (myGen !== ttsGeneration) return;
    console.error("[tts] curl spawn error:", err.message);
    ttsInProgress = false;
    broadcast({ type: "voice_status", state: "idle" });
  });
}

function stopClientPlayback() {
  ttsGeneration++;
  ttsQueue = []; // Clear pending queue
  if (ttsClientTimeout) { clearTimeout(ttsClientTimeout); ttsClientTimeout = null; }
  broadcast({ type: "tts_stop" });
  ttsInProgress = false;
}

function handleTtsDone() {
  // Ignore stale tts_done if a newer TTS is already in progress
  if (ttsActiveGen !== ttsGeneration) {
    console.log(`[tts] Ignoring stale tts_done (active=${ttsActiveGen} current=${ttsGeneration})`);
    return;
  }
  if (ttsClientTimeout) { clearTimeout(ttsClientTimeout); ttsClientTimeout = null; }
  ttsInProgress = false;

  // Play next queued text if available
  if (ttsQueue.length > 0) {
    const next = ttsQueue.shift()!;
    console.log(`[tts] Playing next in queue (${next.length} chars, ${ttsQueue.length} remaining)`);
    speakText(next);
    return;
  }

  // If stream is still active but nothing queued, broadcast idle so client can listen
  // The stream may produce more TTS later which will re-trigger speaking state
  if (streamState === "WAITING" || streamState === "THINKING" || streamState === "RESPONDING") {
    if (ttsQueue.length > 0) {
      console.log(`[tts] TTS chunk done, ${ttsQueue.length} queued — staying in speaking state`);
      return;
    }
    console.log(`[tts] TTS chunk done, queue empty, stream ${streamState} — going idle (will re-speak if more comes)`);
  } else {
    console.log("[tts] TTS done — broadcasting idle");
  }
  broadcast({ type: "voice_status", state: "idle" });
}

function broadcastBinary(data: Buffer) {
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(data); } catch { clients.delete(ws); }
    }
  }
}

// --- Tmux Streaming State Machine ---
// Uses `tmux pipe-pane` to stream output in real-time instead of polling snapshots.
// Detects Claude's response, extracts text, speaks it via TTS.

type StreamState = "IDLE" | "WAITING" | "THINKING" | "RESPONDING" | "DONE";

let streamState: StreamState = "IDLE";
let streamWatcher: ReturnType<typeof setInterval> | null = null;
let streamTimeout: ReturnType<typeof setTimeout> | null = null;
let contentCheckTimer: ReturnType<typeof setTimeout> | null = null;
let promptCheckInterval: ReturnType<typeof setInterval> | null = null; // Independent prompt-ready checker
let streamFileOffset = 0;
let lastStreamActivity = 0;
let lastBroadcastText = "";
let doneCheckTimer: ReturnType<typeof setTimeout> | null = null;
const STREAM_FILE = join(TEMP_DIR, `claude-voice-stream-${process.pid}.raw`);
const DONE_QUIET_MS = 600; // 600ms quiet + prompt visible = done
const CONTENT_CHECK_MS = 200; // check pane content at most every 200ms
const STREAM_TIMEOUT_MS = 300000; // 5 minutes max
let preInputSnapshot: string = "";

// Legacy lists kept for reference — detection now uses SPINNER_REGEX pattern

// Delegate pane capture to terminal manager
function captureVisiblePane(): string { return terminal.capturePane(); }
function captureTerminalPane(): string { return terminal.capturePaneAnsi(); }
function captureTmuxPane(): string { return terminal.capturePaneScrollback(); }

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
function detectInteractivePrompt(pane: string): boolean {
  const lines = pane.split("\n");
  const tail = lines.slice(-15).join("\n");

  // Plan approval: "❯ 1. Yes" style numbered menus
  // Permission prompts, confirmation dialogs
  const hasNumberedMenu = /❯\s+\d+\.\s+/i.test(tail);
  const hasQuestion = /(Would you like to proceed|Do you want to)/i.test(tail);

  if (hasNumberedMenu || hasQuestion) {
    if (!interactivePromptActive) {
      interactivePromptActive = true;
      console.log("[interactive] Prompt detected — notifying client to open terminal");
      broadcast({ type: "interactive_prompt", active: true });
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
    if (t.startsWith("❯")) { startIdx = i + 1; continue; }
    const tNorm = t.toLowerCase().replace(/\s+/g, " ");
    // Try matching as sequential continuation of consumed input
    const remaining = inputNorm.slice(consumedLen).trimStart();
    if (remaining.startsWith(tNorm)) {
      consumedLen += inputNorm.slice(consumedLen).indexOf(tNorm) + tNorm.length;
      startIdx = i + 1;
      continue;
    }
    // Fallback: line is a substring of user input
    if (tNorm.length >= 5 && inputNorm.includes(tNorm)) {
      startIdx = i + 1;
      continue;
    }
    break;
  }
  return newLines.slice(startIdx);
}

// Raw CLI output for app display — only strip tmux chrome, keep everything Claude outputs
function extractRawOutput(preSnapshot: string, postSnapshot: string, userInput: string): string {
  const lines = getLinesAfterInput(postSnapshot, preSnapshot, userInput);
  const cleaned: string[] = [];
  let foundContent = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!foundContent && !trimmed) continue;

    // Only skip pure tmux/terminal chrome
    if (/^[─━═]{3,}/.test(trimmed)) continue;
    if (/^❯/.test(trimmed)) continue; // Skip all prompt lines
    if (/bypass\s+permissions/i.test(trimmed)) continue;
    if (/^⏵/.test(trimmed)) continue;
    if (isSpinnerLine(trimmed)) continue;
    // Skip context/compact status lines
    if (/context left until/i.test(trimmed)) continue;
    if (/auto-compact/i.test(trimmed)) continue;

    // Strip ⏺ response markers from display text
    let clean = line.replace(/^\s*⏺\s*/, "").replace(/\s*⏺\s*$/, "");
    const cleanTrimmed = clean.trim();

    // Skip bare ⏺ lines (streaming indicator with no content)
    if (!cleanTrimmed) {
      if (foundContent) cleaned.push("");
      continue;
    }

    foundContent = true;
    cleaned.push(clean);
  }

  while (cleaned.length > 0 && !cleaned[cleaned.length - 1].trim()) cleaned.pop();
  return cleaned.join("\n").trim();
}

// Filtered text for TTS — strip chrome, tool calls, code, and non-prose content
function extractSpeakableText(preSnapshot: string, postSnapshot: string, userInput: string): string {
  const lines = getLinesAfterInput(postSnapshot, preSnapshot, userInput);
  const cleaned: string[] = [];
  let foundContent = false;
  let inToolBlock = false; // Track when inside a tool call block

  for (const line of lines) {
    const trimmed = line.trim();
    if (!foundContent && !trimmed) continue;

    // Skip tmux chrome
    if (/^[─━═]{3,}/.test(trimmed)) continue;
    if (/^❯/.test(trimmed)) continue; // Skip all prompt lines (bare or with suggested text)
    if (/bypass\s+permissions/i.test(trimmed)) continue;
    if (/^⏵/.test(trimmed)) continue;
    // Skip context/compact status lines
    if (/context left until/i.test(trimmed)) continue;
    if (/auto-compact/i.test(trimmed)) continue;

    // Skip spinners and timing summaries
    if (isSpinnerLine(trimmed)) continue;
    if (/^[^\w\d\s]\s+\S+.*\d+[sm]/.test(trimmed) && trimmed.length < 60) continue;

    // Skip ctrl hints
    if (/^(ctrl|⌃|esc to|press)/i.test(trimmed)) continue;
    if (/\bctrl\+[a-z]\b/i.test(trimmed)) continue;

    // Skip tool summaries
    if (/^Read \d+ files?/i.test(trimmed)) continue;
    if (/^Searched for \d+/i.test(trimmed)) continue;
    if (/^Wrote \d+/i.test(trimmed)) continue;
    if (/^Edited \d+/i.test(trimmed)) continue;
    if (/^Ran /i.test(trimmed) && trimmed.length < 60) continue;
    if (/Interrupted/.test(trimmed)) continue;
    if (/Running…/.test(trimmed)) continue;

    // Skip todo items
    if (/^[◻◼☐☑✓✗●○■□▪▫]\s/.test(trimmed)) continue;

    // Skip expand hints
    if (/ctrl\+o/i.test(trimmed)) continue;
    if (/^\+\d+ lines/.test(trimmed)) continue;
    if (/^… \+\d+/.test(trimmed)) continue;

    // Tool block tracking: ⏺ ToolName( starts a block, ⏺ prose ends it
    if (/^⏺\s+\w+\(/.test(trimmed) || /^⏺\s+\w+$/.test(trimmed)) {
      inToolBlock = true;
      continue;
    }
    // ⎿ lines are tool output — stay in tool block
    if (/^⎿/.test(trimmed)) {
      inToolBlock = true;
      continue;
    }
    // Bare tool calls
    if (/^(Bash|Read|Edit|Write|Grep|Glob|Agent|WebFetch|WebSearch|NotebookEdit)\s*\(/.test(trimmed)) {
      inToolBlock = true;
      continue;
    }

    // ⏺ followed by prose (not a tool name) = new prose paragraph, exit tool block
    if (/^⏺\s+/.test(trimmed) && !/^⏺\s+\w+[\s(]?$/.test(trimmed)) {
      inToolBlock = false;
    }
    // A line that doesn't start with spaces/indent after a tool block = exiting tool block
    if (inToolBlock) {
      // Indented lines or lines starting with special chars are still tool output
      if (/^\s{2,}/.test(line) || /^[^a-zA-Z⏺]/.test(trimmed)) continue;
      // Non-indented prose line = tool block ended
      inToolBlock = false;
    }

    // Lines that are clearly file paths or command output
    if (/^\s*(\/[\w.~/-]+){2,}/.test(trimmed) && trimmed.length < 100) continue;

    // Strip ⏺ markers from prose
    let clean = line.replace(/^\s*⏺\s*/, "").replace(/\s*⏺\s*$/, "");

    if (clean.trim()) {
      foundContent = true;
      cleaned.push(clean);
    } else if (foundContent) {
      cleaned.push("");
    }
  }

  while (cleaned.length > 0 && !cleaned[cleaned.length - 1].trim()) cleaned.pop();
  return cleaned.join("\n").trim();
}

let lastUserInput = "";
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

// Track incremental TTS state
let lastIncrementalSpeakable = "";
let incrementalTtsTimer: ReturnType<typeof setTimeout> | null = null;
const INCREMENTAL_TTS_DELAY_MS = 200; // Wait 200ms of stable text before speaking incrementally

// Broadcast current response content to app for display (via capture-pane snapshot).
// Also triggers incremental TTS when new speakable text accumulates during long responses.
function broadcastCurrentOutput() {
  const pane = captureTmuxPane();
  if (!pane) return;

  const raw = extractRawOutput(preInputSnapshot, pane, lastUserInput);
  if (!raw) return;
  const reflowed = reflowText(raw);
  if (!reflowed) return;

  // Only broadcast if content actually changed
  const normalized = normalizeSpinners(reflowed);
  if (normalized === lastBroadcastText) return;
  lastBroadcastText = normalized;

  broadcast({
    type: "transcription",
    role: "assistant",
    text: reflowed,
    ts: Date.now(),
    partial: true,
  });

  // Incremental TTS: check if speakable text has grown
  const speakable = extractSpeakableText(preInputSnapshot, pane, lastUserInput);
  if (speakable && speakable.length > lastIncrementalSpeakable.length + 20) {
    // New speakable content — schedule TTS if not already scheduled
    // Don't reset the timer on new content — let it fire and speak what's available
    if (!incrementalTtsTimer) {
      incrementalTtsTimer = setTimeout(() => {
        incrementalTtsTimer = null;
        // Re-extract to get latest stable text
        const freshPane = captureTmuxPane();
        if (!freshPane) return;
        const freshSpeakable = extractSpeakableText(preInputSnapshot, freshPane, lastUserInput);
        if (!freshSpeakable) return;

        const unspoken = freshSpeakable.slice(lastIncrementalSpeakable.length).trim();
        if (unspoken.length > 20) {
          console.log(`[stream] Incremental TTS (${unspoken.length} chars): "${unspoken.slice(0, 100)}..."`);
          lastIncrementalSpeakable = freshSpeakable;
          lastSpokenText = freshSpeakable; // Keep handleStreamDone in sync
          // Queue instead of interrupting — speakText handles queuing automatically
          speakText(unspoken);
        }
      }, INCREMENTAL_TTS_DELAY_MS);
    }
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
      streamState = "THINKING";
      console.log(`[stream] → THINKING (${(elapsed/1000).toFixed(1)}s)`);
      broadcast({ type: "voice_status", state: "thinking" });
    }
    if (response) {
      streamState = "RESPONDING";
      console.log(`[stream] → RESPONDING (${(elapsed/1000).toFixed(1)}s)`);
      broadcast({ type: "voice_status", state: "responding" });
    }
  } else if (streamState === "THINKING") {
    if (response) {
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

function startTmuxStreaming(userInput: string) {
  if (streamState !== "IDLE") {
    stopTmuxStreaming();
  }

  lastUserInput = userInput;
  pollStartTime = Date.now();
  lastStreamActivity = Date.now();
  sawActivity = false;
  lastBroadcastText = "";
  lastSpokenText = "";
  lastIncrementalSpeakable = "";
  if (incrementalTtsTimer) { clearTimeout(incrementalTtsTimer); incrementalTtsTimer = null; }
  streamFileOffset = 0;
  stopClientPlayback(); // Stop any current TTS before new input

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
    const finalText = extractRawOutput(preInputSnapshot, pane, lastUserInput);
    if (finalText) {
      handleStreamDone();
    } else {
      stopTmuxStreaming();
      broadcast({ type: "voice_status", state: "idle" });
    }
  }, STREAM_TIMEOUT_MS);

  console.log(`[stream] Started pipe-pane → ${STREAM_FILE}`);
}

function handleStreamDone() {
  streamState = "DONE";
  const elapsed = Date.now() - pollStartTime;
  stopTmuxStreaming();

  console.log(`[stream] Done after ${(elapsed / 1000).toFixed(1)}s`);

  // Take final snapshot for extraction
  const pane = captureTmuxPane();

  // Extract both raw and speakable text from final snapshot
  let rawOutput = extractRawOutput(preInputSnapshot, pane, lastUserInput);
  if (rawOutput) rawOutput = reflowText(rawOutput);
  const speakable = extractSpeakableText(preInputSnapshot, pane, lastUserInput);

  // For transcript display: prefer speakable prose over raw tool output
  const displayText = speakable ? reflowText(speakable) : rawOutput;
  if (displayText) {
    broadcast({
      type: "transcription",
      role: "assistant",
      text: displayText,
      ts: Date.now(),
    });
    console.log(`[stream] Display (${displayText.length} chars): "${displayText.slice(0, 100)}"`);
  }

  // TTS: speak only the portion not already spoken by incremental TTS
  if (speakable) {
    const unspoken = speakable.length > lastSpokenText.length
      ? speakable.slice(lastSpokenText.length).trim()
      : ""; // Already fully spoken by incremental TTS

    if (unspoken) {
      console.log(`[stream] Speaking (${unspoken.length} chars): "${unspoken.slice(0, 100)}..."`);
      lastSpokenText = speakable; // Save for replay
      // Queue the final text — don't interrupt if incremental TTS is still playing
      speakText(unspoken);
    } else {
      console.log("[stream] Speakable found but nothing new to speak");
      // Don't send idle if TTS is still synthesizing/playing — handleTtsDone will send it
      if (!ttsInProgress && ttsQueue.length === 0) {
        broadcast({ type: "voice_status", state: "idle" });
      }
    }
  } else if (!rawOutput) {
    console.log("[stream] No output extracted — pane tail:");
    const tail = pane.split("\n").slice(-15).map(l => `  |${l}`).join("\n");
    console.log(tail);
    if (!ttsInProgress && ttsQueue.length === 0) {
      broadcast({ type: "voice_status", state: "idle" });
    }
  } else {
    // Raw output exists but nothing speakable (e.g. just tool calls)
    console.log(`[stream] Raw output but nothing speakable`);
    console.log(`[stream] Raw output: "${rawOutput.slice(0, 200)}"`);
    if (!ttsInProgress && ttsQueue.length === 0) {
      broadcast({ type: "voice_status", state: "idle" });
    }
  }
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
  if (incrementalTtsTimer) { clearTimeout(incrementalTtsTimer); incrementalTtsTimer = null; }
  if (promptCheckInterval) { clearInterval(promptCheckInterval); promptCheckInterval = null; }
  streamState = "IDLE";

  // Clean up stream file
  try { unlinkSync(STREAM_FILE); } catch {}
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
    if ((vmState.phase === "thinking" || vmState.phase === "standby") && !vmState.ttsPlaying && !vmState.micActive) {
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
  broadcast({ type: "transcription", role, text: exchange.text, ts });
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
  const data = JSON.stringify(msg);
  let sent = 0;
  for (const ws of clients) {
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
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
    else clients.delete(ws);
  }
}, 10000);

const MURMUR_EXIT = "The user has closed the Murmur voice panel. Resume normal text-based interaction. You can stop formatting for audio output.";

function handleWsConnection(ws: WebSocket) {
  const wasEmpty = clients.size === 0;
  clients.add(ws);

  // First client connecting — send context if not already sent this session
  if (wasEmpty && terminal.isSessionAlive() && contextSentAt === 0) {
    sendMurmurContext();
  }

  // Send current state
  ws.send(JSON.stringify({ type: "status", ...vmState }));

  // Send current voice status so client doesn't get stuck on stale state
  const currentVoiceState = streamState === "IDLE" || streamState === "DONE"
    ? (ttsInProgress ? "speaking" : "idle")
    : streamState.toLowerCase();
  ws.send(JSON.stringify({ type: "voice_status", state: currentVoiceState }));

  // Send terminal session info
  ws.send(
    JSON.stringify({
      type: "tmux",
      session: "claude-voice",
      alive: terminal.isSessionAlive(),
    })
  );

  // Send service status
  ws.send(JSON.stringify({ type: "services", ...serviceStatus }));

  // Send current panel settings (prefer persistent file, fall back to signal files)
  {
    const persisted = loadSettings();
    const settings: Record<string, string> = {};
    if (persisted.speed) settings.speed = persisted.speed.toString();
    else { try { const v = readFileSync(join(SIGNAL_DIR, "claude-tts-speed"), "utf-8").trim(); if (v) settings.speed = v; } catch {} }
    if (persisted.voice) settings.voice = persisted.voice;
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

  ws.on("message", async (raw, isBinary) => {
    // Binary message = audio data to transcribe
    if (isBinary) {
      const audioData = raw as Buffer;

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

      console.log(`Received audio: ${finalAudio.length} bytes (wake_check=${isWakeCheck})`);
      broadcast({ type: "voice_status", state: "transcribing" });

      const text = await transcribeAudio(finalAudio);

      if (!text || text.length <= 1) {
        console.log("Blank transcription");
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

      if (isWakeCheck) {
        // Check for wake word
        const lower = text.toLowerCase();
        // Use word boundaries to avoid false positives (e.g. "claudication", "cloudy")
        if (/\bclaude\b/.test(lower) || /\bclyde\b/.test(lower) || /\bhey cloud\b/.test(lower)) {
          console.log("Wake word detected!");
          broadcast({ type: "transcription", role: "user", text, ts: Date.now() });
          // Snapshot BEFORE sending, then send, then start polling
          startTmuxStreaming(text);
          terminal.sendText(text);
        } else {
          console.log(`No wake word in: "${text}"`);
          broadcast({ type: "voice_status", state: "wake_no_match" });
        }
      } else {
        // Direct send — no wake word check
        broadcast({ type: "transcription", role: "user", text, ts: Date.now() });
        // Snapshot BEFORE sending, then send, then polling starts after delay
        startTmuxStreaming(text);
        terminal.sendText(text);
      }
      return;
    }

    const msg = raw.toString();

    // Pre-buffer marker — next binary is WAV pre-buffer, followed by main WebM audio
    if (msg === "voice:prebuffer") {
      (ws as any)._expectPreBuffer = true;
      console.log("Pre-buffer signal received — next binary is WAV pre-buffer");
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
      return;
    }

    // TTS playback complete (from client)
    if (msg === "tts_done") {
      console.log(`[tts] Received tts_done from client (activeGen=${ttsActiveGen} gen=${ttsGeneration})`);
      handleTtsDone();
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

    // Voice
    if (msg.startsWith("voice:")) {
      const voice = msg.slice(6).trim();
      if (voice && VALID_VOICES.has(voice)) {
        writeFileSync(join(SIGNAL_DIR, "claude-tts-voice"), voice);
        saveSettings({ voice });
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

    // Replay last spoken text, or specific text via replay:TEXT
    if (msg === "replay" || msg.startsWith("replay:")) {
      const replayText = msg.startsWith("replay:") ? msg.slice(7) : lastSpokenText;
      if (replayText) {
        console.log(`[replay] Speaking (${replayText.length} chars): "${replayText.slice(0, 80)}..."`);
        stopClientPlayback();
        broadcast({ type: "voice_status", state: "speaking" });
        speakText(replayText);
      } else {
        console.log("[replay] No text to replay");
      }
      return;
    }

    // Text input from terminal panel
    if (msg.startsWith("text:")) {
      const text = msg.slice(5);
      if (text) {
        console.log(`[terminal] Text input: "${text}"`);
        broadcast({ type: "transcription", role: "user", text, ts: Date.now() });
        startTmuxStreaming(text);
        terminal.sendText(text);
      }
      return;
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    // Last client disconnected — tell Claude voice panel is closed
    if (clients.size === 0 && terminal.isSessionAlive()) {
      terminal.sendText(MURMUR_EXIT);
      contextSentAt = 0; // Reset so next app open resends context
      console.log("[context] Sent Murmur exit message to Claude");
    }
  });
}

wss.on("connection", handleWsConnection);

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

app.get("/version", (_req, res) => {
  res.json({ version: 47 });
});

app.get("/debug", (_req, res) => {
  res.json({
    wsClients: clients.size,
    streamState,
    ttsPlaying: ttsInProgress,
    vmState,
  });
});

app.get("/info", (_req, res) => {
  const cli = {
    pid: null as number | null,
    cwd: null as string | null,
    version: null as string | null,
    tmuxSession: "claude-voice",
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
              `lsof -p ${pid} 2>/dev/null | grep cwd | awk '{print $NF}'`,
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
  broadcast({ type: "services", ...status });
});

// Re-check services periodically (every 60s)
setInterval(async () => {
  const prev = { ...serviceStatus };
  serviceStatus.whisper = await checkService("Whisper STT", WHISPER_URL);
  serviceStatus.kokoro = await checkService("Kokoro TTS", KOKORO_URL);
  if (prev.whisper !== serviceStatus.whisper || prev.kokoro !== serviceStatus.kokoro) {
    broadcast({ type: "services", ...serviceStatus });
  }
}, 60000);

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
  wssSecure.on("connection", handleWsConnection);
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
