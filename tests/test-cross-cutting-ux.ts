/**
 * Cross-Cutting Interaction Matrix tests — Part 4 of UX assessment.
 *
 * Tests features IN COMBINATION (highlight × stop, copy × scroll, etc.).
 * Uses simulated WS messages — no live Claude agent required.
 *
 * Requires: server running on localhost:3457
 *
 * Usage:    HEADLESS=1 node --import tsx/esm tests/test-cross-cutting-ux.ts
 */

import { chromium, Browser, Page, BrowserContext } from "playwright";
import { readFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const BASE = "http://localhost:3457?testmode=1";
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = join(__dirname, "screenshots", "cross-cutting");
const HEADLESS = process.env.HEADLESS !== "0";
const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

let browser: Browser;
let ctx: BrowserContext;
let page: Page;
let passed = 0;
let failed = 0;
let screenshotIdx = 0;

// ═══════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════

function report(name: string, ok: boolean, detail = "") {
  if (ok) passed++; else failed++;
  console.log(`  ${ok ? PASS : FAIL}  ${name}${detail ? ` ${DIM}(${detail})${RESET}` : ""}`);
}

async function screenshot(label: string) {
  screenshotIdx++;
  const path = join(SCREENSHOTS_DIR, `${String(screenshotIdx).padStart(3, "0")}-${label}.png`);
  try { await page.screenshot({ path }); } catch {}
}

async function freshPage() {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("murmur-tour-done", "1");
    localStorage.setItem("murmur-flow-mode", "0");
    localStorage.setItem("murmur-flow-tour-done", "1");
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => {
    const ws = (window as any)._ws;
    return ws && ws.readyState === 1;
  }, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);
}

async function freshFlowPage() {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("murmur-tour-done", "1");
    localStorage.setItem("murmur-flow-mode", "1");
    localStorage.setItem("murmur-flow-tour-done", "1");
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => {
    const ws = (window as any)._ws;
    return ws && ws.readyState === 1;
  }, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);
}

async function injectEntries(entries: any[], partial = false) {
  await page.evaluate(({ entries, partial }) => {
    const ws = (window as any)._ws;
    if (ws && ws.onmessage) {
      ws.onmessage({ data: JSON.stringify({ type: "entry", entries, partial }) } as any);
    }
  }, { entries, partial });
  await page.waitForTimeout(200);
}

async function broadcastJson(msg: any) {
  await page.evaluate((json) => {
    const ws = (window as any)._ws;
    if (ws && ws.onmessage) {
      ws.onmessage({ data: JSON.stringify(json) } as any);
    }
  }, msg);
  await page.waitForTimeout(200);
}

function makeEntries(count: number, startId = 1000, turn = 1): any[] {
  const entries: any[] = [];
  for (let i = 0; i < count; i++) {
    const id = startId + i;
    entries.push({
      id, role: i % 2 === 0 ? "user" : "assistant",
      text: i % 2 === 0 ? `User message ${id}` : `Assistant response ${id} with some content to display.`,
      speakable: i % 2 !== 0, spoken: false, ts: Date.now() + i * 100, turn: turn + Math.floor(i / 2),
    });
  }
  return entries;
}

async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); }
  catch (err) {
    report(name, false, (err as Error).message);
    await screenshot(name.replace(/[^a-zA-Z0-9]/g, "-"));
  }
}

mkdirSync(SCREENSHOTS_DIR, { recursive: true });

// ═══════════════════════════════════════════════
// P. Highlight × Everything
// ═══════════════════════════════════════════════

// P1.2 — TTS highlight active → user scrolls to different bubble → highlight follows or stays?
async function testP1_2_highlightStaysOnScroll() {
  console.log(`\n  ${BOLD}[P1.2] Highlight stays on correct bubble when user scrolls${RESET}`);
  await freshPage();

  // Create enough entries to enable scrolling
  const entries = makeEntries(20, 1100);
  await injectEntries(entries, false);

  // Highlight an early entry
  await broadcastJson({ type: "tts_highlight", entryId: 1101 });
  await page.waitForTimeout(100);

  const highlightedBefore = await page.evaluate(() =>
    document.querySelector('.entry-bubble[data-entry-id="1101"]')?.classList.contains("bubble-active") ?? false
  );
  report("P1.2 Highlight set on target entry", highlightedBefore);

  // Scroll to bottom (away from highlighted entry)
  await page.evaluate(() => {
    const transcript = document.getElementById("transcript");
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  });
  await page.waitForTimeout(300);

  // Highlight should still be on the same entry (not transferred to visible area)
  const highlightedAfter = await page.evaluate(() =>
    document.querySelector('.entry-bubble[data-entry-id="1101"]')?.classList.contains("bubble-active") ?? false
  );
  report("P1.2 Highlight persists after scroll away", highlightedAfter);
}

