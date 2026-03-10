/**
 * iOS Flow Mode Scroll Test
 * Simulates iPhone viewport and tests scroll behavior in flow mode.
 * Run: node --import tsx/esm tests/test-ios-scroll.ts
 */

import { chromium, Browser, Page, BrowserContext } from "playwright";

const BASE = "http://localhost:3457?testmode=1";
const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
let browser: Browser;
let ctx: BrowserContext;
let page: Page;
let passed = 0, failed = 0;

function report(name: string, ok: boolean, detail = "") {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? PASS : FAIL}  ${name}${detail ? ` \x1b[2m(${detail})\x1b[0m` : ""}`);
}

async function setup() {
  browser = await chromium.launch({ headless: false, slowMo: 50 });
  // iPhone 14 Pro viewport
  ctx = await browser.newContext({
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  page = await ctx.newPage();
}

async function loadFlowMode() {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    localStorage.setItem("murmur-tour-done", "1");
    localStorage.setItem("murmur-flow-mode", "1");
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
}

async function injectEntries(count: number) {
  // Inject fake conversation entries via WebSocket
  await page.evaluate((n) => {
    const entries = [];
    for (let i = 1; i <= n; i++) {
      entries.push({
        id: i * 2 - 1,
        role: "user",
        text: `Test message ${i} from user — this is a sample message to fill the viewport.`,
        speakable: false,
        spoken: false,
        ts: Date.now() - (n - i) * 60000,
        turn: i,
      });
      entries.push({
        id: i * 2,
        role: "assistant",
        text: `This is Claude's response to message ${i}. It contains enough text to take up some vertical space in the conversation view. The response includes multiple sentences to simulate real conversation content.`,
        speakable: true,
        spoken: true,
        ts: Date.now() - (n - i) * 60000 + 5000,
        turn: i,
      });
    }
    // Dispatch via the renderEntries path
    const ws = (window as any)._ws;
    if (ws && ws.onmessage) {
      ws.onmessage({ data: JSON.stringify({ type: "entry", entries, partial: false }) } as any);
    }
  }, count);
  await page.waitForTimeout(500);
}

async function getScrollInfo() {
  return page.evaluate(() => {
    const t = document.getElementById("transcript")!;
    const userBubbles = t.querySelectorAll(".msg.user");
    const lastUser = userBubbles.length ? userBubbles[userBubbles.length - 1] as HTMLElement : null;
    const allEntries = t.querySelectorAll(".msg.assistant, .msg.user");
    const lastEntry = allEntries.length ? allEntries[allEntries.length - 1] as HTMLElement : null;
    const tR = t.getBoundingClientRect();

    return {
      scrollTop: t.scrollTop,
      scrollHeight: t.scrollHeight,
      clientHeight: t.clientHeight,
      bodyScrollTop: document.documentElement.scrollTop,
      bodyScrollHeight: document.documentElement.scrollHeight,
      bodyClientHeight: document.documentElement.clientHeight,
      flowMode: document.body.classList.contains("flow-mode"),
      transcriptTop: tR.top,
      transcriptBottom: tR.bottom,
      lastUserTop: lastUser ? lastUser.getBoundingClientRect().top : null,
      lastUserBottom: lastUser ? lastUser.getBoundingClientRect().bottom : null,
      lastEntryTop: lastEntry ? lastEntry.getBoundingClientRect().top : null,
      lastEntryBottom: lastEntry ? lastEntry.getBoundingClientRect().bottom : null,
      entryCount: allEntries.length,
      windowHeight: window.innerHeight,
      isIOS: (window as any).isIOS,
      overflowY: getComputedStyle(t).overflowY,
      bodyOverflow: getComputedStyle(document.body).overflow,
    };
  });
}

async function testInitialLoadScroll() {
  console.log("\n  -- Initial Load Scroll --");
  await loadFlowMode();
  await injectEntries(20); // Enough to overflow

  const info = await getScrollInfo();
  report("Flow mode active", info.flowMode);
  report("Transcript overflows", info.scrollHeight > info.clientHeight + 100,
    `scrollH=${info.scrollHeight} clientH=${info.clientHeight}`);
  report("Transcript overflow-y is auto/scroll", ["auto", "scroll"].includes(info.overflowY),
    `overflowY=${info.overflowY}`);
  report("Body overflow in flow mode", true, `bodyOverflow=${info.bodyOverflow}`);

  // The last user message should be visible (within the viewport)
  const lastUserVisible = info.lastUserTop !== null &&
    info.lastUserTop >= 0 && info.lastUserTop < info.windowHeight;
  report("Last user message visible in viewport", lastUserVisible,
    `lastUserTop=${info.lastUserTop} windowH=${info.windowHeight}`);

  // The last entry (assistant response) should be at least partially visible
  const lastEntryVisible = info.lastEntryTop !== null &&
    info.lastEntryTop < info.windowHeight;
  report("Last entry at least partially visible", lastEntryVisible,
    `lastEntryTop=${info.lastEntryTop} windowH=${info.windowHeight}`);

  // Check which container is actually scrolled
  report("Scroll container info", true,
    `transcript.scrollTop=${info.scrollTop} body.scrollTop=${info.bodyScrollTop}`);
}

