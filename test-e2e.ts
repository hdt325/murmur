/**
 * End-to-end voice panel UI test.
 *
 * Generates audio samples, feeds them through the WebSocket as if they were
 * mic input, and watches every UI state transition in a real browser.
 *
 * Run:  npx tsx test-e2e.ts
 */

import { chromium, Browser, Page } from "playwright";
import { readFileSync } from "fs";
import { resolve } from "path";
import WebSocket from "ws";

const BASE = "http://localhost:3457";
const WS_URL = "ws://localhost:3457";
const AUDIO_DIR = resolve(import.meta.dirname!, "test-audio");
const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
const WARN = "\x1b[33m⚠\x1b[0m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

interface TestResult {
  name: string;
  ok: boolean;
  detail?: string;
  states?: string[];
}

const results: TestResult[] = [];
let browser: Browser;
let page: Page;

function report(name: string, ok: boolean, detail = "", states?: string[]) {
  results.push({ name, ok, detail, states });
  const icon = ok ? PASS : FAIL;
  console.log(`  ${icon}  ${name}${detail ? ` ${DIM}(${detail})${RESET}` : ""}`);
  if (states?.length) console.log(`     ${DIM}states: ${states.join(" → ")}${RESET}`);
}

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

/** Capture all UI state transitions during an operation. */
async function captureStates(page: Page, timeoutMs: number): Promise<string[]> {
  // Use page.waitForTimeout-based polling instead of page.evaluate with timers
  // to avoid tsx's __name injection breaking in browser context
  const states: string[] = [];
  const seen = new Set<string>();
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const snap = await page.evaluate(() => {
      const dot = document.getElementById("statusDot");
      const text = document.getElementById("statusText");
      const talk = document.getElementById("talkBtn");
      return {
        dotClass: (dot?.className || "").replace("status-dot", "").trim(),
        statusText: text?.textContent?.trim() || "",
        talkText: talk?.textContent?.trim() || "",
        talkClass: talk?.className?.trim() || "",
      };
    });
    const key = `${snap.dotClass}|${snap.statusText}|${snap.talkClass}`;
    if (!seen.has(key)) {
      seen.add(key);
      states.push(`[${snap.dotClass}] "${snap.statusText}" btn="${snap.talkText.slice(0, 40)}" class=${snap.talkClass}`);
    }
    await page.waitForTimeout(150);
  }
  return states;
}

/** Get current UI snapshot */
async function uiSnapshot(page: Page) {
  return page.evaluate(() => {
    const dot = document.getElementById("statusDot");
    const text = document.getElementById("statusText");
    const talk = document.getElementById("talkBtn") as HTMLElement;
    const transcript = document.getElementById("transcript");
    const msgs = transcript?.querySelectorAll(".msg") || [];
    const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
    return {
      dotClass: dot?.className?.replace("status-dot", "").trim() || "",
      statusText: text?.textContent?.trim() || "",
      talkText: talk?.textContent?.trim() || "",
      talkClass: talk?.className?.trim() || "",
      msgCount: msgs.length,
      lastMsgRole: lastMsg?.classList.contains("assistant") ? "assistant" : lastMsg?.classList.contains("user") ? "user" : null,
      lastMsgText: lastMsg?.textContent?.replace(/^(You|Claude)\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?/i, "").trim().slice(0, 200) || "",
      hasPartial: !!document.getElementById("partialMsg"),
      hasThinking: !!document.getElementById("thinkingBubble"),
    };
  });
}

/** Send audio file through a raw WebSocket (simulating mic input) */
async function sendAudioViaWs(audioPath: string): Promise<void> {
  const audioData = readFileSync(audioPath);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.on("open", () => {
      ws.send(audioData);
      // Close after a short delay to let the server process
      setTimeout(() => { ws.close(); resolve(); }, 500);
    });
    ws.on("error", reject);
  });
}

// ──────────────────────────────────────────────────────────────
// Setup / Teardown
// ──────────────────────────────────────────────────────────────