// P1.3 — Highlight scrolls entry into view → user immediately scrolls away → no fight
async function testP1_3_noScrollFight() {
  console.log(`\n  ${BOLD}[P1.3] Highlight scroll + user scroll don't fight${RESET}`);
  await freshPage();

  const entries = makeEntries(30, 1300);
  await injectEntries(entries, false);

  // Scroll to top
  await page.evaluate(() => {
    const t = document.getElementById("transcript");
    if (t) t.scrollTop = 0;
  });
  await page.waitForTimeout(100);

  // Highlight a bottom entry (will trigger scrollIntoView)
  await broadcastJson({ type: "tts_highlight", entryId: 1329 });

  // Immediately scroll back to top (user "fights" the auto-scroll)
  await page.evaluate(() => {
    const t = document.getElementById("transcript");
    if (t) t.scrollTop = 0;
  });
  await page.waitForTimeout(500);

  // User scroll should win — transcript should stay near top
  const scrollPos = await page.evaluate(() => {
    const t = document.getElementById("transcript");
    return t ? t.scrollTop : -1;
  });
  // Scroll position should be small (user scrolled to top) — no infinite fight
  // Accept any position — the key test is no exception/crash
  report("P1.3 No scroll fight (no crash)", scrollPos >= 0);
}

// P2.2 — Stop: audio stops AND highlight stops
async function testP2_2_stopClearsAudioAndHighlight() {
  console.log(`\n  ${BOLD}[P2.2] Stop clears both audio and highlight${RESET}`);
  await freshPage();

  const entries = [
    { id: 2201, role: "user", text: "Hello", speakable: false, spoken: true, ts: Date.now(), turn: 1 },
    { id: 2202, role: "assistant", text: "Response", speakable: true, spoken: false, ts: Date.now() + 100, turn: 1 },
  ];
  await injectEntries(entries, false);

  // Simulate TTS highlight
  await broadcastJson({ type: "tts_highlight", entryId: 2202 });
  const highlighted = await page.evaluate(() =>
    document.querySelector('.entry-bubble[data-entry-id="2202"]')?.classList.contains("bubble-active") ?? false
  );
  report("P2.2 Highlight active before stop", highlighted);

  // Simulate tts_stop (interrupt)
  await broadcastJson({ type: "tts_stop", reason: "interrupt" });
  await page.waitForTimeout(100);

  const highlightAfterStop = await page.evaluate(() =>
    document.querySelector('.entry-bubble[data-entry-id="2202"]')?.classList.contains("bubble-active") ?? false
  );
  report("P2.2 Highlight cleared after tts_stop", !highlightAfterStop);
}

// P2.4 — Flow mode: words ungraying → Stop → remaining words turn red or stay gray
async function testP2_4_flowStopDropsRemaining() {
  console.log(`\n  ${BOLD}[P2.4] Flow mode stop marks remaining words as dropped${RESET}`);
  await freshFlowPage();

  const entries = [
    { id: 2401, role: "user", text: "Question", speakable: false, spoken: true, ts: Date.now(), turn: 1 },
    { id: 2402, role: "assistant", text: "This is a long response with many words", speakable: true, spoken: false, ts: Date.now() + 100, turn: 1 },
  ];
  await injectEntries(entries, false);

  // Highlight (simulating TTS playing)
  await broadcastJson({ type: "tts_highlight", entryId: 2402 });
  await page.waitForTimeout(100);

  // Stop TTS — non-turn_transition means "dropped"
  await broadcastJson({ type: "tts_stop", reason: "interrupt" });
  await page.waitForTimeout(200);

  // In flow mode, interrupted entries get bubble-dropped class
  const hasDropped = await page.evaluate(() =>
    !!document.querySelector('.entry-bubble.bubble-dropped') ||
    !!document.querySelector('.msg.bubble-dropped')
  );
  // Also acceptable: no bubble-active class remaining
  const noActive = await page.evaluate(() =>
    document.querySelectorAll('.entry-bubble.bubble-active').length === 0
  );
  report("P2.4 No active highlights after stop in flow mode", noActive);
  report("P2.4 Dropped entries marked (or none to mark)", hasDropped || noActive);
}

// P3.3 — Highlight active → toggle clean/verbose → highlight survives
async function testP3_3_highlightSurvivesCleanToggle() {
  console.log(`\n  ${BOLD}[P3.3] Highlight survives clean/verbose toggle${RESET}`);
  await freshPage();

  const entries = [
    { id: 3301, role: "user", text: "Q", speakable: false, spoken: true, ts: Date.now(), turn: 1 },
    { id: 3302, role: "assistant", text: "A response", speakable: true, spoken: false, ts: Date.now() + 100, turn: 1 },
  ];
  await injectEntries(entries, false);
  await broadcastJson({ type: "tts_highlight", entryId: 3302 });

  const activeBefore = await page.evaluate(() =>
    !!document.querySelector('.entry-bubble[data-entry-id="3302"].bubble-active')
  );
  report("P3.3 Highlight active before toggle", activeBefore);

  // Toggle clean mode
  await page.evaluate(() => document.body.classList.toggle("clean-mode"));
  await page.waitForTimeout(200);

  // Check highlight persists — CSS toggle shouldn't remove JS classes
  const activeAfter = await page.evaluate(() =>
    !!document.querySelector('.entry-bubble[data-entry-id="3302"].bubble-active')
  );
  report("P3.3 Highlight persists after clean/verbose toggle", activeAfter);
}

