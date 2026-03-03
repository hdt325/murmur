/**
 * Murmur Visual + Functional + Electron + Site QA
 *
 * Usage:
 *   npx tsx test-qa-visual.ts              # Web UI tests only (needs server on :3457)
 *   npx tsx test-qa-visual.ts --electron   # Full suite: launches Electron, tests UI + app lifecycle
 *   npx tsx test-qa-visual.ts --site       # Marketing site tests only (no server needed)
 *   npx tsx test-qa-visual.ts --all        # Everything: web UI + site + Electron
 *
 * Screenshots saved to /tmp/murmur-qa-shots/ for visual review.
 * Launches a VISIBLE browser so the user can watch.
 */
import { chromium } from "playwright";
import { execSync, spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SHOTS = "/tmp/murmur-qa-shots";
fs.mkdirSync(SHOTS, { recursive: true });

const ELECTRON_MODE = process.argv.includes("--electron") || process.argv.includes("--all");
const SITE_MODE = process.argv.includes("--site") || process.argv.includes("--all");
const results: string[] = [];
const ok = (label: string) => results.push(`✓ ${label}`);
const fail = (label: string, detail: string) => results.push(`✗ ${label}: ${detail}`);

function sh(cmd: string): string {
  try { return execSync(cmd, { timeout: 10000, encoding: "utf-8" }).trim(); }
  catch { return ""; }
}

function printResults(section: string) {
  console.log("\n" + "=".repeat(60));
  console.log(section);
  console.log("=".repeat(60));
  const passed = results.filter(r => r.startsWith("✓")).length;
  const failed = results.filter(r => r.startsWith("✗")).length;
  results.forEach(r => console.log(r));
  console.log("=".repeat(60));
  console.log(`${passed} passed, ${failed} failed`);
  console.log(`Screenshots in: ${SHOTS}/`);
  console.log("=".repeat(60));
  if (failed > 0) process.exitCode = 1;
}

// ─── Electron lifecycle helpers ───────────────────────────

let electronProc: ReturnType<typeof spawn> | null = null;

async function launchElectron(): Promise<void> {
  // Kill any existing server on 3457
  sh("lsof -ti:3457 | xargs kill 2>/dev/null");
  await sleep(1000);

  electronProc = spawn("npx", ["electron", "."], {
    cwd: `${process.cwd()}/electron`,
    stdio: "ignore",
    detached: false,
  });

  // Wait for server to be ready (Electron spawns it)
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try {
      const resp = sh("curl -s -o /dev/null -w '%{http_code}' http://localhost:3457");
      if (resp === "200") { ok("Electron launched, server ready on :3457"); return; }
    } catch {}
  }
  fail("Electron launch", "server not ready after 30s");
}

