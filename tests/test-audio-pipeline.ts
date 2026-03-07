/**
 * Audio pipeline tests — exercises STT/TTS round-trips via WebSocket.
 * Requires: server running on localhost:3457, Whisper STT on :2022, Kokoro TTS on :8880
 *
 * ⚠️  MUST be run in the `test-runner` tmux session — NOT inside the claude-voice session.
 * Generate test audio first (in test-runner): node --import tsx/esm tests/generate-test-audio.ts
 * Run (in test-runner):                       node --import tsx/esm tests/test-audio-pipeline.ts
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

function parseMsg(data: WebSocket.Data): any | null {
  try { return JSON.parse(data.toString()); } catch { return null; }
}

function waitForMessage(ws: WebSocket, filter: (msg: any) => boolean, timeoutMs = 15000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener("message", handler);
      reject(new Error(`Timeout waiting for message (${timeoutMs}ms)`));
    }, timeoutMs);

    function handler(data: WebSocket.Data) {
      const msg = parseMsg(data);
      if (!msg) return;
      if (filter(msg)) {
        clearTimeout(timer);
        ws.removeListener("message", handler);
        resolve(msg);
      }
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
      const msg = parseMsg(data);
      if (!msg) return;
      if (filter(msg)) collected.push(msg);
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
      // Try JSON first — server sends JSON as binary frames
      const msg = parseMsg(data);
      if (msg) {
        if (msg.type === "local_tts") {
          clearTimeout(timer);
          ws.removeListener("message", handler);
          resolve({ binary: null, localTts: msg });
        }
        return; // Skip other JSON messages
      }
      // Not JSON — treat as binary audio
      if (Buffer.isBuffer(data)) {
        clearTimeout(timer);
        ws.removeListener("message", handler);
        resolve({ binary: data, localTts: null });
      }
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
    const result = await waitForMessage(ws, (m) => m.type === "test_result" && m.test === "audio", 45000);
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
    const result = await waitForMessage(ws, (m) => m.type === "test_result" && m.test === "audio", 60000);
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
    const result = await waitForMessage(ws, (m) => m.type === "test_result" && m.test === "audio", 90000);
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
    const result = await waitForMessage(ws, (m) => m.type === "test_result" && m.test === "audio", 45000);
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
    const result = await waitForMessage(ws, (m) => m.type === "test_result" && m.test === "audio", 60000);
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
      45000
    );
    const isBlank = !result.text || result.text === "[BLANK_AUDIO]" || result.text.length < 5;
    const ok = result.type === "voice_status" || (result.type === "test_result" && isBlank);
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
      45000
    );
    // Whisper often hallucinates short phantom text for noise (e.g., "(engine revving)", "Thank you.")
    const isBlank = !result.text || result.text === "[BLANK_AUDIO]" || result.text.length < 20;
    const ok = result.type === "voice_status" || (result.type === "test_result" && isBlank);
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
    const audio = await waitForAudio(ws, 20000);
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
// Long Text & Paragraph Tests
// ═══════════════════════════════════════

async function testTtsParagraph() {
  const ws = await connectWs();
  try {
    const paragraph = "The quick brown fox jumps over the lazy dog. " +
      "This sentence contains every letter of the English alphabet at least once. " +
      "It has been used as a typing exercise since at least the late nineteenth century. " +
      "Various alternative pangrams exist, but none are quite as well known. " +
      "Sphinx of black quartz, judge my vow. Pack my box with five dozen liquor jugs. " +
      "How vexingly quick daft zebras jump. The five boxing wizards jump quickly.";
    const start = Date.now();
    ws.send("test:tts:" + paragraph);
    const audio = await waitForAudio(ws, 30000);
    const elapsed = Date.now() - start;
    if (audio.binary) {
      report("TTS full paragraph (8 sentences)", audio.binary.length > 2000,
        `${paragraph.length} chars → ${audio.binary.length} bytes (${elapsed}ms)`);
    } else {
      report("TTS full paragraph (8 sentences)", true,
        `${paragraph.length} chars → local_tts (${elapsed}ms)`);
    }
  } finally { ws.close(); }
}

async function testCycleLongParagraph() {
  const ws = await connectWs();
  try {
    const paragraph = "A closure in JavaScript is a function that retains access to variables " +
      "from its enclosing lexical scope, even after the outer function has finished executing. " +
      "This powerful concept enables data privacy, function factories, and callback patterns. " +
      "For example, a counter function can maintain a private count variable that cannot be " +
      "accessed directly from outside. Each call to the counter increments and returns the value, " +
      "while the variable itself remains safely encapsulated within the closure scope.";

    const states: string[] = [];
    const stateHandler = (data: WebSocket.Data) => {
      const msg = parseMsg(data);
      if (msg && msg.type === "voice_status") states.push(msg.state);
    };
    ws.on("message", stateHandler);

    ws.send("test:cycle:" + paragraph);

    // Wait for transcription with the full text
    const transcription = await waitForMessage(ws, (m) =>
      m.type === "transcription" && m.role === "assistant" && m.text && m.text.length > 100,
      15000
    );
    ws.removeListener("message", stateHandler);

    const textMatch = transcription.text === paragraph;
    const hasStates = states.includes("thinking") && states.includes("responding");
    report("Cycle long paragraph (6 sentences)", textMatch && hasStates,
      `${transcription.text.length} chars, states: ${states.join("→")}`);
  } finally { ws.close(); }
}

async function testCycleMultiSentenceOutput() {
  const ws = await connectWs();
  try {
    const sentences = [
      "First, let me explain the concept of recursion.",
      "Recursion is when a function calls itself to solve smaller instances of the same problem.",
      "Every recursive function needs a base case to prevent infinite loops.",
      "The classic example is computing factorials: factorial of n equals n times factorial of n minus one.",
      "Without a base case where factorial of zero returns one, the function would recurse forever.",
    ];
    const fullText = sentences.join(" ");
    ws.send("test:cycle:" + fullText);

    const transcription = await waitForMessage(ws, (m) =>
      m.type === "transcription" && m.role === "assistant" && m.text,
      15000
    );

    // Verify ALL sentences are present in the output
    const allPresent = sentences.every(s => transcription.text.includes(s));
    const wordCount = transcription.text.split(/\s+/).length;
    report("Cycle multi-sentence output (5 sentences, all present)", allPresent,
      `${wordCount} words, ${transcription.text.length} chars`);
  } finally { ws.close(); }
}

async function testEntriesMultiParagraph() {
  const ws = await connectWs();
  try {
    const paragraphs = [
      "WebSocket is a communication protocol that provides full-duplex channels over a single TCP connection. Unlike HTTP, where the client must initiate every exchange, WebSocket allows both the server and client to send messages independently at any time.",
      "The protocol begins with an HTTP handshake, where the client sends an Upgrade header. If the server accepts, it responds with a 101 Switching Protocols status code. From that point forward, the connection operates as a persistent bidirectional channel.",
      "Common use cases include real-time chat applications, live sports scores, collaborative editing tools, and voice interfaces like this one. The low overhead makes WebSocket significantly more efficient than HTTP polling for real-time data.",
    ];

    const states: string[] = [];
    const entries: any[] = [];
    const handler = (data: WebSocket.Data) => {
      const msg = parseMsg(data);
      if (!msg) return;
      if (msg.type === "voice_status") states.push(msg.state);
      if (msg.type === "entry") entries.push(msg);
    };
    ws.on("message", handler);

    ws.send("test:entries:" + JSON.stringify(paragraphs));

    // Wait for final non-partial entry broadcast
    await waitForMessage(ws, (m) =>
      m.type === "entry" && m.partial === false && m.entries?.length >= 3,
      10000
    );
    await new Promise(r => setTimeout(r, 500));
    ws.removeListener("message", handler);

    // Verify all paragraphs arrived as separate entries (array may have entries from prior tests)
    const lastBroadcast = entries[entries.length - 1];
    const allEntries = lastBroadcast.entries;
    // Check the LAST 3 entries match our paragraphs (prior tests may have added entries too)
    const tail = allEntries.slice(-paragraphs.length);
    const allTextsMatch = paragraphs.every((p: string, i: number) =>
      tail[i] && tail[i].text === p
    );
    const allSpeakable = tail.every((e: any) => e.speakable === true);
    const allAssistant = tail.every((e: any) => e.role === "assistant");
    const hasThinking = states.includes("thinking");
    const hasResponding = states.includes("responding");

    report("Multi-paragraph entries (3 paragraphs via entry system)",
      allTextsMatch && allSpeakable && allAssistant,
      `${tail.length}/${allEntries.length} entries matched, speakable=${allSpeakable}, states: ${states.join("→")}`);
    report("Entry system state transitions (thinking→responding→idle)", hasThinking && hasResponding,
      `states: ${states.join("→")}`);
  } finally { ws.close(); }
}

async function testEntriesLongParagraph() {
  const ws = await connectWs();
  try {
    // Single very long paragraph (500+ chars)
    const longPara = "In the field of distributed systems, the CAP theorem states that it is impossible " +
      "for a distributed data store to simultaneously provide more than two out of the following three " +
      "guarantees: consistency, which means every read receives the most recent write or an error; " +
      "availability, which means every request receives a non-error response without guarantee that it " +
      "contains the most recent write; and partition tolerance, which means the system continues to " +
      "operate despite an arbitrary number of messages being dropped or delayed by the network between " +
      "nodes. This theorem, proven by Eric Brewer in 2000 and formally proved by Seth Gilbert and " +
      "Nancy Lynch in 2002, has profound implications for the design of modern cloud-native applications " +
      "and microservice architectures that must handle network partitions gracefully.";

    ws.send("test:entries:" + JSON.stringify([longPara]));

    const result = await waitForMessage(ws, (m) =>
      m.type === "entry" && m.partial === false,
      10000
    );

    const lastEntry = result.entries[result.entries.length - 1];
    const textMatch = lastEntry.text === longPara;
    const charCount = lastEntry.text.length;
    report("Single long paragraph entry (500+ chars)", textMatch && charCount > 500,
      `${charCount} chars, text match=${textMatch}`);
  } finally { ws.close(); }
}

// ═══════════════════════════════════════
// Interactive Prompt / Multiple Choice Tests
// ═══════════════════════════════════════

async function testInteractivePrompt() {
  const ws = await connectWs();
  try {
    const choices = {
      question: "Which approach would you like me to take?",
      options: [
        "Create a new file with the implementation",
        "Modify the existing file to add the feature",
        "Show me a diff of the proposed changes first",
      ],
    };

    const promptPromise = waitForMessage(ws, (m) =>
      m.type === "interactive_prompt" && m.active === true,
      8000
    );
    ws.send("test:interactive:" + JSON.stringify(choices));
    const prompt = await promptPromise;

    report("Interactive prompt broadcasts active=true", prompt.active === true);
  } finally { ws.close(); }
}

async function testInteractivePromptEntries() {
  const ws = await connectWs();
  try {
    const choices = {
      question: "How would you like to handle the database migration?",
      options: [
        "Run migration automatically with rollback support",
        "Generate SQL script for manual review",
        "Skip migration and update code to handle both schemas",
        "Cancel and revert the schema change",
      ],
    };

    ws.send("test:interactive:" + JSON.stringify(choices));

    const entryMsg = await waitForMessage(ws, (m) =>
      m.type === "entry" && m.partial === false,
      8000
    );

    // Verify the entry contains the question and all options
    const lastEntry = entryMsg.entries[entryMsg.entries.length - 1];
    const hasQuestion = lastEntry.text.includes(choices.question);
    const hasAllOptions = choices.options.every((opt: string) => lastEntry.text.includes(opt));
    const hasNumbering = /❯ 1\./.test(lastEntry.text) && /❯ 2\./.test(lastEntry.text);

    report("Interactive prompt entry has question + all 4 options",
      hasQuestion && hasAllOptions && hasNumbering,
      `${lastEntry.text.length} chars, options=${choices.options.length}`);
  } finally { ws.close(); }
}

async function testInteractivePromptFormat() {
  const ws = await connectWs();
  try {
    const choices = {
      question: "Select the testing framework to use:",
      options: ["Jest with React Testing Library", "Vitest with happy-dom", "Playwright for E2E only"],
    };

    ws.send("test:interactive:" + JSON.stringify(choices));

    const entryMsg = await waitForMessage(ws, (m) =>
      m.type === "entry" && m.partial === false,
      8000
    );

    const lastEntry = entryMsg.entries[entryMsg.entries.length - 1];
    // Verify numbered format: ❯ 1. Option, ❯ 2. Option, ❯ 3. Option
    const lines = lastEntry.text.split("\n");
    const numberedLines = lines.filter((l: string) => /^❯ \d+\.\s/.test(l));

    report("Interactive prompt uses ❯ numbered format",
      numberedLines.length === choices.options.length,
      `${numberedLines.length}/${choices.options.length} numbered lines: ${numberedLines.map((l: string) => l.slice(0, 30)).join(" | ")}`);
  } finally { ws.close(); }
}

// ═══════════════════════════════════════
// Text Input Tests (via test:cycle — does NOT send to Claude terminal)
// ═══════════════════════════════════════

async function testTextInput() {
  const ws = await connectWs();
  try {
    // Use test:cycle instead of text: to avoid typing into the real Claude terminal
    const entryPromise = waitForMessage(ws, (m) =>
      (m.type === "transcription" && m.role === "assistant") ||
      (m.type === "voice_status" && m.state === "thinking"),
      8000
    );
    ws.send("test:cycle:The capital of France is Paris, which has been the country's capital since the late tenth century.");
    const entry = await entryPromise;
    const ok = !!entry;
    report("Text input accepted by server", ok, entry ? `type=${entry.type}` : "no entry received");
  } finally { ws.close(); }
}

async function testTextInputTriggersState() {
  const ws = await connectWs();
  try {
    // Use test:cycle to verify state transitions without touching Claude terminal
    const statesPromise = collectMessages(ws, (m) => m.type === "voice_status", 8000);
    ws.send("test:cycle:Hello world, this is a multi-word response to verify state transitions work correctly.");
    const states = await statesPromise;
    const stateNames = states.map((s: any) => s.state);
    report("Text input triggers state transitions", stateNames.length > 0,
      stateNames.length > 0 ? `states: ${stateNames.join("→")}` : "no state changes");
  } finally { ws.close(); }
}

// ═══════════════════════════════════════
// True E2E: right TTS ↔ right bubble (entryId chain)
// ═══════════════════════════════════════

async function testReplayCorrectEntry() {
  const ws = await connectWs();
  try {
    // Clear any pending TTS from previous tests
    ws.send("stop");
    await new Promise(r => setTimeout(r, 1000));

    const paragraphs = [
      "Cats are independent animals that have been domesticated for thousands of years.",
      "Dogs are loyal companions known for their devotion to their human families.",
      "Fish are aquatic vertebrates that breathe through gills and live in water.",
    ];

    // Create entries
    ws.send("test:entries:" + JSON.stringify(paragraphs));

    // Wait for final entry broadcast to get entryIds
    const entryMsg = await waitForMessage(ws, (m) =>
      m.type === "entry" && m.partial === false && m.entries?.length >= 3,
      10000
    );
    const assistantEntries = entryMsg.entries.filter((e: any) => e.role === "assistant");
    const lastThree = assistantEntries.slice(-3);

    // Pick the MIDDLE entry (dogs) — replay it by ID
    const targetEntry = lastThree[1];
    const targetId = targetEntry.id;
    const targetText = targetEntry.text;

    // Wait for entry creation to settle
    await new Promise(r => setTimeout(r, 500));

    // Listen for tts_highlight and audio
    const highlightPromise = waitForMessage(ws, (m) =>
      m.type === "tts_highlight" && m.entryId === targetId,
      15000
    );
    const audioPromise = waitForAudio(ws, 20000);

    ws.send("replay:" + targetId);

    const highlight = await highlightPromise;
    const audio = await audioPromise;

    const highlightCorrect = highlight.entryId === targetId;
    const gotAudio = audio.binary ? audio.binary.length > 100 : !!audio.localTts;

    // For local_tts, verify the text matches the dogs paragraph
    let textMatch = true;
    if (audio.localTts) {
      textMatch = audio.localTts.text === targetText;
    }

    report("Replay highlights correct entry (middle of 3)",
      highlightCorrect && gotAudio && textMatch,
      `entryId=${targetId}, highlight=${highlight.entryId}, ` +
      (audio.binary ? `audio=${audio.binary.length}b` : `local_tts text match=${textMatch}`) +
      `, text="${targetText.slice(0, 40)}..."`);
  } finally { ws.close(); }
}

async function testReplayFirstVsLast() {
  const ws = await connectWs();
  try {
    // Clear any pending TTS
    ws.send("stop");
    await new Promise(r => setTimeout(r, 1000));

    const paragraphs = [
      "Alpha paragraph: the first item in a sequence, representing the beginning of ordered data.",
      "Beta paragraph: the second item, sitting between alpha and gamma in the Greek alphabet.",
      "Gamma paragraph: the third item, commonly used in physics to denote high-energy radiation.",
    ];

    ws.send("test:entries:" + JSON.stringify(paragraphs));
    const entryMsg = await waitForMessage(ws, (m) =>
      m.type === "entry" && m.partial === false && m.entries?.length >= 3,
      10000
    );
    const assistantEntries = entryMsg.entries.filter((e: any) => e.role === "assistant");
    const lastThree = assistantEntries.slice(-3);
    await new Promise(r => setTimeout(r, 500));

    // Replay FIRST entry (alpha)
    const firstId = lastThree[0].id;
    const firstText = lastThree[0].text;

    const h1 = waitForMessage(ws, (m) => m.type === "tts_highlight" && m.entryId === firstId, 15000);
    const a1 = waitForAudio(ws, 20000);
    ws.send("replay:" + firstId);
    const highlight1 = await h1;
    const audio1 = await a1;

    const firstCorrect = highlight1.entryId === firstId;
    let firstTextMatch = true;
    if (audio1.localTts) firstTextMatch = audio1.localTts.text === firstText;

    // Wait for first replay to finish
    ws.send("tts_done");
    await new Promise(r => setTimeout(r, 1000));

    // Now replay LAST entry (gamma)
    const lastId = lastThree[2].id;
    const lastText = lastThree[2].text;

    const h2 = waitForMessage(ws, (m) => m.type === "tts_highlight" && m.entryId === lastId, 15000);
    const a2 = waitForAudio(ws, 20000);
    ws.send("replay:" + lastId);
    const highlight2 = await h2;
    const audio2 = await a2;

    const lastCorrect = highlight2.entryId === lastId;
    let lastTextMatch = true;
    if (audio2.localTts) lastTextMatch = audio2.localTts.text === lastText;

    report("Replay first entry → highlight + audio for first",
      firstCorrect && firstTextMatch,
      `entryId=${firstId}, text="${firstText.slice(0, 30)}..."`);
    report("Replay last entry → highlight + audio for last (not first)",
      lastCorrect && lastTextMatch && highlight2.entryId !== firstId,
      `entryId=${lastId} (≠${firstId}), text="${lastText.slice(0, 30)}..."`);
  } finally { ws.close(); }
}

async function testHighlightClearsAfterTtsDone() {
  const ws = await connectWs();
  try {
    // Clear any pending TTS
    ws.send("stop");
    await new Promise(r => setTimeout(r, 1000));

    const paragraphs = ["Short test phrase for highlight clear verification."];
    ws.send("test:entries:" + JSON.stringify(paragraphs));
    const entryMsg = await waitForMessage(ws, (m) =>
      m.type === "entry" && m.partial === false,
      10000
    );
    const entries = entryMsg.entries.filter((e: any) => e.role === "assistant");
    const targetId = entries[entries.length - 1].id;
    await new Promise(r => setTimeout(r, 500));

    // Replay and collect all tts_highlight messages
    const highlights: any[] = [];
    const handler = (data: WebSocket.Data) => {
      const msg = parseMsg(data);
      if (msg && msg.type === "tts_highlight") highlights.push(msg);
    };
    ws.on("message", handler);

    ws.send("replay:" + targetId);

    // Wait for audio to complete
    const audio = await waitForAudio(ws, 20000);
    // Client sends tts_done after playback to signal completion
    ws.send("tts_done");
    // Wait for the null highlight (clear)
    await waitForMessage(ws, (m) =>
      m.type === "tts_highlight" && m.entryId === null,
      10000
    );
    ws.removeListener("message", handler);

    const hasSet = highlights.some(h => h.entryId === targetId);
    const hasClear = highlights.some(h => h.entryId === null);

    report("TTS highlight set then cleared after playback",
      hasSet && hasClear,
      `highlights: ${highlights.map(h => h.entryId).join(" → ")}`);
  } finally { ws.close(); }
}

async function testMultiBubbleTtsSync() {
  const ws = await connectWs();
  try {
    const paragraphs = [
      "Alpha entry: the first paragraph about distributed systems and their fundamental design principles.",
      "Beta entry: the second paragraph discussing consensus algorithms like Raft and Paxos in detail.",
      "Gamma entry: the third and final paragraph covering eventual consistency in modern databases.",
    ];

    // Collect ALL tts_highlight and audio messages
    const highlights: any[] = [];
    const audios: { entryId: number | null; type: string }[] = [];
    let currentHighlight: number | null = null;

    const handler = (data: WebSocket.Data) => {
      const msg = parseMsg(data);
      if (msg) {
        if (msg.type === "tts_highlight") {
          highlights.push(msg);
          currentHighlight = msg.entryId;
        }
        if (msg.type === "local_tts") {
          audios.push({ entryId: msg.entryId, type: "local_tts" });
        }
        return;
      }
      // Binary audio — associate with current highlight
      if (Buffer.isBuffer(data) && data.length > 100) {
        audios.push({ entryId: currentHighlight, type: "binary" });
      }
    };
    ws.on("message", handler);

    ws.send("test:entries-tts:" + JSON.stringify(paragraphs));

    // Wait for entries + all TTS to finish (idle state after all audio)
    await waitForMessage(ws, (m) =>
      m.type === "entry" && m.partial === false && m.entries?.length >= 3,
      10000
    );

    // Get the entryIds
    const entryMsg = await waitForMessage(ws, (m) =>
      m.type === "entry" && m.partial === false,
      5000
    ).catch(() => null);

    // Wait for TTS to complete (highlights should include null=clear at the end)
    // Give enough time for all 3 paragraphs to TTS
    await new Promise(r => setTimeout(r, 15000));
    ws.removeListener("message", handler);

    // Extract the entry IDs that were highlighted (non-null)
    const highlightedIds = highlights
      .filter(h => h.entryId !== null)
      .map(h => h.entryId);
    const uniqueHighlightedIds = [...new Set(highlightedIds)];

    // Each of the 3 entries should have gotten a tts_highlight
    const allThreeHighlighted = uniqueHighlightedIds.length >= 3;
    // The IDs should be in ascending order (entries created in sequence)
    const inOrder = uniqueHighlightedIds.every((id: number, i: number) =>
      i === 0 || id > uniqueHighlightedIds[i - 1]
    );

    report("Multi-bubble TTS: all 3 entries get tts_highlight",
      allThreeHighlighted,
      `highlighted entryIds: [${uniqueHighlightedIds.join(", ")}]`);
    report("Multi-bubble TTS: highlights arrive in entry order",
      inOrder && uniqueHighlightedIds.length >= 3,
      `order: ${uniqueHighlightedIds.join(" → ")}`);
    report("Multi-bubble TTS: audio received for each entry",
      audios.length >= 3,
      `${audios.length} audio chunks, types: ${audios.map(a => a.type).join(", ")}`);
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
      const msg = parseMsg(data);
      if (msg && msg.type === "voice_status") states.push(msg.state);
    };
    // Start listening BEFORE sending to capture all state transitions
    ws.on("message", stateHandler);

    ws.send("test:cycle:Testing one two three. This is a full pipeline cycle with a longer sentence to produce more audio.");

    // Wait for local_tts or binary audio, with enough time for the full cycle
    const audio = await waitForAudio(ws, 30000);
    // Give a moment for final states to arrive
    await new Promise(r => setTimeout(r, 500));
    ws.removeListener("message", stateHandler);

    const hasThinking = states.includes("thinking");
    const hasResponding = states.includes("responding");
    const hasSpeaking = states.includes("speaking");
    const audioOk = audio.binary ? audio.binary.length > 100 : !!audio.localTts;
    // Accept if we got audio and at least 2 of the 3 expected states
    const stateCount = [hasThinking, hasResponding, hasSpeaking].filter(Boolean).length;
    const ok = audioOk && stateCount >= 2;
    const audioDetail = audio.binary ? `audio: ${audio.binary.length}b` : "audio: local_tts";
    report("Full cycle (think→respond→TTS)", ok, `states: ${states.join("→")}, ${audioDetail}`);
  } finally { ws.close(); }
}

// ═══════════════════════════════════════
// Spoken vs Unspoken Boundary Tests
// ═══════════════════════════════════════

async function testMixedSpokenEntries() {
  const ws = await connectWs();
  try {
    ws.send("test:entries-mixed:" + JSON.stringify([
      { text: "Alpha entry — already spoken, should arrive with spoken=true.", spoken: true },
      { text: "Beta entry — also already spoken via TTS earlier.", spoken: true },
      { text: "Gamma entry — not yet spoken, this is the boundary.", spoken: false },
      { text: "Delta entry — also fresh, not yet spoken.", spoken: false },
    ]));
    const entryMsg = await waitForMessage(ws, (m) =>
      m.type === "entry" && m.partial === false, 5000);
    const entries = entryMsg.entries.filter((e: any) => e.role === "assistant").slice(-4);

    const alphaSpoken = entries[0]?.spoken === true;
    const betaSpoken = entries[1]?.spoken === true;
    const gammaFresh = entries[2]?.spoken === false;
    const deltaFresh = entries[3]?.spoken === false;

    report("Mixed entries: spoken flags set correctly",
      alphaSpoken && betaSpoken && gammaFresh && deltaFresh,
      `[spoken=${entries.map((e: any) => e.spoken).join(", ")}]`);
  } finally { ws.close(); }
}

async function testMixedSpeakableEntries() {
  const ws = await connectWs();
  try {
    ws.send("test:entries-mixed:" + JSON.stringify([
      { text: "Speakable and spoken.", spoken: true, speakable: true },
      { text: "Non-speakable tool output.", spoken: false, speakable: false },
      { text: "Speakable but not spoken.", spoken: false, speakable: true },
    ]));
    const entryMsg = await waitForMessage(ws, (m) =>
      m.type === "entry" && m.partial === false, 5000);
    const entries = entryMsg.entries.filter((e: any) => e.role === "assistant").slice(-3);

    report("Mixed speakable: flags match input",
      entries[0]?.speakable === true && entries[0]?.spoken === true &&
      entries[1]?.speakable === false && entries[1]?.spoken === false &&
      entries[2]?.speakable === true && entries[2]?.spoken === false,
      `speakable=[${entries.map((e: any) => e.speakable).join(", ")}], spoken=[${entries.map((e: any) => e.spoken).join(", ")}]`);
  } finally { ws.close(); }
}

async function testReplayAtBoundary() {
  const ws = await connectWs();
  try {
    ws.send("stop");
    await new Promise(r => setTimeout(r, 1000));

    // Create spoken + fresh entries
    ws.send("test:entries-mixed:" + JSON.stringify([
      { text: "This entry was spoken before — it is old context the user already heard.", spoken: true },
      { text: "This entry is the boundary — TTS should pick up here.", spoken: false },
      { text: "This entry is also fresh, waiting in the queue.", spoken: false },
    ]));
    const entryMsg = await waitForMessage(ws, (m) =>
      m.type === "entry" && m.partial === false, 5000);
    const entries = entryMsg.entries.filter((e: any) => e.role === "assistant").slice(-3);
    const boundaryId = entries[1].id; // the first unspoken entry

    // Replay the boundary entry
    const highlightPromise = waitForMessage(ws, (m) =>
      m.type === "tts_highlight" && m.entryId === boundaryId, 15000);
    ws.send("replay:" + boundaryId);
    const highlight = await highlightPromise;

    report("Replay at spoken/unspoken boundary highlights correct entry",
      highlight.entryId === boundaryId,
      `expected=${boundaryId}, got=${highlight.entryId}`);

    ws.send("stop");
    await new Promise(r => setTimeout(r, 500));
  } finally { ws.close(); }
}

async function testTtsHighlightTransitionsSpokenFlag() {
  const ws = await connectWs();
  try {
    ws.send("stop");
    await new Promise(r => setTimeout(r, 1000));

    // Create 2 fresh entries, then speak first via replay
    ws.send("test:entries-mixed:" + JSON.stringify([
      { text: "First fresh entry that will be spoken via replay.", spoken: false },
      { text: "Second fresh entry that stays unspoken.", spoken: false },
    ]));
    const entryMsg = await waitForMessage(ws, (m) =>
      m.type === "entry" && m.partial === false, 5000);
    const entries = entryMsg.entries.filter((e: any) => e.role === "assistant").slice(-2);
    const firstId = entries[0].id;
    const secondId = entries[1].id;

    // Replay first entry
    const firstHighlight = await new Promise<any>((resolve) => {
      const handler = (data: WebSocket.Data) => {
        const msg = parseMsg(data);
        if (msg?.type === "tts_highlight" && msg.entryId === firstId) {
          ws.removeListener("message", handler);
          resolve(msg);
        }
      };
      ws.on("message", handler);
      ws.send("replay:" + firstId);
      setTimeout(() => { ws.removeListener("message", handler); resolve(null); }, 15000);
    });

    // Stop first, then replay second — first should lose highlight
    ws.send("stop");
    await new Promise(r => setTimeout(r, 1000));
    const secondHighlight = await new Promise<any>((resolve) => {
      const handler = (data: WebSocket.Data) => {
        const msg = parseMsg(data);
        if (msg?.type === "tts_highlight" && msg.entryId === secondId) {
          ws.removeListener("message", handler);
          resolve(msg);
        }
      };
      ws.on("message", handler);
      ws.send("replay:" + secondId);
      setTimeout(() => { ws.removeListener("message", handler); resolve(null); }, 15000);
    });

    report("First entry gets tts_highlight",
      firstHighlight?.entryId === firstId,
      `entryId=${firstHighlight?.entryId}`);
    report("Second entry gets tts_highlight after first",
      secondHighlight?.entryId === secondId,
      `entryId=${secondHighlight?.entryId}`);

    ws.send("stop");
    await new Promise(r => setTimeout(r, 500));
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

  // Wrap each test so one failure doesn't crash the suite
  async function run(name: string, fn: () => Promise<void>) {
    try { await fn(); }
    catch (err) { report(name, false, (err as Error).message); }
  }

  console.log("  ── STT Tests ──\n");
  await run("STT short speech (~5s)", testSttShort);
  await run("STT medium speech (~15s)", testSttMedium);
  await run("STT long speech (~30s)", testSttLong);
  await run("STT quiet speech (-20dB)", testSttQuiet);
  await run("STT speech with 3s pause", testSttSpeechWithPauses);

  console.log("\n  ── Rejection Tests ──\n");
  await run("Silence rejection (10s)", testSilenceRejection);
  await run("Noise rejection (10s pink)", testNoiseRejection);

  console.log("\n  ── TTS Tests ──\n");
  await run("TTS short text", testTtsShort);
  await run("TTS long text (~5 sentences)", testTtsLong);

  console.log("\n  ── Long Text & Paragraph Tests ──\n");
  await run("TTS full paragraph (8 sentences)", testTtsParagraph);
  await run("Cycle long paragraph (6 sentences)", testCycleLongParagraph);
  await run("Cycle multi-sentence output verification", testCycleMultiSentenceOutput);
  await run("Multi-paragraph entries (3 paras)", testEntriesMultiParagraph);
  await run("Single long paragraph entry (500+ chars)", testEntriesLongParagraph);

  console.log("\n  ── Interactive Prompt / Multiple Choice Tests ──\n");
  await run("Interactive prompt broadcasts", testInteractivePrompt);
  await run("Interactive prompt entry content", testInteractivePromptEntries);
  await run("Interactive prompt numbered format", testInteractivePromptFormat);

  console.log("\n  ── Text Input Tests (via test:cycle) ──\n");
  await run("Text input accepted by server", testTextInput);
  await run("Text input triggers state transitions", testTextInputTriggersState);

  console.log("\n  ── True E2E: Bubble ↔ TTS (entryId chain) ──\n");
  await run("Replay highlights correct entry (middle)", testReplayCorrectEntry);
  await run("Replay first vs last entry", testReplayFirstVsLast);
  await run("Highlight set then cleared after TTS", testHighlightClearsAfterTtsDone);
  await run("Multi-bubble TTS audio/visual sync (3 long paras)", testMultiBubbleTtsSync);

  console.log("\n  ── Spoken vs Unspoken Boundary Tests ──\n");
  await run("Mixed spoken/fresh entries (flags)", testMixedSpokenEntries);
  await run("Mixed speakable flags", testMixedSpeakableEntries);
  await run("Replay at spoken/unspoken boundary", testReplayAtBoundary);
  await run("TTS highlight transitions between entries", testTtsHighlightTransitionsSpokenFlag);

  console.log("\n  ── Integration Tests ──\n");
  await run("Full cycle (think→respond→TTS)", testFullCycle);
  await run("Debug endpoints respond", testDebugEndpoints);

  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  console.log(`\n  ${passed}/${total} passed\n`);
  process.exit(passed === total ? 0 : 1);
}

main();