async function setup() {
  browser = await chromium.launch({ headless: false, slowMo: 50 });
  const ctx = await browser.newContext({ permissions: ["microphone"] });
  page = await ctx.newPage();
  page.on("dialog", d => d.dismiss());
  // Collect console logs
  page.on("console", msg => {
    if (msg.type() === "error") console.log(`     ${DIM}[browser] ${msg.text()}${RESET}`);
  });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(2000); // Let WS connect and settle
}

async function teardown() {
  await page.waitForTimeout(1000);
  await browser.close();

  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${"═".repeat(50)}`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`\n  Failures:`);
    results.filter(r => !r.ok).forEach(r => {
      console.log(`    ${FAIL}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
    });
  }
  console.log(`${"═".repeat(50)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

// ──────────────────────────────────────────────────────────────
// Test: Initial page load state
// ──────────────────────────────────────────────────────────────
async function testInitialState() {
  console.log("\n── Initial Page State ──");
  const snap = await uiSnapshot(page);

  report("Connection dot is green", snap.dotClass.includes("green"), snap.dotClass);
  report("Status text shows Ready/connected", /ready|connected|listening/i.test(snap.statusText), snap.statusText);
  report("Talk button is in idle state", snap.talkClass === "" || snap.talkClass === "none" || snap.talkText.includes("tap to talk"), snap.talkText);

  // Services
  const whisperUp = await page.locator("#svcWhisper.up").isVisible().catch(() => false);
  const kokoroUp = await page.locator("#svcKokoro.up").isVisible().catch(() => false);
  report("Whisper STT service up", whisperUp as boolean);
  report("Kokoro TTS service up", kokoroUp as boolean);

  // Controls visible
  for (const id of ["stopBtn", "muteBtn", "speedBtn", "voiceBtn", "replayBtn", "termBtn"]) {
    const vis = await page.locator(`#${id}`).isVisible().catch(() => false);
    report(`${id} visible`, vis as boolean);
  }
}

// ──────────────────────────────────────────────────────────────
// Test: Mute toggle
// ──────────────────────────────────────────────────────────────
async function testMuteToggle() {
  console.log("\n── Mute Toggle ──");

  // Mute
  await page.locator("#muteBtn").click();
  await page.waitForTimeout(300);
  let snap = await uiSnapshot(page);
  const muteText = await page.locator("#muteBtn").textContent();
  report("After mute click: button says 'Unmute'", muteText?.includes("Unmute") ?? false, muteText || "");
  report("After mute: status shows Muted", /muted/i.test(snap.statusText), snap.statusText);

  // Unmute
  await page.locator("#muteBtn").click();
  await page.waitForTimeout(300);
  snap = await uiSnapshot(page);
  const unmuteText = await page.locator("#muteBtn").textContent();
  report("After unmute: button says 'Mute'", unmuteText?.includes("Mute") && !unmuteText?.includes("Unmute") || false, unmuteText || "");
  report("After unmute: status shows Ready", /ready/i.test(snap.statusText), snap.statusText);
}

// ──────────────────────────────────────────────────────────────
// Test: Speed cycling
// ──────────────────────────────────────────────────────────────
async function testSpeedCycle() {
  console.log("\n── Speed Cycle ──");
  const SPEEDS = ["0.5x", "1x", "1.25x", "1.5x", "2x", "2.5x", "3x"];
  const speedBtn = page.locator("#speedBtn");
  const startText = await speedBtn.textContent();
  const startIdx = SPEEDS.indexOf(startText?.trim() || "1x");

  const collected: string[] = [];
  for (let i = 0; i < SPEEDS.length; i++) {
    await speedBtn.click();
    await page.waitForTimeout(200);
    const t = (await speedBtn.textContent())?.trim() || "";
    collected.push(t);
  }

  // Should have cycled through all speeds
  const unique = new Set(collected);
  report(`Speed cycles through ${unique.size} unique values`, unique.size >= 5, collected.join(" → "));

  // Reset to 1.25x (the saved default)
  while ((await speedBtn.textContent())?.trim() !== "1.25x") {
    await speedBtn.click();
    await page.waitForTimeout(100);
  }
}

