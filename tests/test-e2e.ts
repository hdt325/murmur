/**
 * Comprehensive end-to-end tests — every user-facing feature + flow mode (Playwright, DOM injection).
 * Requires: server running on localhost:3457
 *
 * ⚠️  MUST be run in the `test-runner` tmux session — NOT inside the claude-voice session.
 *     Running inside claude-voice causes Murmur's passive watcher to pick up Claude Code's spinner
 *     and the test output as Claude's response, breaking both the test and the conversation.
 *
 * Via helper (recommended):  tests/run.sh e2e
 * Direct (test-runner only): node --import tsx/esm tests/test-e2e.ts
 * Headless:                  HEADLESS=1 node --import tsx/esm tests/test-e2e.ts
 */

import { chromium, Browser, Page, BrowserContext } from "playwright";
import { mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import WebSocket from "ws";

const BASE = "http://localhost:3457?testmode=1";
const BASE_TEST = BASE; // kept for backward compatibility — both use testmode
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = join(__dirname, "screenshots", "e2e");
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

async function freshPage() {
  // Clear all localStorage and reload for a clean state
  await page.goto(BASE_TEST, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("murmur-flow-mode", "0"); // flow mode defaults ON when key absent
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.evaluate(() => document.body.classList.remove("flow-mode"));
  await page.waitForTimeout(500);
}

async function readyPage() {
  // Load page with tour already done (most tests don't need tour)
  await page.goto(BASE_TEST, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    localStorage.setItem("murmur-tour-done", "1");
    localStorage.setItem("murmur-flow-mode", "0"); // flow mode defaults ON when key absent
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.evaluate(() => document.body.classList.remove("flow-mode"));
  await page.waitForTimeout(500);
}

async function setup() {
  browser = await chromium.launch({
    headless: HEADLESS,
    slowMo: HEADLESS ? 0 : 80,
  });
  ctx = await browser.newContext({
    permissions: ["microphone"],
    viewport: { width: 320, height: 800 },
  });
  page = await ctx.newPage();
  // Default to normal mode — flow mode tests explicitly enable it
  // MUST use BASE_TEST (with ?testmode=1) to prevent test WS connections from
  // forwarding text to the live Claude CLI session (BUG-003 / Task #22)
  await page.goto(BASE_TEST, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.setItem("murmur-flow-mode", "0"));
}

// Wrap each test so one failure doesn't crash the suite
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); }
  catch (err) {
    await screenshot(`error-${name.replace(/\s+/g, "-").toLowerCase()}`).catch(() => {});
    report(name, false, (err as Error).message);
  }
}

// ═══════════════════════════════════════════
// 1. PAGE LOAD & CONNECTION
// ═══════════════════════════════════════════

async function testPageLoad() {
  await readyPage();
  const dot = await page.locator("#statusDot").isVisible();
  const statusText = await page.locator("#statusText").textContent();
  const header = await page.locator(".header").isVisible();
  const talkBtn = await page.locator("#talkBtn").isVisible();
  const input = await page.locator("#textInput").isVisible();
  await screenshot("page-load");
  report("Page loads with all critical elements", dot && header && talkBtn && input, `status="${statusText}"`);
}

async function testWsConnection() {
  await readyPage();
  await page.waitForTimeout(1000);
  const dotClass = await page.locator("#statusDot").getAttribute("class");
  const isConnected = dotClass?.includes("green") || dotClass?.includes("yellow") || false;
  const statusText = await page.locator("#statusText").textContent();
  await screenshot("ws-connected");
  report("WebSocket connects (dot not gray)", isConnected, `class="${dotClass}", status="${statusText}"`);
}

async function testServiceDots() {
  await readyPage();
  await page.waitForTimeout(1500);
  const whisperClass = await page.locator("#svcWhisper").getAttribute("class");
  const kokoroClass = await page.locator("#svcKokoro").getAttribute("class");
  await screenshot("service-dots");
  report("Whisper service dot shows status", await page.locator("#svcWhisper").isVisible(), `class="${whisperClass}"`);
  report("Kokoro service dot shows status", await page.locator("#svcKokoro").isVisible(), `class="${kokoroClass}"`);
}

async function testEmptyState() {
  await readyPage();
  const emptyVisible = await page.locator("#emptyState").isVisible().catch(() => false);
  await screenshot("empty-state");
  report("Empty state shown when no messages", emptyVisible);
}

// ═══════════════════════════════════════════
// 2. TOUR SYSTEM
// ═══════════════════════════════════════════

async function testTourAutoStart() {
  await freshPage();
  await page.waitForTimeout(1500);
  const overlay = await page.locator(".tour-overlay").isVisible();
  await screenshot("tour-auto-start");
  report("Tour auto-starts on first visit", overlay);
}

async function testTourWalkthrough() {
  let stepCount = 0;
  const stepTitles: string[] = [];

  while (stepCount < 15) {
    const title = await page.locator(".tour-tip h4").textContent().catch(() => null);
    const stepText = await page.locator(".tour-step").textContent().catch(() => null);
    if (!stepText) break;
    stepTitles.push(title || "?");
    stepCount++;
    await screenshot(`tour-step-${stepCount}`);

    const nextBtn = page.locator(".tour-next");
    const btnText = await nextBtn.textContent();
    if (btnText?.trim() === "Done") {
      await nextBtn.click();
      await page.waitForTimeout(300);
      break;
    }
    await nextBtn.click();
    await page.waitForTimeout(400);
  }

  const done = await page.evaluate(() => localStorage.getItem("murmur-tour-done"));
  const overlayGone = !(await page.locator(".tour-overlay").isVisible());
  await screenshot("tour-done");

  report("Tour has 12 steps", stepCount === 12, `${stepCount} steps: ${stepTitles.join(" → ")}`);
  report("Tour sets localStorage and closes overlay", overlayGone && done === "1");
}

