/**
 * UI smoke tests — Playwright tests for core UI interactions.
 * Runs with VISIBLE browser so you can watch the tests execute.
 * Does NOT require voice services (Whisper/Kokoro) — tests UI elements only.
 * Requires: server running on localhost:3457
 *
 * Run:        npx tsx tests/test-smoke.ts
 * Headless:   HEADLESS=1 npx tsx tests/test-smoke.ts
 */

import { chromium, Browser, Page } from "playwright";
import { mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const BASE = "http://localhost:3457";
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = join(__dirname, "screenshots");
const HEADLESS = process.env.HEADLESS === "1";
const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

interface TestResult { name: string; ok: boolean; detail?: string }
const results: TestResult[] = [];
let browser: Browser;
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

async function setup() {
  browser = await chromium.launch({
    headless: HEADLESS,
    slowMo: HEADLESS ? 0 : 100, // slow down so you can watch in headed mode
  });
  const ctx = await browser.newContext({
    permissions: ["microphone"],
    viewport: { width: 320, height: 800 },
  });
  page = await ctx.newPage();
}

// ═══════════════════════════════════════
// Tests
// ═══════════════════════════════════════

async function testPageLoad() {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  const dot = await page.locator("#statusDot").isVisible();
  const text = await page.locator("#statusText").textContent();
  await screenshot("page-load");
  report("Page load + status dot visible", dot, `status="${text}"`);
}

async function testWsConnection() {
  // Check that WebSocket connects (dot should not be red/disconnected)
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  const statusText = await page.locator("#statusText").textContent();
  const dotClass = await page.locator("#statusDot").getAttribute("class");
  // Accept green (ready) or yellow (thinking/active) — just not red/disconnected
  const isConnected = dotClass?.includes("green") || dotClass?.includes("yellow") || false;
  await screenshot("ws-connection");
  report("WebSocket connects (not disconnected)", isConnected, `status="${statusText}", class="${dotClass}"`);
}

async function testTextInput() {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  const input = page.locator("#textInput");
  await input.fill("Hello smoke test");
  await screenshot("text-input-filled");
  await input.press("Enter");
  await page.waitForTimeout(2000);
  await screenshot("text-input-sent");
  // Check if bubble appeared (requires WS echo from server)
  const bubbleCount = await page.locator(".msg.user").count();
  report("Text input creates user bubble", bubbleCount > 0,
    bubbleCount > 0 ? `${bubbleCount} user bubble(s)` : "no bubble — server may not have active Claude session");
}

async function testTourAutoStart() {
  await page.evaluate(() => localStorage.removeItem("murmur-tour-done"));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  const overlay = await page.locator(".tour-overlay").isVisible();
  await screenshot("tour-auto-start");
  report("Tour auto-starts on first visit", overlay);
}

async function testTourWalkthrough() {
  // Tour should be open from previous test
  let stepCount = 0;
  const stepTitles: string[] = [];
  const maxSteps = 15;

  while (stepCount < maxSteps) {
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
  await screenshot("tour-completed");

  report("Tour has 11 steps", stepCount === 11, `${stepCount} steps: ${stepTitles.join(" → ")}`);
  report("Tour completion sets localStorage + closes", overlayGone && done === "1");
}

async function testTourDoesNotRestart() {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  const overlay = await page.locator(".tour-overlay").isVisible();
  report("Tour does not restart after completion", !overlay);
}

async function testModeCycling() {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
  const modeBtn = page.locator("#modeBtn");
  const labels: string[] = [];
  for (let i = 0; i < 5; i++) {
    const text = await modeBtn.textContent();
    labels.push(text?.trim() || "?");
    await screenshot(`mode-${labels[labels.length - 1].toLowerCase()}`);
    await modeBtn.click();
    await page.waitForTimeout(200);
  }
  const unique = new Set(labels.slice(0, 4));
  // 5th label should match 1st (full cycle)
  const cycled = labels[0] === labels[4];
  report("Mode cycles through 4 modes and wraps", unique.size === 4 && cycled, labels.join(" → "));
}

async function testTerminalToggle() {
  await page.evaluate(() => localStorage.removeItem("term-open"));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
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

  report("Terminal panel toggles open/closed", openAfterClick && closedAfterClick);
}

async function testTerminalPersistence() {
  // Open terminal, reload, check it's still open
  await page.evaluate(() => localStorage.removeItem("term-open"));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);
  await page.locator("#terminalHeader").click();
  await page.waitForTimeout(200);

  // Reload
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);
  const stillOpen = await page.locator(".terminal-panel").evaluate((el: Element) => el.classList.contains("open"));
  report("Terminal state persists across reload", stillOpen);
}