// ──────────────────────────────────────────────────────────────
// Test: Voice selection popover
// ──────────────────────────────────────────────────────────────
async function testVoiceSelection() {
  console.log("\n── Voice Selection ──");
  const voiceBtn = page.locator("#voiceBtn");
  const popover = page.locator("#voicePopover");

  await voiceBtn.click();
  await page.waitForTimeout(300);
  const popVisible = await popover.isVisible();
  report("Voice popover opens on click", popVisible);

  // Count voice options
  const voiceCount = await page.locator(".voice-option").count();
  report(`Voice popover has options (${voiceCount})`, voiceCount >= 8, `${voiceCount} voices`);

  // Select a voice
  const firstVoice = page.locator(".voice-option").first();
  const voiceName = await firstVoice.getAttribute("data-voice");
  await firstVoice.click();
  await page.waitForTimeout(500);

  const popClosed = !(await popover.isVisible());
  report("Popover closes after selection", popClosed);

  const btnText = await voiceBtn.textContent();
  report(`Voice button updated to selected voice`, btnText?.trim() === voiceName, `${btnText?.trim()}`);

  // Restore original voice
  await voiceBtn.click();
  await page.waitForTimeout(200);
  const heart = page.locator('.voice-option[data-voice="af_heart"]');
  if (await heart.isVisible()) {
    await heart.click();
    await page.waitForTimeout(300);
  }
}

// ──────────────────────────────────────────────────────────────
// Test: Terminal panel toggle + input
// ──────────────────────────────────────────────────────────────
async function testTerminalPanel() {
  console.log("\n── Terminal Panel ──");

  // Open terminal
  await page.locator("#termBtn").click();
  await page.waitForTimeout(500);
  const panelVisible = await page.locator("#terminalPanel").evaluate(el => {
    return el.classList.contains("open") || getComputedStyle(el).height !== "0px";
  });
  report("Terminal panel opens", panelVisible);

  const inputVisible = await page.locator("#terminalInput").isVisible();
  report("Terminal input field visible", inputVisible);

  // Terminal content comes via WS broadcast every 500ms. Wait for it.
  // Also trigger a terminal request by toggling terminal to ensure server knows we want it.
  await page.waitForTimeout(2500);
  let termContent = await page.locator("#terminalOutput").textContent();
  // If still empty, check localStorage (server may have sent before panel opened)
  if (!termContent?.length) {
    termContent = await page.evaluate(() => localStorage.getItem("term-output") || "");
  }
  report("Terminal output has content", (termContent?.length || 0) > 0, `${termContent?.length} chars`);

  // Close terminal
  await page.locator("#termBtn").click();
  await page.waitForTimeout(500);
}

// ──────────────────────────────────────────────────────────────
// Test: Stop button when idle (should not crash or beep)
// ──────────────────────────────────────────────────────────────
async function testStopWhenIdle() {
  console.log("\n── Stop Button (Idle) ──");
  await page.locator("#stopBtn").click();
  await page.waitForTimeout(500);
  const snap = await uiSnapshot(page);
  report("Stop when idle: no crash, stays ready", snap.talkText.includes("tap to talk"), snap.talkText);
  report("Stop when idle: no 'Tap to respond' prompt", !snap.talkText.includes("Tap to respond"), snap.talkText);
}

