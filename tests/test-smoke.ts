/**
 * UI smoke tests — lightweight Playwright tests for core UI interactions.
 * Does NOT require voice services (Whisper/Kokoro) — tests UI elements only.
 * Requires: server running on localhost:3457
 *
 * Run:  npx tsx tests/test-smoke.ts
 */

import { chromium, Browser, Page } from "playwright";

const BASE = "http://localhost:3457";
const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

interface TestResult { name: string; ok: boolean; detail?: string }
const results: TestResult[] = [];
let browser: Browser;
let page: Page;

function report(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? PASS : FAIL}  ${name}${detail ? ` ${DIM}(${detail})${RESET}` : ""}`);
}

async function setup() {
  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    permissions: ["microphone"],
    viewport: { width: 320, height: 800 },
  });
  page = await ctx.newPage();
}

// --- Tests ---

async function testPageLoad() {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  const dot = await page.locator("#statusDot").isVisible();
  const text = await page.locator("#statusText").textContent();
  report("Page load + status dot visible", dot, `status="${text}"`);
}

async function testTextInput() {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000); // Wait for WS to connect
  const input = page.locator("#textInput");
  await input.fill("Hello smoke test");
  await input.press("Enter");
  // User bubble is created server-side via WS echo — wait a bit longer
  await page.waitForTimeout(1500);
  const bubble = await page.locator(".msg.user").last().textContent();
  const ok = bubble?.includes("Hello smoke test") ?? false;
  report("Text input creates user bubble", ok, ok ? `bubble="${bubble?.slice(0, 40)}"` : "no bubble — server may not echo entry messages");
}

async function testTourAutoStart() {
  await page.evaluate(() => localStorage.removeItem("murmur-tour-done"));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  const overlay = await page.locator(".tour-overlay").isVisible();
  report("Tour auto-starts on first visit", overlay);
}

async function testTourSkip() {
  // Tour should be visible from previous test
  const skipBtn = page.locator(".tour-skip");
  if (await skipBtn.isVisible()) {
    await skipBtn.click();
    await page.waitForTimeout(300);
    const overlay = await page.locator(".tour-overlay").isVisible();
    const done = await page.evaluate(() => localStorage.getItem("murmur-tour-done"));
    report("Tour skip closes overlay + sets localStorage", !overlay && done === "1");
  } else {
    report("Tour skip closes overlay + sets localStorage", false, "skip button not found");
  }
  // Reload — tour should NOT appear
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  const overlay = await page.locator(".tour-overlay").isVisible();
  report("Tour does not restart after skip", !overlay);
}

async function testTourStepCount() {
  // Start tour fresh and count how many steps until Done
  await page.evaluate(() => localStorage.removeItem("murmur-tour-done"));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  let stepCount = 0;
  const maxSteps = 15; // safety limit
  while (stepCount < maxSteps) {
    const stepText = await page.locator(".tour-step").textContent().catch(() => null);
    if (!stepText) break;
    stepCount++;
    const nextBtn = page.locator(".tour-next");
    const btnText = await nextBtn.textContent();
    if (btnText?.trim() === "Done") {
      await nextBtn.click();
      break;
    }
    await nextBtn.click();
    await page.waitForTimeout(200);
  }
  // Tour should have 10 steps (updated with Clean/Verbose + Restart)
  report("Tour has 10 steps", stepCount === 10, `counted ${stepCount} steps`);
}

async function testModeCycling() {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
  const modeBtn = page.locator("#modeBtn");
  const labels: string[] = [];
  for (let i = 0; i < 4; i++) {
    const text = await modeBtn.textContent();
    labels.push(text?.trim() || "?");
    await modeBtn.click();
    await page.waitForTimeout(100);
  }
  // Should cycle: current → next → next → back to start
  const unique = new Set(labels.slice(0, 3));
  report("Mode cycles through 3 modes", unique.size === 3, labels.join(" → "));
}

async function testTerminalToggle() {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
  const panel = page.locator(".terminal-panel");
  await page.evaluate(() => localStorage.removeItem("term-open"));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);

  const header = page.locator("#terminalHeader");
  await header.click();
  await page.waitForTimeout(200);
  const openAfterClick = await panel.evaluate((el: Element) => el.classList.contains("open"));
  await header.click();
  await page.waitForTimeout(200);
  const closedAfterClick = await panel.evaluate((el: Element) => !el.classList.contains("open"));
  report("Terminal panel toggles open/closed", openAfterClick && closedAfterClick);
}

async function testHelpMenu() {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
  await page.locator("#helpBtn").click();
  await page.waitForTimeout(100);
  const open = await page.locator(".help-menu.open").isVisible();
  // Click outside to close
  await page.locator("#transcript").click({ position: { x: 10, y: 100 } });
  await page.waitForTimeout(100);
  const closed = !(await page.locator(".help-menu.open").isVisible());
  report("Help menu opens and closes", open && closed);
}

async function testHelpMenuItems() {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
  await page.locator("#helpBtn").click();
  await page.waitForTimeout(100);
  const menu = page.locator("#helpMenu");
  const items = await menu.locator("button, a").allTextContents();
  const hasTour = items.some(t => t.includes("Tour"));
  const hasDebug = items.some(t => t.includes("Debug"));
  const hasGithub = items.some(t => t.toLowerCase().includes("github"));
  report("Help menu has Tour, Debug, GitHub items", hasTour && hasDebug && hasGithub, items.join(", "));
}

async function testFontZoom() {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
  const getSize = () => page.evaluate(() =>
    getComputedStyle(document.getElementById("transcript")!).getPropertyValue("--chat-font-size")
  );
  const before = parseFloat(await getSize());
  await page.locator("#chatZoomIn").click();
  await page.waitForTimeout(100);
  const after = parseFloat(await getSize());
  await page.locator("#chatZoomOut").click();
  await page.waitForTimeout(100);
  const reset = parseFloat(await getSize());
  report("Font zoom in/out changes size", after > before && reset < after, `${before} → ${after} → ${reset}`);
}

async function testDebugPanel() {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
  // Open debug panel via Ctrl+Shift+D
  await page.keyboard.press("Control+Shift+KeyD");
  await page.waitForTimeout(200);
  const panelVisible = await page.locator("#debugPanel").evaluate(
    (el: HTMLElement) => el.style.display !== "none" && el.offsetHeight > 0
  );
  // Check tabs exist
  const tabs = await page.locator(".dbg-tabs button[data-tab]").allTextContents();
  const hasState = tabs.some(t => t.includes("State"));
  const hasMessages = tabs.some(t => t.includes("Messages"));
  // Close it
  await page.locator(".dbg-close").click();
  await page.waitForTimeout(100);
  const panelHidden = await page.locator("#debugPanel").evaluate(
    (el: HTMLElement) => el.style.display === "none" || el.offsetHeight === 0
  );
  report("Debug panel opens/closes with tabs", panelVisible && hasState && hasMessages && panelHidden,
    `tabs: ${tabs.join(", ")}`);
}

async function testServiceDots() {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500); // Wait for service check
  const whisper = await page.locator("#svcWhisper").isVisible();
  const kokoro = await page.locator("#svcKokoro").isVisible();
  report("Service indicator dots visible", whisper && kokoro);
}

// --- Runner ---

async function main() {
  console.log("\n  Murmur UI Smoke Tests\n  ─────────────────────\n");

  try {
    await setup();
    await testPageLoad();
    await testTextInput();
    await testTourAutoStart();
    await testTourSkip();
    await testTourStepCount();
    await testModeCycling();
    await testTerminalToggle();
    await testHelpMenu();
    await testHelpMenuItems();
    await testFontZoom();
    await testDebugPanel();
    await testServiceDots();
  } catch (err) {
    console.error(`\n  ✗ Fatal: ${(err as Error).message}\n`);
  } finally {
    if (browser) await browser.close();
  }

  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  console.log(`\n  ${passed}/${total} passed\n`);
  process.exit(passed === total ? 0 : 1);
}

main();