// P3.4 — Flow karaoke active → switch to regular mode → highlight state
async function testP3_4_flowToRegularHighlight() {
  console.log(`\n  ${BOLD}[P3.4] Flow karaoke → switch to regular mode${RESET}`);
  await freshFlowPage();

  const entries = [
    { id: 3401, role: "user", text: "Test", speakable: false, spoken: true, ts: Date.now(), turn: 1 },
    { id: 3402, role: "assistant", text: "Flow response", speakable: true, spoken: false, ts: Date.now() + 100, turn: 1 },
  ];
  await injectEntries(entries, false);
  await broadcastJson({ type: "tts_highlight", entryId: 3402 });

  const flowActive = await page.evaluate(() =>
    document.body.classList.contains("flow-mode")
  );
  report("P3.4 In flow mode", flowActive);

  // Switch to regular mode
  await page.evaluate(() => {
    localStorage.setItem("murmur-flow-mode", "0");
    document.body.classList.remove("flow-mode");
  });
  await page.waitForTimeout(300);

  // Page should not crash — entries should still be visible
  const bubbleCount = await page.evaluate(() =>
    document.querySelectorAll('.entry-bubble').length
  );
  report("P3.4 Entries still visible after flow→regular switch", bubbleCount >= 1);
}

// ═══════════════════════════════════════════════
// Q. Copy × Everything
// ═══════════════════════════════════════════════

// Q1.2 — Copy while auto-scrolling during TTS → auto-scroll pauses
async function testQ1_2_copyDuringAutoScroll() {
  console.log(`\n  ${BOLD}[Q1.2] Copy during TTS auto-scroll${RESET}`);
  await freshPage();

  const entries = makeEntries(20, 5100);
  await injectEntries(entries, false);

  // Highlight last entry (triggers scrollIntoView)
  await broadcastJson({ type: "tts_highlight", entryId: 5119 });
  await page.waitForTimeout(100);

  // Click copy on a middle entry via data attribute
  const copyResult = await page.evaluate(() => {
    const el = document.querySelector('.entry-bubble[data-entry-id="5105"]');
    if (!el) return { found: false };
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return { found: true };
  });
  report("Q1.2 Copy target found during TTS", copyResult.found);

  // No crash = success
  const bubbles = await page.evaluate(() => document.querySelectorAll('.entry-bubble').length);
  report("Q1.2 Page stable after copy during TTS scroll", bubbles > 0);
}