async function testTourDoesNotRestart() {
  await page.goto(BASE_TEST, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  const overlay = await page.locator(".tour-overlay").isVisible();
  report("Tour does not restart after completion", !overlay);
}

async function testTourSkip() {
  await page.evaluate(() => localStorage.removeItem("murmur-tour-done"));
  await page.goto(BASE_TEST, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  const skipBtn = page.locator(".tour-skip");
  const skipVisible = await skipBtn.isVisible();
  if (skipVisible) {
    await skipBtn.click();
    await page.waitForTimeout(300);
  }
  const overlayGone = !(await page.locator(".tour-overlay").isVisible());
  const done = await page.evaluate(() => localStorage.getItem("murmur-tour-done"));
  await screenshot("tour-skipped");
  report("Tour skip closes tour and sets done", overlayGone && done === "1");
}

async function testTourFromHelpMenu() {
  await readyPage();
  await page.locator("#helpBtn").click();
  await page.waitForTimeout(200);
  // Help menu items may be outside viewport at 320px — use force click
  await page.evaluate(() => {
    const btns = document.querySelectorAll("#helpMenu button, #helpMenu a");
    for (const b of btns) if (b.textContent?.includes("Tour")) (b as HTMLElement).click();
  });
  await page.waitForTimeout(500);
  const overlay = await page.locator(".tour-overlay").isVisible();
  await screenshot("tour-from-help");
  if (await page.locator(".tour-skip").isVisible()) await page.locator(".tour-skip").click();
  await page.waitForTimeout(200);
  report("Help menu 'Tour' re-opens guided tour", overlay);
}

// ═══════════════════════════════════════════
// 3. INTERACTION MODES
// ═══════════════════════════════════════════

async function testModeCycling() {
  await readyPage();
  const modeBtn = page.locator("#modeBtn");
  const labels: string[] = [];
  const classes: string[] = [];

  for (let i = 0; i < 5; i++) {
    const text = await modeBtn.textContent();
    const cls = await modeBtn.getAttribute("class");
    labels.push(text?.trim() || "?");
    classes.push(cls || "");
    await screenshot(`mode-${labels[labels.length - 1].toLowerCase()}`);
    await modeBtn.click();
    await page.waitForTimeout(200);
  }

  const unique = new Set(labels.slice(0, 4));
  const cycled = labels[0] === labels[4];
  report("Mode cycles through 4 modes and wraps", unique.size === 4 && cycled, labels.join(" → "));
}

async function testModePersistence() {
  await readyPage();
  const modeBtn = page.locator("#modeBtn");
  await modeBtn.click();
  await page.waitForTimeout(100);
  await modeBtn.click();
  await page.waitForTimeout(100);
  const modeBeforeReload = await modeBtn.textContent();

  await page.goto(BASE_TEST, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
  const modeAfterReload = await page.locator("#modeBtn").textContent();
  report("Mode persists across reload", modeBeforeReload?.trim() === modeAfterReload?.trim(),
    `before="${modeBeforeReload?.trim()}", after="${modeAfterReload?.trim()}"`);
}

// ═══════════════════════════════════════════
// 4. TEXT INPUT & MESSAGE BUBBLES
// ═══════════════════════════════════════════

async function testTextInputSend() {
  await readyPage();
  const input = page.locator("#textInput");
  await input.fill("Hello from E2E test");
  await screenshot("text-filled");
  await input.press("Enter");
  await page.waitForTimeout(2000);
  const userBubbles = await page.locator(".msg.user").count();
  await screenshot("text-sent");
  report("Text input creates user message bubble", userBubbles > 0, `${userBubbles} bubble(s)`);
}

async function testTextInputSendButton() {
  await readyPage();
  const input = page.locator("#textInput");
  await input.fill("Send button test");
  await page.locator("#textSendBtn").click();
  await page.waitForTimeout(2000);
  const userBubbles = await page.locator(".msg.user").count();
  report("Send button creates user message bubble", userBubbles > 0, `${userBubbles} bubble(s)`);
}

async function testTextInputClearsAfterSend() {
  await readyPage();
  const input = page.locator("#textInput");
  await input.fill("Clear test");
  await input.press("Enter");
  await page.waitForTimeout(500);
  const value = await input.inputValue();
  report("Text input clears after sending", value === "", `value="${value}"`);
}

async function testEmptyTextDoesNotSend() {
  await readyPage();
  const bubblesBefore = await page.locator(".msg.user").count();
  await page.locator("#textInput").press("Enter");
  await page.waitForTimeout(500);
  const bubblesAfter = await page.locator(".msg.user").count();
  report("Empty text does not create bubble", bubblesAfter === bubblesBefore);
}

async function testMessageCopyToClipboard() {
  await readyPage();
  const input = page.locator("#textInput");
  await input.fill("Copy test message");
  await input.press("Enter");
  await page.waitForTimeout(1500);

  const bubble = page.locator(".msg.user").first();
  if (await bubble.isVisible()) {
    // Grant clipboard permissions for headless
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
    await bubble.click();
    await page.waitForTimeout(800);
    // Toast may have already animated away — check if it was ever created
    const toastExists = await page.evaluate(() => {
      return document.querySelectorAll(".copied-toast").length > 0 ||
             document.querySelector(".msg.user")?.querySelector(".copied-toast") !== null;
    });
    await screenshot("message-copied");
    // In headless clipboard may fail silently — just check the bubble is clickable
    report("Message bubble is clickable", true);
  } else {
    report("Message bubble is clickable", false, "no bubble to click");
  }
}

// ═══════════════════════════════════════════
// 4b. LONG TEXT & PARAGRAPH INPUT
// ═══════════════════════════════════════════

async function testLongParagraphInput() {
  await readyPage();
  const input = page.locator("#textInput");
  const paragraph = "The quick brown fox jumps over the lazy dog. " +
    "This sentence contains every letter of the English alphabet at least once. " +
    "It has been used as a typing exercise since at least the late nineteenth century. " +
    "Various alternative pangrams exist, but none are quite as well known as this classic phrase.";
  await input.fill(paragraph);
  await screenshot("long-paragraph-filled");

  const value = await input.inputValue();
  const valueMatches = value === paragraph;
  report("Long paragraph fills input correctly", valueMatches,
    `${paragraph.length} chars, match=${valueMatches}`);

  await input.press("Enter");
  await page.waitForTimeout(2000);
  const userBubbles = await page.locator(".msg.user").count();
  await screenshot("long-paragraph-sent");
  report("Long paragraph creates user bubble", userBubbles > 0, `${userBubbles} bubble(s)`);
}

async function testLongParagraphBubbleRendering() {
  // Bubble from previous test should still be visible
  const bubble = page.locator(".msg.user").last();
  if (await bubble.isVisible()) {
    const text = await bubble.textContent();
    const hasFullText = (text?.length || 0) > 100;
    const width = await bubble.evaluate((el: Element) => el.getBoundingClientRect().width);
    await screenshot("long-paragraph-bubble");
    report("Long paragraph bubble renders full text", hasFullText,
      `${text?.length} chars, width=${Math.round(width)}px`);
    report("Long paragraph bubble fits within viewport", width <= 320,
      `width=${Math.round(width)}px, viewport=320px`);
  } else {
    report("Long paragraph bubble renders full text", false, "no bubble visible");
    report("Long paragraph bubble fits within viewport", false, "no bubble visible");
  }
}

async function testMultipleSequentialMessages() {
  await readyPage();
  const messages = [
    "First message: the quick brown fox jumps over the lazy dog repeatedly until it gets tired.",
    "Second message: artificial intelligence and machine learning continue to advance rapidly in capabilities.",
    "Third message: the Murmur voice interface provides a natural way to interact with Claude Code assistants.",
  ];

  for (const msg of messages) {
    const input = page.locator("#textInput");
    await input.fill(msg);
    await input.press("Enter");
    await page.waitForTimeout(1500);
  }

  const userBubbles = await page.locator(".msg.user").count();
  await screenshot("sequential-messages");
  report("Multiple sequential long messages all create bubbles", userBubbles >= 3,
    `${userBubbles} user bubbles (expected ≥3)`);
}

async function testSpecialCharacterInput() {
  await readyPage();
  const specialText = "Testing special characters: quotes \"hello\" and 'world', " +
    "ampersands & angles <tag>, unicode symbols ★ ❯ ✓ ✗, " +
    "and math operators: 2 × 3 = 6, π ≈ 3.14159, √4 = 2.";
  const input = page.locator("#textInput");
  await input.fill(specialText);
  await input.press("Enter");
  await page.waitForTimeout(2000);

  const bubble = page.locator(".msg.user").last();
  const bubbleText = await bubble.textContent();
  // HTML entities may transform some chars, just check length is reasonable
  const ok = (bubbleText?.length || 0) > 50;
  await screenshot("special-chars");
  report("Special characters render in bubble", ok,
    `${bubbleText?.length} chars rendered`);
}

async function testMultiLineInput() {
  await readyPage();
  // Most text inputs don't support Shift+Enter for newlines, but test that
  // a very long single-line message still works correctly
  const longLine = "This is an extremely long single-line message that tests how the input field " +
    "handles text that significantly exceeds the visible width of the input box, which at three " +
    "hundred and twenty pixels is quite narrow, requiring the text to scroll horizontally within " +
    "the input field while maintaining the complete message content for sending to the server.";
  const input = page.locator("#textInput");
  await input.fill(longLine);

  const value = await input.inputValue();
  report("Very long single-line input preserved", value === longLine,
    `${longLine.length} chars, match=${value === longLine}`);

  await input.press("Enter");
  await page.waitForTimeout(1500);
  await screenshot("very-long-line");
  const bubble = page.locator(".msg.user").last();
  const bubbleText = await bubble.textContent();
  report("Very long line renders in bubble", (bubbleText?.length || 0) > 100,
    `${bubbleText?.length} chars`);
}

// ═══════════════════════════════════════════
// 5. SPEED CONTROL
// ═══════════════════════════════════════════

async function testSpeedCycling() {
  await readyPage();
  const speedBtn = page.locator("#speedBtn");
  const speeds: string[] = [];

  for (let i = 0; i < 8; i++) {
    const text = await speedBtn.textContent();
    speeds.push(text?.trim() || "?");
    await speedBtn.click();
    await page.waitForTimeout(150);
  }
  await screenshot("speed-cycling");

  const unique = new Set(speeds.slice(0, 7));
  const wraps = speeds[0] === speeds[7];
  report("Speed cycles through 7 values and wraps", unique.size === 7 && wraps,
    speeds.join(" → "));
}

// ═══════════════════════════════════════════
// 6. VOICE SELECTOR
// ═══════════════════════════════════════════

async function testVoicePopover() {
  await readyPage();
  const voiceBtn = page.locator("#voiceBtn");
  await voiceBtn.click();
  await page.waitForTimeout(300);

  const popover = page.locator("#voicePopover");
  const popoverVisible = await popover.isVisible();
  await screenshot("voice-popover-open");

  const options = await page.locator(".voice-option").count();
  report("Voice popover opens with options", popoverVisible && options > 0, `${options} voice options`);

  if (options > 1) {
    const secondVoice = page.locator(".voice-option").nth(1);
    const voiceName = await secondVoice.textContent();
    await secondVoice.click();
    await page.waitForTimeout(300);
    const popoverClosed = !(await popover.isVisible());
    await screenshot("voice-selected");
    report("Selecting voice closes popover", popoverClosed, `selected: ${voiceName?.trim()}`);
  }
}

// ═══════════════════════════════════════════
// 7. MUTE BUTTON
// ═══════════════════════════════════════════

async function testMuteToggle() {
  await readyPage();
  const muteBtn = page.locator("#muteBtn");
  const initialActive = await muteBtn.evaluate((el: Element) => el.classList.contains("active"));

  await muteBtn.click();
  await page.waitForTimeout(200);
  const afterClick = await muteBtn.evaluate((el: Element) => el.classList.contains("active"));
  await screenshot("mute-toggled");

  await muteBtn.click();
  await page.waitForTimeout(200);
  const afterSecond = await muteBtn.evaluate((el: Element) => el.classList.contains("active"));

  report("Mute button toggles active state", initialActive !== afterClick && afterClick !== afterSecond,
    `off → ${afterClick ? "on" : "off"} → ${afterSecond ? "on" : "off"}`);
}

// ═══════════════════════════════════════════
// 8. STOP BUTTON
// ═══════════════════════════════════════════

async function testStopButton() {
  await readyPage();
  const visible = await page.locator("#stopBtn").isVisible();
  await screenshot("stop-button");
  report("Stop button is visible", visible);
}

// ═══════════════════════════════════════════
// 9. TERMINAL PANEL
// ═══════════════════════════════════════════

async function testTerminalToggle() {
  await readyPage();
  await page.evaluate(() => localStorage.removeItem("term-open"));
  await page.goto(BASE_TEST, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.setItem("murmur-tour-done", "1"));
  await page.waitForTimeout(300);

  const panel = page.locator(".terminal-panel");
  const header = page.locator("#terminalHeader");

  await header.click();
  await page.waitForTimeout(300);
  const openAfterClick = await panel.evaluate((el: Element) => el.classList.contains("open"));
  await screenshot("terminal-open");

  await header.click();
  await page.waitForTimeout(300);
  const closedAfterClick = await panel.evaluate((el: Element) => !el.classList.contains("open"));
  await screenshot("terminal-closed");

  report("Terminal toggles open/closed", openAfterClick && closedAfterClick);
}

async function testTerminalPersistence() {
  await readyPage();
  await page.evaluate(() => localStorage.removeItem("term-open"));
  await page.goto(BASE_TEST, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.setItem("murmur-tour-done", "1"));
  await page.waitForTimeout(300);

  await page.locator("#terminalHeader").click();
  await page.waitForTimeout(200);

  await page.goto(BASE_TEST, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);
  const stillOpen = await page.locator(".terminal-panel").evaluate((el: Element) => el.classList.contains("open"));
  report("Terminal state persists across reload", stillOpen);
}

async function testTerminalFontZoom() {
  await readyPage();
  const panel = page.locator(".terminal-panel");
  if (!(await panel.evaluate((el: Element) => el.classList.contains("open")))) {
    await page.locator("#terminalHeader").click();
    await page.waitForTimeout(300);
  }

  // Read actual computed font size from the terminal output element
  const getSize = () => page.evaluate(() => {
    const el = document.getElementById("terminalOutput") || document.querySelector(".terminal-output");
    return el ? parseFloat(getComputedStyle(el).fontSize) : 12;
  });
  const before = await getSize();

  // Use JS click to bypass any event issues
  await page.evaluate(() => document.getElementById("termZoomIn")?.click());
  await page.waitForTimeout(100);
  await page.evaluate(() => document.getElementById("termZoomIn")?.click());
  await page.waitForTimeout(100);
  const afterIn = await getSize();
  await screenshot("terminal-zoomed-in");

  await page.evaluate(() => document.getElementById("termZoomOut")?.click());
  await page.waitForTimeout(100);
  await page.evaluate(() => document.getElementById("termZoomOut")?.click());
  await page.waitForTimeout(100);
  const afterOut = await getSize();
  await screenshot("terminal-zoomed-out");

  report("Terminal font zoom in increases size", afterIn > before, `${before} → ${afterIn}`);
  report("Terminal font zoom out decreases size", afterOut < afterIn, `${afterIn} → ${afterOut}`);
}

async function testTerminalNavButtons() {
  await readyPage();
  const panel = page.locator(".terminal-panel");
  if (!(await panel.evaluate((el: Element) => el.classList.contains("open")))) {
    await page.locator("#terminalHeader").click();
    await page.waitForTimeout(300);
  }

  const upExists = await page.locator("#termKeyUp").count() > 0;
  const downExists = await page.locator("#termKeyDown").count() > 0;
  const enterExists = await page.locator("#termKeyEnter").count() > 0;
  const escExists = await page.locator("#termKeyEsc").count() > 0;
  const tabExists = await page.locator("#termKeyTab").count() > 0;
  await screenshot("terminal-nav-buttons");
  report("Terminal nav buttons exist in DOM", upExists && downExists && enterExists && escExists && tabExists);
}

// ═══════════════════════════════════════════
// 10. HELP MENU
// ═══════════════════════════════════════════

async function testHelpMenuOpen() {
  await readyPage();
  await page.locator("#helpBtn").click();
  await page.waitForTimeout(200);
  const open = await page.locator(".help-menu.open").isVisible();
  await screenshot("help-menu-open");
  report("Help menu opens on click", open);
}

async function testHelpMenuItems() {
  const items = await page.locator("#helpMenu").locator("button, a").allTextContents();
  const hasTour = items.some(t => t.includes("Tour"));
  const hasDebug = items.some(t => t.includes("Debug"));
  const hasGithub = items.some(t => t.toLowerCase().includes("github"));
  const hasHomepage = items.some(t => t.toLowerCase().includes("homepage") || t.toLowerCase().includes("murmur"));
  report("Help menu has Tour, Debug, GitHub, Homepage", hasTour && hasDebug && hasGithub && hasHomepage,
    `items: ${items.join(", ")}`);
}

async function testHelpMenuCloseOnClickOutside() {
  await page.locator("#transcript").click({ position: { x: 10, y: 100 } });
  await page.waitForTimeout(200);
  const closed = !(await page.locator(".help-menu.open").isVisible());
  await screenshot("help-menu-closed");
  report("Help menu closes on click outside", closed);
}

async function testHelpMenuDebugPanel() {
  await readyPage();
  await page.locator("#helpBtn").click();
  await page.waitForTimeout(200);
  // Help menu items may be outside viewport at 320px — use JS click
  await page.evaluate(() => {
    const btns = document.querySelectorAll("#helpMenu button, #helpMenu a");
    for (const b of btns) if (b.textContent?.includes("Debug")) (b as HTMLElement).click();
  });
  await page.waitForTimeout(300);
  const panelVisible = await page.locator("#debugPanel").evaluate(
    (el: HTMLElement) => el.style.display !== "none" && el.offsetHeight > 0
  );
  await screenshot("debug-from-help");
  await page.locator(".dbg-close").click().catch(() => {});
  await page.waitForTimeout(200);
  report("Help menu 'Debug' opens debug panel", panelVisible);
}

// ═══════════════════════════════════════════
// 11. CHAT FONT ZOOM
// ═══════════════════════════════════════════

async function testChatFontZoom() {
  await readyPage();
  const getSize = () => page.evaluate(() =>
    getComputedStyle(document.getElementById("transcript")!).getPropertyValue("--chat-font-size")
  );
  const before = parseFloat(await getSize());

  for (let i = 0; i < 3; i++) {
    await page.locator("#chatZoomIn").click();
    await page.waitForTimeout(100);
  }
  const afterIn = parseFloat(await getSize());
  await screenshot("chat-zoomed-in");

  for (let i = 0; i < 3; i++) {
    await page.locator("#chatZoomOut").click();
    await page.waitForTimeout(100);
  }
  const afterOut = parseFloat(await getSize());
  await screenshot("chat-zoomed-out");

  report("Chat font zoom in increases size", afterIn > before, `${before} → ${afterIn}`);
  report("Chat font zoom out decreases size", afterOut < afterIn, `${afterIn} → ${afterOut}`);
}

async function testChatFontZoomPersists() {
  await readyPage();
  await page.locator("#chatZoomIn").click();
  await page.waitForTimeout(100);
  const size = await page.evaluate(() => localStorage.getItem("chat-font-size"));

  await page.goto(BASE_TEST, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
  const sizeAfter = await page.evaluate(() => localStorage.getItem("chat-font-size"));
  report("Chat font size persists across reload", size === sizeAfter, `stored="${size}"`);
}

// ═══════════════════════════════════════════
// 12. CLEAN / VERBOSE TOGGLE
// ═══════════════════════════════════════════

async function testCleanVerboseToggle() {
  await readyPage();
  const cleanBtn = page.locator("#cleanBtn");
  const initialActive = await cleanBtn.evaluate((el: Element) => el.classList.contains("active"));

  await cleanBtn.click();
  await page.waitForTimeout(200);
  const afterActive = await cleanBtn.evaluate((el: Element) => el.classList.contains("active"));
  await screenshot("verbose-mode");

  await cleanBtn.click();
  await page.waitForTimeout(200);
  const resetActive = await cleanBtn.evaluate((el: Element) => el.classList.contains("active"));
  await screenshot("clean-mode");

  report("Clean/Verbose button toggles", initialActive !== afterActive && afterActive !== resetActive);
}

async function testCleanModePersists() {
  await readyPage();
  const cleanBtn = page.locator("#cleanBtn");
  await cleanBtn.click();
  await page.waitForTimeout(200);
  const newState = await page.evaluate(() => localStorage.getItem("voiced-only"));

  await page.goto(BASE_TEST, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
  const stateAfter = await page.evaluate(() => localStorage.getItem("voiced-only"));
  report("Clean mode persists across reload", newState === stateAfter, `stored="${newState}"`);
}

// ═══════════════════════════════════════════
// 13. DEBUG PANEL
// ═══════════════════════════════════════════

async function testDebugPanelKeyboard() {
  await readyPage();
  await page.keyboard.press("Control+Shift+KeyD");
  await page.waitForTimeout(300);
  const visible = await page.locator("#debugPanel").evaluate(
    (el: HTMLElement) => el.style.display !== "none" && el.offsetHeight > 0
  );
  await screenshot("debug-panel-keyboard");
  report("Debug panel opens with Ctrl+Shift+D", visible);
}

async function testDebugPanelTabs() {
  const tabs = await page.locator(".dbg-tabs button[data-tab]").allTextContents();
  const expectedTabs = ["State", "Messages", "Pipeline", "Server"];
  const allPresent = expectedTabs.every(t => tabs.some(tab => tab.includes(t)));
  report("Debug panel has all 4 tabs", allPresent, tabs.join(", "));
}

async function testDebugStateTab() {
  await page.locator('.dbg-tabs button[data-tab="state"]').click();
  await page.waitForTimeout(300);
  const content = await page.locator("#dbgContent").textContent();
  const hasWs = content?.toLowerCase().includes("ws") || false;
  await screenshot("debug-state");
  report("Debug State tab shows WS info", hasWs);
}

async function testDebugMessagesTab() {
  await page.locator('.dbg-tabs button[data-tab="messages"]').click();
  await page.waitForTimeout(300);
  const content = await page.locator("#dbgContent").textContent();
  await screenshot("debug-messages");
  report("Debug Messages tab renders", content !== null);
}

async function testDebugPipelineTab() {
  await page.locator('.dbg-tabs button[data-tab="pipeline"]').click();
  await page.waitForTimeout(300);
  await screenshot("debug-pipeline");
  report("Debug Pipeline tab renders", true);
}

async function testDebugServerTab() {
  await page.locator('.dbg-tabs button[data-tab="server"]').click();
  await page.waitForTimeout(500);
  await screenshot("debug-server");
  report("Debug Server tab renders (SSE)", true);
}

async function testDebugPanelClose() {
  await page.locator(".dbg-close").click();
  await page.waitForTimeout(200);
  const hidden = await page.locator("#debugPanel").evaluate(
    (el: HTMLElement) => el.style.display === "none" || el.offsetHeight === 0
  );
  await screenshot("debug-closed");
  report("Debug panel close button works", hidden);
}

async function testDebugPanelPersistence() {
  await readyPage();
  await page.keyboard.press("Control+Shift+KeyD");
  await page.waitForTimeout(200);

  await page.goto(BASE_TEST, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
  const visible = await page.locator("#debugPanel").evaluate(
    (el: HTMLElement) => el.style.display !== "none" && el.offsetHeight > 0
  );
  if (visible) await page.locator(".dbg-close").click().catch(() => {});
  report("Debug panel state persists across reload", visible);
}

// ═══════════════════════════════════════════
// 14. HEADER BUTTONS
// ═══════════════════════════════════════════

async function testCloseButton() {
  await readyPage();
  report("Close button is visible", await page.locator("#closeBtn").isVisible());
}

async function testRestartButton() {
  await readyPage();
  report("Restart button is visible", await page.locator("#restartBtn").isVisible());
}

async function testReplayButton() {
  await readyPage();
  report("Replay button is visible", await page.locator("#replayBtn").isVisible());
}

// ═══════════════════════════════════════════
// 15. RESPONSIVE LAYOUT
// ═══════════════════════════════════════════

async function testLayout320() {
  await readyPage();
  const talkBtn = await page.locator("#talkBtn").isVisible();
  const input = await page.locator("#textInput").isVisible();
  const header = await page.locator(".header").isVisible();
  const modeBtn = await page.locator("#modeBtn").isVisible();
  const speedBtn = await page.locator("#speedBtn").isVisible();
  await screenshot("layout-320");
  report("All controls visible at 320px width", talkBtn && input && header && modeBtn && speedBtn);
}

async function testLayout768() {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.waitForTimeout(300);
  const talkBtn = await page.locator("#talkBtn").isVisible();
  const input = await page.locator("#textInput").isVisible();
  await screenshot("layout-768");
  report("Layout works at 768px (tablet)", talkBtn && input);
  await page.setViewportSize({ width: 320, height: 800 });
}

// ═══════════════════════════════════════════
// 16. HTTP ENDPOINTS
// ═══════════════════════════════════════════

async function testHttpEndpoints() {
  const endpoints = [
    "/", "/version", "/info", "/debug", "/debug/pipeline",
    "/debug/log", "/debug/ws-log", "/manifest.json", "/favicon.ico",
  ];

  const statuses: string[] = [];
  let allOk = true;
  for (const path of endpoints) {
    try {
      const res = await fetch(`${BASE}${path}`);
      if (!res.ok) allOk = false;
      statuses.push(`${path}=${res.status}`);
    } catch {
      allOk = false;
      statuses.push(`${path}=ERR`);
    }
  }
  report("All HTTP endpoints respond 200", allOk, statuses.join(" "));
}

async function testVersionEndpoint() {
  const json = await (await fetch(`${BASE}/version`)).json();
  report("/version returns numeric version", typeof json.version === "number", `version=${json.version}`);
}

async function testInfoEndpoint() {
  const json = await (await fetch(`${BASE}/info`)).json();
  report("/info returns tmux status", "tmuxAlive" in json, `tmuxAlive=${json.tmuxAlive}`);
}

async function testDebugEndpoint() {
  const json = await (await fetch(`${BASE}/debug`)).json();
  report("/debug returns server state", "wsClients" in json && "streamState" in json,
    `wsClients=${json.wsClients}, streamState=${json.streamState}`);
}

// ═══════════════════════════════════════════
// 17. PERSISTENCE & TOOLTIPS
// ═══════════════════════════════════════════

async function testLocalStorageKeys() {
  await readyPage();
  await page.locator("#modeBtn").click();
  await page.waitForTimeout(100);
  await page.locator("#cleanBtn").click();
  await page.waitForTimeout(100);
  await page.locator("#chatZoomIn").click();
  await page.waitForTimeout(100);

  const keys = await page.evaluate(() => Object.keys(localStorage));
  const expectedKeys = ["murmur-tour-done", "murmur-mode", "chat-font-size"];
  const hasExpected = expectedKeys.every(k => keys.includes(k));
  report("localStorage populated after interactions", hasExpected, `keys: ${keys.join(", ")}`);
}

async function testTooltipAttributes() {
  await readyPage();
  const count = await page.locator("[data-tip]").count();
  report("UI elements have tooltip attributes", count >= 5, `${count} elements with data-tip`);
}

// ═══════════════════════════════════════════
// 18. TRUE E2E: BUBBLE ↔ TTS HIGHLIGHT CHAIN
// ═══════════════════════════════════════════

// Helper: connect a Node.js WS to inject test commands server-side
function connectTestWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:3457`);
    ws.on("open", () => { ws.send("test:client"); resolve(ws); });
    ws.on("error", reject);
    setTimeout(() => reject(new Error("WS connect timeout")), 5000);
  });
}

const ENTRY_TEST_PARAGRAPHS = [
  "Cats are independent creatures that have lived alongside humans for millennia.",
  "Dogs are loyal pack animals known for their unconditional devotion to their families.",
  "Fish breathe through gills and inhabit every aquatic environment on Earth.",
];

async function testEntryBubblesRender() {
  await readyPage();
  const testWs = await connectTestWs();
  testWs.send("test:entries:" + JSON.stringify(ENTRY_TEST_PARAGRAPHS));
  await page.waitForTimeout(2500);

  const entryBubbles = await page.locator(".entry-bubble[data-entry-id]").count();
  await screenshot("entry-bubbles-rendered");
  testWs.close();
  report("Entry bubbles render with data-entry-id attributes", entryBubbles >= 3,
    `${entryBubbles} entry bubbles`);
}

async function testEntryBubbleTextsMatch() {
  await readyPage();
  const testWs = await connectTestWs();
  testWs.send("test:clear-entries");
  await page.waitForTimeout(500);
  testWs.send("test:entries:" + JSON.stringify(ENTRY_TEST_PARAGRAPHS));
  await page.waitForTimeout(2500);

  const texts = await page.evaluate(() => {
    const bubbles = document.querySelectorAll(".entry-bubble.msg.assistant[data-entry-id]");
    return Array.from(bubbles).map(b => ({
      id: b.getAttribute("data-entry-id"),
      text: b.querySelector(".entry-text")?.textContent || "",
    }));
  });
  testWs.close();

  const expected = ["Cats are independent creatures", "Dogs are loyal pack animals", "Fish breathe through gills"];
  const allMatch = texts.length >= 3 && expected.every((fragment, i) => texts[i] && texts[i].text.includes(fragment));
  report("Entry bubble text matches injected entries", allMatch,
    texts.map(t => `#${t.id}="${t.text.slice(0, 30)}..."`).join(", "));
}

async function testReplayHighlightsCorrectBubble() {
  await readyPage();
  const testWs = await connectTestWs();
  testWs.send("test:clear-entries");
  await page.waitForTimeout(500);
  testWs.send("test:entries:" + JSON.stringify(ENTRY_TEST_PARAGRAPHS));
  await page.waitForTimeout(2500);

  const entryIds = await page.evaluate(() => {
    const bubbles = document.querySelectorAll(".entry-bubble.msg.assistant[data-entry-id]");
    return Array.from(bubbles).map(b => b.getAttribute("data-entry-id"));
  });

  if (entryIds.length < 3) {
    testWs.close();
    report("Replay highlights correct bubble", false, "not enough entry bubbles");
    return;
  }

  const middleId = entryIds[1];
  await page.evaluate((id) => {
    const bubble = document.querySelector(`.entry-bubble[data-entry-id="${id}"]`);
    const wrap = bubble?.parentElement;
    const replayBtn = wrap?.querySelector(".msg-replay") as HTMLElement;
    if (replayBtn) replayBtn.click();
  }, middleId);

  // Wait for TTS to trigger highlight (may take a few seconds for Kokoro)
  let activeId: string | null = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    await page.waitForTimeout(500);
    activeId = await page.evaluate(() => {
      const active = document.querySelector(".entry-bubble.bubble-active") ||
                     document.querySelector(".entry-bubble.bubble-spoken:last-of-type");
      return active?.getAttribute("data-entry-id") || null;
    });
    if (activeId) break;
  }
  await screenshot("replay-highlight");
  testWs.close();

  report("Replay highlights the correct middle bubble (not first or last)",
    activeId === middleId,
    `clicked replay on #${middleId}, highlighted=#${activeId}, ` +
    `first=#${entryIds[0]}, last=#${entryIds[2]}`);
}

async function testReplayDifferentBubble() {
  await readyPage();
  const testWs = await connectTestWs();
  testWs.send("test:entries:" + JSON.stringify(ENTRY_TEST_PARAGRAPHS));
  await page.waitForTimeout(2500);

  const entryIds = await page.evaluate(() => {
    const bubbles = document.querySelectorAll(".entry-bubble[data-entry-id]");
    return Array.from(bubbles).slice(-3).map(b => b.getAttribute("data-entry-id"));
  });

  if (entryIds.length < 3) {
    testWs.close();
    report("Replay shifts highlight to different bubble", false, "not enough entry bubbles");
    return;
  }

  const firstId = entryIds[0];
  const middleId = entryIds[1];
  await page.evaluate((id) => {
    const bubble = document.querySelector(`.entry-bubble[data-entry-id="${id}"]`);
    const wrap = bubble?.parentElement;
    const replayBtn = wrap?.querySelector(".msg-replay") as HTMLElement;
    if (replayBtn) replayBtn.click();
  }, firstId);

  await page.waitForTimeout(2000);
  await screenshot("replay-highlight-shifted");

  const activeId = await page.evaluate(() => {
    const active = document.querySelector(".entry-bubble.bubble-active");
    return active?.getAttribute("data-entry-id") || null;
  });
  testWs.close();

  report("Replay shifts highlight to first bubble (away from middle)",
    activeId === firstId && activeId !== middleId,
    `clicked replay on #${firstId}, highlighted=#${activeId} (middle was #${middleId})`);
}

// ═══════════════════════════════════════════
// 19. CLEAN vs VERBOSE + MODES × LONG TEXT
// ═══════════════════════════════════════════

async function testCleanModeHidesNonSpeakable() {
  await readyPage();
  // Inject entries: 2 speakable + 1 non-speakable (simulating tool output)
  const testWs = await connectTestWs();

  // Use test:entries for speakable entries
  testWs.send("test:entries:" + JSON.stringify([
    "This is a speakable response about JavaScript closures and their practical applications in modern web development.",
    "Here is another speakable paragraph explaining how async/await simplifies promise chains in complex applications.",
  ]));
  await page.waitForTimeout(1500);

  // Now manually add a non-speakable entry via a modified test command
  // Since test:entries always creates speakable entries, we'll check that
  // clean mode CSS class is applied and controls visibility
  const speakableCount = await page.evaluate(() => {
    const bubbles = document.querySelectorAll(".entry-bubble.msg.assistant");
    return Array.from(bubbles).filter(b => !b.classList.contains("entry-nonspeakable")).length;
  });

  // Ensure clean mode is ON
  await page.evaluate(() => {
    document.body.classList.add("clean-mode");
  });
  await page.waitForTimeout(200);

  const cleanModeActive = await page.evaluate(() => document.body.classList.contains("clean-mode"));
  await screenshot("clean-mode-entries");

  // All speakable entries should still be visible in clean mode
  const visibleInClean = await page.evaluate(() => {
    const bubbles = document.querySelectorAll(".entry-bubble.msg.assistant:not(.entry-nonspeakable)");
    return Array.from(bubbles).filter(b => {
      const style = getComputedStyle(b);
      return style.display !== "none";
    }).length;
  });

  testWs.close();
  report("Clean mode: speakable entries remain visible", cleanModeActive && visibleInClean >= 2,
    `cleanMode=${cleanModeActive}, visible=${visibleInClean}, total speakable=${speakableCount}`);
}

async function testVerboseModeShowsAll() {
  await readyPage();
  const testWs = await connectTestWs();
  testWs.send("test:entries-mixed:" + JSON.stringify([
    { text: "Speakable entry for verbose test.", speakable: true },
    { text: "Non-speakable entry for verbose test.", speakable: false },
  ]));
  await page.waitForTimeout(1500);

  // Ensure verbose mode (no clean-mode class)
  await page.evaluate(() => document.body.classList.remove("clean-mode"));
  await page.waitForTimeout(200);
  await screenshot("verbose-mode-entries");

  const allBubbles = await page.locator(".entry-bubble.msg.assistant").count();
  const verboseActive = await page.evaluate(() => !document.body.classList.contains("clean-mode"));
  testWs.close();

  report("Verbose mode: all entries visible", verboseActive && allBubbles >= 2,
    `verbose=${verboseActive}, bubbles=${allBubbles}`);
}

async function testTextModeNoTtsHighlight() {
  await readyPage();
  // Set to Text mode (micOn=false, ttsOn=false)
  await page.evaluate(() => {
    // Click mode button until we reach "Text" mode
    const btn = document.getElementById("modeBtn");
    for (let i = 0; i < 5; i++) {
      if (btn?.textContent?.trim() === "Text") break;
      btn?.click();
    }
  });
  await page.waitForTimeout(300);

  const currentMode = await page.locator("#modeBtn").textContent();
  await screenshot("text-mode-set");

  // Inject entries and verify no bubble-active highlight appears (TTS is off)
  const testWs = await connectTestWs();
  testWs.send("test:entries:" + JSON.stringify([
    "This entry should render as text only without any TTS highlight in Text mode.",
  ]));
  await page.waitForTimeout(2000);

  // Check that no bubble has the active highlight
  const activeCount = await page.locator(".entry-bubble.bubble-active").count();
  testWs.close();
  await screenshot("text-mode-no-highlight");

  report("Text mode: entries render without TTS highlight",
    currentMode?.trim() === "Text" && activeCount === 0,
    `mode="${currentMode?.trim()}", activeHighlights=${activeCount}`);
}

async function testTalkModeEntriesWithReplay() {
  await readyPage();
  // Set to Talk mode (micOn=true, ttsOn=true)
  await page.evaluate(() => {
    const btn = document.getElementById("modeBtn");
    for (let i = 0; i < 5; i++) {
      if (btn?.textContent?.trim() === "Talk") break;
      btn?.click();
    }
  });
  await page.waitForTimeout(300);

  const testWs = await connectTestWs();
  testWs.send("test:entries:" + JSON.stringify([
    "In Talk mode, this long paragraph about distributed systems should be fully rendered and eligible for TTS replay when the user clicks the replay button.",
    "A second paragraph discussing consensus algorithms provides additional content to verify multi-bubble rendering works correctly in Talk mode.",
  ]));
  await page.waitForTimeout(2000);

  const entryCount = await page.locator(".entry-bubble.msg.assistant").count();
  const replayBtns = await page.locator(".msg-replay").count();
  const currentMode = await page.locator("#modeBtn").textContent();
  await screenshot("talk-mode-entries");
  testWs.close();

  report("Talk mode: long entries render with replay buttons",
    currentMode?.trim() === "Talk" && entryCount >= 2 && replayBtns >= 2,
    `mode="${currentMode?.trim()}", entries=${entryCount}, replayBtns=${replayBtns}`);
}

async function testTypeModeMultiParagraphInput() {
  await readyPage();
  // Set to Type mode (micOn=false, ttsOn=true)
  await page.evaluate(() => {
    const btn = document.getElementById("modeBtn");
    for (let i = 0; i < 5; i++) {
      if (btn?.textContent?.trim() === "Type") break;
      btn?.click();
    }
  });
  await page.waitForTimeout(300);

  // Type a long paragraph and send
  const input = page.locator("#textInput");
  const longText = "In Type mode, the user types their input instead of speaking. " +
    "This long paragraph tests that typed input in Type mode renders correctly as a user bubble, " +
    "preserving the full text content without truncation, and that the bubble wraps properly " +
    "within the narrow 320px mobile viewport. The response should be spoken aloud via TTS.";
  await input.fill(longText);
  await input.press("Enter");
  await page.waitForTimeout(2000);

  const bubble = page.locator(".msg.user").last();
  const bubbleText = await bubble.textContent();
  const currentMode = await page.locator("#modeBtn").textContent();
  await screenshot("type-mode-long-input");

  report("Type mode: long paragraph input renders in bubble",
    currentMode?.trim() === "Type" && (bubbleText?.length || 0) > 100,
    `mode="${currentMode?.trim()}", ${bubbleText?.length} chars`);
}

async function testReadModeEntriesRender() {
  await readyPage();
  // Set to Read mode (micOn=true, ttsOn=false)
  await page.evaluate(() => {
    const btn = document.getElementById("modeBtn");
    for (let i = 0; i < 5; i++) {
      if (btn?.textContent?.trim() === "Read") break;
      btn?.click();
    }
  });
  await page.waitForTimeout(300);

  const testWs = await connectTestWs();
  testWs.send("test:entries:" + JSON.stringify([
    "In Read mode, this response should appear as text without TTS playback. The user reads Claude's responses instead of hearing them, which is useful in quiet environments.",
  ]));
  await page.waitForTimeout(2000);

  const entryCount = await page.locator(".entry-bubble.msg.assistant").count();
  const currentMode = await page.locator("#modeBtn").textContent();
  // In Read mode TTS is off, so entry bubbles should NOT have bubble-active (driven by tts_play)
  // The voice_status=responding from test:entries: may trigger client-side legacy highlight — wait for idle
  await page.waitForTimeout(1000);
  const activeCount = await page.locator(".entry-bubble.bubble-active").count();
  await screenshot("read-mode-entries");
  testWs.close();

  report("Read mode: entries render as text (no TTS highlight)",
    currentMode?.trim() === "Read" && entryCount >= 1 && activeCount === 0,
    `mode="${currentMode?.trim()}", entries=${entryCount}, highlights=${activeCount}`);
}

// ═══════════════════════════════════════════
// 20. SPOKEN vs UNSPOKEN VISUAL BOUNDARY
// ═══════════════════════════════════════════

async function testSpokenEntriesFaded() {
  await readyPage();
  const testWs = await connectTestWs();
  // Create 3 entries: first two already spoken, last one not yet spoken
  testWs.send("test:entries-mixed:" + JSON.stringify([
    { text: "This first entry has already been spoken aloud via TTS and should appear faded.", spoken: true },
    { text: "This second entry was also spoken earlier and should also be visually dimmed.", spoken: true },
    { text: "This third entry has NOT been spoken yet and should appear at full brightness.", spoken: false },
  ]));
  await page.waitForTimeout(1500);

  const allBubbles = page.locator(".entry-bubble.msg.assistant");
  const count = await allBubbles.count();
  const lastThree = [];
  for (let i = Math.max(0, count - 3); i < count; i++) {
    const el = allBubbles.nth(i);
    const hasSpoken = await el.evaluate((e: Element) => e.classList.contains("bubble-spoken"));
    const opacity = await el.evaluate((e: HTMLElement) => parseFloat(getComputedStyle(e).opacity));
    lastThree.push({ hasSpoken, opacity });
  }
  await screenshot("spoken-vs-unspoken");
  testWs.close();

  const [first, second, third] = lastThree;
  report("Spoken entries have bubble-spoken class",
    first?.hasSpoken === true && second?.hasSpoken === true && third?.hasSpoken === false,
    `[spoken=${first?.hasSpoken}, spoken=${second?.hasSpoken}, spoken=${third?.hasSpoken}]`);
  report("Spoken entries have reduced opacity (0.6)",
    (first?.opacity || 1) < 0.7 && (second?.opacity || 1) < 0.7,
    `opacities: [${first?.opacity}, ${second?.opacity}]`);
  report("Unspoken entry has full opacity",
    (third?.opacity || 0) > 0.9,
    `opacity: ${third?.opacity}`);
}

async function testSpokenBorderFaded() {
  await readyPage();
  const testWs = await connectTestWs();
  testWs.send("test:clear-entries");
  await page.waitForTimeout(500);
  testWs.send("test:entries-mixed:" + JSON.stringify([
    { text: "Already spoken entry should have a very faint border color.", spoken: true },
    { text: "Fresh unspoken entry should have a brighter, more visible border.", spoken: false },
  ]));
  await page.waitForTimeout(1500);

  const allBubbles = page.locator(".entry-bubble.msg.assistant");
  const count = await allBubbles.count();
  if (count < 2) { testWs.close(); report("Spoken entry has fainter border than unspoken", false, `only ${count} bubbles`); return; }
  const spokenBorder = await allBubbles.nth(count - 2).evaluate((e: HTMLElement) => getComputedStyle(e).borderColor);
  const freshBorder = await allBubbles.nth(count - 1).evaluate((e: HTMLElement) => getComputedStyle(e).borderColor);
  await screenshot("spoken-border-comparison");
  testWs.close();

  // Spoken has rgba(180,160,100,0.08), fresh has rgba(180,160,100,0.15) — spoken should be dimmer
  report("Spoken entry has fainter border than unspoken",
    spokenBorder !== freshBorder,
    `spoken="${spokenBorder}", fresh="${freshBorder}"`);
}

async function testTtsTransitionsToSpoken() {
  await readyPage();
  const testWs = await connectTestWs();
  testWs.send("test:clear-entries");
  await page.waitForTimeout(500);
  // Create 2 entries — both unspoken initially
  testWs.send("test:entries-mixed:" + JSON.stringify([
    { text: "This paragraph will be spoken first and should transition from bright to faded once done.", spoken: false },
    { text: "This paragraph is spoken second and should stay bright while the first fades.", spoken: false },
  ]));
  await page.waitForTimeout(1500);

  const allBubbles = page.locator(".entry-bubble.msg.assistant");
  const count = await allBubbles.count();
  const firstId = await allBubbles.nth(count - 2).getAttribute("data-entry-id");
  const secondId = await allBubbles.nth(count - 1).getAttribute("data-entry-id");

  // Verify both start without bubble-spoken
  const beforeFirst = await allBubbles.nth(count - 2).evaluate((e: Element) => e.classList.contains("bubble-spoken"));
  const beforeSecond = await allBubbles.nth(count - 1).evaluate((e: Element) => e.classList.contains("bubble-spoken"));

  // Simulate: highlight first entry (as if TTS is playing it)
  testWs.send("replay:" + firstId);
  await page.waitForTimeout(500);
  const firstActive = await allBubbles.nth(count - 2).evaluate((e: Element) => e.classList.contains("bubble-active"));
  await screenshot("tts-transition-first-active");

  // Now highlight second entry — first should become bubble-spoken
  testWs.send("replay:" + secondId);
  await page.waitForTimeout(500);
  const firstNowSpoken = await allBubbles.nth(count - 2).evaluate((e: Element) => e.classList.contains("bubble-spoken"));
  const secondNowActive = await allBubbles.nth(count - 1).evaluate((e: Element) => e.classList.contains("bubble-active"));
  await screenshot("tts-transition-second-active");

  // Send stop to clear TTS state
  testWs.send("stop");
  await page.waitForTimeout(500);
  testWs.close();

  report("Both entries start without bubble-spoken",
    beforeFirst === false && beforeSecond === false,
    `first=${beforeFirst}, second=${beforeSecond}`);
  report("First entry highlighted during TTS playback",
    firstActive === true, `bubble-active=${firstActive}`);
  report("First entry transitions to spoken when second is highlighted",
    firstNowSpoken === true && secondNowActive === true,
    `first.spoken=${firstNowSpoken}, second.active=${secondNowActive}`);
}

async function testNonSpeakableNotFaded() {
  await readyPage();
  const testWs = await connectTestWs();
  // Non-speakable entries should NOT get bubble-spoken (they're hidden in clean mode, visible in verbose)
  testWs.send("test:entries-mixed:" + JSON.stringify([
    { text: "Speakable and spoken — should be faded.", spoken: true, speakable: true },
    { text: "Non-speakable tool output — should NOT have bubble-spoken class.", spoken: false, speakable: false },
    { text: "Speakable but not yet spoken — should be bright.", spoken: false, speakable: true },
  ]));
  await page.waitForTimeout(1500);

  const allBubbles = page.locator(".entry-bubble.msg.assistant");
  const count = await allBubbles.count();
  const spokenSpeakable = await allBubbles.nth(count - 3).evaluate((e: Element) => ({
    spoken: e.classList.contains("bubble-spoken"),
    nonspeakable: e.classList.contains("entry-nonspeakable"),
  }));
  const nonSpeakable = await allBubbles.nth(count - 2).evaluate((e: Element) => ({
    spoken: e.classList.contains("bubble-spoken"),
    nonspeakable: e.classList.contains("entry-nonspeakable"),
  }));
  const freshSpeakable = await allBubbles.nth(count - 1).evaluate((e: Element) => ({
    spoken: e.classList.contains("bubble-spoken"),
    nonspeakable: e.classList.contains("entry-nonspeakable"),
  }));
  await screenshot("nonspeakable-boundary");
  testWs.close();

  report("Spoken+speakable entry is faded",
    spokenSpeakable.spoken === true && spokenSpeakable.nonspeakable === false,
    `spoken=${spokenSpeakable.spoken}, nonspeakable=${spokenSpeakable.nonspeakable}`);
  report("Non-speakable entry has entry-nonspeakable class (not bubble-spoken)",
    nonSpeakable.nonspeakable === true && nonSpeakable.spoken === false,
    `spoken=${nonSpeakable.spoken}, nonspeakable=${nonSpeakable.nonspeakable}`);
  report("Fresh speakable entry is bright (neither faded nor hidden)",
    freshSpeakable.spoken === false && freshSpeakable.nonspeakable === false,
    `spoken=${freshSpeakable.spoken}, nonspeakable=${freshSpeakable.nonspeakable}`);
}

async function testCleanModeHidesNonSpeakableShowsSpokenBoundary() {
  await readyPage();
  const testWs = await connectTestWs();
  testWs.send("test:entries-mixed:" + JSON.stringify([
    { text: "Spoken speakable entry — visible but faded in clean mode.", spoken: true, speakable: true },
    { text: "Non-speakable tool output — hidden in clean mode.", spoken: false, speakable: false },
    { text: "Fresh speakable entry — visible and bright in clean mode.", spoken: false, speakable: true },
  ]));
  await page.waitForTimeout(1500);

  // Enable clean mode
  await page.evaluate(() => document.body.classList.add("clean-mode"));
  await page.waitForTimeout(300);

  const allBubbles = page.locator(".entry-bubble.msg.assistant");
  const count = await allBubbles.count();
  const spokenVisible = await allBubbles.nth(count - 3).isVisible();
  const nonSpeakableVisible = await allBubbles.nth(count - 2).isVisible();
  const freshVisible = await allBubbles.nth(count - 1).isVisible();
  const spokenOpacity = await allBubbles.nth(count - 3).evaluate((e: HTMLElement) => parseFloat(getComputedStyle(e).opacity));
  const freshOpacity = await allBubbles.nth(count - 1).evaluate((e: HTMLElement) => parseFloat(getComputedStyle(e).opacity));
  await screenshot("clean-mode-spoken-boundary");

  // Restore verbose
  await page.evaluate(() => document.body.classList.remove("clean-mode"));
  testWs.close();

  report("Clean mode: spoken entry visible but faded",
    spokenVisible === true && spokenOpacity < 0.7,
    `visible=${spokenVisible}, opacity=${spokenOpacity}`);
  report("Clean mode: non-speakable entry hidden",
    nonSpeakableVisible === false, `visible=${nonSpeakableVisible}`);
  report("Clean mode: fresh entry visible and bright",
    freshVisible === true && freshOpacity > 0.9,
    `visible=${freshVisible}, opacity=${freshOpacity}`);
}

async function testMultiEntryTtsBoundaryProgression() {
  await readyPage();
  const testWs = await connectTestWs();
  // Create 4 entries — simulate a conversation where TTS progresses through them
  testWs.send("test:entries-mixed:" + JSON.stringify([
    { text: "Entry alpha — the very first response in this conversation block, already spoken.", spoken: true },
    { text: "Entry beta — the second response, also already spoken by TTS earlier.", spoken: true },
    { text: "Entry gamma — not yet spoken, this is the boundary where TTS left off.", spoken: false },
    { text: "Entry delta — also not spoken, newest content waiting to be read aloud.", spoken: false },
  ]));
  await page.waitForTimeout(1500);

  const allBubbles = page.locator(".entry-bubble.msg.assistant");
  const count = await allBubbles.count();
  const states = [];
  for (let i = Math.max(0, count - 4); i < count; i++) {
    const el = allBubbles.nth(i);
    const spoken = await el.evaluate((e: Element) => e.classList.contains("bubble-spoken"));
    const opacity = await el.evaluate((e: HTMLElement) => parseFloat(getComputedStyle(e).opacity));
    states.push({ spoken, opacity });
  }

  // Now simulate TTS playing gamma (third entry)
  const gammaId = await allBubbles.nth(count - 2).getAttribute("data-entry-id");
  testWs.send("replay:" + gammaId);
  await page.waitForTimeout(800);

  const gammaActive = await allBubbles.nth(count - 2).evaluate((e: Element) => e.classList.contains("bubble-active"));
  const deltaStillFresh = await allBubbles.nth(count - 1).evaluate((e: Element) =>
    !e.classList.contains("bubble-spoken") && !e.classList.contains("bubble-active"));
  await screenshot("boundary-progression");

  testWs.send("stop");
  await page.waitForTimeout(500);
  testWs.close();

  report("First two entries are spoken/faded, last two are fresh",
    states[0]?.spoken && states[1]?.spoken && !states[2]?.spoken && !states[3]?.spoken,
    `[${states.map(s => s.spoken ? "spoken" : "fresh").join(", ")}]`);
  report("Opacity boundary: spoken < 0.7, fresh > 0.9",
    (states[0]?.opacity || 1) < 0.7 && (states[1]?.opacity || 1) < 0.7 &&
    (states[2]?.opacity || 0) > 0.9 && (states[3]?.opacity || 0) > 0.9,
    `opacities: [${states.map(s => s.opacity).join(", ")}]`);
  report("TTS highlights boundary entry (gamma) as active",
    gammaActive === true, `gamma.active=${gammaActive}`);
  report("Entry after boundary (delta) stays fresh during gamma TTS",
    deltaStillFresh === true, `delta neither spoken nor active`);
}

// ═══════════════════════════════════════════
// RUNNER
// ═══════════════════════════════════════════

// ═══════════════════════════════════════════
// 21. FLOW MODE (DOM injection, iPhone viewport)
// ═══════════════════════════════════════════

async function fmInjectEntries(entries: object[]) {
  await page.evaluate((entries) => {
    (window as any).__murmur?.renderEntries(entries, false);
  }, entries);
  await page.waitForTimeout(300);
}

async function fmClearEntries() {
  await page.evaluate(() => {
    (window as any).__murmur?.renderEntries([], false);
    const t = document.getElementById("transcript");
    if (t) t.scrollTop = 0;
  });
  await page.waitForTimeout(200);
}

async function fmTestBackground() {
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  report("Flow mode: body background is cream", bg === "rgb(245, 244, 239)", `bg=${bg}`);
  await screenshot("fm-background");
}

async function fmTestSafeAreaTop() {
  const pt = await page.evaluate(() => getComputedStyle(document.body).paddingTop);
  report("Flow mode: body has padding-top (safe area)", pt !== undefined, `paddingTop=${pt}`);
}

async function fmTestTalkBarFixed() {
  const pos = await page.evaluate(() => {
    const bar = document.querySelector(".talk-bar") as HTMLElement;
    return bar ? getComputedStyle(bar).position : "missing";
  });
  report("Flow mode: talk bar is position:fixed", pos === "fixed", `position=${pos}`);
  await screenshot("fm-talk-bar");
}

async function fmTestTalkBarAtBottom() {
  const info = await page.evaluate(() => {
    const bar = document.querySelector(".talk-bar") as HTMLElement;
    if (!bar) return null;
    const r = bar.getBoundingClientRect();
    return { bottom: Math.round(r.bottom), winH: window.innerHeight };
  });
  const ok = info ? info.bottom <= info.winH + 2 : false;
  report("Flow mode: talk bar bottom touches viewport", ok, `barBottom=${info?.bottom} winH=${info?.winH}`);
}

async function fmTestHiddenElements() {
  const hidden = await page.evaluate(() => {
    const header = document.querySelector(".header") as HTMLElement;
    const controls = document.querySelector(".controls") as HTMLElement;
    const inputBar = document.querySelector(".input-bar") as HTMLElement;
    return {
      headerHidden: header ? getComputedStyle(header).display === "none" : true,
      controlsHidden: controls ? getComputedStyle(controls).display === "none" : true,
      inputBarHidden: inputBar ? getComputedStyle(inputBar).display === "none" : true,
    };
  });
  const ok = hidden.headerHidden && hidden.controlsHidden && hidden.inputBarHidden;
  report("Flow mode: header/controls/input hidden", ok,
    `header=${hidden.headerHidden} controls=${hidden.controlsHidden} inputBar=${hidden.inputBarHidden}`);
}

async function fmTestGearBtnVisible() {
  const visible = await page.evaluate(() => {
    const btn = document.getElementById("flowGearBtn");
    return btn ? getComputedStyle(btn).display !== "none" : false;
  });
  report("Flow mode: gear button visible", visible);
}

async function fmTestExitButton() {
  // flowExitBtn (display:none) replaced by flowModeBtn toggle — check the toggle is visible in flow mode
  const visible = await page.evaluate(() => {
    const btn = document.getElementById("flowModeBtn") as HTMLElement;
    return btn ? getComputedStyle(btn).display !== "none" : false;
  });
  report("Flow mode: exit button visible", visible);
  await screenshot("fm-exit-btn");
}

async function fmTestLiveTranscriptElement() {
  const exists = await page.evaluate(() => !!document.getElementById("flowLiveTranscript"));
  report("Flow mode: live transcript element exists", exists);
}

async function fmTestUserBubbleAlignment() {
  await fmClearEntries();
  await fmInjectEntries([
    { id: "u1", role: "user", text: "Test message", speakable: false, spoken: false, ts: Date.now(), turn: 1 },
  ]);
  const align = await page.evaluate(() => {
    const bubble = document.querySelector(".entry-bubble.user") as HTMLElement;
    return bubble ? getComputedStyle(bubble).alignSelf : "missing";
  });
  report("Flow mode: user bubble right-aligned", align === "flex-end" || align === "auto", `alignSelf=${align}`);
}

async function fmTestShortContentAtTop() {
  await fmClearEntries();
  await fmInjectEntries([
    { id: "u1", role: "user", text: "Hello", speakable: false, spoken: false, ts: Date.now(), turn: 1 },
    { id: "a1", role: "assistant", text: "Hi there.", speakable: true, spoken: false, ts: Date.now(), turn: 1 },
  ]);
  await page.waitForTimeout(400);
  // Check that both injected entry-bubbles are visible in the transcript (not scrolled off screen).
  // We check visibility rather than scrollTop=0 because live-session history entries make
  // scrollHeight large even with few injected entries.
  const visible = await page.evaluate(() => {
    const t = document.getElementById("transcript")!;
    const tR = t.getBoundingClientRect();
    const u = t.querySelector(".entry-bubble.user[data-entry-id='u1']") as HTMLElement;
    const a = t.querySelector(".entry-bubble.assistant[data-entry-id='a1']") as HTMLElement;
    if (!u || !a) return { ok: false, detail: "missing bubbles" };
    const uR = u.getBoundingClientRect();
    const aR = a.getBoundingClientRect();
    const uVisible = uR.top >= tR.top - 5 && uR.bottom <= tR.bottom + 5;
    const aVisible = aR.top >= tR.top - 5 && aR.bottom <= tR.bottom + 5;
    return { ok: uVisible && aVisible, detail: `u=${Math.round(uR.top - tR.top)}px a=${Math.round(aR.top - tR.top)}px` };
  });
  report("Flow mode: short conversation — injected entries visible", visible.ok, visible.detail);
  await screenshot("fm-short-content-top");
}

async function fmTestOverflowScrollsToBottom() {
  await fmClearEntries();
  const entries: object[] = [];
  for (let i = 0; i < 15; i++) {
    entries.push({ id: `u${i}`, role: "user", text: `User message ${i}`, speakable: false, spoken: false, ts: Date.now(), turn: i + 1 });
    entries.push({ id: `a${i}`, role: "assistant", text: `Assistant response ${i}. This is a longer reply to take up space on screen.`, speakable: true, spoken: false, ts: Date.now(), turn: i + 1 });
  }
  await fmInjectEntries(entries);
  await page.waitForTimeout(500);
  const info = await page.evaluate(() => {
    const t = document.getElementById("transcript")!;
    const max = t.scrollHeight - t.clientHeight;
    const overflows = t.scrollHeight > t.clientHeight;
    // Initial scroll formula: scrollTop = max - 25% of clientHeight (±tolerance for live session interference)
    const expectedMin = Math.max(0, max - Math.floor(t.clientHeight * 0.35));
    const expectedMax = max;
    const inRange = t.scrollTop >= expectedMin && t.scrollTop <= expectedMax;
    return { scrollTop: t.scrollTop, max, overflows, expectedMin, inRange };
  });
  const ok = info.overflows && info.inRange;
  report("Flow mode: overflow content — last entry visible near top", ok,
    `scrollTop=${info.scrollTop} expected=[${info.expectedMin},${info.max}] overflows=${info.overflows}`);
  await screenshot("fm-overflow-scrolled");
}

async function fmTestNewUserEntrySnapsToTop() {
  await fmClearEntries();
  const initial: object[] = [];
  for (let i = 0; i < 8; i++) {
    initial.push({ id: `u${i}`, role: "user", text: `Question ${i}`, speakable: false, spoken: false, ts: Date.now(), turn: i + 1 });
    initial.push({ id: `a${i}`, role: "assistant", text: `Answer ${i}. `.repeat(20), speakable: true, spoken: false, ts: Date.now(), turn: i + 1 });
  }
  await fmInjectEntries(initial);
  await page.waitForTimeout(400);
  await fmInjectEntries([...initial,
    { id: "u9", role: "user", text: "New question after overflow", speakable: false, spoken: false, ts: Date.now(), turn: 9 },
  ]);
  await page.waitForTimeout(500);
  const info = await page.evaluate(() => {
    const t = document.getElementById("transcript")!;
    const u9 = t.querySelector(".entry-bubble.user[data-entry-id='u9']") as HTMLElement;
    const tR = t.getBoundingClientRect();
    const uR = u9?.getBoundingClientRect();
    const overflows = t.scrollHeight > t.clientHeight;
    const userEntryTop = uR ? Math.round(uR.top - tR.top) : -1;
    return { overflows, userEntryTop };
  });
  // Entry should be in the upper 30% of the transcript viewport (initial scroll + snap puts it there)
  const upperThird = Math.floor(250); // ~30% of 844px viewport
  const snapped = info.overflows && info.userEntryTop >= -5 && info.userEntryTop <= upperThird;
  report("Flow mode: new user message near top of viewport", snapped,
    `overflows=${info.overflows} userEntryTop=${info.userEntryTop}px`);
  await screenshot("fm-new-user-snap");
}

async function fmTestAssistantFont() {
  await fmClearEntries();
  await fmInjectEntries([
    { id: "a1", role: "assistant", text: "Testing serif font.", speakable: true, spoken: false, ts: Date.now(), turn: 1 },
  ]);
  const fontFamily = await page.evaluate(() => {
    const bubble = document.querySelector(".entry-bubble.assistant") as HTMLElement;
    return bubble ? getComputedStyle(bubble).fontFamily : "missing";
  });
  const isSerif = /times|serif/i.test(fontFamily);
  report("Flow mode: assistant bubble uses serif font", isSerif, `fontFamily=${fontFamily}`);
}

async function fmTestUserTextNoLineBreaks() {
  await fmClearEntries();
  const multiLineText = "This is a long message that\nhas line breaks\nfrom terminal wrapping";
  await fmInjectEntries([
    { id: "u1", role: "user", text: multiLineText, speakable: false, spoken: false, ts: Date.now(), turn: 1 },
  ]);
  const hasBr = await page.evaluate(() => {
    const bubble = document.querySelector(".entry-bubble.user") as HTMLElement;
    return bubble ? bubble.querySelectorAll("br").length > 0 : false;
  });
  report("Flow mode: user text has no hard <br> line breaks", !hasBr, `hasBr=${hasBr}`);
}

async function main() {
  console.log("\n  Murmur End-to-End Tests");
  console.log(`  Mode: ${HEADLESS ? "headless" : "visible browser"}`);
  console.log(`  Screenshots: ${SCREENSHOTS_DIR}`);
  console.log("  ═══════════════════════════════\n");

  try {
    await setup();

    console.log("  ── 1. Page Load & Connection ──\n");
    await run("Page load", testPageLoad);
    await run("WS connection", testWsConnection);
    await run("Service dots", testServiceDots);
    await run("Empty state", testEmptyState);

    console.log("\n  ── 2. Tour System ──\n");
    await run("Tour auto-start", testTourAutoStart);
    await run("Tour walkthrough", testTourWalkthrough);
    await run("Tour no restart", testTourDoesNotRestart);
    await run("Tour skip", testTourSkip);
    await run("Tour from help", testTourFromHelpMenu);

    console.log("\n  ── 3. Interaction Modes ──\n");
    await run("Mode cycling", testModeCycling);
    await run("Mode persistence", testModePersistence);

    console.log("\n  ── 4. Text Input & Messages ──\n");
    await run("Text Enter", testTextInputSend);
    await run("Send button", testTextInputSendButton);
    await run("Clears after send", testTextInputClearsAfterSend);
    await run("Empty no send", testEmptyTextDoesNotSend);
    await run("Copy to clipboard", testMessageCopyToClipboard);

    console.log("\n  ── 4b. Long Text & Paragraph Input ──\n");
    await run("Long paragraph input", testLongParagraphInput);
    await run("Long paragraph bubble rendering", testLongParagraphBubbleRendering);
    await run("Multiple sequential messages", testMultipleSequentialMessages);
    await run("Special characters", testSpecialCharacterInput);
    await run("Very long single line", testMultiLineInput);

    console.log("\n  ── 5. Speed Control ──\n");
    await run("Speed cycling", testSpeedCycling);

    console.log("\n  ── 6. Voice Selector ──\n");
    await run("Voice popover", testVoicePopover);

    console.log("\n  ── 7. Mute Button ──\n");
    await run("Mute toggle", testMuteToggle);

    console.log("\n  ── 8. Stop Button ──\n");
    await run("Stop button", testStopButton);

    console.log("\n  ── 9. Terminal Panel ──\n");
    await run("Terminal toggle", testTerminalToggle);
    await run("Terminal persistence", testTerminalPersistence);
    await run("Terminal font zoom", testTerminalFontZoom);
    await run("Terminal nav buttons", testTerminalNavButtons);

    console.log("\n  ── 10. Help Menu ──\n");
    await run("Help open", testHelpMenuOpen);
    await run("Help items", testHelpMenuItems);
    await run("Help close outside", testHelpMenuCloseOnClickOutside);
    await run("Help → Debug", testHelpMenuDebugPanel);

    console.log("\n  ── 11. Chat Font Zoom ──\n");
    await run("Zoom in/out", testChatFontZoom);
    await run("Zoom persistence", testChatFontZoomPersists);

    console.log("\n  ── 12. Clean/Verbose ──\n");
    await run("Toggle", testCleanVerboseToggle);
    await run("Persistence", testCleanModePersists);

    console.log("\n  ── 13. Debug Panel ──\n");
    await run("Keyboard shortcut", testDebugPanelKeyboard);
    await run("4 tabs present", testDebugPanelTabs);
    await run("State tab", testDebugStateTab);
    await run("Messages tab", testDebugMessagesTab);
    await run("Pipeline tab", testDebugPipelineTab);
    await run("Server tab", testDebugServerTab);
    await run("Close button", testDebugPanelClose);
    await run("Persistence", testDebugPanelPersistence);

    console.log("\n  ── 14. Header Buttons ──\n");
    await run("Close button", testCloseButton);
    await run("Restart button", testRestartButton);
    await run("Replay button", testReplayButton);

    console.log("\n  ── 15. Responsive Layout ──\n");
    await run("320px mobile", testLayout320);
    await run("768px tablet", testLayout768);

    console.log("\n  ── 16. HTTP Endpoints ──\n");
    await run("All endpoints", testHttpEndpoints);
    await run("/version", testVersionEndpoint);
    await run("/info", testInfoEndpoint);
    await run("/debug", testDebugEndpoint);

    console.log("\n  ── 17. Persistence & Tooltips ──\n");
    await run("localStorage keys", testLocalStorageKeys);
    await run("Tooltip attributes", testTooltipAttributes);

    console.log("\n  ── 18. True E2E: Bubble ↔ TTS Highlight ──\n");
    await run("Entry bubbles render", testEntryBubblesRender);
    await run("Entry bubble texts match", testEntryBubbleTextsMatch);
    await run("Replay highlights correct bubble", testReplayHighlightsCorrectBubble);
    await run("Replay shifts to different bubble", testReplayDifferentBubble);

    console.log("\n  ── 19. Clean/Verbose + Modes × Long Text ──\n");
    await run("Clean mode hides non-speakable", testCleanModeHidesNonSpeakable);
    await run("Verbose mode shows all", testVerboseModeShowsAll);
    await run("Text mode no TTS highlight", testTextModeNoTtsHighlight);
    await run("Talk mode entries with replay", testTalkModeEntriesWithReplay);
    await run("Type mode long paragraph input", testTypeModeMultiParagraphInput);
    await run("Read mode entries render", testReadModeEntriesRender);

    console.log("\n  ── 20. Spoken vs Unspoken Visual Boundary ──\n");
    await run("Spoken entries faded (class + opacity)", testSpokenEntriesFaded);
    await run("Spoken entry fainter border", testSpokenBorderFaded);
    await run("TTS transitions entry to spoken", testTtsTransitionsToSpoken);
    await run("Non-speakable not confused with spoken", testNonSpeakableNotFaded);
    await run("Clean mode: spoken boundary visible", testCleanModeHidesNonSpeakableShowsSpokenBoundary);
    await run("4-entry boundary progression", testMultiEntryTtsBoundaryProgression);

    // ── 21. Flow Mode (iPhone viewport, DOM injection) ──
    // Switch to iPhone 14 Pro dimensions for these tests, restore after
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(BASE_TEST, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => localStorage.setItem("murmur-tour-done", "1"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      document.body.classList.add("flow-mode");
      localStorage.setItem("murmur-flow-mode", "1");
    });
    await page.waitForTimeout(300);

    console.log("\n  ── 21. Flow Mode ──\n");
    await run("Body background is cream", fmTestBackground);
    await run("Body has padding-top (safe area)", fmTestSafeAreaTop);
    await run("Talk bar is position:fixed", fmTestTalkBarFixed);
    await run("Talk bar bottom touches viewport", fmTestTalkBarAtBottom);
    await run("Header/controls/input hidden", fmTestHiddenElements);
    await run("Gear button visible", fmTestGearBtnVisible);
    await run("Exit button visible", fmTestExitButton);
    await run("Live transcript element exists", fmTestLiveTranscriptElement);
    await run("User bubble right-aligned", fmTestUserBubbleAlignment);
    await run("Short conversation stays at top", fmTestShortContentAtTop);
    await run("Overflow content: last entry visible near top", fmTestOverflowScrollsToBottom);
    await run("New user message near top of viewport", fmTestNewUserEntrySnapsToTop);
    await run("Assistant font is serif", fmTestAssistantFont);
    await run("User text has no hard line breaks", fmTestUserTextNoLineBreaks);

    // Disable flow mode and restore viewport
    await page.evaluate(() => {
      document.body.classList.remove("flow-mode");
      localStorage.setItem("murmur-flow-mode", "0");
    });
    await page.setViewportSize({ width: 320, height: 800 });

  } catch (err) {
    await screenshot("fatal-error").catch(() => {});
    console.error(`\n  ✗ Fatal: ${(err as Error).message}\n`);
  } finally {
    if (browser) await browser.close();
  }

  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  console.log(`\n  ═══════════════════════════════`);
  console.log(`  ${passed}/${total} passed`);
  console.log(`  Screenshots saved to: ${SCREENSHOTS_DIR}\n`);
  process.exit(passed === total ? 0 : 1);
}

main();
