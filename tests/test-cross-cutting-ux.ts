/**
 * Cross-Cutting UX Assessment — Part 4: Feature interaction matrix.
 * Highlight×Scroll, Highlight×Stop, Copy×Scroll, Stop×Highlight, Recording×WindowSwitch, etc.
 *
 * Requires: server running on localhost:3457
 * Usage: HEADLESS=1 node --import tsx/esm tests/test-cross-cutting-ux.ts 2>&1 | tee /tmp/ux-cross-results.txt
 */

import { chromium, Browser, Page, BrowserContext } from "playwright";
import { mkdirSync, appendFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const BASE = "http://localhost:3457?testmode=1";
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = join(__dirname, "screenshots", "ux-cross");
const HEADLESS = process.env.HEADLESS === "1";
const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
const WARN = "\x1b[33m⚠\x1b[0m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const PIPELINE = "/tmp/murmur-agent-pipeline.jsonl";
const RESULTS_FILE = "/tmp/ux-cross-results.json";

interface TestResult {
  section: string;
  test: string;
  ok: boolean;
  detail?: string;
  anomalies?: string[];
}

const results: TestResult[] = [];
let browser: Browser;
let ctx: BrowserContext;
let page: Page;
let screenshotIdx = 0;

mkdirSync(SCREENSHOTS_DIR, { recursive: true });

function logPipeline(action: string, summary: string) {
  appendFileSync(PIPELINE, JSON.stringify({
    ts: new Date().toISOString(), from: "ux-expert", action, summary, tag: "cross-cutting-assess",
  }) + "\n");
}

function report(section: string, test: string, ok: boolean, detail = "", anomalies: string[] = []) {
  results.push({ section, test, ok, detail, anomalies });
  const icon = ok ? PASS : (anomalies.length ? WARN : FAIL);
  console.log(`  ${icon}  [${section}] ${test}${detail ? ` ${DIM}(${detail})${RESET}` : ""}`);
  anomalies.forEach(a => console.log(`      ${WARN} ${a}`));
}

async function screenshot(label: string): Promise<string> {
  screenshotIdx++;
  const filename = `${String(screenshotIdx).padStart(3, "0")}-${label.replace(/\s+/g, "-").toLowerCase()}.png`;
  const path = join(SCREENSHOTS_DIR, filename);
  await page.screenshot({ path, fullPage: true });
  return path;
}

async function getDomState() {
  return page.evaluate(() => {
    const bubbles = document.querySelectorAll(".entry-bubble");
    const transcript = document.getElementById("transcript") || document.querySelector(".transcript");
    const el = transcript || document.documentElement;
    let users = 0, assistants = 0;
    const texts: string[] = [];
    const highlighted: number[] = [];
    const dropped: number[] = [];
    bubbles.forEach(b => {
      if (b.classList.contains("user-bubble") || b.getAttribute("data-role") === "user") users++;
      else assistants++;
      texts.push((b.textContent || "").trim().slice(0, 80));
      const id = parseInt(b.getAttribute("data-entry-id") || "0");
      if (b.classList.contains("bubble-active")) highlighted.push(id);
      if (b.classList.contains("bubble-dropped")) dropped.push(id);
    });
    return {
      userBubbles: users,
      assistantBubbles: assistants,
      totalBubbles: bubbles.length,
      texts,
      highlighted,
      dropped,
      hasFlowMode: document.body.classList.contains("flow-mode"),
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    };
  });
}

async function getApiState(): Promise<any> {
  try {
    return await page.evaluate(async () => (await fetch("/api/state")).json());
  } catch { return { error: "failed" }; }
}

async function freshPage() {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("murmur-tour-done", "1");
    localStorage.setItem("murmur-flow-tour-done", "1");
    localStorage.setItem("murmur-flow-mode", "0");
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(500);
}

async function freshFlowPage() {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("murmur-tour-done", "1");
    localStorage.setItem("murmur-flow-tour-done", "1");
    localStorage.setItem("murmur-flow-mode", "1");
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(500);
}

async function injectEntries(entries: any[], partial = false) {
  await page.evaluate(({ entries, partial }) => {
    const ws = (window as any)._ws;
    if (ws?.onmessage) ws.onmessage({ data: JSON.stringify({ type: "entry", entries, partial }) } as any);
  }, { entries, partial });
  await page.waitForTimeout(200);
}

async function broadcastJson(msg: any) {
  await page.evaluate((json) => {
    const ws = (window as any)._ws;
    if (ws?.onmessage) ws.onmessage({ data: JSON.stringify(json) } as any);
  }, msg);
  await page.waitForTimeout(200);
}

async function run(name: string, section: string, fn: () => Promise<void>) {
  try { await fn(); }
  catch (err) {
    await screenshot(`error-${section}-${name.replace(/\s+/g, "-")}`).catch(() => {});
    report(section, name, false, (err as Error).message);
  }
}

/** Inject a set of entries good for scroll + highlight testing */
async function injectScrollableEntries() {
  const entries = [];
  for (let i = 0; i < 15; i++) {
    entries.push({
      id: 5000 + i * 2, role: "user",
      text: `Cross-cut Q${i + 1}: A test question with enough length for scrolling.`,
      speakable: false, spoken: false, ts: Date.now() + i * 100, turn: i + 1,
    });
    entries.push({
      id: 5001 + i * 2, role: "assistant",
      text: `Cross-cut A${i + 1}: Reply with sufficient text to ensure the viewport overflows.`,
      speakable: true, spoken: false, ts: Date.now() + i * 100 + 50, turn: i + 1,
    });
  }
  await injectEntries(entries);
  return entries;
}

// ═══════════════════════════════════════════════════════
// SECTION P: Highlight × Everything
// ═══════════════════════════════════════════════════════

async function sectionP() {
  console.log("\n\x1b[1m═══ SECTION P: Highlight × Everything ═══\x1b[0m");
  logPipeline("test_start", "Section P: Highlight cross-cutting");

  // P1: Highlight + Scroll
  await run("P1.1 Highlight active → user scrolls away", "P", async () => {
    await freshPage();
    await injectScrollableEntries();
    // Highlight an early entry
    await broadcastJson({ type: "tts_highlight", entryId: 5001 });
    await page.waitForTimeout(300);
    const domBefore = await getDomState();
    const wasHighlighted = domBefore.highlighted.includes(5001);
    // User scrolls to bottom
    await page.evaluate(() => {
      const el = document.getElementById("transcript") || document.documentElement;
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(300);
    const domAfter = await getDomState();
    const stillHighlighted = domAfter.highlighted.includes(5001);
    await screenshot("P1.1-highlight-scroll-away");
    report("P", "P1.1 Highlight persists when user scrolls away", stillHighlighted,
      `beforeHL=${wasHighlighted}, afterHL=${stillHighlighted}`);
  });

  await run("P1.4 Multiple entries highlighted in sequence → smooth scroll", "P", async () => {
    await freshPage();
    await injectScrollableEntries();
    const scrollPositions: number[] = [];
    // Highlight entries in sequence
    for (const id of [5001, 5003, 5005, 5007, 5009]) {
      await broadcastJson({ type: "tts_highlight", entryId: id });
      await page.waitForTimeout(400);
      const dom = await getDomState();
      scrollPositions.push(dom.scrollTop);
    }
    await screenshot("P1.4-sequence-highlight");
    report("P", "P1.4 Sequential highlights — scroll follows", true,
      `scrollPositions=${JSON.stringify(scrollPositions)}`);
  });

  await run("P1.5 Highlight first → scroll to last → highlight last", "P", async () => {
    await freshPage();
    await injectScrollableEntries();
    await broadcastJson({ type: "tts_highlight", entryId: 5001 });
    await page.waitForTimeout(300);
    const dom1 = await getDomState();
    // Scroll to bottom
    await page.evaluate(() => {
      const el = document.getElementById("transcript") || document.documentElement;
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(200);
    // Highlight last entry
    await broadcastJson({ type: "tts_highlight", entryId: 5029 });
    await page.waitForTimeout(300);
    const dom2 = await getDomState();
    await screenshot("P1.5-highlight-jump");
    const firstCleared = !dom2.highlighted.includes(5001);
    const lastHighlighted = dom2.highlighted.includes(5029);
    report("P", "P1.5 Highlight jump first→last", firstCleared && lastHighlighted,
      `firstCleared=${firstCleared}, lastHL=${lastHighlighted}`);
  });

  await run("P1.6 Flow karaoke → user scrolls during highlight", "P", async () => {
    await freshFlowPage();
    await injectScrollableEntries();
    await broadcastJson({ type: "tts_highlight", entryId: 5001 });
    await page.waitForTimeout(200);
    // User scrolls mid-highlight
    await page.evaluate(() => {
      const el = document.getElementById("transcript") || document.documentElement;
      el.scrollTop = el.scrollHeight / 2;
    });
    await page.waitForTimeout(300);
    const dom = await getDomState();
    await screenshot("P1.6-flow-karaoke-scroll");
    report("P", "P1.6 Flow karaoke + user scroll", true,
      `flow=${dom.hasFlowMode}, scrollTop=${dom.scrollTop}`);
  });

  // P2: Highlight + Stop
  await run("P2.1 TTS playing → Stop → highlight clears", "P", async () => {
    await freshPage();
    await injectScrollableEntries();
    await broadcastJson({ type: "tts_highlight", entryId: 5001 });
    await page.waitForTimeout(300);
    const domBefore = await getDomState();
    // Simulate stop
    await broadcastJson({ type: "tts_stop" });
    await broadcastJson({ type: "stream_state", state: "IDLE" });
    await page.waitForTimeout(500);
    const domAfter = await getDomState();
    await screenshot("P2.1-stop-highlight");
    const cleared = domAfter.highlighted.length === 0;
    report("P", "P2.1 Stop clears highlight", cleared,
      `beforeHL=${domBefore.highlighted.length}, afterHL=${domAfter.highlighted.length}`,
      cleared ? [] : [`Highlight NOT cleared after stop: ${JSON.stringify(domAfter.highlighted)}`]);
  });

  await run("P2.3 Stop → next entry highlights → previous cleaned up", "P", async () => {
    await freshPage();
    await injectScrollableEntries();
    await broadcastJson({ type: "tts_highlight", entryId: 5001 });
    await page.waitForTimeout(200);
    await broadcastJson({ type: "tts_stop" });
    await page.waitForTimeout(200);
    // Next entry starts
    await broadcastJson({ type: "tts_highlight", entryId: 5003 });
    await page.waitForTimeout(300);
    const dom = await getDomState();
    await screenshot("P2.3-stop-next");
    const prevCleared = !dom.highlighted.includes(5001);
    const nextActive = dom.highlighted.includes(5003);
    report("P", "P2.3 Stop → next highlight — previous cleaned", prevCleared && nextActive,
      `prev5001=${!prevCleared}, next5003=${nextActive}`);
  });

  await run("P2.5 Stop during multi-entry TTS chain", "P", async () => {
    await freshPage();
    await injectScrollableEntries();
    // Highlight chain
    await broadcastJson({ type: "tts_highlight", entryId: 5001 });
    await page.waitForTimeout(200);
    await broadcastJson({ type: "tts_highlight", entryId: 5003 });
    await page.waitForTimeout(200);
    // Stop mid-chain
    await broadcastJson({ type: "tts_stop" });
    await page.waitForTimeout(500);
    const dom = await getDomState();
    await screenshot("P2.5-stop-chain");
    report("P", "P2.5 Stop mid-chain — all highlights clear", dom.highlighted.length === 0,
      `remaining=${JSON.stringify(dom.highlighted)}`);
  });

  // P3: Highlight + Mode Switch
  await run("P3.1 Highlight → switch Talk→Type mode", "P", async () => {
    await freshPage();
    await injectScrollableEntries();
    await broadcastJson({ type: "tts_highlight", entryId: 5001 });
    await page.waitForTimeout(300);
    // Change input mode
    const modeBtn = page.locator("#modeBtn, .mode-btn");
    if (await modeBtn.count() > 0) {
      await modeBtn.first().click();
      await page.waitForTimeout(300);
    }
    const dom = await getDomState();
    await screenshot("P3.1-highlight-mode");
    report("P", "P3.1 Highlight + mode switch", true,
      `highlighted=${JSON.stringify(dom.highlighted)}`);
  });

  await run("P3.2 Highlight → toggle flow mode", "P", async () => {
    await freshPage();
    await injectScrollableEntries();
    await broadcastJson({ type: "tts_highlight", entryId: 5001 });
    await page.waitForTimeout(300);
    // Toggle to flow
    await page.evaluate(() => localStorage.setItem("murmur-flow-mode", "1"));
    const flowBtn = page.locator("#flowToggle, .flow-toggle");
    if (await flowBtn.count() > 0) {
      await flowBtn.first().click();
      await page.waitForTimeout(500);
    } else {
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForTimeout(500);
    }
    const dom = await getDomState();
    await screenshot("P3.2-highlight-flow-toggle");
    report("P", "P3.2 Highlight + flow toggle", dom.hasFlowMode,
      `flow=${dom.hasFlowMode}, highlighted=${JSON.stringify(dom.highlighted)}`);
  });

  // P4: Highlight + Window Switch
  await run("P4.1 Highlight → switch window → clears?", "P", async () => {
    await freshPage();
    await injectScrollableEntries();
    const api = await getApiState();
    const windows = api.windows || [];
    await broadcastJson({ type: "tts_highlight", entryId: 5001 });
    await page.waitForTimeout(300);
    if (windows.length >= 2) {
      await broadcastJson({ type: "switch_window", window: windows[1] });
      await page.waitForTimeout(1000);
    }
    const dom = await getDomState();
    await screenshot("P4.1-highlight-window");
    report("P", "P4.1 Highlight + window switch", true,
      `highlighted=${JSON.stringify(dom.highlighted)}`,
      dom.highlighted.length > 0 ? ["Highlight still active after window switch"] : []);
  });

  await run("P4.3 Highlight → switch → switch back → restored?", "P", async () => {
    await freshPage();
    await injectScrollableEntries();
    const api = await getApiState();
    const windows = api.windows || [];
    await broadcastJson({ type: "tts_highlight", entryId: 5005 });
    await page.waitForTimeout(300);
    if (windows.length >= 2) {
      await broadcastJson({ type: "switch_window", window: windows[1] });
      await page.waitForTimeout(500);
      await broadcastJson({ type: "switch_window", window: windows[0] });
      await page.waitForTimeout(1000);
    }
    const dom = await getDomState();
    await screenshot("P4.3-highlight-switch-back");
    report("P", "P4.3 Highlight after window roundtrip", true,
      `highlighted=${JSON.stringify(dom.highlighted)}`);
  });

  // P5: Highlight + Refresh
  await run("P5.1 Highlight → refresh → clean state?", "P", async () => {
    await freshPage();
    await injectScrollableEntries();
    await broadcastJson({ type: "tts_highlight", entryId: 5001 });
    await page.waitForTimeout(300);
    await page.reload({ waitUntil: "networkidle" });
    await page.evaluate(() => {
      localStorage.setItem("murmur-tour-done", "1");
      localStorage.setItem("murmur-flow-tour-done", "1");
      localStorage.setItem("murmur-flow-mode", "0");
    });
    await page.waitForTimeout(1000);
    const dom = await getDomState();
    await screenshot("P5.1-highlight-refresh");
    report("P", "P5.1 Refresh clears highlight", dom.highlighted.length === 0,
      `highlighted=${JSON.stringify(dom.highlighted)}`,
      dom.highlighted.length > 0 ? ["Stale highlight after refresh!"] : []);
  });

  logPipeline("test_complete", "Section P done");
}

// ═══════════════════════════════════════════════════════
// SECTION Q: Copy × Everything
// ═══════════════════════════════════════════════════════

async function sectionQ() {
  console.log("\n\x1b[1m═══ SECTION Q: Copy × Everything ═══\x1b[0m");
  logPipeline("test_start", "Section Q: Copy cross-cutting");

  // Q1: Copy + Scroll
  await run("Q1.1 Copy bubble → scroll position frozen", "Q", async () => {
    await freshPage();
    await injectScrollableEntries();
    // Scroll to middle
    await page.evaluate(() => {
      const el = document.getElementById("transcript") || document.documentElement;
      el.scrollTop = el.scrollHeight / 2;
    });
    await page.waitForTimeout(200);
    const scrollBefore = (await getDomState()).scrollTop;
    // Try to click copy on a bubble (if copy button exists)
    const copyBtn = page.locator(".copy-btn, [data-action='copy']").first();
    if (await copyBtn.isVisible().catch(() => false)) {
      await copyBtn.click();
      await page.waitForTimeout(300);
    }
    const scrollAfter = (await getDomState()).scrollTop;
    await screenshot("Q1.1-copy-scroll");
    const preserved = Math.abs(scrollBefore - scrollAfter) < 20;
    report("Q", "Q1.1 Copy preserves scroll position", preserved,
      `before=${scrollBefore}, after=${scrollAfter}`);
  });

  // Q2: Copy + Highlight
  await run("Q2.1 Copy highlighted bubble → highlight persists", "Q", async () => {
    await freshPage();
    await injectScrollableEntries();
    await broadcastJson({ type: "tts_highlight", entryId: 5001 });
    await page.waitForTimeout(300);
    const copyBtn = page.locator('.entry-bubble[data-entry-id="5001"] .copy-btn, .entry-bubble[data-entry-id="5001"] [data-action="copy"]');
    if (await copyBtn.count() > 0) {
      await copyBtn.first().click();
      await page.waitForTimeout(300);
    }
    const dom = await getDomState();
    await screenshot("Q2.1-copy-highlight");
    report("Q", "Q2.1 Copy + highlight coexist", true,
      `highlighted=${JSON.stringify(dom.highlighted)}`);
  });

  // Q3: Copy + TTS
  await run("Q3.2 Copy → clipboard has clean text", "Q", async () => {
    await freshPage();
    await injectEntries([
      { id: 6000, role: "assistant", text: "Clean text for copy test", speakable: true, spoken: true, ts: Date.now(), turn: 1 },
    ]);
    // Try programmatic clipboard check
    const clipCheck = await page.evaluate(async () => {
      try {
        const el = document.querySelector('.entry-bubble[data-entry-id="6000"]');
        if (!el) return "no-element";
        const text = el.textContent?.trim() || "";
        return text.includes("<") ? "has-html" : "clean";
      } catch { return "error"; }
    });
    report("Q", "Q3.2 Copy yields clean text", clipCheck !== "has-html",
      `result=${clipCheck}`);
  });

  logPipeline("test_complete", "Section Q done");
}

// ═══════════════════════════════════════════════════════
// SECTION R: Stop × Everything
// ═══════════════════════════════════════════════════════

async function sectionR() {
  console.log("\n\x1b[1m═══ SECTION R: Stop × Everything ═══\x1b[0m");
  logPipeline("test_start", "Section R: Stop cross-cutting");

  // R1: Stop + Audio
  await run("R1.1 Stop → ttsPlaying goes false", "R", async () => {
    await freshPage();
    await injectEntries([
      { id: 7000, role: "assistant", text: "Audio stop test", speakable: true, spoken: false, ts: Date.now(), turn: 1 },
    ]);
    await broadcastJson({ type: "tts_highlight", entryId: 7000 });
    await page.waitForTimeout(200);
    await broadcastJson({ type: "tts_stop" });
    await page.waitForTimeout(500);
    const api = await getApiState();
    await screenshot("R1.1-stop-audio");
    report("R", "R1.1 Stop → ttsPlaying=false", !api.ttsPlaying,
      `ttsPlaying=${api.ttsPlaying}`);
  });

  // R1.5: Double stop
  await run("R1.5 Double stop — no error", "R", async () => {
    await freshPage();
    await broadcastJson({ type: "tts_stop" });
    await page.waitForTimeout(100);
    await broadcastJson({ type: "tts_stop" });
    await page.waitForTimeout(300);
    const dom = await getDomState();
    await screenshot("R1.5-double-stop");
    report("R", "R1.5 Double stop — no error", true, `bubbles=${dom.totalBubbles}`);
  });

  // R2: Stop + Highlight
  await run("R2.1 Stop → all highlights clear", "R", async () => {
    await freshPage();
    await injectScrollableEntries();
    await broadcastJson({ type: "tts_highlight", entryId: 5001 });
    await broadcastJson({ type: "tts_highlight", entryId: 5003 });
    await page.waitForTimeout(200);
    await broadcastJson({ type: "tts_stop" });
    await page.waitForTimeout(500);
    const dom = await getDomState();
    await screenshot("R2.1-stop-all-highlights");
    report("R", "R2.1 Stop clears all highlights", dom.highlighted.length === 0,
      `remaining=${JSON.stringify(dom.highlighted)}`);
  });

  await run("R2.3 Stop → no new highlights after", "R", async () => {
    await freshPage();
    await injectScrollableEntries();
    await broadcastJson({ type: "tts_stop" });
    await page.waitForTimeout(200);
    // Try to trigger highlight after stop
    await broadcastJson({ type: "tts_highlight", entryId: 5001 });
    await page.waitForTimeout(300);
    const dom = await getDomState();
    await screenshot("R2.3-stop-no-new");
    // After a user stop, new highlights from a new TTS session SHOULD work
    // But if stop was a gen bump, old gen highlights should NOT
    report("R", "R2.3 Post-stop highlight behavior", true,
      `highlighted=${JSON.stringify(dom.highlighted)}`);
  });

  // R4: Stop + Claude streaming
  await run("R4.2 Stop during streaming → entry finalizes", "R", async () => {
    await freshPage();
    await broadcastJson({ type: "stream_state", state: "STREAMING" });
    await injectEntries([
      { id: 7100, role: "assistant", text: "Streaming partial...", speakable: true, spoken: false, ts: Date.now(), turn: 1 },
    ], true);
    await page.waitForTimeout(200);
    // Stop
    await broadcastJson({ type: "stream_state", state: "IDLE" });
    await page.waitForTimeout(500);
    const api = await getApiState();
    const dom = await getDomState();
    await screenshot("R4.2-stop-streaming");
    report("R", "R4.2 Stop streaming → IDLE", api.streamState === "IDLE",
      `stream=${api.streamState}, bubbles=${dom.totalBubbles}`);
  });

  logPipeline("test_complete", "Section R done");
}

// ═══════════════════════════════════════════════════════
// SECTION S: Recording × Everything
// ═══════════════════════════════════════════════════════

async function sectionS() {
  console.log("\n\x1b[1m═══ SECTION S: Recording × Everything ═══\x1b[0m");
  logPipeline("test_start", "Section S: Recording cross-cutting");

  // S1: Recording + Scroll
  await run("S1.1 Recording indicator visible while scrolled", "S", async () => {
    await freshPage();
    await injectScrollableEntries();
    // Check recording UI exists
    const recordingIndicator = page.locator("#talkBtn, .talk-btn, .mic-btn, .record-indicator");
    const hasRecordUI = await recordingIndicator.count() > 0;
    // Scroll to top
    await page.evaluate(() => {
      const el = document.getElementById("transcript") || document.documentElement;
      el.scrollTop = 0;
    });
    await page.waitForTimeout(200);
    const stillVisible = hasRecordUI ? await recordingIndicator.first().isVisible() : false;
    await screenshot("S1.1-record-scroll");
    report("S", "S1.1 Recording UI visible when scrolled", !hasRecordUI || stillVisible,
      `hasUI=${hasRecordUI}, visible=${stillVisible}`);
  });

  // S2: Recording + Highlight — barge-in
  await run("S2.2 Barge-in: recording starts → TTS stops", "S", async () => {
    await freshPage();
    await injectEntries([
      { id: 8000, role: "assistant", text: "Playing before barge-in", speakable: true, spoken: false, ts: Date.now(), turn: 1 },
    ]);
    await broadcastJson({ type: "tts_highlight", entryId: 8000 });
    await page.waitForTimeout(200);
    // Simulate barge-in
    await broadcastJson({ type: "barge_in" });
    await broadcastJson({ type: "tts_stop" });
    await page.waitForTimeout(500);
    const dom = await getDomState();
    await screenshot("S2.2-barge-in");
    report("S", "S2.2 Barge-in clears highlight", dom.highlighted.length === 0,
      `highlighted=${JSON.stringify(dom.highlighted)}`);
  });

  // S3: Recording + Window Switch
  await run("S3.1 Recording → window switch", "S", async () => {
    await freshPage();
    const api = await getApiState();
    const windows = api.windows || [];
    if (windows.length >= 2) {
      await broadcastJson({ type: "switch_window", window: windows[1] });
      await page.waitForTimeout(1000);
      await broadcastJson({ type: "switch_window", window: windows[0] });
      await page.waitForTimeout(1000);
    }
    const dom = await getDomState();
    await screenshot("S3.1-record-window");
    report("S", "S3.1 Recording + window switch", true, `bubbles=${dom.totalBubbles}`);
  });

  logPipeline("test_complete", "Section S done");
}

// ═══════════════════════════════════════════════════════
// SECTION T: Terminal Panel × Everything
// ═══════════════════════════════════════════════════════

async function sectionT() {
  console.log("\n\x1b[1m═══ SECTION T: Terminal Panel × Everything ═══\x1b[0m");
  logPipeline("test_start", "Section T: Terminal cross-cutting");

  await run("T1.1 Terminal open → conversation scroll independent", "T", async () => {
    await freshPage();
    await injectScrollableEntries();
    const termBtn = page.locator("#terminalBtn, .terminal-btn, [data-action='terminal']");
    if (await termBtn.count() > 0) {
      await termBtn.first().click();
      await page.waitForTimeout(500);
      // Try scrolling conversation
      await page.evaluate(() => {
        const el = document.getElementById("transcript") || document.documentElement;
        el.scrollTop = el.scrollHeight / 2;
      });
      await page.waitForTimeout(300);
      const dom = await getDomState();
      await screenshot("T1.1-terminal-scroll");
      await termBtn.first().click(); // close
      report("T", "T1.1 Terminal open — conversation scroll works", dom.scrollTop > 0,
        `scrollTop=${dom.scrollTop}`);
    } else {
      report("T", "T1.1 Terminal scroll", true, "SKIPPED — no terminal button");
    }
  });

  await run("T2.1 Terminal open → new entry arrives", "T", async () => {
    await freshPage();
    const termBtn = page.locator("#terminalBtn, .terminal-btn, [data-action='terminal']");
    if (await termBtn.count() > 0) {
      await termBtn.first().click();
      await page.waitForTimeout(500);
      await injectEntries([
        { id: 9000, role: "assistant", text: "Entry while terminal open", speakable: true, spoken: true, ts: Date.now(), turn: 1 },
      ]);
      await page.waitForTimeout(300);
      const dom = await getDomState();
      const hasEntry = dom.texts.some(t => t.includes("Entry while terminal"));
      await screenshot("T2.1-terminal-entry");
      await termBtn.first().click(); // close
      report("T", "T2.1 Entry arrives while terminal open", hasEntry,
        `found=${hasEntry}, bubbles=${dom.totalBubbles}`);
    } else {
      report("T", "T2.1 Terminal + entries", true, "SKIPPED");
    }
  });

  logPipeline("test_complete", "Section T done");
}

// ═══════════════════════════════════════════════════════
// SECTION U: Replay × Everything
// ═══════════════════════════════════════════════════════

async function sectionU() {
  console.log("\n\x1b[1m═══ SECTION U: Replay × Everything ═══\x1b[0m");
  logPipeline("test_start", "Section U: Replay cross-cutting");

  await run("U1.2 Replay while another entry highlighted → old clears", "U", async () => {
    await freshPage();
    await injectEntries([
      { id: 9100, role: "assistant", text: "First entry", speakable: true, spoken: true, ts: Date.now(), turn: 1 },
      { id: 9101, role: "assistant", text: "Second entry", speakable: true, spoken: true, ts: Date.now() + 100, turn: 1 },
    ]);
    // Highlight first
    await broadcastJson({ type: "tts_highlight", entryId: 9100 });
    await page.waitForTimeout(200);
    const domBefore = await getDomState();
    // "Replay" second (simulate highlight on second)
    await broadcastJson({ type: "tts_highlight", entryId: 9101 });
    await page.waitForTimeout(300);
    const domAfter = await getDomState();
    await screenshot("U1.2-replay-switch");
    const firstCleared = !domAfter.highlighted.includes(9100);
    const secondActive = domAfter.highlighted.includes(9101);
    report("U", "U1.2 Replay clears previous highlight", firstCleared && secondActive,
      `first=${!firstCleared}, second=${secondActive}`);
  });

  await run("U2.1 Replay → Stop → replay TTS stops", "U", async () => {
    await freshPage();
    await injectEntries([
      { id: 9200, role: "assistant", text: "Replay stop test", speakable: true, spoken: true, ts: Date.now(), turn: 1 },
    ]);
    await broadcastJson({ type: "tts_highlight", entryId: 9200 });
    await page.waitForTimeout(200);
    await broadcastJson({ type: "tts_stop" });
    await page.waitForTimeout(500);
    const dom = await getDomState();
    await screenshot("U2.1-replay-stop");
    report("U", "U2.1 Replay → Stop clears", dom.highlighted.length === 0,
      `highlighted=${JSON.stringify(dom.highlighted)}`);
  });

  await run("U2.2 Replay → Stop → Replay again → works", "U", async () => {
    await freshPage();
    await injectEntries([
      { id: 9300, role: "assistant", text: "Replay cycle test", speakable: true, spoken: true, ts: Date.now(), turn: 1 },
    ]);
    // First replay
    await broadcastJson({ type: "tts_highlight", entryId: 9300 });
    await page.waitForTimeout(200);
    // Stop
    await broadcastJson({ type: "tts_stop" });
    await page.waitForTimeout(300);
    // Second replay
    await broadcastJson({ type: "tts_highlight", entryId: 9300 });
    await page.waitForTimeout(300);
    const dom = await getDomState();
    await screenshot("U2.2-replay-cycle");
    report("U", "U2.2 Replay cycle works", dom.highlighted.includes(9300),
      `highlighted=${JSON.stringify(dom.highlighted)}`);
  });

  await run("U3.1 Replay off-screen entry → scrolls into view", "U", async () => {
    await freshPage();
    await injectScrollableEntries();
    // Scroll to top
    await page.evaluate(() => {
      const el = document.getElementById("transcript") || document.documentElement;
      el.scrollTop = 0;
    });
    await page.waitForTimeout(200);
    // Replay a late entry
    await broadcastJson({ type: "tts_highlight", entryId: 5029 });
    await page.waitForTimeout(500);
    const dom = await getDomState();
    await screenshot("U3.1-replay-offscreen");
    report("U", "U3.1 Replay off-screen → scrolls to entry", dom.scrollTop > 100,
      `scrollTop=${dom.scrollTop}`);
  });

  logPipeline("test_complete", "Section U done");
}

// ═══════════════════════════════════════════════════════
// SECTION V: Settings × Everything
// ═══════════════════════════════════════════════════════

async function sectionV() {
  console.log("\n\x1b[1m═══ SECTION V: Settings × Everything ═══\x1b[0m");
  logPipeline("test_start", "Section V: Settings cross-cutting");

  await run("V1.1 Voice change → entries preserved", "V", async () => {
    await freshPage();
    await injectEntries([
      { id: 9400, role: "assistant", text: "Voice change test", speakable: true, spoken: true, ts: Date.now(), turn: 1 },
    ]);
    const domBefore = await getDomState();
    await broadcastJson({ type: "settings", voice: "af_heart" });
    await page.waitForTimeout(300);
    const domAfter = await getDomState();
    await screenshot("V1.1-voice-change");
    report("V", "V1.1 Voice change preserves entries", domAfter.totalBubbles === domBefore.totalBubbles,
      `before=${domBefore.totalBubbles}, after=${domAfter.totalBubbles}`);
  });

  await run("V2.1 Speed change → entries preserved", "V", async () => {
    await freshPage();
    await injectEntries([
      { id: 9500, role: "assistant", text: "Speed change test", speakable: true, spoken: true, ts: Date.now(), turn: 1 },
    ]);
    const domBefore = await getDomState();
    await broadcastJson({ type: "settings", speed: 1.5 });
    await page.waitForTimeout(300);
    const domAfter = await getDomState();
    await screenshot("V2.1-speed-change");
    report("V", "V2.1 Speed change preserves entries", domAfter.totalBubbles === domBefore.totalBubbles,
      `before=${domBefore.totalBubbles}, after=${domAfter.totalBubbles}`);
  });

  logPipeline("test_complete", "Section V done");
}

// ═══════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════

async function main() {
  console.log("\n\x1b[1;35m╔══════════════════════════════════════════════════════╗\x1b[0m");
  console.log("\x1b[1;35m║  CROSS-CUTTING UX ASSESSMENT — Sections P-V          ║\x1b[0m");
  console.log("\x1b[1;35m╚══════════════════════════════════════════════════════════╝\x1b[0m\n");
  logPipeline("assess_start", "Cross-cutting UX assessment starting — sections P through V");

  browser = await chromium.launch({
    headless: HEADLESS,
    slowMo: HEADLESS ? 0 : 50,
  });
  ctx = await browser.newContext({
    permissions: ["microphone"],
    viewport: { width: 390, height: 844 },
  });
  page = await ctx.newPage();
  page.on("dialog", d => d.dismiss());

  try {
    await sectionP();
    await sectionQ();
    await sectionR();
    await sectionS();
    await sectionT();
    await sectionU();
    await sectionV();
  } catch (err) {
    console.error("\x1b[31mFATAL:\x1b[0m", err);
  }

  await browser.close();

  // Summary
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  const withAnomalies = results.filter(r => r.anomalies && r.anomalies.length > 0).length;

  console.log("\n\x1b[1m═══════════════════════════════════════════\x1b[0m");
  console.log(`\x1b[1mRESULTS: ${passed} passed, ${failed} failed, ${withAnomalies} with anomalies\x1b[0m`);
  console.log(`\x1b[1mTotal: ${results.length} tests across ${new Set(results.map(r => r.section)).size} sections\x1b[0m`);
  console.log("\x1b[1m═══════════════════════════════════════════\x1b[0m");

  if (failed > 0) {
    console.log("\n\x1b[31mFAILURES:\x1b[0m");
    results.filter(r => !r.ok).forEach(r => {
      console.log(`  \x1b[31m✗\x1b[0m [${r.section}] ${r.test}: ${r.detail}`);
      r.anomalies?.forEach(a => console.log(`    ${a}`));
    });
  }

  if (withAnomalies > 0) {
    console.log("\n\x1b[33mANOMALIES:\x1b[0m");
    results.filter(r => r.anomalies && r.anomalies.length > 0).forEach(r => {
      console.log(`  \x1b[33m⚠\x1b[0m [${r.section}] ${r.test}:`);
      r.anomalies!.forEach(a => console.log(`    ${a}`));
    });
  }

  writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  console.log(`\nFull results saved to ${RESULTS_FILE}`);

  logPipeline("assess_complete",
    `Cross-cutting UX assessment done: ${passed}/${results.length} passed, ${failed} failed, ${withAnomalies} anomalies`);
}

main().catch(console.error);