// ──────────────────────────────────────────────────────────────
// Test: Feed audio sample and observe full voice flow
// ──────────────────────────────────────────────────────────────
async function testVoiceFlow(sampleFile: string, label: string) {
  console.log(`\n── Voice Flow: "${label}" (${sampleFile}) ──`);
  const audioPath = resolve(AUDIO_DIR, sampleFile);
  const audioData = readFileSync(audioPath);

  // Clear transcript state
  const msgCountBefore = await page.evaluate(() =>
    document.querySelectorAll(".msg").length
  );

  // Small delay then send audio via the page's existing WebSocket
  await page.waitForTimeout(300);
  await page.evaluate((audioBytes) => {
    const arr = new Uint8Array(audioBytes);
    const ws = (window as any).__voiceWs;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(arr.buffer);
    }
  }, Array.from(audioData));

  // If the page doesn't expose __voiceWs, fall back to raw WS
  const sentViaPage = await page.evaluate(() => !!(window as any).__voiceWs);
  if (!sentViaPage) {
    console.log(`     ${DIM}[info] Page WS not exposed, sending via raw WebSocket${RESET}`);
    await sendAudioViaWs(audioPath);
  }

  // Now wait and watch the UI flow
  // Poll for state transitions with a timeout
  const startTime = Date.now();
  let sawTranscribing = false;
  let sawThinking = false;
  let sawResponding = false;
  let sawSpeaking = false;
  let sawIdle = false;
  let sawUserMsg = false;
  let sawAssistantMsg = false;
  let lastTalkText = "";
  let lastStatusText = "";
  const timeline: string[] = [];

  while (Date.now() - startTime < 60000) {
    const snap = await uiSnapshot(page);
    const talkLower = snap.talkText.toLowerCase();
    const statusLower = snap.statusText.toLowerCase();

    // Track state transitions
    if (snap.talkText !== lastTalkText || snap.statusText !== lastStatusText) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      timeline.push(`${elapsed}s: [${snap.dotClass}] "${snap.statusText}" — "${snap.talkText.slice(0, 50)}"`);
      lastTalkText = snap.talkText;
      lastStatusText = snap.statusText;
    }

    if (talkLower.includes("transcribing") || statusLower.includes("transcribing")) sawTranscribing = true;
    if (talkLower.includes("thinking") || statusLower.includes("thinking")) sawThinking = true;
    if (talkLower.includes("responding") || statusLower.includes("responding")) sawResponding = true;
    if (talkLower.includes("speaking") || statusLower.includes("speaking")) sawSpeaking = true;

    // Check for new messages
    const currentMsgCount = await page.evaluate(() => document.querySelectorAll(".msg").length);
    const lastRole = await page.evaluate(() => {
      const msgs = document.querySelectorAll(".msg");
      return msgs.length > 0 ? msgs[msgs.length - 1].classList.contains("user") ? "user" : "assistant" : null;
    });
    if (currentMsgCount > msgCountBefore && lastRole === "user") sawUserMsg = true;
    if (currentMsgCount > msgCountBefore && lastRole === "assistant") sawAssistantMsg = true;

    // Done when we see idle after speaking, or "tap to respond", or back to "tap to talk"
    if ((sawSpeaking || sawResponding) && (talkLower.includes("tap to") || talkLower.includes("press right"))) {
      sawIdle = true;
      break;
    }

    // Also catch blank transcription (no speech detected)
    if (statusLower.includes("no speech") || talkLower.includes("no speech")) {
      timeline.push(`${((Date.now() - startTime) / 1000).toFixed(1)}s: BLANK TRANSCRIPTION`);
      break;
    }

    await page.waitForTimeout(300);
  }

  // Final snapshot
  const finalSnap = await uiSnapshot(page);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  timeline.push(`${elapsed}s: FINAL — [${finalSnap.dotClass}] "${finalSnap.statusText}" — "${finalSnap.talkText.slice(0, 50)}"`);

  console.log(`     ${DIM}Timeline:${RESET}`);
  timeline.forEach(t => console.log(`       ${DIM}${t}${RESET}`));

  // Report
  report("Saw 'Transcribing' state", sawTranscribing);
  report("Saw 'Thinking' state", sawThinking);
  report("Saw 'Responding' or 'Speaking' state", sawResponding || sawSpeaking);
  report("User message appeared in transcript", sawUserMsg);
  report("Assistant message appeared in transcript", sawAssistantMsg);

  // Check assistant message isn't scrollback garbage (Bug 10)
  if (sawAssistantMsg) {
    const lastAssistant = await page.evaluate(() => {
      const msgs = document.querySelectorAll(".msg.assistant");
      const last = msgs[msgs.length - 1];
      return {
        text: last?.textContent?.replace(/^Claude\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?/i, "").trim() || "",
        hasPartialId: last?.id === "partialMsg",
      };
    });
    report(
      "Response is reasonable length (not scrollback)",
      lastAssistant.text.length < 1000,
      `${lastAssistant.text.length} chars: "${lastAssistant.text.slice(0, 80)}..."`
    );
    report("No stale partial message left over (Bug 11)", !lastAssistant.hasPartialId);
  }

  // Check returned to idle properly (Bug 7)
  report("Returned to idle/ready state", finalSnap.talkText.includes("tap to") || finalSnap.talkText.includes("Press Right"), finalSnap.talkText.slice(0, 50));

  // Wait for the full cycle to finish before next test
  // Must wait past: speaking → idle → echo cooldown
  const waitStart = Date.now();
  while (Date.now() - waitStart < 60000) {
    const t = (await page.locator("#talkBtn").textContent())?.toLowerCase() || "";
    if (t.includes("tap to talk") || t.includes("press right") || t.includes("tap to respond")) break;
    await page.waitForTimeout(500);
  }
  console.log(`     ${DIM}Cycle complete, cooling down...${RESET}`);
  await page.waitForTimeout(3000); // echo cooldown + settle
}

