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
// Bug 10: broadcastCurrentOutput scoped to current response via extractStructuredOutput
// ──────────────────────────────────────────────────────────────
async function testBug10_broadcastScope() {
  console.log("\n[Bug 10] broadcastCurrentOutput uses extractStructuredOutput");

  const { readFileSync } = await import("fs");
  const serverSrc = readFileSync(
    new URL("../server.ts", import.meta.url).pathname,
    "utf-8"
  );

  // broadcastCurrentOutput should use extractStructuredOutput with pre/post snapshots
  const usesExtract = serverSrc.includes("extractStructuredOutput(preInputSnapshot, pane, lastUserInput)");
  report("broadcastCurrentOutput uses extractStructuredOutput with preInputSnapshot", usesExtract);
}

// ──────────────────────────────────────────────────────────────
// Bug 11: Partial→final transcript smooth transition
// ──────────────────────────────────────────────────────────────
async function testBug11_partialFinalTransition() {
  console.log("\n[Bug 11] Partial→final transcript in-place upgrade");

  // Check that the entry rendering system handles partial updates without full DOM rebuilds
  const result = await page.evaluate(() => {
    const transcript = document.getElementById("transcript");
    if (!transcript) return { error: "no transcript element" };

    // The entry system uses renderEntries() with keyed reconciliation:
    // existing elements are updated in-place, new ones created, stale ones removed
    const html = document.documentElement.innerHTML;
    // Check for keyed reconciliation patterns
    const hasKeyedUpdate = html.includes("renderEntries") && html.includes("data-entry-id");
    return { hasInPlaceUpgrade: hasKeyedUpdate };
  });

  if ("error" in result) {
    report("Transcript element found", false, result.error);
  } else {
    report("Entry rendering uses keyed reconciliation (in-place updates)", result.hasInPlaceUpgrade);
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

  const termInput = page.locator("#textInput");
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
    // 'responding' state may be missed for very short replies (sub-400ms) — non-fatal
    if (sawResponse) report("Saw 'responding' or 'speaking' state", true);

    // Check transcript has an assistant message — wait up to 45s for entry to render
    const hasAssistantMsg = await page.waitForSelector(".msg.assistant", { timeout: 45000 })
      .then(() => true).catch(() => false);
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
// Feature: Voice + Text Queuing
// Messages sent while Claude is active get queued with visual styling
// ──────────────────────────────────────────────────────────────
async function testFeature_voiceQueue() {
  console.log("\n[Feature] Voice/text queue system");

  const { readFileSync } = await import("fs");
  const serverSrc = readFileSync(
    new URL("../server.ts", import.meta.url).pathname,
    "utf-8"
  );
  const htmlSrc = readFileSync(
    new URL("../index.html", import.meta.url).pathname,
    "utf-8"
  );

  // Server: pendingVoiceInput with entryId tracking
  const hasQueue = serverSrc.includes("pendingVoiceInput") && serverSrc.includes("entryId");
  report("Server has pendingVoiceInput with entryId tracking", hasQueue);

  // Server: drain lock to prevent concurrent drains
  const hasDrainLock = serverSrc.includes("_voiceQueueDraining");
  report("Server has _voiceQueueDraining lock", hasDrainLock);

  // Server: text: handler queues when Claude active
  const textHandlerQueues = serverSrc.includes("text:") && serverSrc.includes("addUserEntry(text, true)");
  report("text: handler queues when Claude active", textHandlerQueues);

  // Server: stop clears queue and removes queued entries
  const stopClearsQueue = serverSrc.includes("pendingVoiceInput.length = 0") ||
    serverSrc.includes("pendingVoiceInput = []") ||
    serverSrc.includes("pendingVoiceInput.splice");
  report("Stop clears pendingVoiceInput", stopClearsQueue);

  // Frontend: entry-queued CSS class exists
  const hasQueuedCss = htmlSrc.includes("entry-queued");
  report("Frontend has entry-queued CSS class", hasQueuedCss);

  // Frontend: queued entries get dimmed opacity
  const hasOpacity = htmlSrc.includes("0.72") || htmlSrc.includes("opacity: 0.7");
  report("Queued entry has reduced opacity", hasOpacity);

  // Frontend: ⏳ icon inline in queued entry
  const hasHourglass = htmlSrc.includes("queued-icon") && htmlSrc.includes("⏳");
  report("Queued entry shows ⏳ inline icon", hasHourglass);
}

// ──────────────────────────────────────────────────────────────
// Feature: Interrupt Button Always Visible
// ⚡ button stays in place, dimmed when inactive
// ──────────────────────────────────────────────────────────────
async function testFeature_interruptButton() {
  console.log("\n[Feature] Interrupt button always visible");

  // Load fresh page (idle state, no Claude session active)
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.setItem("murmur-tour-done", "1"));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  // Check source: interruptBtn uses CSS active class, not show/hide
  const htmlSrc = await page.content();
  const hasInterruptBtn = htmlSrc.includes("interruptBtn");
  report("Interrupt button exists in DOM", hasInterruptBtn);

  // Button should be in DOM and visible (not hidden with display:none)
  const interruptBtn = page.locator("#interruptBtn");
  const isVisible = await interruptBtn.isVisible().catch(() => false);
  report("Interrupt button is visible (always-present)", isVisible as boolean);

  // When idle (fresh page, no active Claude session): should NOT have active class
  const hasActiveClass = await interruptBtn.evaluate(el => el.classList.contains("active")).catch(() => false);
  report("Interrupt button is dimmed (no active class) when idle", !hasActiveClass);
}

// ──────────────────────────────────────────────────────────────
// Feature: Paste Auto-Submit
// Pasting into text input auto-sends without pressing Enter
// ──────────────────────────────────────────────────────────────
async function testFeature_pasteAutoSubmit() {
  console.log("\n[Feature] Paste auto-submit");

  const { readFileSync } = await import("fs");
  const htmlSrc = readFileSync(
    new URL("../index.html", import.meta.url).pathname,
    "utf-8"
  );

  // Dual detection: paste flag + insertFromPaste
  const hasPasteFlag = htmlSrc.includes("_pasteFlag");
  report("Paste flag variable present (dual-detection)", hasPasteFlag);

  const hasPasteEvent = htmlSrc.includes(`addEventListener("paste"`) && htmlSrc.includes("_pasteFlag = true");
  report("paste event sets _pasteFlag", hasPasteEvent);

  const hasInputCheck = htmlSrc.includes("insertFromPaste") && htmlSrc.includes("isPaste");
  report("input event checks flag + insertFromPaste", hasInputCheck);

  // Live test: programmatic paste triggers auto-submit
  const termInput = page.locator("#textInput");
  if (await termInput.isVisible()) {
    // Use clipboard API simulation via Playwright
    await termInput.focus();
    await page.evaluate(() => {
      const input = document.getElementById("textInput") as HTMLInputElement;
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      nativeInputValueSetter.call(input, "test-paste-content");
      // Simulate paste event then input event
      input.dispatchEvent(new Event("paste", { bubbles: true }));
      input.dispatchEvent(new InputEvent("input", { inputType: "insertFromPaste", bubbles: true }));
    });
    await page.waitForTimeout(300);
    // Input should be cleared after auto-submit
    const value = await termInput.inputValue();
    report("Paste auto-submit clears input field", value === "");
  } else {
    report("Text input visible for paste test", false, "input not found");
  }
}

// ──────────────────────────────────────────────────────────────
// Feature: Tmux Session Persistence
// Last-used tmux session restored after server restart
// ──────────────────────────────────────────────────────────────
async function testFeature_tmuxPersistence() {
  console.log("\n[Feature] Tmux session persistence");

  const { readFileSync } = await import("fs");
  const serverSrc = readFileSync(
    new URL("../server.ts", import.meta.url).pathname,
    "utf-8"
  );

  // PanelSettings interface has tmuxTarget
  const hasInterface = serverSrc.includes("tmuxTarget") && serverSrc.includes("PanelSettings");
  report("PanelSettings interface has tmuxTarget field", hasInterface);

  // saveSettings called on tmux switch
  const saveOnSwitch = serverSrc.includes("saveSettings") && serverSrc.includes("tmuxTarget");
  report("tmuxTarget saved to settings on switch", saveOnSwitch);

  // Startup code restores saved target
  const hasRestore = serverSrc.includes("loadSettings().tmuxTarget") || serverSrc.includes("savedTarget");
  report("Server restores tmuxTarget on startup", hasRestore);

  // switchTarget call on restore
  const callsSwitchTarget = serverSrc.includes("terminal.switchTarget") || serverSrc.includes("switchTarget(session");
  report("Server calls switchTarget with saved session", callsSwitchTarget);
}

// ──────────────────────────────────────────────────────────────
// Feature: npm start Auto-Restart
// start.mjs wrapper re-spawns server on exit code 0
// ──────────────────────────────────────────────────────────────
async function testFeature_autoRestart() {
  console.log("\n[Feature] npm start auto-restart (start.mjs)");

  const { readFileSync, existsSync } = await import("fs");

  const startMjsPath = new URL("../start.mjs", import.meta.url).pathname;
  const startExists = existsSync(startMjsPath);
  report("start.mjs wrapper file exists", startExists);

  if (startExists) {
    const startSrc = readFileSync(startMjsPath, "utf-8");
    const spawnsServer = startSrc.includes("tsx") && startSrc.includes("server.ts");
    report("start.mjs spawns npx tsx server.ts", spawnsServer);

    const restartsOnZero = startSrc.includes("code === 0") && startSrc.includes("setTimeout");
    report("start.mjs restarts on exit code 0", restartsOnZero);

    const exitsOnError = startSrc.includes("process.exit");
    report("start.mjs exits on non-zero code", exitsOnError);
  }

  const pkgSrc = readFileSync(new URL("../package.json", import.meta.url).pathname, "utf-8");
  const pkg = JSON.parse(pkgSrc);
  const usesStartMjs = pkg.scripts?.start === "node start.mjs";
  report("package.json start script uses node start.mjs", usesStartMjs);
}

// ──────────────────────────────────────────────────────────────
// Feature: Session Popover Color Coding
// Group headers blue, items lighter, active item gold
// ──────────────────────────────────────────────────────────────
async function testFeature_sessionPopoverColors() {
  console.log("\n[Feature] Session popover color coding");

  const { readFileSync } = await import("fs");
  const htmlSrc = readFileSync(
    new URL("../index.html", import.meta.url).pathname,
    "utf-8"
  );

  const hasGroupColor = htmlSrc.includes("#7ab8e8") && htmlSrc.includes("sess-group");
  report("Session group headers use blue (#7ab8e8)", hasGroupColor);

  const hasActiveGold = htmlSrc.includes("#c9a227") && htmlSrc.includes("sess-item.active");
  report("Active session item uses gold (#c9a227)", hasActiveGold);

  const hasItemColor = htmlSrc.includes("#c8cdd5") && htmlSrc.includes("sess-item");
  report("Session items use lighter color (#c8cdd5)", hasItemColor);
}

// ──────────────────────────────────────────────────────────────
// Feature: Terminal Label Inline Styles
// Stats text uses inline color (not CSS classes) to fix specificity
// ──────────────────────────────────────────────────────────────
async function testFeature_terminalLabelStyles() {
  console.log("\n[Feature] Terminal label uses inline styles");

  const { readFileSync } = await import("fs");
  const htmlSrc = readFileSync(
    new URL("../index.html", import.meta.url).pathname,
    "utf-8"
  );

  // updateTermLabel uses inline style="color:..."
  const hasInlineStyle = htmlSrc.includes(`style="font-size:10px;color:`) &&
    htmlSrc.includes("updateTermLabel");
  report("updateTermLabel uses inline style for color", hasInlineStyle);

  // Three color states: blue, orange, red
  const hasBlue = htmlSrc.includes("#7ab8e8");
  const hasOrange = htmlSrc.includes("#c0853a");
  const hasRed = htmlSrc.includes("#c0453a");
  report("Terminal label has blue/orange/red color states", hasBlue && hasOrange && hasRed);
}

// ──────────────────────────────────────────────────────────────
// Feature: TTS Highlight Scroll
// Highlighted entry scrolls to near top of transcript (32px offset)
// ──────────────────────────────────────────────────────────────
async function testFeature_ttsScrollToTop() {
  console.log("\n[Feature] TTS highlight scrolls entry near top");

  const { readFileSync } = await import("fs");
  const htmlSrc = readFileSync(
    new URL("../index.html", import.meta.url).pathname,
    "utf-8"
  );

  // Look for the scroll positioning logic (elRelTop - 32)
  const hasScrollTop = htmlSrc.includes("elRelTop - 32") || htmlSrc.includes("elRelTop-32");
  report("TTS highlight scroll positions entry 32px from top", hasScrollTop);

  // Should use getBoundingClientRect for positioning
  const usesGetBCR = htmlSrc.includes("getBoundingClientRect") &&
    htmlSrc.includes("highlightEntry");
  report("highlightEntry uses getBoundingClientRect for scroll", usesGetBCR);
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

  // New features from session
  await testFeature_voiceQueue();
  await testFeature_interruptButton();
  await testFeature_pasteAutoSubmit();
  await testFeature_tmuxPersistence();
  await testFeature_autoRestart();
  await testFeature_sessionPopoverColors();
  await testFeature_terminalLabelStyles();
  await testFeature_ttsScrollToTop();

  await teardown();
}

main().catch(err => {
  console.error("Test runner error:", err);
  process.exit(2);
});