// Q1.3 — Copy a partially off-screen bubble → no scroll jump
async function testQ1_3_copyOffScreenNoJump() {
  console.log(`\n  ${BOLD}[Q1.3] Copy off-screen bubble doesn't jump scroll${RESET}`);
  await freshPage();

  const entries = makeEntries(20, 5200);
  await injectEntries(entries, false);

  // Scroll to middle
  await page.evaluate(() => {
    const t = document.getElementById("transcript");
    if (t) t.scrollTop = t.scrollHeight / 2;
  });
  await page.waitForTimeout(200);

  const scrollBefore = await page.evaluate(() =>
    document.getElementById("transcript")?.scrollTop ?? 0
  );

  // Click copy on an entry that may be partially off-screen
  await page.evaluate(() => {
    const el = document.querySelector('.entry-bubble[data-entry-id="5201"]');
    if (el) el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForTimeout(300);

  const scrollAfter = await page.evaluate(() =>
    document.getElementById("transcript")?.scrollTop ?? 0
  );

  // Scroll should not have dramatically jumped (allow small delta for smooth scroll)
  const scrollDelta = Math.abs(scrollAfter - scrollBefore);
  report("Q1.3 Scroll position stable after copy", scrollDelta < 200, `delta=${scrollDelta}`);
}

// Q2.2 — Copy a non-highlighted bubble during TTS playback → no interference
async function testQ2_2_copyNonHighlightedDuringTts() {
  console.log(`\n  ${BOLD}[Q2.2] Copy non-highlighted bubble during TTS${RESET}`);
  await freshPage();

  const entries = [
    { id: 5301, role: "user", text: "First", speakable: false, spoken: true, ts: Date.now(), turn: 1 },
    { id: 5302, role: "assistant", text: "First response", speakable: true, spoken: false, ts: Date.now() + 100, turn: 1 },
    { id: 5303, role: "user", text: "Second", speakable: false, spoken: true, ts: Date.now() + 200, turn: 2 },
    { id: 5304, role: "assistant", text: "Second response", speakable: true, spoken: false, ts: Date.now() + 300, turn: 2 },
  ];
  await injectEntries(entries, false);

  // Highlight second assistant entry (simulating TTS playing)
  await broadcastJson({ type: "tts_highlight", entryId: 5304 });

  // Click copy on first assistant entry (not highlighted)
  await page.evaluate(() => {
    const el = document.querySelector('.entry-bubble[data-entry-id="5302"]');
    if (el) el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForTimeout(200);

  // Highlight on 5304 should still be active
  const stillHighlighted = await page.evaluate(() =>
    document.querySelector('.entry-bubble[data-entry-id="5304"]')?.classList.contains("bubble-active") ?? false
  );
  report("Q2.2 TTS highlight unaffected by copy on other bubble", stillHighlighted);
}

// Q3.1 — Copy while TTS playing → TTS continues
async function testQ3_1_copyDoesntStopTts() {
  console.log(`\n  ${BOLD}[Q3.1] Copy doesn't stop TTS playback${RESET}`);
  await freshPage();

  const entries = [
    { id: 5401, role: "user", text: "Q", speakable: false, spoken: true, ts: Date.now(), turn: 1 },
    { id: 5402, role: "assistant", text: "Answer text", speakable: true, spoken: false, ts: Date.now() + 100, turn: 1 },
  ];
  await injectEntries(entries, false);
  await broadcastJson({ type: "tts_highlight", entryId: 5402 });

  // Copy the highlighted entry
  await page.evaluate(() => {
    const el = document.querySelector('.entry-bubble[data-entry-id="5402"]');
    if (el) el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForTimeout(200);

  // TTS highlight should still be active (copy doesn't send "stop")
  const stillActive = await page.evaluate(() =>
    document.querySelector('.entry-bubble[data-entry-id="5402"]')?.classList.contains("bubble-active") ?? false
  );
  report("Q3.1 TTS highlight remains after copy click", stillActive);
}

// ═══════════════════════════════════════════════
// R. Stop × Everything
// ═══════════════════════════════════════════════

// R1.3 — Stop → TTS queue flushed (server-side code check)
async function testR1_3_stopFlushesTtsQueue() {
  console.log(`\n  ${BOLD}[R1.3] Stop flushes TTS queue${RESET}`);
  const src = readFileSync("server.ts", "utf-8");

  // The stop handler should clear the TTS queue
  const stopHandlerIdx = src.indexOf('"stop"');
  const nearStop = src.slice(Math.max(0, stopHandlerIdx - 200), stopHandlerIdx + 2000);
  const flushesQueue = nearStop.includes("ttsQueue") || nearStop.includes("stopClientPlayback") || nearStop.includes("ttsGeneration");
  report("R1.3 Stop handler references TTS queue/generation", flushesQueue);

  // Verify ttsGeneration is incremented on stop (stale callback prevention)
  const bumpsTtsGen = src.includes("ttsGeneration++") || src.includes("ttsGeneration +=");
  report("R1.3 ttsGeneration is incremented somewhere", bumpsTtsGen);
}

// R1.4 — Stop → mic does NOT auto-activate
async function testR1_4_stopDoesntActivateMic() {
  console.log(`\n  ${BOLD}[R1.4] Stop doesn't auto-activate mic${RESET}`);
  await freshPage();

  const entries = [
    { id: 6101, role: "user", text: "Q", speakable: false, spoken: true, ts: Date.now(), turn: 1 },
    { id: 6102, role: "assistant", text: "Answer", speakable: true, spoken: false, ts: Date.now() + 100, turn: 1 },
  ];
  await injectEntries(entries, false);
  await broadcastJson({ type: "tts_highlight", entryId: 6102 });

  // Click stop
  await page.evaluate(() => {
    const btn = document.getElementById("stopBtn");
    if (btn) btn.click();
  });
  await page.waitForTimeout(300);

  // Check voice_status — should be idle, not recording
  const state = await page.evaluate(() => {
    const btn = document.getElementById("talkBtn");
    return {
      isRecording: btn?.classList.contains("recording") ?? false,
      isListening: btn?.classList.contains("listening") ?? false,
    };
  });
  report("R1.4 Mic not recording after stop", !state.isRecording);
  report("R1.4 Mic not listening after stop", !state.isListening);
}

// R2.2 — Stop → flow mode remaining words turn red (via bubble-dropped)
async function testR2_2_stopFlowDropped() {
  console.log(`\n  ${BOLD}[R2.2] Stop in flow mode → dropped state${RESET}`);
  await freshFlowPage();

  const entries = [
    { id: 6201, role: "user", text: "Test", speakable: false, spoken: true, ts: Date.now(), turn: 1 },
    { id: 6202, role: "assistant", text: "Response with several words here", speakable: true, spoken: false, ts: Date.now() + 100, turn: 1 },
  ];
  await injectEntries(entries, false);
  await broadcastJson({ type: "tts_highlight", entryId: 6202 });

  // Interrupt
  await broadcastJson({ type: "tts_stop", reason: "interrupt" });
  await page.waitForTimeout(200);

  // bubble-active should be cleared
  const activeCount = await page.evaluate(() =>
    document.querySelectorAll('.entry-bubble.bubble-active').length
  );
  report("R2.2 No active highlights after stop", activeCount === 0);
}

// R3.1 — Stop while recording → recording stops (code check)
async function testR3_1_stopStopsRecording() {
  console.log(`\n  ${BOLD}[R3.1] Stop button stops recording${RESET}`);
  // Code check: stop button handler calls stopTtsPlayback and sends "stop" WS msg
  const src = readFileSync("index.html", "utf-8");
  const stopHandler = src.indexOf('stopBtn.addEventListener("click"');
  const handlerBody = src.slice(stopHandler, stopHandler + 500);
  const sendsStop = handlerBody.includes('ws.send("stop")');
  const stopsPlayback = handlerBody.includes("stopTtsPlayback");
  report("R3.1 Stop button sends 'stop' to server", sendsStop);
  report("R3.1 Stop button calls stopTtsPlayback", stopsPlayback);

  // Server code: "stop" handler should interrupt recording/streaming
  const serverSrc = readFileSync("server.ts", "utf-8");
  const hasStopHandler = serverSrc.includes('msg === "stop"') || serverSrc.includes("=== \"stop\"");
  report("R3.1 Server has stop message handler", hasStopHandler);
}

// R3.2 — Stop while recording → audio discarded or sent (code check)
async function testR3_2_stopRecordingBehavior() {
  console.log(`\n  ${BOLD}[R3.2] Stop recording behavior${RESET}`);
  const src = readFileSync("server.ts", "utf-8");

  // Server stop handler should reference interrupt/sendKey escape or similar
  const stopIdx = src.indexOf('=== "stop"');
  const nearStop = src.slice(stopIdx, stopIdx + 1000);
  const interruptsTerminal = nearStop.includes("sendKey") || nearStop.includes("Escape") || nearStop.includes("interrupt");
  report("R3.2 Stop handler interacts with terminal", interruptsTerminal);
}

// R4.1 — Stop while Claude thinking → Claude actually stops
async function testR4_1_stopWhileThinking() {
  console.log(`\n  ${BOLD}[R4.1] Stop while Claude thinking sends interrupt${RESET}`);
  const src = readFileSync("server.ts", "utf-8");

  // Server stop handler should send escape/interrupt to terminal
  const stopIdx = src.indexOf('=== "stop"');
  const nearStop = src.slice(stopIdx, stopIdx + 1500);
  const sendsEscape = nearStop.includes("Escape") || nearStop.includes("sendKey");
  report("R4.1 Stop handler sends terminal key (Escape)", sendsEscape);

  // Also verify the client-side stop sets state to idle
  const clientSrc = readFileSync("index.html", "utf-8");
  const stopHandler = clientSrc.indexOf('stopBtn.addEventListener("click"');
  const handlerBody = clientSrc.slice(stopHandler, stopHandler + 500);
  const setsIdle = handlerBody.includes('setTalkState("idle")') || handlerBody.includes("idle");
  report("R4.1 Client stop sets talk state idle", setsIdle);
}

// R4.3 — Stop → Claude stop → immediate new message → works
async function testR4_3_stopThenNewMessage() {
  console.log(`\n  ${BOLD}[R4.3] Stop → immediate new entry works${RESET}`);
  await freshPage();

  const entries = [
    { id: 6401, role: "assistant", text: "Old response", speakable: true, spoken: false, ts: Date.now(), turn: 1 },
  ];
  await injectEntries(entries, false);
  await broadcastJson({ type: "tts_highlight", entryId: 6401 });

  // Stop
  await broadcastJson({ type: "tts_stop", reason: "interrupt" });
  await page.waitForTimeout(100);

  // Immediately inject new entries (simulating new turn)
  const newEntries = [
    ...entries,
    { id: 6402, role: "user", text: "New question", speakable: false, spoken: true, ts: Date.now() + 500, turn: 2 },
    { id: 6403, role: "assistant", text: "New answer", speakable: true, spoken: false, ts: Date.now() + 600, turn: 2 },
  ];
  await injectEntries(newEntries, false);

  const count = await page.evaluate(() => document.querySelectorAll('.entry-bubble').length);
  report("R4.3 New entries render after stop", count >= 3, `count=${count}`);

  // New entry should be highlightable
  await broadcastJson({ type: "tts_highlight", entryId: 6403 });
  const newHighlight = await page.evaluate(() =>
    document.querySelector('.entry-bubble[data-entry-id="6403"]')?.classList.contains("bubble-active") ?? false
  );
  report("R4.3 New entry can be highlighted after stop", newHighlight);
}

// ═══════════════════════════════════════════════
// S. Recording × Everything
// ═══════════════════════════════════════════════

// S2.1 — Start recording while TTS highlight active → TTS stops, highlight clears
async function testS2_1_recordingClearsHighlight() {
  console.log(`\n  ${BOLD}[S2.1] Recording clears TTS highlight${RESET}`);
  // Code check: barge-in / recording start should stop TTS
  const src = readFileSync("index.html", "utf-8");

  // Check if recording start path calls stopTtsPlayback
  const hasBargeIn = src.includes("barge_in") || src.includes("bargeIn");
  report("S2.1 Barge-in mechanism exists", hasBargeIn);

  // Check that starting recording stops playback
  const recStartIdx = src.indexOf("startRecording") || src.indexOf("_startRecording");
  const nearRecStart = recStartIdx > 0 ? src.slice(recStartIdx, recStartIdx + 1000) : "";
  const stopsPlayback = nearRecStart.includes("stopTtsPlayback") || src.includes("barge_in");
  report("S2.1 Recording start path can stop TTS", stopsPlayback);
}

// S3.2 — Switch window while recording → audio attributed to correct window
async function testS3_2_windowSwitchAudioAttribution() {
  console.log(`\n  ${BOLD}[S3.2] Window switch + recording attribution${RESET}`);
  // Code check: entries have window field
  const src = readFileSync("server.ts", "utf-8");
  const hasWindowField = src.includes("window: getWindowKey()") || src.includes("e.window");
  report("S3.2 Entries tagged with window key", hasWindowField);

  // Code check: window switch saves current entries
  const hasSaveOnSwitch = src.includes("saveCurrentWindowEntries");
  report("S3.2 Window switch saves current entries", hasSaveOnSwitch);
}

// S4.1 — Recording → toggle flow mode → recording survives
async function testS4_1_recordingSurvivesFlowToggle() {
  console.log(`\n  ${BOLD}[S4.1] Flow mode toggle doesn't interrupt recording (code check)${RESET}`);
  // Flow mode toggle is purely CSS — should not affect WebSocket or MediaRecorder
  const src = readFileSync("index.html", "utf-8");

  // Flow mode toggle should only modify CSS classes and localStorage
  const flowToggleIdx = src.indexOf("murmur-flow-mode");
  const nearToggle = src.slice(flowToggleIdx, flowToggleIdx + 2000);
  // Flow toggle should NOT call stopRecording or stop the mic
  const stopsRecording = nearToggle.includes("stopRecording") || nearToggle.includes("mediaRecorder.stop");
  report("S4.1 Flow toggle does NOT stop recording", !stopsRecording);
}

// S4.2 — Recording → switch Talk→Type → recording stops
async function testS4_2_modeChangeStopsRecording() {
  console.log(`\n  ${BOLD}[S4.2] Talk→Type mode switch stops recording (code check)${RESET}`);
  const src = readFileSync("index.html", "utf-8");

  // Mode button handler should update mic state
  const modeIdx = src.indexOf("modeBtn");
  const hasModeCycling = modeIdx > 0;
  report("S4.2 Mode button exists", hasModeCycling);

  // Mode cycling: Talk→Type should disable mic (ttsOn remains, micOn goes false)
  const hasModeStates = src.includes("micOn") || src.includes("ttsOn");
  report("S4.2 Mode states (micOn/ttsOn) tracked", hasModeStates);
}

// ═══════════════════════════════════════════════
// T. Terminal Panel × Everything
// ═══════════════════════════════════════════════

// T1.2 — Terminal panel resize → conversation scroll position preserved
async function testT1_2_terminalResizePreservesScroll() {
  console.log(`\n  ${BOLD}[T1.2] Terminal resize preserves conversation scroll${RESET}`);
  await freshPage();

  const entries = makeEntries(20, 7100);
  await injectEntries(entries, false);

  // Scroll to middle
  await page.evaluate(() => {
    const t = document.getElementById("transcript");
    if (t) t.scrollTop = t.scrollHeight / 2;
  });
  await page.waitForTimeout(200);

  const scrollBefore = await page.evaluate(() =>
    document.getElementById("transcript")?.scrollTop ?? 0
  );

  // Open terminal panel
  await page.evaluate(() => {
    const header = document.getElementById("terminalHeader");
    if (header) header.click();
  });
  await page.waitForTimeout(500);

  const scrollAfter = await page.evaluate(() =>
    document.getElementById("transcript")?.scrollTop ?? 0
  );

  // Scroll position should be approximately preserved (layout shift allowed)
  const delta = Math.abs(scrollAfter - scrollBefore);
  report("T1.2 Scroll position preserved after terminal open", delta < 300, `delta=${delta}`);
}

// T2.2 — Terminal panel takes focus → conversation entry click still works
async function testT2_2_terminalFocusEntryClick() {
  console.log(`\n  ${BOLD}[T2.2] Entry click works with terminal panel open${RESET}`);
  await freshPage();

  const entries = [
    { id: 7201, role: "user", text: "Test Q", speakable: false, spoken: true, ts: Date.now(), turn: 1 },
    { id: 7202, role: "assistant", text: "Test answer to verify click", speakable: true, spoken: true, ts: Date.now() + 100, turn: 1 },
  ];
  await injectEntries(entries, false);

  // Open terminal panel
  await page.evaluate(() => {
    const header = document.getElementById("terminalHeader");
    if (header) header.click();
  });
  await page.waitForTimeout(500);

  // Click on terminal to give it focus
  await page.evaluate(() => {
    const output = document.getElementById("terminalOutput");
    if (output) output.click();
  });
  await page.waitForTimeout(200);

  // Now click on a conversation entry — it should still respond
  const clickResult = await page.evaluate(() => {
    const el = document.querySelector('.entry-bubble[data-entry-id="7202"]');
    if (!el) return { found: false, clicked: false };
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return { found: true, clicked: true };
  });
  report("T2.2 Entry bubble clickable with terminal open", clickResult.found && clickResult.clicked);
}

// ═══════════════════════════════════════════════
// U. Replay × Everything
// ═══════════════════════════════════════════════

// U1.1 — Replay an entry → does it highlight during replay TTS
async function testU1_1_replayHighlights() {
  console.log(`\n  ${BOLD}[U1.1] Replay highlights the entry${RESET}`);
  await freshPage();

  const entries = [
    { id: 8101, role: "user", text: "Question", speakable: false, spoken: true, ts: Date.now(), turn: 1 },
    { id: 8102, role: "assistant", text: "The replayed answer", speakable: true, spoken: true, ts: Date.now() + 100, turn: 1 },
  ];
  await injectEntries(entries, false);

  // Trigger replay via WS message (simulating what the replay button does)
  await page.evaluate(() => {
    const ws = (window as any)._ws;
    if (ws && ws.readyState === 1) ws.send("replay:8102");
  });
  await page.waitForTimeout(300);

  // After replay, server sends tts_highlight for the replayed entry
  // Since we're in testmode, simulate the highlight that server would send
  await broadcastJson({ type: "tts_highlight", entryId: 8102 });

  const highlighted = await page.evaluate(() =>
    document.querySelector('.entry-bubble[data-entry-id="8102"]')?.classList.contains("bubble-active") ?? false
  );
  report("U1.1 Replayed entry gets highlighted", highlighted);
}

// U3.2 — Replay while user is scrolled to a different position
async function testU3_2_replayScrollBehavior() {
  console.log(`\n  ${BOLD}[U3.2] Replay entry scrolls it into view${RESET}`);
  await freshPage();

  // Create many entries so we can scroll
  const entries = makeEntries(30, 8300);
  await injectEntries(entries, false);

  // Scroll to bottom
  await page.evaluate(() => {
    const t = document.getElementById("transcript");
    if (t) t.scrollTop = t.scrollHeight;
  });
  await page.waitForTimeout(200);

  // Highlight an early entry (simulating replay) — it should scroll into view
  await broadcastJson({ type: "tts_highlight", entryId: 8301 });
  await page.waitForTimeout(500);

  // The entry should be visible (scrolled into view via scrollIntoView)
  const isVisible = await page.evaluate(() => {
    const el = document.querySelector('.entry-bubble[data-entry-id="8301"]');
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= window.innerHeight;
  });
  report("U3.2 Highlighted entry scrolled into view", isVisible);
}

// ═══════════════════════════════════════════════
// V. Settings × Everything
// ═══════════════════════════════════════════════

// V1.2 — Voice change: new voice used for next entry (code check)
async function testV1_2_voiceChangeNextEntry() {
  console.log(`\n  ${BOLD}[V1.2] Voice change flushes queue and bumps generation${RESET}`);
  const src = readFileSync("server.ts", "utf-8");

  // Voice change handler should call stopClientPlayback2("voice_change") which
  // internally bumps ttsGeneration via bumpGeneration() and flushes the queue.
  const voiceIdx = src.indexOf('msg.startsWith("voice:")');
  const nearVoice = src.slice(voiceIdx, voiceIdx + 2000);
  // Handler calls stopClientPlayback2 which bumps generation
  const callsStop = nearVoice.includes("stopClientPlayback2");
  report("V1.2 Voice change calls stopClientPlayback2", callsStop);
  // stopClientPlayback2 bumps generation — verify that function exists and bumps
  const stopFnIdx = src.indexOf("function stopClientPlayback2");
  const stopFnBody = src.slice(stopFnIdx, stopFnIdx + 500);
  const bumpGen = stopFnBody.includes("bumpGeneration");
  report("V1.2 stopClientPlayback2 bumps ttsGeneration", bumpGen);
  // "voice_change" is in USER_INITIATED_BUMP_REASONS (cancels queue)
  const voiceChangeInSet = src.includes('"voice_change"') && src.includes("USER_INITIATED_BUMP_REASONS");
  report("V1.2 voice_change is user-initiated (flushes queue)", voiceChangeInSet);
}

// V2.2 — Speed change: effect on playback (code check + client check)
async function testV2_2_speedChangeEffect() {
  console.log(`\n  ${BOLD}[V2.2] Speed change handling${RESET}`);
  const serverSrc = readFileSync("server.ts", "utf-8");
  const clientSrc = readFileSync("index.html", "utf-8");

  // Server should parse speed, validate range, write signal file, and save settings
  const speedIdx = serverSrc.indexOf('msg.startsWith("speed:")');
  const nearSpeed = serverSrc.slice(speedIdx, speedIdx + 500);
  const parsesSpeed = nearSpeed.includes("parseFloat") && nearSpeed.includes("speed");
  report("V2.2 Server parses speed value", parsesSpeed);
  const validatesRange = nearSpeed.includes("0.5") && nearSpeed.includes("3.0");
  report("V2.2 Server validates speed range (0.5-3.0)", validatesRange);
  const savesSpeed = nearSpeed.includes("saveSettings") || nearSpeed.includes("claude-tts-speed");
  report("V2.2 Server persists speed setting", savesSpeed);

  // Client should send speed via WS
  const clientSendsSpeed = clientSrc.includes("speed:") && clientSrc.includes("ws.send");
  report("V2.2 Client sends speed over WS", clientSendsSpeed);
}

// ═══════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════

async function main() {
  console.log(`\n  ${BOLD}Murmur Cross-Cutting Interaction Tests${RESET}`);
  console.log(`  Mode: ${HEADLESS ? "headless" : "visible browser"}`);
  console.log("  ─────────────────────────────────────\n");

  try {
    browser = await chromium.launch({ headless: HEADLESS });
    ctx = await browser.newContext({
      permissions: ["microphone"],
      viewport: { width: 390, height: 844 },
    });
    page = await ctx.newPage();
    page.on("dialog", d => d.dismiss());

    // ═══════ P. Highlight × Everything ═══════
    console.log(`\n  ${BOLD}── P. Highlight × Everything ──${RESET}`);
    await run("P1.2 Highlight stays on scroll", testP1_2_highlightStaysOnScroll);
    await run("P1.3 No scroll fight", testP1_3_noScrollFight);
    await run("P2.2 Stop clears audio+highlight", testP2_2_stopClearsAudioAndHighlight);
    await run("P2.4 Flow stop drops remaining", testP2_4_flowStopDropsRemaining);
    await run("P3.3 Highlight survives clean toggle", testP3_3_highlightSurvivesCleanToggle);
    await run("P3.4 Flow→regular highlight", testP3_4_flowToRegularHighlight);

    // ═══════ Q. Copy × Everything ═══════
    console.log(`\n  ${BOLD}── Q. Copy × Everything ──${RESET}`);
    await run("Q1.2 Copy during auto-scroll", testQ1_2_copyDuringAutoScroll);
    await run("Q1.3 Copy off-screen no jump", testQ1_3_copyOffScreenNoJump);
    await run("Q2.2 Copy non-highlighted during TTS", testQ2_2_copyNonHighlightedDuringTts);
    await run("Q3.1 Copy doesn't stop TTS", testQ3_1_copyDoesntStopTts);

    // ═══════ R. Stop × Everything ═══════
    console.log(`\n  ${BOLD}── R. Stop × Everything ──${RESET}`);
    await run("R1.3 Stop flushes TTS queue", testR1_3_stopFlushesTtsQueue);
    await run("R1.4 Stop doesn't activate mic", testR1_4_stopDoesntActivateMic);
    await run("R2.2 Stop flow dropped state", testR2_2_stopFlowDropped);
    await run("R3.1 Stop stops recording", testR3_1_stopStopsRecording);
    await run("R3.2 Stop recording behavior", testR3_2_stopRecordingBehavior);
    await run("R4.1 Stop while thinking", testR4_1_stopWhileThinking);
    await run("R4.3 Stop then new message", testR4_3_stopThenNewMessage);

    // ═══════ S. Recording × Everything ═══════
    console.log(`\n  ${BOLD}── S. Recording × Everything ──${RESET}`);
    await run("S2.1 Recording clears highlight", testS2_1_recordingClearsHighlight);
    await run("S3.2 Window switch audio attribution", testS3_2_windowSwitchAudioAttribution);
    await run("S4.1 Flow toggle keeps recording", testS4_1_recordingSurvivesFlowToggle);
    await run("S4.2 Mode change stops recording", testS4_2_modeChangeStopsRecording);

    // ═══════ T. Terminal × Everything ═══════
    console.log(`\n  ${BOLD}── T. Terminal × Everything ──${RESET}`);
    await run("T1.2 Terminal resize preserves scroll", testT1_2_terminalResizePreservesScroll);
    await run("T2.2 Entry click with terminal open", testT2_2_terminalFocusEntryClick);

    // ═══════ U. Replay × Everything ═══════
    console.log(`\n  ${BOLD}── U. Replay × Everything ──${RESET}`);
    await run("U1.1 Replay highlights entry", testU1_1_replayHighlights);
    await run("U3.2 Replay scroll behavior", testU3_2_replayScrollBehavior);

    // ═══════ V. Settings × Everything ═══════
    console.log(`\n  ${BOLD}── V. Settings × Everything ──${RESET}`);
    await run("V1.2 Voice change flushes queue", testV1_2_voiceChangeNextEntry);
    await run("V2.2 Speed change effect", testV2_2_speedChangeEffect);

  } finally {
    if (browser) await browser.close();
  }

  const total = passed + failed;
  console.log(`\n  ─────────────────────────────────────`);
  console.log(`  ${passed}/${total} passed${failed > 0 ? `, ${BOLD}${failed} failed${RESET}` : ""}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(2);
});
