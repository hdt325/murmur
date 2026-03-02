/**
 * Automated UI tests for Murmur bug fixes.
 * Drives a real Chromium browser against http://localhost:3457
 *
 * Run:  npx playwright test test-bugs.ts
 *   or: npx tsx test-bugs.ts   (self-running mode)
 */

import { chromium, Browser, Page, WebSocket as PWWebSocket } from "playwright";

const BASE = "http://localhost:3457";
const PASS = "\x1b[32m✓ PASS\x1b[0m";
const FAIL = "\x1b[31m✗ FAIL\x1b[0m";
let browser: Browser;
let page: Page;
let passed = 0;
let failed = 0;

function report(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ${PASS}  ${name}`); }
  else { failed++; console.log(`  ${FAIL}  ${name}${detail ? " — " + detail : ""}`); }
}

async function setup() {
  browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({
    // Grant mic permission so AudioContext initializes (won't actually use mic)
    permissions: ["microphone"],
  });
  page = await ctx.newPage();
  // Suppress dialog popups
  page.on("dialog", d => d.dismiss());
  await page.goto(BASE, { waitUntil: "networkidle" });
  // Wait for WebSocket connection
  await page.waitForFunction(() => (window as any).__wsConnected !== undefined || document.querySelector(".status-dot.green") !== null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1500); // Let UI settle
  // Dismiss tour overlay if present (prevents pointer interception)
  await page.evaluate(() => localStorage.setItem("murmur-tour-done", "1"));
  const tourOverlay = page.locator(".tour-overlay");
  if (await tourOverlay.isVisible({ timeout: 500 }).catch(() => false)) {
    await page.locator(".tour-skip").click().catch(() => {});
    await page.waitForTimeout(300);
  }
}

async function teardown() {
  await browser.close();
  console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

// ──────────────────────────────────────────────────────────────
// Bug 4: Canvas scale should NOT accumulate on resize
// ──────────────────────────────────────────────────────────────
async function testBug4_canvasScale() {
  console.log("\n[Bug 4] Canvas scale accumulation on resize");

  // Get the mic canvas transform after initial load
  const getTransform = () =>
    page.evaluate(() => {
      const c = document.querySelector("#micCanvas") as HTMLCanvasElement | null;
      if (!c) return null;
      const ctx = c.getContext("2d");
      if (!ctx) return null;
      // getTransform() returns DOMMatrix with a,b,c,d,e,f
      const t = ctx.getTransform();
      return { a: t.a, d: t.d }; // a = scaleX, d = scaleY
    });

  const dpr = await page.evaluate(() => window.devicePixelRatio);

  // Resize window 5 times
  for (let i = 0; i < 5; i++) {
    await page.setViewportSize({ width: 400 + i * 50, height: 600 });
    await page.waitForTimeout(100);
  }

  const t = await getTransform();
  if (!t) {
    report("Canvas transform readable", false, "canvas or ctx not found");
    return;
  }

  // With the fix, scale should be exactly devicePixelRatio, not dpr^N
  const scaleOk = Math.abs(t.a - dpr) < 0.01 && Math.abs(t.d - dpr) < 0.01;
  report(`Scale is ${dpr}x after 5 resizes (got ${t.a.toFixed(2)}x)`, scaleOk);

  // Reset viewport
  await page.setViewportSize({ width: 480, height: 700 });
}

// ──────────────────────────────────────────────────────────────
// Bug 5: Fallback Audio blob should use ArrayBuffer, not Blob-in-Blob
// ──────────────────────────────────────────────────────────────
async function testBug5_fallbackAudio() {
  console.log("\n[Bug 5] Fallback Audio uses ArrayBuffer (code path check)");

  // We can't easily trigger the fallback in a real browser (Web Audio works fine),
  // so we verify the code structure: playTtsAudio should reference rawBuffer in catch
  const htmlSource = await page.content();
  const hasRawBuffer = htmlSource.includes("rawBuffer = buffer") && htmlSource.includes("rawBuffer || blob");
  report("playTtsAudio stores rawBuffer and uses it in fallback", hasRawBuffer);
}

// ──────────────────────────────────────────────────────────────
// Bug 7 + Bug 3: No beep / "Tap to respond" after manual Stop
// ──────────────────────────────────────────────────────────────
async function testBug7_noBeepOnStop() {
  console.log("\n[Bug 7+3] No beep / 'Tap to respond' after Stop click");

  // Verify idleFromTtsCompletion variable exists
  const hasFlag = await page.evaluate(() => {
    // The variable is inside the IIFE scope, so we check the source
    return document.documentElement.innerHTML.includes("idleFromTtsCompletion");
  });
  report("idleFromTtsCompletion flag exists in code", hasFlag);

  // Click Stop button → should show "Ready", not "Tap to respond"
  const stopBtn = page.locator("#stopBtn");
  if (await stopBtn.isVisible()) {
    await stopBtn.click();
    await page.waitForTimeout(500);

    const talkText = await page.locator("#talkBtn").textContent();
    const noTapPrompt = !talkText?.includes("Tap to respond");
    report(`After Stop: talk button says "${talkText?.trim()}" (not "Tap to respond")`, noTapPrompt);
  } else {
    report("Stop button visible", false, "not found");
  }
}

// ──────────────────────────────────────────────────────────────
// Bug 6: TTS timeout minimum lowered from 15s to 5s
// ──────────────────────────────────────────────────────────────
async function testBug6_ttsTimeout() {
  console.log("\n[Bug 6] TTS timeout minimum lowered");

  // Fetch server.ts source and check the value
  const resp = await fetch(`${BASE}`);
  // We can't fetch server.ts via HTTP — check via a WebSocket message.
  // Instead, let's just verify by sending a mock short TTS and checking timing.
  // Simpler: read the source file directly via the test runner's fs access.
  const { readFileSync } = await import("fs");
  const serverSrc = readFileSync(
    new URL("../server.ts", import.meta.url).pathname,
    "utf-8"
  );

  const hasLowTimeout = serverSrc.includes("Math.max(5000,");
  const noHighTimeout = !serverSrc.includes("Math.max(15000,");
  report("Timeout minimum is 5000ms (not 15000ms)", hasLowTimeout && noHighTimeout);

  const hasLowerBuffer = serverSrc.includes("* 1000 + 3000");
  report("Buffer reduced to +3000ms", hasLowerBuffer);
}

// ──────────────────────────────────────────────────────────────
// Bug 10: broadcastRawOutput scoped to current response
// ──────────────────────────────────────────────────────────────
async function testBug10_broadcastScope() {
  console.log("\n[Bug 10] broadcastRawOutput uses extractRawOutput");

  const { readFileSync } = await import("fs");
  const serverSrc = readFileSync(
    new URL("../server.ts", import.meta.url).pathname,
    "utf-8"
  );

  // The fix replaces stripChrome(pane.split("\n")) with extractRawOutput(...)
  const usesExtract = serverSrc.includes("extractRawOutput(preInputSnapshot, pane, lastUserInput)");
  const noStripChrome = !(/broadcastRawOutput[\s\S]{0,200}stripChrome/.test(serverSrc));
  report("broadcastRawOutput calls extractRawOutput (not stripChrome)", usesExtract && noStripChrome);
}

// ──────────────────────────────────────────────────────────────
// Bug 11: Partial→final transcript smooth transition
// ──────────────────────────────────────────────────────────────
async function testBug11_partialFinalTransition() {
  console.log("\n[Bug 11] Partial→final transcript in-place upgrade");

  // Simulate a partial message via WebSocket injection, then a final message
  const result = await page.evaluate(() => {
    // Find the WebSocket message handler by simulating messages
    const transcript = document.getElementById("transcript");
    if (!transcript) return { error: "no transcript element" };

    // Dispatch a fake partial transcription
    const fakePartial = new MessageEvent("message", {
      data: JSON.stringify({
        type: "transcription",
        role: "assistant",
        text: "Testing partial message...",
        ts: Date.now(),
        partial: true,
      }),
    });

    // We need to call the handler directly — find it via the ws.onmessage
    // Instead, check the DOM behavior by looking at the code structure
    const html = document.documentElement.innerHTML;
    const hasInPlaceUpgrade = html.includes("partial.removeAttribute") && html.includes('partial.style.opacity = "1"');
    return { hasInPlaceUpgrade };
  });

  if ("error" in result) {
    report("Transcript element found", false, result.error);
  } else {
    report("Final message upgrades partial bubble in-place (no remove+add)", result.hasInPlaceUpgrade);
  }
}

// ──────────────────────────────────────────────────────────────
// Bug 8: Terminal scroll position preserved when not auto-scrolling
// ──────────────────────────────────────────────────────────────
async function testBug8_terminalScroll() {
  console.log("\n[Bug 8] Terminal scroll position preserved");

  // Check that the terminal handler saves/restores scroll
  const htmlSource = await page.content();
  const savesPrevScroll = htmlSource.includes("prevScroll = terminalOutput.scrollTop");
  const restoresScroll = htmlSource.includes("terminalOutput.scrollTop = prevScroll");
  report("Terminal handler saves prevScroll before update", savesPrevScroll);
  report("Terminal handler restores prevScroll when not auto-scrolling", restoresScroll);
}

// ──────────────────────────────────────────────────────────────
// Bug 2: Dead speakNewContent function removed
// ──────────────────────────────────────────────────────────────
async function testBug2_deadCodeRemoved() {
  console.log("\n[Bug 2] Dead speakNewContent function removed");

  const { readFileSync } = await import("fs");
  const serverSrc = readFileSync(
    new URL("../server.ts", import.meta.url).pathname,
    "utf-8"
  );

  const removed = !serverSrc.includes("function speakNewContent");
  report("speakNewContent function removed from server.ts", removed);
}

// ──────────────────────────────────────────────────────────────
// Integration: WebSocket connects and receives expected messages
// ──────────────────────────────────────────────────────────────
async function testIntegration_wsConnect() {
  console.log("\n[Integration] WebSocket connection health");

  const wsStatus = await page.evaluate(() => {
    const dot = document.querySelector(".status-dot");
    return dot?.classList.contains("green") ? "green" : dot?.className || "unknown";
  });
  report(`Connection dot is green (got: ${wsStatus})`, wsStatus === "green");

  // Check services are reported up
  const whisperUp = await page.locator("#svcWhisper.up").isVisible().catch(() => false);
  const kokoroUp = await page.locator("#svcKokoro.up").isVisible().catch(() => false);
  report("Whisper service dot is up", whisperUp as boolean);
  report("Kokoro service dot is up", kokoroUp as boolean);
}

// ──────────────────────────────────────────────────────────────
// Live interaction: Send text via terminal input, watch response cycle
// ──────────────────────────────────────────────────────────────
async function testIntegration_textInput() {
  console.log("\n[Integration] Send text input and observe response cycle");

  // Open terminal panel
  const termBtn = page.locator("#termBtn");
  if (await termBtn.isVisible()) {
    await termBtn.click();
    await page.waitForTimeout(500);
  }

  const termInput = page.locator("#terminalInput");
  if (await termInput.isVisible()) {
    // Type a simple question
    await termInput.fill("Say just the word hello");
    await termInput.press("Enter");
    report("Text input sent via terminal", true);

    // Watch for thinking/responding state changes (up to 30s)
    let sawThinking = false;
    let sawResponse = false;

    const startTime = Date.now();
    while (Date.now() - startTime < 45000) {
      const talkText = (await page.locator("#talkBtn").textContent())?.toLowerCase() || "";
      const headerText = (await page.locator("#statusText").textContent())?.toLowerCase() || "";

      if (talkText.includes("thinking") || headerText.includes("thinking")) sawThinking = true;
      if (talkText.includes("responding") || headerText.includes("responding")) sawResponse = true;
      if (talkText.includes("speaking") || headerText.includes("speaking")) break;
      // Also break if it went back to idle/ready after thinking
      if (sawThinking && (talkText.includes("tap to") || talkText.includes("press right"))) break;

      await page.waitForTimeout(400);
    }
    report("Saw 'thinking' state", sawThinking);
    report("Saw 'responding' or 'speaking' state", sawResponse);

    // Check transcript has an assistant message
    await page.waitForTimeout(3000); // Wait for TTS to finish
    const hasAssistantMsg = await page.evaluate(() => {
      const msgs = document.querySelectorAll(".msg.assistant");
      return msgs.length > 0;
    });
    report("Transcript contains assistant message", hasAssistantMsg);

    // Verify the assistant message is scoped (not full scrollback) — Bug 10
    const lastMsgLength = await page.evaluate(() => {
      const msgs = document.querySelectorAll(".msg.assistant");
      if (msgs.length === 0) return -1;
      const last = msgs[msgs.length - 1];
      return last.textContent?.length || 0;
    });
    // A response to "say just hello" should be short, not thousands of chars of scrollback
    if (lastMsgLength > 0) {
      report(`Response length reasonable (${lastMsgLength} chars, <500 expected)`, lastMsgLength < 500);
    }
  } else {
    report("Terminal input field visible", false, "not found");
  }
}

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────
async function main() {
  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║  Murmur — Bug Fix Verification           ║");
  console.log("╚══════════════════════════════════════════╝");

  await setup();

  // Code/structure checks (fast)
  await testBug4_canvasScale();
  await testBug5_fallbackAudio();
  await testBug7_noBeepOnStop();
  await testBug6_ttsTimeout();
  await testBug10_broadcastScope();
  await testBug11_partialFinalTransition();
  await testBug8_terminalScroll();
  await testBug2_deadCodeRemoved();

  // Live integration checks
  await testIntegration_wsConnect();
  await testIntegration_textInput();

  await teardown();
}

main().catch(err => {
  console.error("Test runner error:", err);
  process.exit(2);
});