async function testHelpMenu() {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
  await page.locator("#helpBtn").click();
  await page.waitForTimeout(200);
  const open = await page.locator(".help-menu.open").isVisible();
  await screenshot("help-menu-open");

  // Check menu items
  const items = await page.locator("#helpMenu").locator("button, a").allTextContents();
  const hasTour = items.some(t => t.includes("Tour"));
  const hasDebug = items.some(t => t.includes("Debug"));
  const hasGithub = items.some(t => t.toLowerCase().includes("github"));
  const hasHomepage = items.some(t => t.toLowerCase().includes("homepage") || t.toLowerCase().includes("murmur"));

  // Click outside to close
  await page.locator("#transcript").click({ position: { x: 10, y: 100 } });
  await page.waitForTimeout(200);
  const closed = !(await page.locator(".help-menu.open").isVisible());
  await screenshot("help-menu-closed");

  report("Help menu opens and closes", open && closed);
  report("Help menu has all items", hasTour && hasDebug && hasGithub && hasHomepage,
    `items: ${items.join(", ")}`);
}

async function testFontZoom() {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);

  const getSize = () => page.evaluate(() =>
    getComputedStyle(document.getElementById("transcript")!).getPropertyValue("--chat-font-size")
  );
  const before = parseFloat(await getSize());

  // Zoom in 3 times
  for (let i = 0; i < 3; i++) {
    await page.locator("#chatZoomIn").click();
    await page.waitForTimeout(100);
  }
  const afterZoomIn = parseFloat(await getSize());
  await screenshot("font-zoomed-in");

  // Zoom out 3 times
  for (let i = 0; i < 3; i++) {
    await page.locator("#chatZoomOut").click();
    await page.waitForTimeout(100);
  }
  const afterZoomOut = parseFloat(await getSize());
  await screenshot("font-zoomed-out");

  report("Font zoom in increases size", afterZoomIn > before, `${before} → ${afterZoomIn}`);
  report("Font zoom out decreases size", afterZoomOut < afterZoomIn, `${afterZoomIn} → ${afterZoomOut}`);
}

async function testDebugPanel() {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);

  // Open via keyboard shortcut
  await page.keyboard.press("Control+Shift+KeyD");
  await page.waitForTimeout(300);
  const panelVisible = await page.locator("#debugPanel").evaluate(
    (el: HTMLElement) => el.style.display !== "none" && el.offsetHeight > 0
  );
  await screenshot("debug-panel-open");

  // Check all 4 tabs exist
  const tabs = await page.locator(".dbg-tabs button[data-tab]").allTextContents();
  const expectedTabs = ["State", "Messages", "Pipeline", "Server"];
  const allTabsPresent = expectedTabs.every(t => tabs.some(tab => tab.includes(t)));

  // Click through each tab
  for (const tab of expectedTabs) {
    const btn = page.locator(`.dbg-tabs button[data-tab]`).filter({ hasText: tab });
    await btn.click();
    await page.waitForTimeout(300);
    await screenshot(`debug-tab-${tab.toLowerCase()}`);
  }

  // Check State tab has content
  await page.locator('.dbg-tabs button[data-tab="state"]').click();
  await page.waitForTimeout(300);
  const stateContent = await page.locator("#dbgContent").textContent();
  const hasWsInfo = stateContent?.includes("WS") || stateContent?.includes("ws") || false;

  // Close it
  await page.locator(".dbg-close").click();
  await page.waitForTimeout(200);
  await screenshot("debug-panel-closed");

  report("Debug panel opens with Ctrl+Shift+D", panelVisible);
  report("Debug panel has all 4 tabs", allTabsPresent, tabs.join(", "));
  report("Debug State tab shows WS info", hasWsInfo);
}

