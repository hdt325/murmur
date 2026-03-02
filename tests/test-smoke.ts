/**
 * UI smoke tests — lightweight Playwright tests for core UI interactions.
 * Does NOT require voice services (Whisper/Kokoro) — tests UI elements only.
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
  await page.waitForTimeout(500);
  const input = page.locator("#textInput");
  await input.fill("Hello smoke test");
  await input.press("Enter");
  await page.waitForTimeout(300);
  const bubble = await page.locator(".msg.user").last().textContent();
  report("Text input creates user bubble", bubble?.includes("Hello smoke test") ?? false, `bubble="${bubble?.slice(0, 40)}"`);
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
  // Close terminal first if open
  const panel = page.locator(".terminal-panel");
  const header = page.locator("#terminalHeader");
  await page.evaluate(() => localStorage.removeItem("term-open"));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);

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

async function testFontZoom() {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
  const getBefore = () => page.evaluate(() =>
    getComputedStyle(document.getElementById("transcript")!).getPropertyValue("--chat-font-size")
  );
  const before = parseFloat(await getBefore());
  await page.locator("#chatZoomIn").click();
  await page.waitForTimeout(100);
  const after = parseFloat(await getBefore());
  await page.locator("#chatZoomOut").click();
  await page.waitForTimeout(100);
  const reset = parseFloat(await getBefore());
  report("Font zoom in/out changes size", after > before && reset < after, `${before} → ${after} → ${reset}`);
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
    await testModeCycling();
    await testTerminalToggle();
    await testHelpMenu();
    await testFontZoom();
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