// ──────────────────────────────────────────────────────────────
// Test: Stop mid-TTS — verify no beep (Bug 7 + Bug 3)
// ──────────────────────────────────────────────────────────────
async function testStopMidTts() {
  console.log("\n── Stop Mid-TTS (Bug 7+3) ──");

  // Send audio that will produce a response
  const audioPath = resolve(AUDIO_DIR, "sample1.wav");
  const audioData = readFileSync(audioPath);

  await page.evaluate((audioBytes) => {
    const arr = new Uint8Array(audioBytes);
    const ws = (window as any).__voiceWs;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(arr.buffer);
  }, Array.from(audioData));

  if (!(await page.evaluate(() => !!(window as any).__voiceWs))) {
    await sendAudioViaWs(audioPath);
  }

  // Wait until speaking state
  const startTime = Date.now();
  let reachedSpeaking = false;
  while (Date.now() - startTime < 45000) {
    const talkText = (await page.locator("#talkBtn").textContent())?.toLowerCase() || "";
    if (talkText.includes("speaking")) { reachedSpeaking = true; break; }
    await page.waitForTimeout(300);
  }

  if (reachedSpeaking) {
    // Click stop mid-TTS
    await page.locator("#stopBtn").click();
    await page.waitForTimeout(1000);

    const snap = await uiSnapshot(page);
    report("After Stop mid-TTS: no 'Tap to respond'", !snap.talkText.includes("Tap to respond"), snap.talkText);
    report("After Stop mid-TTS: shows idle/ready state", snap.talkText.includes("tap to talk") || snap.talkText.includes("Press Right"), snap.talkText);
  } else {
    report("Reached speaking state (prerequisite)", false, "timed out waiting for TTS");
  }

  await page.waitForTimeout(2000);
}

// ──────────────────────────────────────────────────────────────
// Test: Replay button
// ──────────────────────────────────────────────────────────────
async function testReplay() {
  console.log("\n── Replay Button ──");

  await page.locator("#replayBtn").click();

  // Wait up to 5s for speaking state to appear (server needs to generate TTS)
  let sawSpeaking = false;
  const start = Date.now();
  while (Date.now() - start < 8000) {
    const t = (await page.locator("#talkBtn").textContent())?.toLowerCase() || "";
    const s = (await page.locator("#statusText").textContent())?.toLowerCase() || "";
    if (t.includes("speaking") || s.includes("speaking")) { sawSpeaking = true; break; }
    await page.waitForTimeout(300);
  }
  report("Replay triggers speaking state", sawSpeaking);

  // Wait for it to finish
  if (sawSpeaking) {
    await page.waitForFunction(
      () => !(document.getElementById("talkBtn")?.textContent?.toLowerCase().includes("speaking")),
      { timeout: 30000 }
    ).catch(() => {});
  }
  await page.waitForTimeout(3000);
}

