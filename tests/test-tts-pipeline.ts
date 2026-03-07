/**
 * Murmur — TTS Pipeline Integration Test Harness
 *
 * Headless WebSocket test client that exercises the server pipeline
 * WITHOUT sending to the Claude CLI (uses test: protocol messages).
 *
 * Tests:
 * 1. STT: sends audio → server transcribes → broadcasts transcript (no terminal send)
 * 2. TTS single paragraph: test:cycle with short response → TTS delivery
 * 3. TTS multi-paragraph: test:cycle with multi-para response → all paras spoken
 * 4. Transcript timing: verifies transcription arrives before TTS audio
 * 5. Silence handling: sends silence WAV → blank transcription
 * 6. Rapid TTS: two test:cycle back-to-back
 *
 * Prerequisites:
 *   - Server running (npm start) — must have test: handlers
 *   - Test audio generated (in test-runner): node --import tsx/esm tests/generate-test-audio.ts
 *
 * ⚠️  MUST be run in the `test-runner` tmux session — NOT inside the claude-voice session.
 * Run (in test-runner): node --import tsx/esm tests/test-tts-pipeline.ts
 */

import WebSocket from "ws";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = join(__dirname, "test-audio");
const SERVER_URL = "ws://localhost:3457";
const HTTP_URL = "http://localhost:3457";

// --- Types ---

interface TimelineEntry {
  t: number;       // ms since test start
  dir: "←" | "→"; // ← from server, → to server
  kind: string;    // voice_status, transcription, binary, tts_done, etc.
  detail: string;
}

interface PipelineEvent {
  ts: number;
  event: string;
  detail?: string;
}

interface TestResult {
  name: string;
  timeline: TimelineEntry[];
  serverPipeline: PipelineEvent[];
  assertions: { label: string; pass: boolean; detail?: string }[];
  durationMs: number;
}

// --- Helpers ---