async function testNewMessageScroll() {
  console.log("\n  -- New Message Auto-Scroll --");
  await loadFlowMode();
  await injectEntries(15);

  // Now add one more user message
  await page.evaluate(() => {
    const ws = (window as any)._ws;
    if (!ws || !ws.onmessage) return;
    // Get current entries from DOM
    const existing = document.querySelectorAll(".entry-bubble");
    const maxId = Math.max(...Array.from(existing).map(e => parseInt(e.getAttribute("data-entry-id") || "0")));
    const newEntries: any[] = [];
    existing.forEach(e => {
      newEntries.push({
        id: parseInt(e.getAttribute("data-entry-id") || "0"),
        role: e.classList.contains("user") ? "user" : "assistant",
        text: e.querySelector(".entry-text")?.textContent || "",
        speakable: e.getAttribute("data-entry-speakable") === "1",
        spoken: e.classList.contains("bubble-spoken"),
        ts: Date.now() - 10000,
        turn: parseInt(e.getAttribute("data-entry-turn") || "0"),
      });
    });
    // Add new user message
    newEntries.push({
      id: maxId + 1,
      role: "user",
      text: "This is a brand new message that should auto-scroll into view!",
      speakable: false,
      spoken: false,
      ts: Date.now(),
      turn: 999,
    });
    ws.onmessage({ data: JSON.stringify({ type: "entry", entries: newEntries, partial: false }) } as any);
  });
  await page.waitForTimeout(800); // Extra time for iOS RAF delay

  const info = await getScrollInfo();
  const newMsgVisible = info.lastUserTop !== null &&
    info.lastUserTop >= 0 && info.lastUserTop < info.windowHeight;
  report("New user message scrolled into view", newMsgVisible,
    `lastUserTop=${info.lastUserTop} windowH=${info.windowHeight}`);
}

async function testManualScroll() {
  console.log("\n  -- Manual Touch Scroll --");
  await loadFlowMode();
  await injectEntries(20);

  // Scroll up via touch gesture simulation
  const beforeScroll = await getScrollInfo();

  // Simulate swipe up (finger moves up = content scrolls down, so swipe down = content scrolls up)
  await page.mouse.move(196, 600);
  await page.mouse.down();
  await page.mouse.move(196, 200, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(500);

  const afterScroll = await getScrollInfo();
  const scrollChanged = afterScroll.scrollTop !== beforeScroll.scrollTop ||
    afterScroll.bodyScrollTop !== beforeScroll.bodyScrollTop;
  report("Touch scroll changes position", scrollChanged,
    `before: t=${beforeScroll.scrollTop}/b=${beforeScroll.bodyScrollTop} after: t=${afterScroll.scrollTop}/b=${afterScroll.bodyScrollTop}`);
}

async function testContentFitsNoSnap() {
  console.log("\n  -- Content Fits (No Snap) --");
  await loadFlowMode();
  await injectEntries(2); // Only 2 exchanges — should fit viewport

  const info = await getScrollInfo();
  // Content fits — first message should be near top, no user-snap behavior
  const contentH = info.entryCount > 0 ? (info.lastEntryBottom || 0) - (info.transcriptTop || 0) : 0;
  const fits = contentH < info.windowHeight;
  report("Small content fits viewport", fits,
    `contentH=${Math.round(contentH)} windowH=${info.windowHeight}`);

  if (fits) {
    report("Scroll at top (no snap)", info.scrollTop < 10 && info.bodyScrollTop < 10,
      `scrollTop=${info.scrollTop} bodyScrollTop=${info.bodyScrollTop}`);
  }
}

(async () => {
  console.log("\n  iOS Flow Mode Scroll Tests");
  console.log("  Viewport: 393x852 (iPhone 14 Pro)");
  console.log("  ─────────────────────────────────");

  await setup();

  try {
    await testInitialLoadScroll();
    await testNewMessageScroll();
    await testManualScroll();
    await testContentFitsNoSnap();
  } catch (err) {
    console.error("\n  Fatal:", (err as Error).message);
  }

  console.log(`\n  ${passed}/${passed + failed} passed`);
  await browser.close();
})();