async function testServiceDots() {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);

  const whisperVisible = await page.locator("#svcWhisper").isVisible();
  const kokoroVisible = await page.locator("#svcKokoro").isVisible();
  const audioVisible = await page.locator("#svcAudio").isVisible();
  const whisperClass = await page.locator("#svcWhisper").getAttribute("class");
  const kokoroClass = await page.locator("#svcKokoro").getAttribute("class");
  const audioClass = await page.locator("#svcAudio").getAttribute("class");
  await screenshot("service-dots");

  report("Service indicator dots visible", whisperVisible && kokoroVisible && audioVisible,
    `whisper=${whisperClass}, kokoro=${kokoroClass}, audio=${audioClass}`);
}

async function testCleanVerboseToggle() {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);

  const cleanBtn = page.locator("#cleanBtn");
  const initialText = await cleanBtn.textContent();
  const initialActive = await cleanBtn.evaluate((el: Element) => el.classList.contains("active"));

  await cleanBtn.click();
  await page.waitForTimeout(200);
  const afterText = await cleanBtn.textContent();
  const afterActive = await cleanBtn.evaluate((el: Element) => el.classList.contains("active"));
  await screenshot("verbose-mode");

  await cleanBtn.click();
  await page.waitForTimeout(200);
  const resetActive = await cleanBtn.evaluate((el: Element) => el.classList.contains("active"));
  await screenshot("clean-mode");

  // Button should toggle between active and inactive states
  report("Clean/Verbose toggles", initialActive !== afterActive && afterActive !== resetActive,
    `${initialText}(${initialActive ? "on" : "off"}) → ${afterText}(${afterActive ? "on" : "off"}) → (${resetActive ? "on" : "off"})`);
}

async function testResponsiveLayout() {
  // Test narrow width (phone-like, which is the primary use case)
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);

  // Check all critical elements are visible at narrow width
  const talkVisible = await page.locator("#talkBtn").isVisible();
  const inputVisible = await page.locator("#textInput").isVisible();
  const headerVisible = await page.locator(".header").isVisible();
  await screenshot("layout-320px");

  report("All critical elements visible at 320px", talkVisible && inputVisible && headerVisible);
}