// ──────────────────────────────────────────────────────────────
// Test: Terminal scroll preservation (Bug 8)
// ──────────────────────────────────────────────────────────────
async function testTerminalScroll() {
  console.log("\n── Terminal Scroll (Bug 8) ──");

  // Open terminal
  await page.locator("#termBtn").click();
  await page.waitForTimeout(500);

  const termOutput = page.locator("#terminalOutput");
  const scrollHeight = await termOutput.evaluate(el => el.scrollHeight);

  if (scrollHeight > 100) {
    // Scroll to middle
    await termOutput.evaluate(el => { el.scrollTop = el.scrollHeight / 2; });
    const scrollBefore = await termOutput.evaluate(el => el.scrollTop);
    await page.waitForTimeout(1500); // Wait for at least 2 terminal updates (500ms each)
    const scrollAfter = await termOutput.evaluate(el => el.scrollTop);

    report(
      "Scroll position preserved after terminal update",
      Math.abs(scrollAfter - scrollBefore) < 10,
      `before=${scrollBefore.toFixed(0)} after=${scrollAfter.toFixed(0)}`
    );
  } else {
    report("Terminal has enough content to scroll", false, `scrollHeight=${scrollHeight}`);
  }

  // Close terminal
  await page.locator("#termBtn").click();
  await page.waitForTimeout(300);
}

// ──────────────────────────────────────────────────────────────
// Test: Canvas resize (Bug 4) — live behavioral test
// ──────────────────────────────────────────────────────────────
async function testCanvasResize() {
  console.log("\n── Canvas Resize (Bug 4) ──");

  for (let i = 0; i < 5; i++) {
    await page.setViewportSize({ width: 400 + i * 80, height: 600 + i * 20 });
    await page.waitForTimeout(200);
  }

  const transform = await page.evaluate(() => {
    const c = document.getElementById("micCanvas") as HTMLCanvasElement | null;
    const ctx = c?.getContext("2d");
    if (!ctx) return null;
    const t = ctx.getTransform();
    return { a: t.a, d: t.d };
  });

  const dpr = await page.evaluate(() => window.devicePixelRatio);
  if (transform) {
    report(
      `Canvas scale = ${dpr}x after 5 resizes`,
      Math.abs(transform.a - dpr) < 0.01,
      `got ${transform.a.toFixed(3)}x (expected ${dpr}x)`
    );
  } else {
    report("Canvas context accessible", false);
  }

  await page.setViewportSize({ width: 480, height: 700 });
}

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────
async function main() {
  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║  Voice Panel — Full E2E UI Test Suite        ║");
  console.log("╚══════════════════════════════════════════════╝");

  await setup();

  // First, expose the WebSocket for audio injection
  // We need to find and expose the page's WS connection
  await page.evaluate(() => {
    // Monkey-patch WebSocket to capture the voice panel's connection
    const origWs = window.WebSocket;
    const existingWs = (window as any).__voiceWs;
    if (existingWs) return; // Already set

    // Try to find existing WS by overriding send
    const origSend = origWs.prototype.send;
    origWs.prototype.send = function (...args: any[]) {
      if (!((window as any).__voiceWs) && this.url?.includes("localhost:3457")) {
        (window as any).__voiceWs = this;
        console.log("[test] Captured WebSocket reference");
      }
      return origSend.apply(this, args);
    };

    // Trigger a send to capture the WS
    // The ping/keepalive or any message will expose it
  });

  // Trigger a WS send so we can capture the reference
  await page.evaluate(() => {
    // Force a small message to expose the WS
    document.getElementById("stopBtn")?.click();
  });
  await page.waitForTimeout(500);

  const hasWs = await page.evaluate(() => !!(window as any).__voiceWs);
  if (!hasWs) {
    // Fallback: hook into reconnect
    console.log(`  ${WARN}  Could not capture page WebSocket — will use raw WS fallback`);
  } else {
    console.log(`  ${PASS}  Captured page WebSocket for audio injection`);
  }

  // ── Run test suites ──
  await testInitialState();
  await testMuteToggle();
  await testSpeedCycle();
  await testVoiceSelection();
  await testTerminalPanel();
  await testStopWhenIdle();
  await testCanvasResize();

  // Voice flow tests with real audio
  await testVoiceFlow("sample1.wav", "What is two plus two?");
  await testReplay(); // Test replay right after a successful voice flow
  await testVoiceFlow("sample2.wav", "Say hello world");
  await testVoiceFlow("sample3.wav", "List three colors");

  // Bug-specific behavioral tests
  await testStopMidTts();
  await testTerminalScroll();

  await teardown();
}

main().catch(err => {
  console.error("Test runner error:", err);
  browser?.close();
  process.exit(2);
});