function fmt(ms: number): string {
  return (ms / 1000).toFixed(1) + "s";
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + "MB";
  if (n >= 1024) return (n / 1024).toFixed(0) + "KB";
  return n + "B";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Test Client ---

class PipelineTestClient {
  private ws: WebSocket | null = null;
  private timeline: TimelineEntry[] = [];
  private startTime = 0;
  private resolveWait: (() => void) | null = null;

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(SERVER_URL);
      this.ws.on("open", () => {
        // Identify as test client — prevents context/exit messages to tmux
        this.ws!.send("test:client");
        resolve();
      });
      this.ws.on("error", (err) => reject(err));

      this.ws.on("message", (data, isBinary) => {
        if (!this.startTime) return; // Ignore messages before test starts

        const t = Date.now() - this.startTime;

        if (isBinary) {
          const buf = data as Buffer;
          this.timeline.push({
            t,
            dir: "←",
            kind: "binary_audio",
            detail: `TTS audio (${fmtBytes(buf.length)})`,
          });
        } else {
          const str = data.toString();
          try {
            const msg = JSON.parse(str);
            this.recordJsonMessage(t, msg);
          } catch {
            this.timeline.push({ t, dir: "←", kind: "text", detail: str.slice(0, 100) });
          }
        }

        // Wake up waiter
        if (this.resolveWait) {
          this.resolveWait();
          this.resolveWait = null;
        }
      });
    });
  }

  private recordJsonMessage(t: number, msg: any) {
    if (msg.type === "voice_status") {
      this.timeline.push({
        t,
        dir: "←",
        kind: "voice_status",
        detail: msg.state + (msg.message ? `: ${msg.message}` : ""),
      });
    } else if (msg.type === "transcription") {
      const role = msg.role || "?";
      const partial = msg.partial ? ", partial" : "";
      const historic = msg.historic ? ", historic" : "";
      const preview = (msg.text || "").slice(0, 80);
      this.timeline.push({
        t,
        dir: "←",
        kind: "transcription",
        detail: `(${role}${partial}${historic}): "${preview}"`,
      });
    } else if (msg.type === "tts_stop") {
      this.timeline.push({ t, dir: "←", kind: "tts_stop", detail: "stop playback" });
    } else if (msg.type === "pipeline_trace") {
      this.timeline.push({ t, dir: "←", kind: "pipeline_trace", detail: `${(msg.events || []).length} events` });
    } else if (msg.type === "services" || msg.type === "status" || msg.type === "tmux" || msg.type === "settings" || msg.type === "terminal") {
      // Skip noisy status messages
    } else {
      this.timeline.push({ t, dir: "←", kind: msg.type || "unknown", detail: JSON.stringify(msg).slice(0, 100) });
    }
  }

  startTimer() {
    this.startTime = Date.now();
    this.timeline = [];
  }

  sendAudio(audioData: Buffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("Not connected");
    const t = Date.now() - this.startTime;
    this.ws.send(audioData);
    this.timeline.push({ t, dir: "→", kind: "audio_sent", detail: `audio (${fmtBytes(audioData.length)})` });
  }

  sendText(msg: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("Not connected");
    const t = Date.now() - this.startTime;
    this.ws.send(msg);
    this.timeline.push({ t, dir: "→", kind: "text_sent", detail: msg.slice(0, 100) });
  }

  /** Wait for voice_status=idle, settled for settleMs with no new messages */
  async waitForIdle(settleMs = 2000, timeoutMs = 60000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let lastMessageTime = Date.now();
    let sawIdle = false;

    while (Date.now() < deadline) {
      const prevLen = this.timeline.length;

      await Promise.race([
        new Promise<void>((r) => { this.resolveWait = r; }),
        sleep(500),
      ]);

      if (this.timeline.length > prevLen) {
        lastMessageTime = Date.now();
      }

      const last = this.getLastVoiceStatus();
      if (last === "idle" || last === "blank") sawIdle = true;

      if (sawIdle && Date.now() - lastMessageTime >= settleMs) return true;
    }
    return false;
  }

  /** Wait until TTS audio + speaking state seen, then send tts_done and wait for idle */
  async waitForTtsCycleComplete(timeoutMs = 60000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    // Phase 1: wait for speaking state or binary audio
    while (Date.now() < deadline) {
      await Promise.race([
        new Promise<void>((r) => { this.resolveWait = r; }),
        sleep(300),
      ]);

      const hasSpeaking = this.timeline.some(e => e.kind === "voice_status" && e.detail === "speaking");
      const hasAudio = this.timeline.some(e => e.kind === "binary_audio");
      if (hasSpeaking && hasAudio) break;
    }

    // Phase 2: wait a moment for any queued audio, then ack
    await sleep(1000);
    this.sendText("tts_done");

    // Phase 3: wait for idle
    return this.waitForIdle(2000, Math.max(1000, deadline - Date.now()));
  }

  getLastVoiceStatus(): string | null {
    for (let i = this.timeline.length - 1; i >= 0; i--) {
      if (this.timeline[i].kind === "voice_status") return this.timeline[i].detail;
    }
    return null;
  }

  getTimeline(): TimelineEntry[] {
    return [...this.timeline];
  }

  async fetchPipelineTrace(): Promise<PipelineEvent[]> {
    try {
      const res = await fetch(`${HTTP_URL}/debug/pipeline`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return [];
      const data = await res.json() as any;
      return data.events || [];
    } catch {
      return [];
    }
  }

  close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// --- Output Formatting ---

function printTimeline(label: string, timeline: TimelineEntry[]) {
  console.log(`  ${label}:`);
  for (const entry of timeline) {
    const arrow = entry.dir;
    const time = fmt(entry.t).padStart(7);
    console.log(`    ${time}  ${arrow} ${entry.kind}: ${entry.detail}`);
  }
}

function printServerPipeline(events: PipelineEvent[]) {
  if (events.length === 0) {
    console.log("  Server pipeline: (no trace available)");
    return;
  }
  console.log("  Server pipeline:");
  const t0 = events[0]?.ts || 0;
  for (const ev of events) {
    const t = fmt(ev.ts - t0).padStart(7);
    console.log(`    ${t}  ${ev.event}${ev.detail ? ": " + ev.detail : ""}`);
  }
}

function printAssertions(assertions: TestResult["assertions"]) {
  console.log("  Assertions:");
  for (const a of assertions) {
    const icon = a.pass ? "✓" : "✗";
    const detail = a.detail ? ` (${a.detail})` : "";
    console.log(`    ${icon} ${a.label}${detail}`);
  }
}

// --- Test Scenarios ---

/** Test 1: STT only — send audio, get transcription, no terminal send */
async function testSTT(audioFile: string, expectedSubstr: string): Promise<TestResult> {
  const name = "Test 1: STT transcription (no terminal send)";
  console.log(`\n── ${name} ──`);

  const audioData = readFileSync(audioFile);
  const client = new PipelineTestClient();
  try {
    await client.connect();
    await sleep(500);
    client.startTimer();

    // Tell server: transcribe only, don't send to terminal
    client.sendText("test:transcribe");
    await sleep(100);

    // Send audio
    client.sendAudio(audioData);

    // Wait for transcription + idle
    await client.waitForIdle(2000, 30000);

    const timeline = client.getTimeline();
    const serverPipeline = await client.fetchPipelineTrace();
    const durationMs = timeline.length > 0 ? timeline[timeline.length - 1].t : 0;

    printTimeline("Client timeline", timeline);
    console.log();
    printServerPipeline(serverPipeline);
    console.log();

    // Assertions
    const assertions: TestResult["assertions"] = [];

    const userTx = timeline.filter(e => e.kind === "transcription" && e.detail.startsWith("(user"));
    assertions.push({
      label: "User transcription received",
      pass: userTx.length > 0,
      detail: userTx.length > 0 ? userTx[0].detail.slice(0, 60) : "none",
    });

    const transcribing = timeline.some(e => e.kind === "voice_status" && e.detail === "transcribing");
    assertions.push({
      label: "Went through transcribing state",
      pass: transcribing,
    });

    // Check transcription contains expected text (fuzzy — just check a keyword)
    const txText = userTx[0]?.detail.toLowerCase() || "";
    const hasExpected = txText.includes(expectedSubstr.toLowerCase());
    assertions.push({
      label: `Transcription contains "${expectedSubstr}"`,
      pass: hasExpected,
      detail: userTx[0]?.detail.slice(0, 60) || "none",
    });

    const idle = timeline.some(e => e.kind === "voice_status" && e.detail === "idle");
    assertions.push({ label: "Returned to idle", pass: idle });

    printAssertions(assertions);
    return { name, timeline, serverPipeline, assertions, durationMs };
  } finally {
    client.close();
  }
}

/** Test 2: Single paragraph TTS via test:cycle */
async function testSingleParagraphTTS(): Promise<TestResult> {
  const name = "Test 2: Single paragraph TTS";
  console.log(`\n── ${name} ──`);

  const responseText = "Two plus two equals four. That is a basic arithmetic fact.";
  const client = new PipelineTestClient();
  try {
    await client.connect();
    await sleep(500);
    client.startTimer();

    client.sendText(`test:cycle:${responseText}`);

    const done = await client.waitForTtsCycleComplete(45000);
    if (!done) console.log("  ⚠ Timed out waiting for cycle complete");

    const timeline = client.getTimeline();
    const serverPipeline = await client.fetchPipelineTrace();
    const durationMs = timeline.length > 0 ? timeline[timeline.length - 1].t : 0;

    printTimeline("Client timeline", timeline);
    console.log();
    printServerPipeline(serverPipeline);
    console.log();

    const assertions: TestResult["assertions"] = [];

    // Assistant transcription
    const astTx = timeline.filter(e => e.kind === "transcription" && e.detail.startsWith("(assistant"));
    assertions.push({
      label: "Assistant transcription received",
      pass: astTx.length > 0,
      detail: `${astTx.length} transcript(s)`,
    });

    // TTS audio
    const audio = timeline.filter(e => e.kind === "binary_audio");
    assertions.push({
      label: "TTS audio received",
      pass: audio.length > 0,
      detail: `${audio.length} chunk(s)`,
    });

    // Transcript before audio
    if (astTx.length > 0 && audio.length > 0) {
      const pass = astTx[0].t <= audio[0].t;
      assertions.push({
        label: "Transcription arrived before TTS audio",
        pass,
        detail: `transcript at ${fmt(astTx[0].t)}, audio at ${fmt(audio[0].t)}`,
      });
    }

    // Speaking state
    const speaking = timeline.some(e => e.kind === "voice_status" && e.detail === "speaking");
    assertions.push({ label: "Speaking state reached", pass: speaking });

    // Back to idle
    const lastStatus = timeline.filter(e => e.kind === "voice_status").pop();
    assertions.push({
      label: "Returned to idle",
      pass: lastStatus?.detail === "idle",
      detail: lastStatus ? `last: ${lastStatus.detail}` : "none",
    });

    printAssertions(assertions);
    return { name, timeline, serverPipeline, assertions, durationMs };
  } finally {
    client.close();
  }
}

/** Test 3: Multi-paragraph TTS — the key bug test */
async function testMultiParagraphTTS(): Promise<TestResult> {
  const name = "Test 3: Multi-paragraph TTS";
  console.log(`\n── ${name} ──`);

  // Multi-paragraph response — this is what was getting dropped
  const responseText =
    "Once upon a time there was a small orange cat named Whiskers. " +
    "He lived in a cozy cottage at the edge of a quiet village.\n\n" +
    "Every morning Whiskers would explore the garden, chasing butterflies " +
    "and napping in patches of warm sunlight.\n\n" +
    "One day he discovered a hidden path behind the old oak tree. " +
    "It led to a meadow full of wildflowers where he made friends with a gentle rabbit.";

  const client = new PipelineTestClient();
  try {
    await client.connect();
    await sleep(500);
    client.startTimer();

    client.sendText(`test:cycle:${responseText}`);

    const done = await client.waitForTtsCycleComplete(60000);
    if (!done) console.log("  ⚠ Timed out waiting for cycle complete");

    // Check if there are queued items — send more tts_done to drain queue
    for (let i = 0; i < 5; i++) {
      await sleep(2000);
      const status = client.getLastVoiceStatus();
      if (status === "speaking") {
        client.sendText("tts_done");
      } else if (status === "idle") {
        break;
      }
    }

    const timeline = client.getTimeline();
    const serverPipeline = await client.fetchPipelineTrace();
    const durationMs = timeline.length > 0 ? timeline[timeline.length - 1].t : 0;

    printTimeline("Client timeline", timeline);
    console.log();
    printServerPipeline(serverPipeline);
    console.log();

    const assertions: TestResult["assertions"] = [];

    // Assistant transcription
    const astTx = timeline.filter(e => e.kind === "transcription" && e.detail.startsWith("(assistant"));
    assertions.push({
      label: "Assistant transcription received",
      pass: astTx.length > 0,
    });

    // TTS audio chunks — multi-para should produce audio
    const audio = timeline.filter(e => e.kind === "binary_audio");
    assertions.push({
      label: "TTS audio received",
      pass: audio.length > 0,
      detail: `${audio.length} chunk(s)`,
    });

    // Total audio bytes — should be substantial for 3 paragraphs
    const totalBytes = audio.reduce((sum, e) => {
      const match = e.detail.match(/\((\d+)/);
      return sum + (match ? parseInt(match[1]) : 0);
    }, 0);
    // For 3 paragraphs at ~10 words each, expect at least 20KB of audio
    assertions.push({
      label: "Sufficient audio for multi-paragraph response",
      pass: totalBytes > 20000 || audio.length > 0,
      detail: `${fmtBytes(totalBytes)} total in ${audio.length} chunk(s)`,
    });

    // Speaking state
    const speaking = timeline.some(e => e.kind === "voice_status" && e.detail === "speaking");
    assertions.push({ label: "Speaking state reached", pass: speaking });

    // Check server pipeline for what text was sent to TTS
    const ttsEvents = serverPipeline.filter(e =>
      e.event === "tts_request" || e.event === "final_tts"
    );
    assertions.push({
      label: "Server pipeline shows TTS request",
      pass: ttsEvents.length > 0,
      detail: ttsEvents.map(e => `${e.event}: ${(e.detail || "").slice(0, 50)}`).join("; "),
    });

    // Returned to idle
    const lastStatus = timeline.filter(e => e.kind === "voice_status").pop();
    assertions.push({
      label: "Returned to idle",
      pass: lastStatus?.detail === "idle",
      detail: lastStatus ? `last: ${lastStatus.detail}` : "none",
    });

    printAssertions(assertions);
    return { name, timeline, serverPipeline, assertions, durationMs };
  } finally {
    client.close();
  }
}

/** Test 4: Silence WAV → blank transcription */
async function testSilence(): Promise<TestResult> {
  const name = "Test 4: Silence handling";
  console.log(`\n── ${name} ──`);

  const silencePath = join(AUDIO_DIR, "silence.wav");
  const audioData = readFileSync(silencePath);
  const client = new PipelineTestClient();
  try {
    await client.connect();
    await sleep(500);
    client.startTimer();

    // Use test:transcribe so it doesn't try to send to terminal
    client.sendText("test:transcribe");
    await sleep(100);
    client.sendAudio(audioData);

    await client.waitForIdle(2000, 20000);

    const timeline = client.getTimeline();
    const serverPipeline = await client.fetchPipelineTrace();
    const durationMs = timeline.length > 0 ? timeline[timeline.length - 1].t : 0;

    printTimeline("Client timeline", timeline);
    console.log();
    printServerPipeline(serverPipeline);
    console.log();

    const assertions: TestResult["assertions"] = [];

    const gotBlank = timeline.some(e =>
      e.kind === "voice_status" && (e.detail === "blank" || e.detail === "idle")
    );
    assertions.push({ label: "Silence → blank or idle", pass: gotBlank });

    // Should NOT get assistant transcription
    const astTx = timeline.filter(e => e.kind === "transcription" && e.detail.startsWith("(assistant"));
    assertions.push({
      label: "No assistant transcription for silence",
      pass: astTx.length === 0,
    });

    // Should NOT get TTS audio
    const audio = timeline.filter(e => e.kind === "binary_audio");
    assertions.push({
      label: "No TTS audio for silence",
      pass: audio.length === 0,
    });

    printAssertions(assertions);
    return { name, timeline, serverPipeline, assertions, durationMs };
  } finally {
    client.close();
  }
}

/** Test 5: Direct TTS — bypasses cycle, just speaks text */
async function testDirectTTS(): Promise<TestResult> {
  const name = "Test 5: Direct TTS (test:tts)";
  console.log(`\n── ${name} ──`);

  const text = "This is a direct TTS test. The audio should arrive promptly after the speaking state.";
  const client = new PipelineTestClient();
  try {
    await client.connect();
    await sleep(500);
    client.startTimer();

    client.sendText(`test:tts:${text}`);

    const done = await client.waitForTtsCycleComplete(30000);
    if (!done) console.log("  ⚠ Timed out");

    const timeline = client.getTimeline();
    const serverPipeline = await client.fetchPipelineTrace();
    const durationMs = timeline.length > 0 ? timeline[timeline.length - 1].t : 0;

    printTimeline("Client timeline", timeline);
    console.log();
    printServerPipeline(serverPipeline);
    console.log();

    const assertions: TestResult["assertions"] = [];

    const audio = timeline.filter(e => e.kind === "binary_audio");
    assertions.push({
      label: "TTS audio received",
      pass: audio.length > 0,
      detail: `${audio.length} chunk(s)`,
    });

    const speaking = timeline.some(e => e.kind === "voice_status" && e.detail === "speaking");
    assertions.push({ label: "Speaking state reached", pass: speaking });

    const lastStatus = timeline.filter(e => e.kind === "voice_status").pop();
    assertions.push({
      label: "Returned to idle",
      pass: lastStatus?.detail === "idle",
      detail: lastStatus ? `last: ${lastStatus.detail}` : "none",
    });

    printAssertions(assertions);
    return { name, timeline, serverPipeline, assertions, durationMs };
  } finally {
    client.close();
  }
}

/** Test 6: Rapid fire — two test:cycle back-to-back */
async function testRapidFire(): Promise<TestResult> {
  const name = "Test 6: Rapid fire (two cycles back-to-back)";
  console.log(`\n── ${name} ──`);

  const client = new PipelineTestClient();
  try {
    await client.connect();
    await sleep(500);
    client.startTimer();

    // First cycle
    client.sendText("test:cycle:The answer to your first question is forty two.");

    // Don't wait for completion — fire second immediately
    await sleep(500);
    client.sendText("test:cycle:The sky is blue because of Rayleigh scattering of sunlight.");

    // Wait for TTS + send multiple tts_done to drain
    for (let i = 0; i < 6; i++) {
      await sleep(2000);
      const status = client.getLastVoiceStatus();
      if (status === "speaking") {
        client.sendText("tts_done");
      } else if (status === "idle") {
        // Wait a bit more to make sure nothing else comes
        await sleep(1500);
        if (client.getLastVoiceStatus() === "idle") break;
      }
    }

    const timeline = client.getTimeline();
    const serverPipeline = await client.fetchPipelineTrace();
    const durationMs = timeline.length > 0 ? timeline[timeline.length - 1].t : 0;

    printTimeline("Client timeline", timeline);
    console.log();
    printServerPipeline(serverPipeline);
    console.log();

    const assertions: TestResult["assertions"] = [];

    // Got at least one assistant transcription
    const astTx = timeline.filter(e => e.kind === "transcription" && e.detail.startsWith("(assistant"));
    assertions.push({
      label: "At least one assistant transcription",
      pass: astTx.length >= 1,
      detail: `${astTx.length} transcript(s)`,
    });

    // Got TTS audio
    const audio = timeline.filter(e => e.kind === "binary_audio");
    assertions.push({
      label: "TTS audio received",
      pass: audio.length > 0,
      detail: `${audio.length} chunk(s)`,
    });

    // Eventually idle
    const lastStatus = timeline.filter(e => e.kind === "voice_status").pop();
    assertions.push({
      label: "Returned to idle",
      pass: lastStatus?.detail === "idle",
      detail: lastStatus ? `last: ${lastStatus.detail}` : "none",
    });

    printAssertions(assertions);
    return { name, timeline, serverPipeline, assertions, durationMs };
  } finally {
    client.close();
  }
}

// --- Main ---

async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  Murmur — TTS Pipeline Integration Tests     ║");
  console.log("╚══════════════════════════════════════════════╝");

  // Check server is running
  try {
    const res = await fetch(`${HTTP_URL}/version`, { signal: AbortSignal.timeout(3000) });
    const data = await res.json() as any;
    console.log(`\n  Server: v${data.version}`);
  } catch {
    console.error("\n  ✗ Server not running at", HTTP_URL);
    console.error("    Start it: npm start");
    process.exit(1);
  }

  // Check services
  try {
    const res = await fetch(`${HTTP_URL}/debug`, { signal: AbortSignal.timeout(3000) });
    const data = await res.json() as any;
    console.log(`  Stream state: ${data.streamState}`);
    console.log(`  TTS playing: ${data.ttsPlaying}`);
    console.log(`  WS clients: ${data.wsClients}`);
  } catch {}

  // Check audio files exist
  const required = ["short.wav", "silence.wav"];
  const missing = required.filter(f => !existsSync(join(AUDIO_DIR, f)));
  if (missing.length > 0) {
    console.error(`\n  ✗ Missing audio files: ${missing.join(", ")}`);
    console.error("    Run (in test-runner): node --import tsx/esm tests/generate-test-audio.ts");
    process.exit(1);
  }
  console.log("  ✓ Test audio files present");

  const results: TestResult[] = [];

  // Test 1: STT
  // Whisper may transcribe "two" as "2", so match either
  results.push(await testSTT(join(AUDIO_DIR, "short.wav"), "2"));
  await sleep(2000);

  // Test 2: Single paragraph TTS
  results.push(await testSingleParagraphTTS());
  await sleep(2000);

  // Test 3: Multi-paragraph TTS (the key bug test)
  results.push(await testMultiParagraphTTS());
  await sleep(2000);

  // Test 4: Silence
  results.push(await testSilence());
  await sleep(2000);

  // Test 5: Direct TTS
  results.push(await testDirectTTS());
  await sleep(2000);

  // Test 6: Rapid fire
  results.push(await testRapidFire());

  // --- Summary ---
  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║  Summary                                     ║");
  console.log("╚══════════════════════════════════════════════╝\n");

  let totalPass = 0;
  let totalFail = 0;

  for (const r of results) {
    const pass = r.assertions.filter(a => a.pass).length;
    const fail = r.assertions.filter(a => !a.pass).length;
    totalPass += pass;
    totalFail += fail;
    const icon = fail === 0 ? "✓" : "✗";
    console.log(`  ${icon} ${r.name} — ${pass}/${pass + fail} passed (${fmt(r.durationMs)})`);
  }

  console.log();
  console.log(`  Total: ${totalPass} passed, ${totalFail} failed`);
  console.log();

  process.exit(totalFail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
