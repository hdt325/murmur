/**
 * Audio pipeline tests — exercises STT/TTS round-trips via WebSocket.
 * Requires: server running on localhost:3457, Whisper STT on :2022, Kokoro TTS on :8880
 *
 * Run:  npx tsx tests/test-audio-pipeline.ts
 */

import WebSocket from "ws";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const WS_URL = "ws://localhost:3457";
const AUDIO_DIR = resolve(import.meta.dirname!, "test-audio");
const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

interface TestResult { name: string; ok: boolean; detail?: string }
const results: TestResult[] = [];

function report(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? PASS : FAIL}  ${name}${detail ? ` ${DIM}(${detail})${RESET}` : ""}`);
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
      // Skip binary
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

function waitForBinary(ws: WebSocket, timeoutMs = 15000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener("message", handler);
      reject(new Error(`Timeout waiting for binary (${timeoutMs}ms)`));
    }, timeoutMs);

    function handler(data: WebSocket.Data) {
      if (Buffer.isBuffer(data)) {
        clearTimeout(timer);
        ws.removeListener("message", handler);
        resolve(data);
      }
    }
    ws.on("message", handler);
  });
}

// --- Tests ---

async function testSttRoundTrip() {
  const audioFile = resolve(AUDIO_DIR, "speech-48k.wav");
  if (!existsSync(audioFile)) {
    report("STT round-trip", false, "speech-48k.wav not found — run generate-test-audio.ts first");
    return;
  }

  const ws = await connectWs();
  try {
    const start = Date.now();
    ws.send("test:audio:speech-48k");
    const result = await waitForMessage(ws, (m) => m.type === "test_result" && m.test === "audio");
    const elapsed = Date.now() - start;
    const ok = result.text && result.text.length > 0;
    report("STT round-trip", ok, ok ? `"${result.text.slice(0, 60)}" (${elapsed}ms)` : `error: ${result.error || "empty"}`);
  } finally {
    ws.close();
  }
}

async function testSilenceRejection() {
  const audioFile = resolve(AUDIO_DIR, "silence-48k.wav");
  if (!existsSync(audioFile)) {
    report("Silence rejection", false, "silence-48k.wav not found");
    return;
  }

  const ws = await connectWs();
  try {
    ws.send("test:audio:silence-48k");
    const result = await waitForMessage(ws, (m) =>
      (m.type === "test_result" && m.test === "audio") ||
      (m.type === "voice_status" && m.state === "blank")
    );
    const ok = result.type === "voice_status" || (result.type === "test_result" && !result.text);
    report("Silence rejection", ok, result.type === "voice_status" ? "blank status" : `text=${result.text || "null"}`);
  } finally {
    ws.close();
  }
}

async function testNoiseRejection() {
  const audioFile = resolve(AUDIO_DIR, "noise-48k.wav");
  if (!existsSync(audioFile)) {
    report("Noise rejection", false, "noise-48k.wav not found");
    return;
  }

  const ws = await connectWs();
  try {
    ws.send("test:audio:noise-48k");
    const result = await waitForMessage(ws, (m) =>
      (m.type === "test_result" && m.test === "audio") ||
      (m.type === "voice_status" && m.state === "blank")
    );
    const ok = result.type === "voice_status" || (result.type === "test_result" && !result.text);
    report("Noise rejection", ok, result.type === "voice_status" ? "blank status" : `text=${result.text || "null"}`);
  } finally {
    ws.close();
  }
}

async function testTtsRoundTrip() {
  const ws = await connectWs();
  try {
    const start = Date.now();
    ws.send("test:tts:Hello world, this is a test.");
    const audio = await waitForBinary(ws);
    const elapsed = Date.now() - start;
    report("TTS round-trip", audio.length > 100, `${audio.length} bytes (${elapsed}ms)`);
  } finally {
    ws.close();
  }
}

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

    ws.send("test:cycle:Testing one two three. This is a full pipeline cycle.");
    // Wait for TTS audio
    const audio = await waitForBinary(ws, 20000);
    ws.removeListener("message", stateHandler);

    const hasThinking = states.includes("thinking");
    const hasResponding = states.includes("responding");
    const hasSpeaking = states.includes("speaking");
    const ok = hasThinking && hasResponding && hasSpeaking && audio.length > 100;
    report("Full cycle (think→respond→TTS)", ok, `states: ${states.join("→")}, audio: ${audio.length}b`);
  } finally {
    ws.close();
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

  await testSttRoundTrip();
  await testSilenceRejection();
  await testNoiseRejection();
  await testTtsRoundTrip();
  await testFullCycle();

  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  console.log(`\n  ${passed}/${total} passed\n`);
  process.exit(passed === total ? 0 : 1);
}

main();
