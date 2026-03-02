/**
 * Audio pipeline tests — exercises STT/TTS round-trips via WebSocket.
 * Requires: server running on localhost:3457, Whisper STT on :2022, Kokoro TTS on :8880
 *
 * Generate test audio first:  npx tsx tests/generate-test-audio.ts
 * Run:  npx tsx tests/test-audio-pipeline.ts
 */

import WebSocket from "ws";
import { existsSync } from "fs";
import { resolve } from "path";

const WS_URL = "ws://localhost:3457";
const AUDIO_DIR = resolve(import.meta.dirname!, "test-audio");
const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
const WARN = "\x1b[33m⚠\x1b[0m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

interface TestResult { name: string; ok: boolean; detail?: string }
const results: TestResult[] = [];

function report(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? PASS : FAIL}  ${name}${detail ? ` ${DIM}(${detail})${RESET}` : ""}`);
}

function skip(name: string, reason: string) {
  console.log(`  ${WARN}  ${name} ${DIM}(SKIP: ${reason})${RESET}`);
}

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.on("open", () => {
      ws.send("test:client");
      resolve(ws);
    });
    ws.on("error", reject);
    setTimeout(() => reject(new Error("WS connect timeout")), 5000);
  });
}

function waitForMessage(ws: WebSocket, filter: (msg: any) => boolean, timeoutMs = 15000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener("message", handler);
      reject(new Error(`Timeout waiting for message (${timeoutMs}ms)`));
    }, timeoutMs);

    function handler(data: WebSocket.Data) {
      if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) return;
      try {
        const msg = JSON.parse(data.toString());
        if (filter(msg)) {
          clearTimeout(timer);
          ws.removeListener("message", handler);
          resolve(msg);
        }
      } catch {}
    }
    ws.on("message", handler);
  });
}

/** Collect all JSON messages matching filter until timeout or stopper fires */
function collectMessages(ws: WebSocket, filter: (msg: any) => boolean, timeoutMs = 10000): Promise<any[]> {
  return new Promise((resolve) => {
    const collected: any[] = [];
    const timer = setTimeout(() => {
      ws.removeListener("message", handler);
      resolve(collected);
    }, timeoutMs);

    function handler(data: WebSocket.Data) {
      if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) return;
      try {
        const msg = JSON.parse(data.toString());
        if (filter(msg)) collected.push(msg);
      } catch {}
    }
    ws.on("message", handler);
  });
}

/** Wait for either binary audio or a local_tts JSON message */
function waitForAudio(ws: WebSocket, timeoutMs = 15000): Promise<{ binary: Buffer | null; localTts: any | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener("message", handler);
      reject(new Error(`Timeout waiting for audio (${timeoutMs}ms)`));
    }, timeoutMs);

    function handler(data: WebSocket.Data) {
      if (Buffer.isBuffer(data)) {
        clearTimeout(timer);
        ws.removeListener("message", handler);
        resolve({ binary: data, localTts: null });
        return;
      }
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "local_tts") {
          clearTimeout(timer);
          ws.removeListener("message", handler);
          resolve({ binary: null, localTts: msg });
        }
      } catch {}
    }
    ws.on("message", handler);
  });
}

function hasAudioFile(name: string): boolean {
  return existsSync(resolve(AUDIO_DIR, `${name}.wav`));
}

// ═══════════════════════════════════════
// STT Tests
// ═══════════════════════════════════════

async function testSttShort() {
  if (!hasAudioFile("short")) { skip("STT short speech (~5s)", "short.wav missing"); return; }
  const ws = await connectWs();
  try {
    const start = Date.now();
    ws.send("test:audio:short");
    const result = await waitForMessage(ws, (m) => m.type === "test_result" && m.test === "audio", 20000);
    const elapsed = Date.now() - start;
    const ok = result.text && result.text.length > 10;
    report("STT short speech (~5s)", ok, ok ? `"${result.text.slice(0, 80)}" (${elapsed}ms)` : `error: ${result.error || "empty"}`);
  } finally { ws.close(); }
}

async function testSttMedium() {
  if (!hasAudioFile("medium")) { skip("STT medium speech (~15s)", "medium.wav missing"); return; }
  const ws = await connectWs();
  try {
    const start = Date.now();
    ws.send("test:audio:medium");
    const result = await waitForMessage(ws, (m) => m.type === "test_result" && m.test === "audio", 30000);
    const elapsed = Date.now() - start;
    const ok = result.text && result.text.length > 30;
    report("STT medium speech (~15s)", ok, ok ? `"${result.text.slice(0, 80)}..." (${elapsed}ms)` : `error: ${result.error || "empty"}`);
  } finally { ws.close(); }
}

async function testSttLong() {
  if (!hasAudioFile("long")) { skip("STT long speech (~30s)", "long.wav missing"); return; }
  const ws = await connectWs();
  try {
    const start = Date.now();
    ws.send("test:audio:long");
    const result = await waitForMessage(ws, (m) => m.type === "test_result" && m.test === "audio", 45000);
    const elapsed = Date.now() - start;
    const ok = result.text && result.text.length > 50;
    report("STT long speech (~30s)", ok, ok ? `${result.text.length} chars (${elapsed}ms)` : `error: ${result.error || "empty"}`);
  } finally { ws.close(); }
}

async function testSttQuiet() {
  if (!hasAudioFile("quiet")) { skip("STT quiet speech (-20dB)", "quiet.wav missing"); return; }
  const ws = await connectWs();
  try {
    const start = Date.now();
    ws.send("test:audio:quiet");
    const result = await waitForMessage(ws, (m) => m.type === "test_result" && m.test === "audio", 20000);
    const elapsed = Date.now() - start;
    // loudnorm should boost this enough to transcribe
    const ok = result.text && result.text.length > 10;
    report("STT quiet speech (-20dB)", ok, ok ? `"${result.text.slice(0, 60)}" (${elapsed}ms)` : `got: "${result.text || ""}" — loudnorm may not have boosted enough`);
  } finally { ws.close(); }
}

async function testSttSpeechWithPauses() {
  if (!hasAudioFile("speech-with-pauses")) { skip("STT speech with 3s pause", "speech-with-pauses.wav missing"); return; }
  const ws = await connectWs();
  try {
    const start = Date.now();
    ws.send("test:audio:speech-with-pauses");
    const result = await waitForMessage(ws, (m) => m.type === "test_result" && m.test === "audio", 30000);
    const elapsed = Date.now() - start;
    // Should transcribe both parts despite the gap
    const ok = result.text && result.text.length > 20;
    report("STT speech with 3s pause", ok, ok ? `"${result.text.slice(0, 80)}..." (${elapsed}ms)` : `error: ${result.error || "empty"}`);
  } finally { ws.close(); }
}

// ═══════════════════════════════════════
// Rejection Tests
// ═══════════════════════════════════════

async function testSilenceRejection() {
  if (!hasAudioFile("silence")) { skip("Silence rejection (10s)", "silence.wav missing"); return; }
  const ws = await connectWs();
  try {
    ws.send("test:audio:silence");
    const result = await waitForMessage(ws, (m) =>
      (m.type === "test_result" && m.test === "audio") ||
      (m.type === "voice_status" && m.state === "blank"),
      20000
    );
    const ok = result.type === "voice_status" || (result.type === "test_result" && !result.text);
    report("Silence rejection (10s)", ok, result.type === "voice_status" ? "blank status" : `text="${result.text || "null"}"`);
  } finally { ws.close(); }
}

async function testNoiseRejection() {
  if (!hasAudioFile("noise")) { skip("Noise rejection (10s pink)", "noise.wav missing"); return; }
  const ws = await connectWs();
  try {
    ws.send("test:audio:noise");
    const result = await waitForMessage(ws, (m) =>
      (m.type === "test_result" && m.test === "audio") ||
      (m.type === "voice_status" && m.state === "blank"),
      20000
    );
    const ok = result.type === "voice_status" || (result.type === "test_result" && (!result.text || result.text.length < 5));
    report("Noise rejection (10s pink)", ok, result.type === "voice_status" ? "blank status" : `text="${result.text || "null"}"`);
  } finally { ws.close(); }
}

// ═══════════════════════════════════════
// TTS Tests
// ═══════════════════════════════════════

async function testTtsShort() {
  const ws = await connectWs();
  try {
    const start = Date.now();
    ws.send("test:tts:The answer is forty-two.");
    const audio = await waitForAudio(ws, 15000);
    const elapsed = Date.now() - start;
    if (audio.binary) {
      report("TTS short text", audio.binary.length > 100, `${audio.binary.length} bytes (${elapsed}ms)`);
    } else {
      report("TTS short text", true, `local_tts (${elapsed}ms)`);
    }
  } finally { ws.close(); }
}

async function testTtsLong() {
  const ws = await connectWs();
  try {
    const longText = "Here is a detailed explanation of how WebSocket connections work. " +
      "When a client wants to establish a WebSocket connection, it starts with an HTTP upgrade request. " +
      "The server responds with a 101 status code, and from that point on, the connection is upgraded to a full-duplex WebSocket channel. " +
      "Both sides can send messages at any time without waiting for a request-response cycle. " +
      "This makes WebSockets ideal for real-time applications like chat, live dashboards, and voice interfaces.";
    const start = Date.now();
    ws.send("test:tts:" + longText);
    const audio = await waitForAudio(ws, 30000);
    const elapsed = Date.now() - start;
    if (audio.binary) {
      report("TTS long text (~5 sentences)", audio.binary.length > 1000, `${audio.binary.length} bytes (${elapsed}ms)`);
    } else {
      report("TTS long text (~5 sentences)", true, `local_tts (${elapsed}ms)`);
    }
  } finally { ws.close(); }
}

// ═══════════════════════════════════════
// Text Input Tests (typed text → server processing)
// ═══════════════════════════════════════

async function testTextInput() {
  const ws = await connectWs();
  try {
    // Send typed text like the UI does
    ws.send("text:What is the capital of France?");
    // Server should broadcast a transcription entry for the user input
    const entry = await waitForMessage(ws, (m) =>
      (m.type === "entry" && m.role === "user") ||
      (m.type === "transcription" && m.role === "user"),
      5000
    );
    const ok = !!entry;
    report("Text input accepted by server", ok, entry ? `type=${entry.type}, text="${(entry.text || "").slice(0, 40)}"` : "no entry received");
  } finally { ws.close(); }
}

async function testTextInputTriggersState() {
  const ws = await connectWs();
  try {
    // Collect voice_status messages for a few seconds after sending text
    const statesPromise = collectMessages(ws, (m) => m.type === "voice_status", 8000);
    ws.send("text:Hello world");
    const states = await statesPromise;
    const stateNames = states.map((s: any) => s.state);
    // After text input, server should transition through some states (thinking at minimum if tmux is active)
    report("Text input triggers state transitions", stateNames.length > 0,
      stateNames.length > 0 ? `states: ${stateNames.join("→")}` : "no state changes — tmux/Claude may not be running");
  } finally { ws.close(); }
}

// ═══════════════════════════════════════
// Full Cycle Test
// ═══════════════════════════════════════

async function testFullCycle() {
  const ws = await connectWs();
  try {
    const states: string[] = [];
    const stateHandler = (data: WebSocket.Data) => {
      if (Buffer.isBuffer(data)) return;
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "voice_status") states.push(msg.state);
      } catch {}
    };
    ws.on("message", stateHandler);

    ws.send("test:cycle:Testing one two three. This is a full pipeline cycle with a longer sentence to produce more audio.");
    const audio = await waitForAudio(ws, 25000);
    ws.removeListener("message", stateHandler);

    const hasThinking = states.includes("thinking");
    const hasResponding = states.includes("responding");
    const hasSpeaking = states.includes("speaking");
    const audioOk = audio.binary ? audio.binary.length > 100 : !!audio.localTts;
    const ok = hasThinking && hasResponding && hasSpeaking && audioOk;
    const audioDetail = audio.binary ? `audio: ${audio.binary.length}b` : "audio: local_tts";
    report("Full cycle (think→respond→TTS)", ok, `states: ${states.join("→")}, ${audioDetail}`);
  } finally { ws.close(); }
}

// ═══════════════════════════════════════
// Debug Endpoint Tests
// ═══════════════════════════════════════

async function testDebugEndpoints() {
  try {
    const [debugRes, pipelineRes, logRes, wsLogRes] = await Promise.all([
      fetch("http://localhost:3457/debug").then(r => ({ ok: r.ok, status: r.status })),
      fetch("http://localhost:3457/debug/pipeline").then(r => ({ ok: r.ok, status: r.status })),
      fetch("http://localhost:3457/debug/log").then(r => ({ ok: r.ok, status: r.status })),
      fetch("http://localhost:3457/debug/ws-log").then(r => ({ ok: r.ok, status: r.status })),
    ]);
    const allOk = debugRes.ok && pipelineRes.ok && logRes.ok && wsLogRes.ok;
    report("Debug endpoints respond", allOk,
      `/debug=${debugRes.status} /debug/pipeline=${pipelineRes.status} /debug/log=${logRes.status} /debug/ws-log=${wsLogRes.status}`);
  } catch (err) {
    report("Debug endpoints respond", false, (err as Error).message);
  }
}

// --- Runner ---

async function main() {
  console.log("\n  Murmur Audio Pipeline Tests\n  ───────────────────────────\n");

  // Check server is running
  try {
    const ws = new WebSocket(WS_URL);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => { ws.close(); resolve(); });
      ws.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 3000);
    });
  } catch {
    console.error("  ✗ Server not running on localhost:3457\n");
    process.exit(1);
  }

  console.log("  ── STT Tests ──\n");
  await testSttShort();
  await testSttMedium();
  await testSttLong();
  await testSttQuiet();
  await testSttSpeechWithPauses();

  console.log("\n  ── Rejection Tests ──\n");
  await testSilenceRejection();
  await testNoiseRejection();

  console.log("\n  ── TTS Tests ──\n");
  await testTtsShort();
  await testTtsLong();

  console.log("\n  ── Text Input Tests ──\n");
  await testTextInput();
  await testTextInputTriggersState();

  console.log("\n  ── Integration Tests ──\n");
  await testFullCycle();
  await testDebugEndpoints();

  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  console.log(`\n  ${passed}/${total} passed\n`);
  process.exit(passed === total ? 0 : 1);
}

main();