async function quitElectron(): Promise<void> {
  sh(`osascript -e 'tell application "Electron" to quit'`);
  await sleep(4000);
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ─── Web UI Tests ─────────────────────────────────────────

async function runWebUITests() {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ viewport: { width: 375, height: 667 } });
  const page = await ctx.newPage();

  try {
    // 1. Navigate, dismiss tour
    await page.goto("http://localhost:3457", { waitUntil: "networkidle", timeout: 15000 });
    await page.evaluate(() => {
      localStorage.setItem("tourSeen", "1");
      document.querySelectorAll("[class*='tour']").forEach(el => (el as HTMLElement).remove());
    });
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      document.querySelectorAll("[class*='tour']").forEach(el => (el as HTMLElement).remove());
    });
    await page.waitForTimeout(200);

    await page.screenshot({ path: `${SHOTS}/01-fresh-load-375.png`, fullPage: true });
    ok("Fresh load at 375px (iPhone)");

    // 2. Header — status dot alignment
    const statusDot = await page.locator("#statusDot").boundingBox();
    const statusText = await page.locator("#statusText").boundingBox();
    if (statusDot && statusText) {
      const dotCenter = statusDot.y + statusDot.height / 2;
      const textCenter = statusText.y + statusText.height / 2;
      const offset = Math.abs(dotCenter - textCenter);
      if (offset < 5) ok(`Status dot aligned (offset ${offset.toFixed(1)}px)`);
      else fail("Status dot alignment", `${offset.toFixed(1)}px off`);
    } else {
      fail("Status dot/text", "not found");
    }

    // 3. Controls — button vertical alignment
    const controls = await page.locator(".controls").boundingBox();
    const btnIds = ["#stopBtn", "#muteBtn", "#modeBtn", "#replayBtn", "#speedBtn", "#voiceBtn"];
    if (controls) {
      const center = controls.y + controls.height / 2;
      let maxOff = 0, worst = "";
      for (const sel of btnIds) {
        const box = await page.locator(sel).boundingBox().catch(() => null);
        if (box) {
          const off = Math.abs(box.y + box.height / 2 - center);
          if (off > maxOff) { maxOff = off; worst = sel; }
        }
      }
      if (maxOff < 5) ok(`Buttons vertically centered (worst: ${maxOff.toFixed(1)}px)`);
      else fail("Button alignment", `${worst} is ${maxOff.toFixed(1)}px off`);
      ok(`Controls: ${controls.width.toFixed(0)}x${controls.height.toFixed(0)}px`);
    } else {
      fail("Controls", "not found");
    }

    // 4. Touch targets >= 34px
    let small = 0;
    for (const sel of btnIds) {
      const box = await page.locator(sel).boundingBox().catch(() => null);
      if (box && box.height < 34) { small++; fail("Touch target", `${sel} ${box.height.toFixed(0)}px`); }
    }
    if (small === 0) ok("All touch targets >= 34px");

    await page.screenshot({
      path: `${SHOTS}/02-controls-closeup.png`,
      clip: controls ? { x: 0, y: Math.max(0, controls.y - 10), width: 375, height: controls.height + 20 } : undefined,
    });

    // 5. Mode cycling
    const modeBtn = page.locator("#modeBtn");
    const modes: string[] = [];
    for (let i = 0; i < 5; i++) {
      modes.push((await modeBtn.textContent())?.trim() || "?");
      await modeBtn.click({ force: true });
      await page.waitForTimeout(250);
    }
    ok(`Modes: ${modes.join(" → ")}`);
    if (modes[0] === modes[4]) ok("Mode wraps");
    else fail("Mode wrap", `${modes[0]} !== ${modes[4]}`);

    // 6. Speed cycling
    const speedBtn = page.locator("#speedBtn");
    const speeds: string[] = [];
    for (let i = 0; i < 8; i++) {
      speeds.push((await speedBtn.textContent())?.trim() || "?");
      await speedBtn.click({ force: true });
      await page.waitForTimeout(150);
    }
    ok(`Speeds: ${speeds.join(" → ")}`);
    if (speeds[0] === speeds[7]) ok("Speed wraps");
    else fail("Speed wrap", `${speeds[0]} !== ${speeds[7]}`);

    // 7. Voice popover
    await page.locator("#voiceBtn").click({ force: true });
    await page.waitForTimeout(500);
    const popover = page.locator(".voice-popover");
    if (await popover.isVisible().catch(() => false)) {
      const opts = await page.locator(".voice-option").all();
      ok(`Voice popover (${opts.length} voices)`);
      await page.screenshot({ path: `${SHOTS}/03-voice-popover.png` });
      await page.locator(".header").click({ force: true });
      await page.waitForTimeout(300);
    } else {
      fail("Voice popover", "did not appear");
    }

    // 8. Text input
    let cur = await modeBtn.textContent();
    for (let i = 0; i < 4; i++) {
      if (cur?.includes("Type") || cur?.includes("Text")) break;
      await modeBtn.click({ force: true });
      await page.waitForTimeout(200);
      cur = await modeBtn.textContent();
    }
    ok(`Mode: ${cur?.trim()}`);

    const textInput = page.locator("#textInput");
    if (await textInput.isVisible().catch(() => false)) {
      ok("Text input visible");
      await textInput.fill("QA test message");
      await page.screenshot({ path: `${SHOTS}/04-text-input-filled.png`, fullPage: true });
      await textInput.press("Enter");
      await page.waitForTimeout(1000);
      await page.screenshot({ path: `${SHOTS}/05-text-sent.png`, fullPage: true });
      const bubbles = await page.locator(".entry-bubble, .msg").all();
      if (bubbles.length > 0) ok(`Message sent (${bubbles.length} bubble(s))`);
      else fail("Text send", "no bubble");
    } else {
      fail("Text input", "not visible");
    }

    // 9. HTTP root
    try {
      const resp = await page.request.get("http://localhost:3457/");
      if (resp.ok()) ok(`GET / → ${resp.status()}`);
      else fail("GET /", `${resp.status()}`);
    } catch (e: any) {
      fail("GET /", e.message?.slice(0, 60));
    }

    // 10. WebSocket indicator (green = idle, yellow = Claude working — both mean connected)
    const dotClass = await page.locator("#statusDot").getAttribute("class");
    if (dotClass?.includes("green") || dotClass?.includes("yellow")) ok(`WS connected (${dotClass?.includes("green") ? "idle" : "active"})`);
    else fail("WS", `dot: ${dotClass}`);

    // 11. Service indicators
    const stt = await page.locator("#svcWhisper").getAttribute("class");
    const tts = await page.locator("#svcKokoro").getAttribute("class");
    ok(`Services — STT: ${stt?.includes("up") ? "up" : "down"}, TTS: ${tts?.includes("up") ? "up" : "down"}`);

    // 12. Terminal toggle
    const termHeader = page.locator(".terminal-header");
    if (await termHeader.isVisible().catch(() => false)) {
      await termHeader.click({ force: true });
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${SHOTS}/06-terminal-open.png`, fullPage: true });
      if (await page.locator(".terminal-output").isVisible().catch(() => false)) ok("Terminal opens");
      else fail("Terminal", "not visible");
      await termHeader.click({ force: true });
      await page.waitForTimeout(300);
    } else {
      fail("Terminal header", "not found");
    }

    // 13. Responsive — tablet
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/07-tablet-768.png`, fullPage: true });
    ok("Tablet (768px) captured");

    // 14. Responsive — desktop
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/08-desktop-1280.png`, fullPage: true });
    ok("Desktop (1280px) captured");

    // 15. Replay button sized correctly
    const replay = await page.locator("#replayBtn").boundingBox().catch(() => null);
    if (replay) ok(`Replay: ${replay.width.toFixed(0)}x${replay.height.toFixed(0)}px`);
    else fail("Replay", "not found");

  } catch (e: any) {
    fail("FATAL (web)", e.message);
    console.error(e);
  }

  await page.waitForTimeout(2000);
  await browser.close();
}

// ─── Electron App Tests ───────────────────────────────────

async function runElectronTests() {
  console.log("\n--- Electron App Tests ---\n");

  // Test: App is in dock / process list
  const inDock = sh(`osascript -e 'tell application "System Events" to get name of every application process' 2>&1`);
  if (inDock.includes("Electron")) ok("Electron in process list");
  else fail("Electron process", "not found");

  // Test: Menu bar has standard items
  const menus = sh(`osascript -e 'tell application "System Events" to tell process "Electron" to get name of every menu bar item of menu bar 1'`);
  if (menus.includes("File") && menus.includes("Edit")) ok(`Menu bar: ${menus}`);
  else fail("Menu bar", menus || "not found");

  // Test: Window exists and has title
  const title = sh(`osascript -e 'tell application "System Events" to tell process "Electron" to get title of first window'`);
  if (title) ok(`Window title: "${title}"`);
  else fail("Window title", "no window");

  // Test: Screenshot of Electron app
  sh(`osascript -e 'tell application "System Events" to tell process "Electron" to set position of first window to {100, 50}'`);
  sh(`osascript -e 'tell application "System Events" to tell process "Electron" to set size of first window to {500, 800}'`);
  await sleep(1000);
  sh(`screencapture -R 100,50,500,800 ${SHOTS}/09-electron-app.png`);
  if (fs.existsSync(`${SHOTS}/09-electron-app.png`)) ok("Electron screenshot captured");
  else fail("Electron screenshot", "file not created");

  // Test: Close window — app should stay running (macOS convention)
  sh(`osascript -e 'tell application "System Events" to tell process "Electron" to click menu item "Close Window" of menu "File" of menu bar 1'`);
  await sleep(2000);
  const afterClose = sh(`ps aux | grep 'Electron.app/Contents/MacOS/Electron' | grep -v grep | wc -l`).trim();
  if (parseInt(afterClose) > 0) ok("Close window keeps app running");
  else fail("Close window", "app quit unexpectedly");

  // Test: Reactivate (dock click) — window should reappear
  sh(`osascript -e 'tell application "Electron" to activate'`);
  await sleep(2000);
  const winCount = sh(`osascript -e 'tell application "System Events" to tell process "Electron" to get number of windows'`);
  if (parseInt(winCount) >= 1) ok("Dock click restores window");
  else fail("Dock reactivate", `windows: ${winCount}`);

  // Test: No update dialog (source install guard)
  const dialogs = sh(`osascript -e 'tell application "System Events" to tell process "Electron" to get every sheet of first window' 2>&1`);
  if (!dialogs || dialogs === "") ok("No update dialog (source guard works)");
  else fail("Update dialog", dialogs);

  // Test: Quit — all processes die, port freed
  const serverPid = sh("pgrep -f 'tsx server.ts' | head -1");
  await quitElectron();

  const remainingElectron = sh("ps aux | grep 'Electron.app' | grep -v grep | wc -l").trim();
  if (remainingElectron === "0") ok("Quit: 0 Electron processes");
  else fail("Quit: Electron processes remain", remainingElectron);

  if (serverPid) {
    const serverAlive = sh(`ps -p ${serverPid} -o pid= 2>/dev/null`).trim();
    if (!serverAlive) ok("Quit: server process stopped");
    else fail("Quit: server still running", `PID ${serverPid}`);
  }

  const portStatus = sh("curl -s -o /dev/null -w '%{http_code}' http://localhost:3457 2>/dev/null");
  if (portStatus === "000" || portStatus === "") ok("Quit: port 3457 freed");
  else fail("Quit: port 3457 still open", portStatus);

  const dockAfterQuit = sh(`osascript -e 'tell application "System Events" to get name of every application process' 2>&1`);
  if (!dockAfterQuit.includes("Electron")) ok("Quit: not in dock");
  else fail("Quit: still in dock", "");
}

// ─── Marketing Site Tests ─────────────────────────────────

async function runSiteTests() {
  console.log("\n--- Marketing Site Tests (site/index.html) ---\n");

  const siteFile = path.resolve(__dirname, "site/index.html");
  if (!fs.existsSync(siteFile)) {
    fail("Site file", `not found at ${siteFile}`);
    return;
  }
  ok("site/index.html present");

  const browser = await chromium.launch({ headless: false });
  // Grant clipboard permissions so Copy button test works
  const ctx = await browser.newContext({
    viewport: { width: 375, height: 812 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await ctx.newPage();

  try {
    await page.goto(`file://${siteFile}`, { waitUntil: "load", timeout: 10000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/site-01-mobile-375.png`, fullPage: true });
    ok("Site loads at 375px (mobile)");

    // 1. Title
    const title = await page.title();
    if (title.includes("Murmur")) ok(`Page title: "${title}"`);
    else fail("Page title", `got "${title}"`);

    // 2. Hero heading
    const h1 = await page.locator("h1").first().textContent();
    if (h1?.trim() === "Murmur") ok(`H1: "${h1?.trim()}"`);
    else fail("H1", `got "${h1?.trim()}"`);

    // 3. Hero tagline
    const tagline = await page.locator(".tagline").textContent().catch(() => null);
    if (tagline?.includes("voice") || tagline?.includes("Claude")) ok(`Tagline: "${tagline?.trim()}"`);
    else fail("Tagline", tagline || "not found");

    // 4. Launch App CTA — href must point to localhost:3457
    const launchHref = await page.locator("#launchBtn").getAttribute("href").catch(() => null);
    if (launchHref === "http://localhost:3457") ok(`Launch App href: ${launchHref}`);
    else fail("Launch App href", launchHref || "not found");

    // 5. Download CTA — href must be #download anchor
    const dlCtaHref = await page.locator("a[href='#download']").first().getAttribute("href").catch(() => null);
    if (dlCtaHref === "#download") ok("Download CTA href: #download");
    else fail("Download CTA href", dlCtaHref || "not found");

    // 6. Feature cards — expect 6
    const featureCards = await page.locator(".feature-card").all();
    if (featureCards.length === 6) ok(`Feature cards: ${featureCards.length}`);
    else fail("Feature cards", `expected 6, got ${featureCards.length}`);

    // Check feature headings text
    const featureTitles: string[] = [];
    for (const card of featureCards) {
      const t = await card.locator("h3").textContent().catch(() => "");
      featureTitles.push(t?.trim() || "");
    }
    ok(`Features: ${featureTitles.join(", ")}`);

    // 7. Getting started steps — expect 3
    const steps = await page.locator(".step").all();
    if (steps.length === 3) ok(`Getting started steps: ${steps.length}`);
    else fail("Getting started steps", `expected 3, got ${steps.length}`);

    // 8. Mode cards — expect 4 (Talk/Type/Read/Text)
    const modeCards = await page.locator(".mode-card").all();
    const modeNames: string[] = [];
    for (const card of modeCards) {
      const n = await card.locator(".mode-name").textContent().catch(() => "");
      modeNames.push(n?.trim() || "");
    }
    if (modeCards.length === 4 && modeNames.includes("Talk") && modeNames.includes("Text")) {
      ok(`Mode cards: ${modeNames.join(", ")}`);
    } else {
      fail("Mode cards", `got: ${modeNames.join(", ")}`);
    }

    // 9. Keyboard shortcuts section visible
    const shortcuts = await page.locator("#shortcuts").isVisible().catch(() => false);
    if (shortcuts) ok("Shortcuts section visible");
    else fail("Shortcuts section", "not visible");

    const shortcutRows = await page.locator(".shortcut-row").all();
    if (shortcutRows.length >= 5) ok(`Shortcut rows: ${shortcutRows.length}`);
    else fail("Shortcut rows", `expected ≥5, got ${shortcutRows.length}`);

    // 10. Download section — macOS and Windows buttons
    const dlMac = page.locator("#dlMac");
    const dlWin = page.locator("#dlWin");
    if (await dlMac.isVisible().catch(() => false)) ok("macOS download button visible");
    else fail("macOS button", "not visible");
    if (await dlWin.isVisible().catch(() => false)) ok("Windows download button visible");
    else fail("Windows button", "not visible");

    // Buttons initially point to /releases/latest (before GitHub API resolves)
    const macHref = await dlMac.getAttribute("href").catch(() => null);
    const winHref = await dlWin.getAttribute("href").catch(() => null);
    if (macHref?.includes("github.com")) ok(`macOS href: ${macHref}`);
    else fail("macOS href", macHref || "not found");
    if (winHref?.includes("github.com")) ok(`Windows href: ${winHref}`);
    else fail("Windows href", winHref || "not found");

    await page.screenshot({ path: `${SHOTS}/site-02-download-section.png`, clip: { x: 0, y: 0, width: 375, height: 812 } });

    // 11. "Build from source" code block
    const codeBlock = page.locator(".code-block");
    if (await codeBlock.isVisible().catch(() => false)) {
      const code = await codeBlock.locator("code").textContent().catch(() => "");
      if (code?.includes("git clone") && code?.includes("npm install")) ok("Source install code block present");
      else fail("Source install code", code?.slice(0, 60) || "empty");
    } else {
      fail("Code block", "not visible");
    }

    // 12. Copy button — click, verify it changes to "Copied!"
    const copyBtn = page.locator("#copyBtn");
    if (await copyBtn.isVisible().catch(() => false)) {
      const before = await copyBtn.textContent();
      await copyBtn.click({ force: true });
      await page.waitForTimeout(300);
      const after = await copyBtn.textContent();
      if (after?.includes("Copied")) ok(`Copy btn: "${before?.trim()}" → "${after?.trim()}"`);
      else fail("Copy btn text change", `still: "${after?.trim()}"`);
      // Wait for reset
      await page.waitForTimeout(2200);
      const reset = await copyBtn.textContent();
      if (reset?.trim() === "Copy") ok("Copy btn resets to 'Copy' after 2s");
      else fail("Copy btn reset", `got "${reset?.trim()}"`);
    } else {
      fail("Copy button", "not visible");
    }

    // 13. Prerequisites accordion — click to expand
    const prereqSummary = page.locator(".prereqs summary");
    if (await prereqSummary.isVisible().catch(() => false)) {
      await prereqSummary.click({ force: true });
      await page.waitForTimeout(400);
      const prereqList = page.locator(".prereq-list");
      if (await prereqList.isVisible().catch(() => false)) {
        const items = await prereqList.locator("li").all();
        ok(`Prerequisites expanded (${items.length} items)`);
        // Click again to close
        await prereqSummary.click({ force: true });
        await page.waitForTimeout(300);
      } else {
        fail("Prerequisites list", "not visible after click");
      }
    } else {
      fail("Prerequisites accordion", "summary not found");
    }

    await page.screenshot({ path: `${SHOTS}/site-03-prereqs.png`, fullPage: true });

    // 14. Footer — GitHub link
    const ghLink = page.locator("footer a[href*='github.com']");
    const ghHref = await ghLink.getAttribute("href").catch(() => null);
    if (ghHref?.includes("github.com")) ok(`Footer GitHub: ${ghHref}`);
    else fail("Footer GitHub", ghHref || "not found");
    const ghTarget = await ghLink.getAttribute("target").catch(() => null);
    if (ghTarget === "_blank") ok("GitHub link opens in new tab");
    else fail("GitHub link target", ghTarget || "missing");

    // 15. Responsive — tablet
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/site-04-tablet-768.png`, fullPage: true });
    ok("Tablet (768px) screenshot captured");

    // 16. Responsive — desktop
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/site-05-desktop-1280.png`, fullPage: true });
    ok("Desktop (1280px) screenshot captured");

    // 17. All 4 main sections present
    const sections = ["hero", "features", "howto", "download"];
    for (const s of sections) {
      const visible = await page.locator(`.${s}, #${s}, section.${s}`).first().isVisible().catch(() => false);
      if (visible) ok(`Section "${s}" visible`);
      else fail(`Section "${s}"`, "not visible");
    }

    // 18. No broken inline images (SVG icons should render)
    const svgs = await page.locator("svg").all();
    if (svgs.length > 10) ok(`SVG icons: ${svgs.length}`);
    else fail("SVG icons", `expected >10, got ${svgs.length}`);

    // 19. Waveform animation element present
    const waveform = page.locator(".waveform");
    const bars = await waveform.locator(".bar").all();
    if (bars.length === 7) ok(`Waveform bars: ${bars.length}`);
    else fail("Waveform", `expected 7 bars, got ${bars.length}`);

    // 20. Scroll to top and take final full-page desktop shot
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/site-06-full-desktop.png`, fullPage: true });
    ok("Full-page desktop screenshot saved");

  } catch (e: any) {
    fail("FATAL (site)", e.message);
    console.error(e);
  }

  await page.waitForTimeout(1500);
  await browser.close();
}

// ─── Main ─────────────────────────────────────────────────

(async () => {
  const parts: string[] = [];

  if (!SITE_MODE || ELECTRON_MODE) {
    // Web UI tests require the server
    if (ELECTRON_MODE) {
      console.log("Mode: Electron\n");
      await launchElectron();
    } else {
      console.log("Mode: Web UI only (server must be running on :3457)\n");
      console.log("Tip: --electron for Electron lifecycle, --site for marketing site, --all for everything\n");
    }
    await runWebUITests();
    parts.push("Web UI");
  }

  if (SITE_MODE) {
    await runSiteTests();
    parts.push("Site");
  }

  if (ELECTRON_MODE) {
    await runElectronTests();
    parts.push("Electron");
  }

  const label = parts.length > 0 ? parts.join(" + ") : "Web UI";
  printResults(`MURMUR QA (${label})`);
})();