async function testFlowMode() {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);

  // Ensure flow mode is off initially (reset localStorage)
  await page.evaluate(() => localStorage.removeItem("murmur-flow-mode"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);

  const flowBtn = page.locator("#flowModeBtn");
  const flowBtnExists = await flowBtn.count() > 0;
  report("Flow mode button exists in conv-toolbar", flowBtnExists);

  const exitBtnExists = await page.locator(".flow-exit-btn").count() > 0;
  report("Flow exit button exists", exitBtnExists);

  // Activate flow mode
  if (flowBtnExists) {
    await flowBtn.click();
    await page.waitForTimeout(400);
    const bodyHasFlowMode = await page.evaluate(() => document.body.classList.contains("flow-mode"));
    const localStorageSet = await page.evaluate(() => localStorage.getItem("murmur-flow-mode") === "1");
    await screenshot("flow-mode-active");
    report("Flow mode adds body.flow-mode on click", bodyHasFlowMode);
    report("Flow mode persists to localStorage", localStorageSet);

    // Check that talk button is enlarged in flow mode
    const talkBtnHeight = await page.locator("#talkBtn").evaluate((el: HTMLElement) => el.getBoundingClientRect().height);
    report("Flow mode enlarges talk button (>60px)", talkBtnHeight > 60, `${talkBtnHeight.toFixed(0)}px`);

    // Check light background applied
    const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    report("Flow mode: light background (#f5f4ef)", bodyBg === "rgb(245, 244, 239)", bodyBg);

    // Gear visible in flow mode
    const gearVisible = await page.evaluate(() => getComputedStyle(document.querySelector(".flow-gear-btn")!).display !== "none");
    report("Flow mode: gear button visible", gearVisible);

    // Header/controls hidden
    const headerHidden = await page.evaluate(() => getComputedStyle(document.querySelector(".header")!).display === "none");
    const controlsHidden = await page.evaluate(() => getComputedStyle(document.querySelector(".controls")!).display === "none");
    report("Flow mode: header hidden", headerHidden);
    report("Flow mode: controls hidden", controlsHidden);

    // Gear and stop NOT shown in normal mode (check after re-enabling flow mode then disabling)
    await page.evaluate(() => document.getElementById("flowModeBtn")!.click()); // toggle off briefly
    await page.waitForTimeout(200);
    await page.evaluate(() => document.getElementById("flowModeBtn")!.click()); // toggle back on
    await page.waitForTimeout(200);

    // Deactivate via exit button
    await page.locator(".flow-exit-btn").click();
    await page.waitForTimeout(300);
    const bodyExited = await page.evaluate(() => !document.body.classList.contains("flow-mode"));
    const gearHiddenInNormal = await page.evaluate(() => getComputedStyle(document.querySelector(".flow-gear-btn")!).display === "none");
    await screenshot("flow-mode-exited");
    report("Flow exit button removes body.flow-mode", bodyExited);
    report("Gear hidden in normal mode", gearHiddenInNormal);
  }
}

async function testContinuousWaveform() {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);

  // Canvas should always be visible (not display:none)
  const canvasVisible = await page.locator("#talkWaveCanvas").evaluate((el: HTMLElement) => {
    const s = window.getComputedStyle(el);
    return s.display !== "none" && parseFloat(s.opacity) > 0;
  });
  report("Waveform canvas always visible (no display:none)", canvasVisible);

  // Canvas should be drawing (width > 0)
  const canvasHasSize = await page.locator("#talkWaveCanvas").evaluate((el: HTMLCanvasElement) => el.width > 0);
  report("Waveform canvas has non-zero width after load", canvasHasSize);

  // Tool status line element exists
  const toolStatusExists = await page.locator("#toolStatusLine").count() > 0;
  report("Tool status line element exists in talk button", toolStatusExists);

  // talkLabel persistent element exists
  const talkLabelExists = await page.locator("#talkLabel").count() > 0;
  report("Persistent talkLabel element exists", talkLabelExists);
}

// ═══════════════════════════════════════
// Runner
// ═══════════════════════════════════════

async function main() {
  console.log("\n  Murmur UI Smoke Tests");
  console.log(`  Mode: ${HEADLESS ? "headless" : "visible browser"}`);
  console.log(`  Screenshots: ${SCREENSHOTS_DIR}`);
  console.log("  ─────────────────────\n");

  try {
    await setup();
    await testPageLoad();
    await testWsConnection();
    await testTextInput();
    await testTourAutoStart();
    await testTourWalkthrough();
    await testTourDoesNotRestart();
    await testModeCycling();
    await testTerminalToggle();
    await testTerminalPersistence();
    await testHelpMenu();
    await testFontZoom();
    await testDebugPanel();
    await testServiceDots();
    await testCleanVerboseToggle();
    await testResponsiveLayout();
    await testFlowMode();
    await testContinuousWaveform();
  } catch (err) {
    await screenshot("fatal-error").catch(() => {});
    console.error(`\n  ✗ Fatal: ${(err as Error).message}\n`);
  } finally {
    if (browser) await browser.close();
  }

  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  console.log(`\n  ${passed}/${total} passed`);
  console.log(`  Screenshots saved to: ${SCREENSHOTS_DIR}\n`);
  process.exit(passed === total ? 0 : 1);
}

main();
