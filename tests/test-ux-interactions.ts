/**
 * UX State Machine Tests — Playwright tests for DOM state transitions via WebSocket injection.
 * Verifies entry lifecycle, TTS highlight flow, voice status, flow mode, clean/verbose,
 * interaction chains, deduplication, queued entries, and opacity boundaries.
 *
 * Requires: server running on localhost:3457
 *
 * Usage:    node --import tsx/esm tests/test-ux-interactions.ts
 * Headless: HEADLESS=1 node --import tsx/esm tests/test-ux-interactions.ts
 */

import { chromium, Browser, Page, BrowserContext } from "playwright";
import { mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const BASE = "http://localhost:3457?testmode=1";
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = join(__dirname, "screenshots", "ux-interactions");
const HEADLESS = process.env.HEADLESS === "1";
const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

interface TestResult { name: string; ok: boolean; detail?: string }
const results: TestResult[] = [];
let browser: Browser;
let ctx: BrowserContext;
let page: Page;
let screenshotIdx = 0;

mkdirSync(SCREENSHOTS_DIR, { recursive: true });

function report(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? PASS : FAIL}  ${name}${detail ? ` ${DIM}(${detail})${RESET}` : ""}`);
}

async function screenshot(label: string) {
  screenshotIdx++;
  const filename = `${String(screenshotIdx).padStart(2, "0")}-${label.replace(/\s+/g, "-").toLowerCase()}.png`;
  await page.screenshot({ path: join(SCREENSHOTS_DIR, filename), fullPage: true });
}

/** Reset page to clean state: normal mode, tour done, no stale entries */
async function freshPage() {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("murmur-tour-done", "1");
    localStorage.setItem("murmur-flow-mode", "0");
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.evaluate(() => document.body.classList.remove("flow-mode"));
  await page.waitForTimeout(500);
}

/** Reset page to flow mode */
async function freshFlowPage() {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("murmur-tour-done", "1");
    localStorage.setItem("murmur-flow-mode", "1");
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(500);
}

/** Inject entries by calling ws.onmessage directly (bypasses server) */
async function injectEntries(entries: any[], partial = false) {
  await page.evaluate(({ entries, partial }) => {
    const ws = (window as any)._ws;
    if (ws && ws.onmessage) {
      ws.onmessage({ data: JSON.stringify({ type: "entry", entries, partial }) } as any);
    }
  }, { entries, partial });
  await page.waitForTimeout(200);
}

/** Broadcast a JSON message via ws.onmessage */
async function broadcastJson(msg: any) {
  await page.evaluate((json) => {
    const ws = (window as any)._ws;
    if (ws && ws.onmessage) {
      ws.onmessage({ data: JSON.stringify(json) } as any);
    }
  }, msg);
  await page.waitForTimeout(200);
}

/** Wrap test so one failure does not crash the suite */
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); }
  catch (err) {
    await screenshot(`error-${name.replace(/\s+/g, "-").toLowerCase()}`).catch(() => {});
    report(name, false, (err as Error).message);
  }
}

async function setup() {
  browser = await chromium.launch({
    headless: HEADLESS,
    slowMo: HEADLESS ? 0 : 80,
  });
  ctx = await browser.newContext({
    permissions: ["microphone"],
    viewport: { width: 390, height: 844 },
  });
  page = await ctx.newPage();
  page.on("dialog", d => d.dismiss());
}

// ======================================================
// 1. ENTRY LIFECYCLE (the red text / bubble-dropped bug)
// ======================================================

async function testPartialEntriesNotRed() {
  await freshPage();
  const entries = [
    { id: 1, role: "user", text: "Hello", speakable: false, spoken: false, ts: Date.now(), turn: 1 },
    { id: 2, role: "assistant", text: "Working on it...", speakable: true, spoken: false, ts: Date.now(), turn: 1 },
  ];
  // Partial broadcast (streaming) — should NOT be red/dropped
  await injectEntries(entries, true);
  const hasDropped = await page.evaluate(() =>
    document.querySelector('.entry-bubble[data-entry-id="2"]')?.classList.contains("bubble-dropped") || false
  );
  await screenshot("partial-not-red");
  report("Partial entries do NOT get bubble-dropped", !hasDropped);
}

async function testSpokenEntriesNotRed() {
  await freshPage();
  const entries = [
    { id: 1, role: "user", text: "Hello", speakable: false, spoken: false, ts: Date.now(), turn: 1 },
    { id: 2, role: "assistant", text: "Here is my answer.", speakable: true, spoken: true, ts: Date.now(), turn: 1 },
  ];
  // Final broadcast with spoken=true — should NOT be red
  await injectEntries(entries, false);
  const hasDropped = await page.evaluate(() =>
    document.querySelector('.entry-bubble[data-entry-id="2"]')?.classList.contains("bubble-dropped") || false
  );
  report("Spoken entries (spoken=true) do NOT get bubble-dropped", !hasDropped);
}

async function testDroppedEntryInFlowMode() {
  await freshFlowPage();
  const entries = [
    { id: 1, role: "user", text: "Question", speakable: false, spoken: false, ts: Date.now(), turn: 1 },
    { id: 2, role: "assistant", text: "Unspoken answer.", speakable: true, spoken: false, ts: Date.now(), turn: 1 },
  ];
  // Final (non-partial) broadcast in flow mode, speakable but not spoken — SHOULD be dropped
  await injectEntries(entries, false);
  const hasDropped = await page.evaluate(() =>
    document.querySelector('.entry-bubble[data-entry-id="2"]')?.classList.contains("bubble-dropped") || false
  );
  await screenshot("flow-dropped");
  report("Flow mode: unspoken speakable entry gets bubble-dropped", hasDropped);
}

async function testDroppedRemovedWhenActive() {
  await freshFlowPage();
  // First inject as dropped
  await injectEntries([
    { id: 1, role: "user", text: "Q", speakable: false, spoken: false, ts: Date.now(), turn: 1 },
    { id: 2, role: "assistant", text: "Dropped text.", speakable: true, spoken: false, ts: Date.now(), turn: 1 },
  ], false);
  // Now simulate TTS play — should remove dropped and add active
  await broadcastJson({ type: "tts_play", entryId: 2, fullText: "Dropped text.", speakableText: "Dropped text.", chunkCount: 1, chunkWordCounts: [2] });
  await page.waitForTimeout(300);
  const result = await page.evaluate(() => {
    const el = document.querySelector('.entry-bubble[data-entry-id="2"]');
    return {
      hasDropped: el?.classList.contains("bubble-dropped") || false,
      hasActive: el?.classList.contains("bubble-active") || false,
    };
  });
  report("bubble-dropped removed when bubble-active is added via tts_play", !result.hasDropped && result.hasActive);
}

// ======================================================
// 2. TTS HIGHLIGHT FLOW
// ======================================================

async function testTtsHighlightChain() {
  await freshPage();
  await injectEntries([
    { id: 10, role: "user", text: "Tell me a story", speakable: false, spoken: false, ts: Date.now(), turn: 1 },
    { id: 11, role: "assistant", text: "Once upon a time.", speakable: true, spoken: false, ts: Date.now(), turn: 1 },
    { id: 12, role: "assistant", text: "There was a dragon.", speakable: true, spoken: false, ts: Date.now(), turn: 1 },
  ], false);

  // tts_play entry 11 — should get bubble-active
  await broadcastJson({ type: "tts_play", entryId: 11, fullText: "Once upon a time.", speakableText: "Once upon a time.", chunkCount: 1, chunkWordCounts: [5] });
  await page.waitForTimeout(300);
  const step1 = await page.evaluate(() => {
    const e11 = document.querySelector('.entry-bubble[data-entry-id="11"]');
    return { active: e11?.classList.contains("bubble-active") || false };
  });
  report("TTS play: entry 11 gets bubble-active", step1.active);

  // tts_play entry 12 — entry 11 should become spoken
  await broadcastJson({ type: "tts_play", entryId: 12, fullText: "There was a dragon.", speakableText: "There was a dragon.", chunkCount: 1, chunkWordCounts: [5] });
  await page.waitForTimeout(300);
  const step2 = await page.evaluate(() => {
    const e11 = document.querySelector('.entry-bubble[data-entry-id="11"]');
    const e12 = document.querySelector('.entry-bubble[data-entry-id="12"]');
    return {
      e11Spoken: e11?.classList.contains("bubble-spoken") || false,
      e11Active: e11?.classList.contains("bubble-active") || false,
      e12Active: e12?.classList.contains("bubble-active") || false,
    };
  });
  report("TTS play chain: entry 11 becomes bubble-spoken", step2.e11Spoken && !step2.e11Active);
  report("TTS play chain: entry 12 becomes bubble-active", step2.e12Active);

  // tts_stop — last entry should become spoken
  await broadcastJson({ type: "tts_stop" });
  await page.waitForTimeout(300);
  const step3 = await page.evaluate(() => {
    const e12 = document.querySelector('.entry-bubble[data-entry-id="12"]');
    return {
      e12Spoken: e12?.classList.contains("bubble-spoken") || false,
      e12Active: e12?.classList.contains("bubble-active") || false,
    };
  });
  report("TTS stop: last entry becomes bubble-spoken", step3.e12Spoken && !step3.e12Active);
  await screenshot("tts-highlight-chain");
}

// ======================================================
// 3. VOICE STATUS TRANSITIONS
// ======================================================

async function testVoiceStatusThinking() {
  await freshPage();
  await broadcastJson({ type: "voice_status", state: "thinking" });
  await page.waitForTimeout(300);
  const hasThinking = await page.evaluate(() =>
    document.getElementById("talkBtn")?.classList.contains("thinking") || false
  );
  const statusText = await page.locator("#statusText").textContent();
  report("voice_status thinking: talkBtn has .thinking class", hasThinking);
  report("voice_status thinking: header shows thinking text", statusText?.includes("thinking") || false, `"${statusText}"`);
  await screenshot("voice-status-thinking");
}

async function testVoiceStatusResponding() {
  await freshPage();
  await broadcastJson({ type: "voice_status", state: "responding" });
  await page.waitForTimeout(300);
  const hasResponding = await page.evaluate(() =>
    document.getElementById("talkBtn")?.classList.contains("responding") || false
  );
  report("voice_status responding: talkBtn has .responding class", hasResponding);
}

async function testVoiceStatusIdleReset() {
  await freshPage();
  // First go to thinking, then back to idle
  await broadcastJson({ type: "voice_status", state: "thinking" });
  await page.waitForTimeout(200);
  await broadcastJson({ type: "voice_status", state: "idle" });
  await page.waitForTimeout(300);
  const result = await page.evaluate(() => {
    const btn = document.getElementById("talkBtn")!;
    return {
      hasThinking: btn.classList.contains("thinking"),
      hasResponding: btn.classList.contains("responding"),
      hasIdle: btn.classList.contains("idle-state"),
    };
  });
  report("voice_status idle: clears thinking, sets idle-state", !result.hasThinking && result.hasIdle);
  await screenshot("voice-status-idle");
}

// ======================================================
// 4. FLOW MODE TOGGLE
// ======================================================

async function testFlowModeToggle() {
  await freshPage();
  const flowBtn = page.locator("#flowModeBtn");
  const exists = await flowBtn.count() > 0;
  if (!exists) {
    report("Flow mode button exists", false);
    return;
  }

  // Activate flow mode
  await flowBtn.click();
  await page.waitForTimeout(400);
  const activated = await page.evaluate(() => ({
    bodyClass: document.body.classList.contains("flow-mode"),
    headerHidden: getComputedStyle(document.querySelector(".header")!).display === "none",
    controlsHidden: getComputedStyle(document.querySelector(".controls")!).display === "none",
  }));
  report("Flow toggle ON: body.flow-mode added", activated.bodyClass);
  report("Flow toggle ON: header hidden", activated.headerHidden);
  report("Flow toggle ON: controls hidden", activated.controlsHidden);
  await screenshot("flow-toggle-on");

  // Deactivate flow mode
  await flowBtn.click();
  await page.waitForTimeout(400);
  const deactivated = await page.evaluate(() => ({
    bodyClass: document.body.classList.contains("flow-mode"),
    headerVisible: getComputedStyle(document.querySelector(".header")!).display !== "none",
    controlsVisible: getComputedStyle(document.querySelector(".controls")!).display !== "none",
  }));
  report("Flow toggle OFF: body.flow-mode removed", !deactivated.bodyClass);
  report("Flow toggle OFF: header restored", deactivated.headerVisible);
  report("Flow toggle OFF: controls restored", deactivated.controlsVisible);
  await screenshot("flow-toggle-off");
}

// ======================================================
// 5. CLEAN / VERBOSE MODE
// ======================================================

async function testCleanVerboseVisibility() {
  await freshPage();
  // Start in clean mode (default)
  await page.evaluate(() => localStorage.setItem("voiced-only", "true"));
  await page.reload({ waitUntil: "networkidle" });
  await page.evaluate(() => {
    localStorage.setItem("murmur-tour-done", "1");
    localStorage.setItem("murmur-flow-mode", "0");
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(500);

  // Inject entries: one speakable, one non-speakable
  await injectEntries([
    { id: 20, role: "user", text: "Fix the bug", speakable: false, spoken: false, ts: Date.now(), turn: 1 },
    { id: 21, role: "assistant", text: "Read(server.ts)", speakable: false, spoken: true, ts: Date.now(), turn: 1 },
    { id: 22, role: "assistant", text: "I found the issue in the handler.", speakable: true, spoken: true, ts: Date.now(), turn: 1 },
  ], false);

  // Check clean mode hides non-speakable
  const cleanResult = await page.evaluate(() => {
    const nonspeakable = document.querySelector('.entry-bubble[data-entry-id="21"]') as HTMLElement;
    const speakable = document.querySelector('.entry-bubble[data-entry-id="22"]') as HTMLElement;
    return {
      nonspeakableHidden: nonspeakable ? getComputedStyle(nonspeakable).display === "none" : false,
      speakableVisible: speakable ? getComputedStyle(speakable).display !== "none" : false,
      bodyHasClean: document.body.classList.contains("clean-mode"),
    };
  });
  report("Clean mode: non-speakable entry hidden", cleanResult.nonspeakableHidden);
  report("Clean mode: speakable entry visible", cleanResult.speakableVisible);
  await screenshot("clean-mode");

  // Toggle to verbose
  await page.locator("#cleanBtn").click();
  await page.waitForTimeout(300);
  const verboseResult = await page.evaluate(() => {
    const nonspeakable = document.querySelector('.entry-bubble[data-entry-id="21"]') as HTMLElement;
    return {
      nonspeakableVisible: nonspeakable ? getComputedStyle(nonspeakable).display !== "none" : false,
      bodyHasClean: document.body.classList.contains("clean-mode"),
    };
  });
  report("Verbose mode: non-speakable entry visible", verboseResult.nonspeakableVisible);
  report("Verbose mode: body.clean-mode removed", !verboseResult.bodyHasClean);
  await screenshot("verbose-mode");
}

// ======================================================
// 6. INTERACTION CHAINS
// ======================================================

async function testTextInputCreatesUserBubble() {
  await freshPage();
  const input = page.locator("#textInput");
  await input.fill("Hello from test");
  await input.press("Enter");
  await page.waitForTimeout(1500);
  const bubbleCount = await page.locator(".msg.user").count();
  report("Text input creates user bubble", bubbleCount > 0, `${bubbleCount} user bubble(s)`);
  await screenshot("text-input-bubble");
}

async function testModeCycling() {
  await freshPage();
  const modeBtn = page.locator("#modeBtn");
  const labels: string[] = [];
  for (let i = 0; i < 5; i++) {
    const text = await modeBtn.textContent();
    labels.push(text?.trim() || "?");
    await modeBtn.click();
    await page.waitForTimeout(200);
  }
  const unique = new Set(labels.slice(0, 4));
  const cycled = labels[0] === labels[4];
  report("Mode cycles through 4 modes and wraps", unique.size === 4 && cycled, labels.join(" -> "));
}

async function testTerminalToggle() {
  await freshPage();
  await page.evaluate(() => localStorage.removeItem("term-open"));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(300);

  await page.locator("#terminalHeader").click();
  await page.waitForTimeout(300);
  const opened = await page.locator(".terminal-panel").evaluate(
    (el: Element) => el.classList.contains("open")
  );

  await page.locator("#terminalHeader").click();
  await page.waitForTimeout(300);
  const closed = await page.locator(".terminal-panel").evaluate(
    (el: Element) => !el.classList.contains("open")
  );
  report("Terminal panel toggles open and closed", opened && closed);
  await screenshot("terminal-toggle");
}

async function testHelpMenuTour() {
  await freshPage();
  await page.locator("#helpBtn").click();
  await page.waitForTimeout(200);
  const menuOpen = await page.locator(".help-menu.open").isVisible();
  report("Help menu opens on click", menuOpen);

  // Click Tour item to start tour
  const tourItem = page.locator("#helpMenu button, #helpMenu a").filter({ hasText: "Tour" });
  const tourExists = await tourItem.count() > 0;
  if (tourExists) {
    await tourItem.first().click();
    await page.waitForTimeout(1500);
    const tourStarted = await page.locator(".tour-overlay").isVisible();
    report("Help menu Tour item starts tour", tourStarted);
  } else {
    report("Help menu Tour item starts tour", false, "Tour item not found");
  }
  await screenshot("help-tour");
}

// ======================================================
// 7. ENTRY DEDUPLICATION
// ======================================================

async function testEntryDeduplication() {
  await freshPage();
  const entries = [
    { id: 30, role: "user", text: "Same question", speakable: false, spoken: false, ts: Date.now(), turn: 1 },
    { id: 31, role: "assistant", text: "Same answer.", speakable: true, spoken: true, ts: Date.now(), turn: 1 },
  ];
  // Inject same entries twice
  await injectEntries(entries, false);
  await injectEntries(entries, false);
  const count = await page.evaluate(() =>
    document.querySelectorAll('.entry-bubble[data-entry-id="30"]').length
  );
  report("Entry deduplication: same ID renders only one bubble", count === 1, `count=${count}`);
}

// ======================================================
// 8. RECONNECT BEHAVIOR
// ======================================================

async function testReconnectEntryRestore() {
  await freshPage();
  // Inject entries via server test protocol (so server stores them)
  await page.evaluate(() => {
    const ws = (window as any)._ws;
    if (ws && ws.readyState === 1) {
      ws.send("test:entries:" + JSON.stringify([
        { id: 40, role: "user", text: "Before reconnect", speakable: false, spoken: false, ts: Date.now(), turn: 1 },
        { id: 41, role: "assistant", text: "Response before reconnect.", speakable: true, spoken: true, ts: Date.now(), turn: 1 },
      ]));
    }
  });
  await page.waitForTimeout(500);

  // Reload the page (simulates reconnect)
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    localStorage.setItem("murmur-tour-done", "1");
    localStorage.setItem("murmur-flow-mode", "0");
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  // Check if entries are restored (server broadcasts on WS connect)
  const entryCount = await page.locator(".entry-bubble").count();
  report("Reconnect: entries restored after page reload", entryCount >= 2, `entryCount=${entryCount}`);
  await screenshot("reconnect-restore");
}

// ======================================================
// 9. QUEUED ENTRY LIFECYCLE
// ======================================================

async function testQueuedEntryVisual() {
  await freshPage();
  await injectEntries([
    { id: 50, role: "user", text: "Initial question", speakable: false, spoken: false, ts: Date.now(), turn: 1 },
    { id: 51, role: "assistant", text: "Working...", speakable: true, spoken: false, ts: Date.now(), turn: 1 },
    { id: 52, role: "user", text: "Queued follow-up", speakable: false, spoken: false, ts: Date.now(), turn: 2, queued: true },
  ], false);

  const queuedResult = await page.evaluate(() => {
    const el = document.querySelector('.entry-bubble[data-entry-id="52"]');
    if (!el) return { exists: false, hasQueued: false, hasHourglass: false, hasDashed: false };
    const style = getComputedStyle(el);
    return {
      exists: true,
      hasQueued: el.classList.contains("entry-queued"),
      hasHourglass: !!el.querySelector(".queued-icon"),
      hasDashed: style.borderStyle === "dashed",
    };
  });
  report("Queued entry has entry-queued class", queuedResult.hasQueued);
  report("Queued entry has hourglass icon", queuedResult.hasHourglass);
  report("Queued entry has dashed border", queuedResult.hasDashed);
  await screenshot("queued-entry");
}

async function testQueuedToDeliveredTransition() {
  await freshPage();
  // First inject as queued
  await injectEntries([
    { id: 60, role: "user", text: "Will be delivered", speakable: false, spoken: false, ts: Date.now(), turn: 1, queued: true },
  ], false);

  const beforeDeliver = await page.evaluate(() => {
    const el = document.querySelector('.entry-bubble[data-entry-id="60"]');
    return el?.classList.contains("entry-queued") || false;
  });

  // Re-inject same entry with queued: false
  await injectEntries([
    { id: 60, role: "user", text: "Will be delivered", speakable: false, spoken: false, ts: Date.now(), turn: 1, queued: false },
  ], false);

  const afterDeliver = await page.evaluate(() => {
    const el = document.querySelector('.entry-bubble[data-entry-id="60"]');
    return {
      hasQueued: el?.classList.contains("entry-queued") || false,
      hasDelivered: el?.classList.contains("entry-delivered") || false,
      hasHourglass: !!el?.querySelector(".queued-icon"),
    };
  });

  report("Queued-to-delivered: entry-queued removed", beforeDeliver && !afterDeliver.hasQueued);
  report("Queued-to-delivered: entry-delivered flash added", afterDeliver.hasDelivered);
  report("Queued-to-delivered: hourglass icon removed", !afterDeliver.hasHourglass);
  await screenshot("queued-delivered");
}

// ======================================================
// 10. SPOKEN / UNSPOKEN OPACITY BOUNDARY
// ======================================================

async function testOpacityBoundary() {
  await freshPage();
  await injectEntries([
    { id: 70, role: "assistant", text: "Spoken entry one.", speakable: true, spoken: true, ts: Date.now(), turn: 1 },
    { id: 71, role: "assistant", text: "Spoken entry two.", speakable: true, spoken: true, ts: Date.now(), turn: 1 },
    { id: 72, role: "assistant", text: "Unspoken entry three.", speakable: true, spoken: false, ts: Date.now(), turn: 1 },
    { id: 73, role: "assistant", text: "Unspoken entry four.", speakable: true, spoken: false, ts: Date.now(), turn: 1 },
  ], false);

  const opacities = await page.evaluate(() => {
    const results: { id: string; opacity: number; spoken: boolean }[] = [];
    for (const id of ["70", "71", "72", "73"]) {
      const el = document.querySelector(`.entry-bubble[data-entry-id="${id}"]`) as HTMLElement;
      if (el) {
        const op = parseFloat(getComputedStyle(el).opacity);
        results.push({ id, opacity: op, spoken: el.classList.contains("bubble-spoken") });
      }
    }
    return results;
  });

  const spokenOpacity = opacities.filter(o => o.spoken).map(o => o.opacity);
  const unspokenOpacity = opacities.filter(o => !o.spoken).map(o => o.opacity);

  const spokenDim = spokenOpacity.length > 0 && spokenOpacity.every(o => o <= 0.7);
  const unspokenBright = unspokenOpacity.length > 0 && unspokenOpacity.every(o => o >= 0.9);

  report("Spoken entries have reduced opacity (<= 0.7)", spokenDim,
    `spoken: [${spokenOpacity.join(", ")}]`);
  report("Unspoken entries have full opacity (>= 0.9)", unspokenBright,
    `unspoken: [${unspokenOpacity.join(", ")}]`);
  await screenshot("opacity-boundary");
}

// ======================================================
// 11. ADDITIONAL STATE CHECKS
// ======================================================

async function testToolStatusDisplay() {
  await freshPage();
  await broadcastJson({ type: "tool_status", text: "Reading server.ts" });
  await page.waitForTimeout(300);
  const toolText = await page.locator("#toolStatusLine").textContent();
  const toolOpacity = await page.locator("#toolStatusLine").evaluate(
    (el: HTMLElement) => getComputedStyle(el).opacity
  );
  report("tool_status displays text in toolStatusLine", toolText === "Reading server.ts", `"${toolText}"`);
  report("tool_status sets opacity to 1", toolOpacity === "1");

  // Clear tool status (CSS transition: opacity 0.4s ease — wait for it to complete)
  await broadcastJson({ type: "tool_status", text: "" });
  await page.waitForTimeout(600);
  const clearedOpacity = await page.locator("#toolStatusLine").evaluate(
    (el: HTMLElement) => getComputedStyle(el).opacity
  );
  report("tool_status empty clears opacity to 0", clearedOpacity === "0");
}

async function testTtsStopClearsHighlights() {
  await freshPage();
  await injectEntries([
    { id: 80, role: "assistant", text: "Being spoken.", speakable: true, spoken: false, ts: Date.now(), turn: 1 },
  ], false);
  await broadcastJson({ type: "tts_play", entryId: 80, fullText: "Being spoken.", speakableText: "Being spoken.", chunkCount: 1, chunkWordCounts: [2] });
  await page.waitForTimeout(300);

  // Verify active before tts_stop
  const beforeStop = await page.evaluate(() =>
    document.querySelector('.entry-bubble[data-entry-id="80"]')?.classList.contains("bubble-active") || false
  );

  // Send tts_stop
  await broadcastJson({ type: "tts_stop" });
  await page.waitForTimeout(300);
  // tts_stop causes stopTtsPlayback which clears highlights
  await broadcastJson({ type: "voice_status", state: "idle" });
  await page.waitForTimeout(300);

  const afterStop = await page.evaluate(() => {
    const el = document.querySelector('.entry-bubble[data-entry-id="80"]');
    return {
      hasActive: el?.classList.contains("bubble-active") || false,
      hasSpoken: el?.classList.contains("bubble-spoken") || false,
    };
  });
  report("tts_play sets bubble-active before stop", beforeStop);
  report("voice_status idle after tts_stop clears bubble-active", !afterStop.hasActive);
  await screenshot("tts-stop-clear");
}

async function testEntryNonspeakableClass() {
  await freshPage();
  await injectEntries([
    { id: 90, role: "assistant", text: "Read(file.ts)", speakable: false, spoken: false, ts: Date.now(), turn: 1 },
    { id: 91, role: "assistant", text: "Visible prose.", speakable: true, spoken: false, ts: Date.now(), turn: 1 },
  ], false);
  const result = await page.evaluate(() => {
    const tool = document.querySelector('.entry-bubble[data-entry-id="90"]');
    const prose = document.querySelector('.entry-bubble[data-entry-id="91"]');
    return {
      toolNonspeakable: tool?.classList.contains("entry-nonspeakable") || false,
      proseNonspeakable: prose?.classList.contains("entry-nonspeakable") || false,
    };
  });
  report("Non-speakable entry has entry-nonspeakable class", result.toolNonspeakable);
  report("Speakable entry does NOT have entry-nonspeakable class", !result.proseNonspeakable);
}

async function testFlowModeButtonVisibleBothModes() {
  await freshPage();
  // Normal mode: flow button should be visible
  const normalVisible = await page.locator("#flowModeBtn").isVisible();
  report("Flow button visible in normal mode", normalVisible);

  // Flow mode: flow button should still be visible
  await page.locator("#flowModeBtn").click();
  await page.waitForTimeout(400);
  const flowVisible = await page.locator("#flowModeBtn").isVisible();
  report("Flow button visible in flow mode", flowVisible);

  // Restore
  await page.locator("#flowModeBtn").click();
  await page.waitForTimeout(200);
}

// ======================================================
// RUNNER
// ======================================================

async function main() {
  console.log("\n  Murmur UX State Machine Tests");
  console.log(`  Mode: ${HEADLESS ? "headless" : "visible browser"}`);
  console.log(`  Screenshots: ${SCREENSHOTS_DIR}`);
  console.log("  ─────────────────────────────────\n");

  try {
    await setup();

    console.log("\n  [Entry Lifecycle]");
    await run("Partial entries not red", testPartialEntriesNotRed);
    await run("Spoken entries not red", testSpokenEntriesNotRed);
    await run("Dropped entry in flow mode", testDroppedEntryInFlowMode);
    await run("Dropped removed when active", testDroppedRemovedWhenActive);

    console.log("\n  [TTS Highlight Flow]");
    await run("TTS highlight chain", testTtsHighlightChain);

    console.log("\n  [Voice Status Transitions]");
    await run("Voice status thinking", testVoiceStatusThinking);
    await run("Voice status responding", testVoiceStatusResponding);
    await run("Voice status idle reset", testVoiceStatusIdleReset);

    console.log("\n  [Flow Mode Toggle]");
    await run("Flow mode toggle", testFlowModeToggle);

    console.log("\n  [Clean / Verbose Mode]");
    await run("Clean verbose visibility", testCleanVerboseVisibility);

    console.log("\n  [Interaction Chains]");
    await run("Text input creates user bubble", testTextInputCreatesUserBubble);
    await run("Mode cycling", testModeCycling);
    await run("Terminal toggle", testTerminalToggle);
    await run("Help menu tour", testHelpMenuTour);

    console.log("\n  [Entry Deduplication]");
    await run("Entry deduplication", testEntryDeduplication);

    console.log("\n  [Reconnect Behavior]");
    await run("Reconnect entry restore", testReconnectEntryRestore);

    console.log("\n  [Queued Entry Lifecycle]");
    await run("Queued entry visual", testQueuedEntryVisual);
    await run("Queued to delivered transition", testQueuedToDeliveredTransition);

    console.log("\n  [Opacity Boundary]");
    await run("Opacity boundary", testOpacityBoundary);

    console.log("\n  [Additional State Checks]");
    await run("Tool status display", testToolStatusDisplay);
    await run("TTS stop clears highlights", testTtsStopClearsHighlights);
    await run("Entry nonspeakable class", testEntryNonspeakableClass);
    await run("Flow button visible both modes", testFlowModeButtonVisibleBothModes);

  } catch (err) {
    await screenshot("fatal-error").catch(() => {});
    console.error(`\n  Fatal: ${(err as Error).message}\n`);
  } finally {
    if (browser) await browser.close();
  }

  const passed = results.filter(r => r.ok).length;
  const total = results.length;
  console.log(`\n  ${passed}/${total} passed`);
  console.log(`  Screenshots saved to: ${SCREENSHOTS_DIR}\n`);
  process.exit(passed === total ? 0 : 1);
}

main();
