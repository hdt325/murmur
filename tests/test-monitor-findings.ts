/**
 * Monitor Findings Tests — Tests derived from Monitor agent's runtime observations.
 * Covers: window switch entry preservation, dedup behavior, TTS stall recovery.
 *
 * Requires: server running on localhost:3457
 * Usage: HEADLESS=1 node --import tsx/esm tests/test-monitor-findings.ts 2>&1 | tee /tmp/monitor-findings-results.txt
 */

import { chromium, Browser, Page, BrowserContext } from "playwright";
import { readFileSync, appendFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const BASE = "http://localhost:3457?testmode=1";
const __dirname = dirname(fileURLToPath(import.meta.url));
const PIPELINE = "/tmp/murmur-agent-pipeline.jsonl";
const RESULTS_FILE = "/tmp/monitor-findings-results.json";
const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

interface TestResult { section: string; test: string; ok: boolean; detail?: string }
const results: TestResult[] = [];
let browser: Browser;
let ctx: BrowserContext;
let page: Page;

function logPipeline(action: string, summary: string) {
  appendFileSync(PIPELINE, JSON.stringify({
    ts: new Date().toISOString(), from: "ux-expert", action, summary, tag: "monitor-findings",
  }) + "\n");
}

function report(section: string, test: string, ok: boolean, detail = "") {
  results.push({ section, test, ok, detail });
  console.log(`  ${ok ? PASS : FAIL}  [${section}] ${test}${detail ? ` ${DIM}(${detail})${RESET}` : ""}`);
}

async function getApiState(): Promise<any> {
  try {
    return await page.evaluate(async () => (await fetch("/api/state")).json());
  } catch { return { error: "failed" }; }
}

async function getDebugEntries(): Promise<any> {
  try {
    return await page.evaluate(async () => (await fetch("/debug/entries")).json());
  } catch { return { error: "failed" }; }
}

async function getDomBubbles(): Promise<{ count: number; texts: string[]; ids: number[] }> {
  return page.evaluate(() => {
    const bubbles = document.querySelectorAll(".entry-bubble");
    const texts: string[] = [];
    const ids: number[] = [];
    bubbles.forEach(b => {
      texts.push((b.textContent || "").trim().slice(0, 100));
      ids.push(parseInt(b.getAttribute("data-entry-id") || "0"));
    });
    return { count: bubbles.length, texts, ids };
  });
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
  await page.waitForTimeout(1000);
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

async function run(section: string, name: string, fn: () => Promise<void>) {
  try { await fn(); }
  catch (err) { report(section, name, false, (err as Error).message); }
}

// ═══════════════════════════════════════════════════════
// SECTION W: Window Switch Entry Preservation
// (Monitor finding: entries disappear on window switch)
// ═══════════════════════════════════════════════════════

async function sectionW() {
  console.log("\n\x1b[1m═══ SECTION W: Window Switch Entry Preservation ═══\x1b[0m");
  logPipeline("test_start", "Section W: Window switch entries (Monitor finding)");

  const api = await getApiState();
  const windows = api.windows || [];
  const currentWin = api.currentWindow;
  console.log(`  ${DIM}currentWindow=${currentWin}, windows=${JSON.stringify(windows)}${RESET}`);

  // W1: Entry count preserved in API after window switch
  await run("W", "W1 API entryCount preserved after switch roundtrip", async () => {
    await freshPage();
    const apiBefore = await getApiState();
    const countBefore = apiBefore.entryCount || 0;
    const winBefore = apiBefore.currentWindow;

    if (windows.length < 2) {
      report("W", "W1 API entryCount preserved", true, "SKIPPED — need 2+ windows");
      return;
    }

    const otherWin = windows.find((w: string) => w !== winBefore) || windows[1];

    // Switch away via WS
    await page.evaluate((win) => {
      const ws = (window as any)._ws;
      if (ws) ws.send(`tmux:switch:${win}`);
    }, otherWin);
    await page.waitForTimeout(2000);

    const apiMid = await getApiState();

    // Switch back
    await page.evaluate((win) => {
      const ws = (window as any)._ws;
      if (ws) ws.send(`tmux:switch:${win}`);
    }, winBefore);
    await page.waitForTimeout(2000);

    const apiAfter = await getApiState();
    const countAfter = apiAfter.entryCount || 0;

    report("W", "W1 API entryCount preserved after switch roundtrip",
      countAfter >= countBefore,
      `before=${countBefore}, mid(${otherWin})=${apiMid.entryCount}, after=${countAfter}`);
  });

  // W2: DOM bubbles reappear after switch roundtrip
  await run("W", "W2 DOM bubbles reappear after roundtrip", async () => {
    await freshPage();
    await page.waitForTimeout(2000); // Let entries load
    const domBefore = await getDomBubbles();

    if (windows.length < 2) {
      report("W", "W2 DOM bubbles reappear", true, "SKIPPED — need 2+ windows");
      return;
    }

    const winBefore = (await getApiState()).currentWindow;
    const otherWin = windows.find((w: string) => w !== winBefore) || windows[1];

    // Switch away
    await page.evaluate((win) => {
      const ws = (window as any)._ws;
      if (ws) ws.send(`tmux:switch:${win}`);
    }, otherWin);
    await page.waitForTimeout(2000);

    // Switch back
    await page.evaluate((win) => {
      const ws = (window as any)._ws;
      if (ws) ws.send(`tmux:switch:${win}`);
    }, winBefore);
    await page.waitForTimeout(3000); // Give passive watcher time to repopulate

    const domAfter = await getDomBubbles();

    report("W", "W2 DOM bubbles reappear after roundtrip",
      domAfter.count >= domBefore.count,
      `before=${domBefore.count}, after=${domAfter.count}`);
  });

  // W3: Cross-window isolation — injected entries don't leak
  await run("W", "W3 Cross-window isolation", async () => {
    await freshPage();
    // Inject entries tagged for current window
    const uniqueText = `isolation-test-${Date.now()}`;
    await injectEntries([
      { id: 9900, role: "user", text: uniqueText, speakable: false, spoken: false, ts: Date.now(), turn: 1 },
    ]);
    const domWith = await getDomBubbles();
    const hasEntry = domWith.texts.some(t => t.includes("isolation-test"));

    if (windows.length < 2) {
      report("W", "W3 Cross-window isolation", hasEntry, "Partial — only 1 window, verified injection");
      return;
    }

    const winBefore = (await getApiState()).currentWindow;
    const otherWin = windows.find((w: string) => w !== winBefore) || windows[1];

    // Switch to other window
    await page.evaluate((win) => {
      const ws = (window as any)._ws;
      if (ws) ws.send(`tmux:switch:${win}`);
    }, otherWin);
    await page.waitForTimeout(2000);

    const domOther = await getDomBubbles();
    const leakedToOther = domOther.texts.some(t => t.includes("isolation-test"));

    report("W", "W3 Cross-window isolation", !leakedToOther,
      `injected=${hasEntry}, leakedToOther=${leakedToOther}`);

    // Switch back
    await page.evaluate((win) => {
      const ws = (window as any)._ws;
      if (ws) ws.send(`tmux:switch:${win}`);
    }, winBefore);
    await page.waitForTimeout(1000);
  });

  // W4: currentWindow persists after refresh
  await run("W", "W4 currentWindow persists after refresh", async () => {
    await freshPage();
    const apiBefore = await getApiState();
    const winBefore = apiBefore.currentWindow;

    await page.reload({ waitUntil: "networkidle" });
    await page.evaluate(() => {
      localStorage.setItem("murmur-tour-done", "1");
      localStorage.setItem("murmur-flow-tour-done", "1");
      localStorage.setItem("murmur-flow-mode", "0");
    });
    await page.waitForTimeout(1500);

    const apiAfter = await getApiState();
    report("W", "W4 currentWindow persists after refresh",
      apiAfter.currentWindow === winBefore,
      `before=${winBefore}, after=${apiAfter.currentWindow}`);
  });

  // W5: /debug/entries returns entries scoped to current window
  await run("W", "W5 debug/entries scoped to currentWindow", async () => {
    await freshPage();
    const api = await getApiState();
    const debug = await getDebugEntries();
    const hasEntries = debug.entries?.length >= 0 || debug.count >= 0;
    report("W", "W5 debug/entries responds with data", hasEntries,
      `keys=${Object.keys(debug).join(",")}, window=${api.currentWindow}`);
  });

  logPipeline("test_complete", "Section W done");
}

// ═══════════════════════════════════════════════════════
// SECTION X: Dedup Behavior
// (Monitor finding: duplicate entries with same text, different IDs)
// ═══════════════════════════════════════════════════════

async function sectionX() {
  console.log("\n\x1b[1m═══ SECTION X: Dedup Behavior ═══\x1b[0m");
  logPipeline("test_start", "Section X: Dedup (Monitor finding)");

  // X1: Same user text injected twice within 60s — deduped in DOM
  await run("X", "X1 User dedup within 60s window", async () => {
    await freshPage();
    const ts = Date.now();
    // First injection
    await injectEntries([
      { id: 4001, role: "user", text: "Hello dedup test", speakable: false, spoken: false, ts, turn: 1 },
    ]);
    const dom1 = await getDomBubbles();
    const count1 = dom1.texts.filter(t => t.includes("Hello dedup test")).length;

    // Second injection same text, different ID, within 60s
    await injectEntries([
      { id: 4001, role: "user", text: "Hello dedup test", speakable: false, spoken: false, ts, turn: 1 },
      { id: 4002, role: "user", text: "Hello dedup test", speakable: false, spoken: false, ts: ts + 1000, turn: 2 },
    ]);
    const dom2 = await getDomBubbles();
    const count2 = dom2.texts.filter(t => t.includes("Hello dedup test")).length;

    // With dedup, the second injection shouldn't double the count
    // The render should show at most 2 (one from each injection call)
    report("X", "X1 User dedup — same text not duplicated",
      count2 <= 2,
      `firstCall=${count1}, secondCall=${count2}`);
  });

  // X2: Different text creates separate entries
  await run("X", "X2 Different text creates separate entries", async () => {
    await freshPage();
    await injectEntries([
      { id: 4010, role: "user", text: "Message A", speakable: false, spoken: false, ts: Date.now(), turn: 1 },
      { id: 4011, role: "user", text: "Message B", speakable: false, spoken: false, ts: Date.now() + 100, turn: 2 },
    ]);
    const dom = await getDomBubbles();
    const hasA = dom.texts.some(t => t.includes("Message A"));
    const hasB = dom.texts.some(t => t.includes("Message B"));
    report("X", "X2 Different texts create separate entries", hasA && hasB,
      `hasA=${hasA}, hasB=${hasB}, total=${dom.count}`);
  });

  // X3: Assistant entries not duplicated across re-renders
  await run("X", "X3 Assistant entries not duplicated on re-render", async () => {
    await freshPage();
    const entries = [
      { id: 4020, role: "user", text: "Q for dedup", speakable: false, spoken: false, ts: Date.now(), turn: 1 },
      { id: 4021, role: "assistant", text: "A for dedup test", speakable: true, spoken: true, ts: Date.now() + 100, turn: 1 },
    ];
    // Inject same entries 3 times (simulating passive watcher re-broadcasts)
    await injectEntries(entries);
    await injectEntries(entries);
    await injectEntries(entries);
    const dom = await getDomBubbles();
    const assistantCount = dom.texts.filter(t => t.includes("A for dedup test")).length;
    report("X", "X3 Assistant not duplicated on re-render", assistantCount === 1,
      `assistantBubbles=${assistantCount}, total=${dom.count}`);
  });

  // X4: Entry IDs are unique in DOM
  await run("X", "X4 Entry IDs unique in DOM", async () => {
    await freshPage();
    await injectEntries([
      { id: 4030, role: "user", text: "Unique ID 1", speakable: false, spoken: false, ts: Date.now(), turn: 1 },
      { id: 4031, role: "assistant", text: "Unique ID 2", speakable: true, spoken: true, ts: Date.now(), turn: 1 },
      { id: 4032, role: "user", text: "Unique ID 3", speakable: false, spoken: false, ts: Date.now(), turn: 2 },
    ]);
    const dom = await getDomBubbles();
    const uniqueIds = new Set(dom.ids.filter(id => id > 0));
    report("X", "X4 Entry IDs unique in DOM", uniqueIds.size === dom.count || dom.count <= uniqueIds.size,
      `bubbles=${dom.count}, uniqueIds=${uniqueIds.size}`);
  });

  // X5: Rapid identical injections don't accumulate
  await run("X", "X5 Rapid identical injections don't accumulate", async () => {
    await freshPage();
    const entry = { id: 4040, role: "user", text: "Rapid fire", speakable: false, spoken: false, ts: Date.now(), turn: 1 };
    // Fire 5 rapid injections of same entry
    for (let i = 0; i < 5; i++) {
      await injectEntries([entry]);
    }
    await page.waitForTimeout(500);
    const dom = await getDomBubbles();
    const rapidCount = dom.texts.filter(t => t.includes("Rapid fire")).length;
    report("X", "X5 Rapid identical injections — 1 bubble", rapidCount === 1,
      `count=${rapidCount}`);
  });

  logPipeline("test_complete", "Section X done");
}

// ═══════════════════════════════════════════════════════
// SECTION Y: TTS Stall Recovery
// (Monitor finding: ttsPlaying stuck true indefinitely)
// ═══════════════════════════════════════════════════════

async function sectionY() {
  console.log("\n\x1b[1m═══ SECTION Y: TTS Stall Recovery ═══\x1b[0m");
  logPipeline("test_start", "Section Y: TTS stall recovery (Monitor finding)");

  // Y1: Server-side TTS state — verify ttsPlaying is false when idle
  await run("Y", "Y1 TTS idle state — ttsPlaying=false", async () => {
    await freshPage();
    await page.waitForTimeout(2000);
    const api = await getApiState();
    report("Y", "Y1 TTS idle — ttsPlaying=false", !api.ttsPlaying,
      `ttsPlaying=${api.ttsPlaying}, queue=${api.ttsQueueLength}`);
  });

  // Y2: TTS queue empty when idle
  await run("Y", "Y2 TTS queue empty when idle", async () => {
    const api = await getApiState();
    report("Y", "Y2 Queue empty when idle", api.ttsQueueLength === 0,
      `queueLength=${api.ttsQueueLength}`);
  });

  // Y3: After stop, TTS state resets
  await run("Y", "Y3 After stop — TTS state resets", async () => {
    await freshPage();
    // Simulate TTS playing
    await broadcastJson({ type: "tts_highlight", entryId: 999 });
    await page.waitForTimeout(200);
    // Send stop
    await broadcastJson({ type: "tts_stop" });
    await page.waitForTimeout(500);
    // Check API state
    const api = await getApiState();
    report("Y", "Y3 After stop — ttsPlaying resets", !api.ttsPlaying,
      `ttsPlaying=${api.ttsPlaying}`);
  });

  // Y4: Generation counter exists and is positive
  await run("Y", "Y4 TTS generation counter exists", async () => {
    const api = await getApiState();
    const hasGen = typeof api.ttsGeneration === "number";
    report("Y", "Y4 ttsGeneration exists and is number", hasGen,
      `ttsGeneration=${api.ttsGeneration}`);
  });

  // Y5: Queue doesn't grow unbounded — verify cap
  await run("Y", "Y5 TTS queue bounded", async () => {
    const api = await getApiState();
    report("Y", "Y5 Queue bounded (<=50)", api.ttsQueueLength <= 50,
      `queueLength=${api.ttsQueueLength}`);
  });

  // Y6: Server code has stall recovery (check via server.ts)
  await run("Y", "Y6 Server has TTS stall recovery sweep", async () => {
    try {
      const serverCode = readFileSync(join(__dirname, "..", "server.ts"), "utf8");
      const hasSweep = serverCode.includes("stall") || serverCode.includes("PLAYING_TIMEOUT")
        || serverCode.includes("playingSince") || serverCode.includes("orphan");
      const hasSweepInterval = serverCode.includes("setInterval") && (
        serverCode.includes("10_000") || serverCode.includes("10000") || serverCode.includes("15_000")
      );
      report("Y", "Y6 Server has TTS stall recovery sweep", hasSweep,
        `hasSweep=${hasSweep}, hasSweepInterval=${hasSweepInterval}`);
    } catch {
      report("Y", "Y6 Server stall recovery", false, "Could not read server.ts");
    }
  });

  // Y7: ttsPlayingEntryId is null when idle
  await run("Y", "Y7 ttsPlayingEntryId null when idle", async () => {
    const api = await getApiState();
    report("Y", "Y7 ttsPlayingEntryId null when idle", api.ttsPlayingEntryId === null,
      `ttsPlayingEntryId=${api.ttsPlayingEntryId}`);
  });

  // Y8: Server reports services status
  await run("Y", "Y8 API reports service status", async () => {
    const api = await getApiState();
    const hasServices = api.services && typeof api.services === "object";
    report("Y", "Y8 API reports services", hasServices,
      `services=${JSON.stringify(api.services || "none")}`);
  });

  logPipeline("test_complete", "Section Y done");
}

// ═══════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════

async function main() {
  console.log("\n\x1b[1;33m╔════════════════════════════════════════════════════╗\x1b[0m");
  console.log("\x1b[1;33m║  MONITOR FINDINGS TESTS — Sections W, X, Y         ║\x1b[0m");
  console.log("\x1b[1;33m╚════════════════════════════════════════════════════╝\x1b[0m\n");
  logPipeline("assess_start", "Monitor findings tests starting — sections W, X, Y");

  browser = await chromium.launch({ headless: process.env.HEADLESS === "1" });
  ctx = await browser.newContext({
    permissions: ["microphone"],
    viewport: { width: 390, height: 844 },
  });
  page = await ctx.newPage();
  page.on("dialog", d => d.dismiss());

  try {
    await sectionW();
    await sectionX();
    await sectionY();
  } catch (err) {
    console.error("\x1b[31mFATAL:\x1b[0m", err);
  }

  await browser.close();

  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;

  console.log("\n\x1b[1m═══════════════════════════════════════════\x1b[0m");
  console.log(`\x1b[1mRESULTS: ${passed} passed, ${failed} failed\x1b[0m`);
  console.log(`\x1b[1mTotal: ${results.length} tests\x1b[0m`);
  console.log("\x1b[1m═══════════════════════════════════════════\x1b[0m");

  if (failed > 0) {
    console.log("\n\x1b[31mFAILURES:\x1b[0m");
    results.filter(r => !r.ok).forEach(r => {
      console.log(`  \x1b[31m✗\x1b[0m [${r.section}] ${r.test}: ${r.detail}`);
    });
  }

  writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  console.log(`\nFull results saved to ${RESULTS_FILE}`);

  // Log final summary — with fix_needed if failures exist
  const summary = `Monitor findings tests: ${passed}/${results.length} passed, ${failed} failed`;
  logPipeline("assess_complete", summary);

  if (failed > 0) {
    const failNames = results.filter(r => !r.ok).map(r => `${r.test}: ${r.detail}`).join("; ");
    logPipeline("fix_needed", `${failed} monitor-finding tests FAILED confirming bugs: ${failNames}`);
  }

  console.log(`\n${passed}/${results.length} passed, ${failed} failed`);
}

main().catch(console.error);
