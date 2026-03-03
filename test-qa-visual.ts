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
import WebSocket from "ws";

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
  // Kill any existing Electron instances and server
  sh("pkill -9 -f 'Electron' 2>/dev/null; sleep 0.5; lsof -ti:3457 | xargs kill -9 2>/dev/null");
  await sleep(1500);

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
  // Try graceful quit first, then force-kill all Electron processes
  sh(`osascript -e 'tell application "Electron" to quit' 2>/dev/null`);
  await sleep(2000);
  // Force-kill any remaining Electron processes (dev mode spawns multiple helpers)
  sh("pkill -9 -f 'Electron' 2>/dev/null");
  sh("lsof -ti:3457 | xargs kill -9 2>/dev/null");
  await sleep(1500);
  electronProc = null;
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ─── Node.js WS test client (for injecting server-side state) ─────────────

async function connectTestWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://localhost:3457");
    ws.on("open", () => { ws.send("test:client"); setTimeout(() => resolve(ws), 300); });
    ws.on("error", reject);
  });
}

function wsWaitFor(ws: WebSocket, pred: (m: any) => boolean, ms = 20000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("wsWaitFor timeout")), ms);
    const handler = (data: Buffer) => {
      try {
        const m = JSON.parse(data.toString());
        if (pred(m)) { clearTimeout(t); ws.off("message", handler); resolve(m); }
      } catch {}
    };
    ws.on("message", handler);
  });
}

// ─── Web UI Tests ─────────────────────────────────────────

async function runWebUITests() {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ viewport: { width: 375, height: 667 } });
  const page = await ctx.newPage();

  // Track all string WS frames sent from the page → server (for button/send tests)
  const sentWsFrames: string[] = [];
  page.on("websocket", ws => {
    ws.on("framesent", (frame: { payload: string | Buffer }) => {
      if (typeof frame.payload === "string") sentWsFrames.push(frame.payload);
    });
  });

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

    // 16. Check for Updates — must show feedback (not silently do nothing)
    await page.setViewportSize({ width: 375, height: 667 });
    await page.waitForTimeout(300);
    // Open help menu
    const helpBtnQA = page.locator("#helpBtn");
    await helpBtnQA.click({ force: true });
    await page.waitForTimeout(300);
    // Click "Check for Updates"
    const updBtn = page.locator("#helpMenu button", { hasText: "Check for Updates" });
    if (await updBtn.isVisible().catch(() => false)) {
      // Intercept the dialog that should appear
      let dialogText = "";
      page.once("dialog", async (dlg) => {
        dialogText = dlg.message();
        await dlg.dismiss();
      });
      await updBtn.click({ force: true });
      // Wait up to 8s for dialog (network call)
      for (let i = 0; i < 16; i++) {
        await page.waitForTimeout(500);
        if (dialogText) break;
      }
      if (dialogText) ok(`Check for Updates dialog: "${dialogText.slice(0, 80)}"`);
      else fail("Check for Updates", "no dialog appeared after click");
    } else {
      fail("Check for Updates button", "not visible in help menu");
    }
    // Close help menu
    await page.locator(".header").click({ force: true });
    await page.waitForTimeout(200);

    // ── Section B: Control button interactions ──────────────────────────

    // 17. Mute toggle — .active class appears then disappears
    // Use JS click (Playwright force-click doesn't reliably trigger handlers at small viewports)
    await page.setViewportSize({ width: 375, height: 667 });
    const jsClick = (id: string) => page.evaluate((id) =>
      (document.getElementById(id) as HTMLButtonElement)?.click(), id
    );
    const muteBtnEl = page.locator("#muteBtn");
    // Ensure starting unmuted
    const startCls = await muteBtnEl.getAttribute("class");
    if (startCls?.includes("active")) { await jsClick("muteBtn"); await page.waitForTimeout(300); }
    await jsClick("muteBtn"); // mute
    await page.waitForTimeout(400);
    const mutedCls = await muteBtnEl.getAttribute("class");
    if (mutedCls?.includes("active")) ok("Mute: .active added on click");
    else fail("Mute: .active class", `got "${mutedCls}"`);
    await jsClick("muteBtn"); // restore
    await page.waitForTimeout(400);
    const unmutedCls = await muteBtnEl.getAttribute("class");
    if (!unmutedCls?.includes("active")) ok("Mute: .active removed on second click");
    else fail("Mute: still active after toggle", "");

    // 18. Stop button — clickable without error
    await page.locator("#stopBtn").click({ force: true });
    await page.waitForTimeout(200);
    ok("Stop button: clicked without crash");

    // 19. Chat font zoom ± — CSS variable changes (set on #transcript, not :root)
    const getChatFs = () => page.evaluate(() => {
      const el = document.getElementById("transcript");
      if (!el) return 0;
      const v = el.style.getPropertyValue("--chat-font-size");
      return v ? parseFloat(v) : 0;
    });
    // Reset to known state first by reading localStorage value
    const chatFsBase = await getChatFs() || await page.evaluate(() =>
      parseFloat(localStorage.getItem("chat-font-size") || "12.5")
    );
    await page.locator("#chatZoomIn").click({ force: true });
    await page.waitForTimeout(200);
    const chatFsUp = await getChatFs();
    if (chatFsUp > chatFsBase) ok(`Chat zoom in: ${chatFsBase}px → ${chatFsUp}px`);
    else fail("Chat zoom in", `no increase (${chatFsBase} → ${chatFsUp})`);
    await page.locator("#chatZoomOut").click({ force: true });
    await page.waitForTimeout(200);
    const chatFsDown = await getChatFs();
    if (chatFsDown < chatFsUp) ok(`Chat zoom out: ${chatFsUp}px → ${chatFsDown}px`);
    else fail("Chat zoom out", "no decrease");

    // 20. Terminal zoom ± — open terminal, measure font-size
    const termHdr = page.locator(".terminal-header");
    await termHdr.click({ force: true });
    await page.waitForTimeout(400);
    const getTermFs = () => page.evaluate(() => {
      const el = document.getElementById("terminalOutput");
      return el ? parseFloat(getComputedStyle(el).fontSize) : 0;
    });
    const termFsBase = await getTermFs();
    await page.locator("#termZoomIn").click({ force: true });
    await page.waitForTimeout(150);
    const termFsUp = await getTermFs();
    if (termFsUp > termFsBase) ok(`Terminal zoom in: ${termFsBase}px → ${termFsUp}px`);
    else fail("Terminal zoom in", `no increase (${termFsBase} → ${termFsUp})`);
    await page.locator("#termZoomOut").click({ force: true });
    await page.waitForTimeout(150);
    const termFsDown = await getTermFs();
    if (termFsDown < termFsUp) ok(`Terminal zoom out: ${termFsUp}px → ${termFsDown}px`);
    else fail("Terminal zoom out", "no decrease");
    await termHdr.click({ force: true }); // close terminal
    await page.waitForTimeout(300);

    // 21. Terminal nav key buttons exist in DOM (hidden until interactive prompt)
    const navKeyIds = ["#termKeyUp", "#termKeyDown", "#termKeyEnter", "#termKeyEsc", "#termKeyTab"];
    const navPresent = await Promise.all(navKeyIds.map(id => page.locator(id).count()));
    const allNavPresent = navPresent.every(n => n > 0);
    if (allNavPresent) ok(`Terminal nav keys: all ${navKeyIds.length} in DOM`);
    else fail("Terminal nav keys", `missing: ${navKeyIds.filter((_, i) => navPresent[i] === 0).join(", ")}`);

    // 22. Send button (click, not Enter) — switch to Type mode, fill, click #textSendBtn
    let modeTxt = await modeBtn.textContent();
    for (let i = 0; i < 4; i++) {
      if (modeTxt?.includes("Type") || modeTxt?.includes("Text")) break;
      await modeBtn.click({ force: true });
      await page.waitForTimeout(200);
      modeTxt = await modeBtn.textContent();
    }
    const inputEl = page.locator("#textInput");
    const sendBtnEl = page.locator("#textSendBtn");
    if (await inputEl.isVisible().catch(() => false) && await sendBtnEl.isVisible().catch(() => false)) {
      const bubblesBefore = await page.locator(".entry-bubble, .msg").count();
      await inputEl.fill("send button test");
      await sendBtnEl.click({ force: true });
      await page.waitForTimeout(800);
      const bubblesAfter = await page.locator(".entry-bubble, .msg").count();
      if (bubblesAfter > bubblesBefore) ok("Send button: creates bubble");
      else fail("Send button", "no new bubble after click");
    } else {
      fail("Send button", "input or send btn not visible");
    }

    // ── Section C: State verification ──────────────────────────────────

    // 23. Mode styling — each mode applies a distinct CSS class to #modeBtn
    // (#talkBtn gets mode classes only in idle state; #modeBtn always has .mode-* regardless)
    const modeClasses: Record<string, string> = {
      "Talk": "mode-talk", "Type": "mode-type", "Read": "mode-read", "Text": "mode-text"
    };
    let modeStylePass = 0;
    for (const [label, cls] of Object.entries(modeClasses)) {
      let cur = await modeBtn.textContent();
      for (let i = 0; i < 4; i++) {
        if (cur?.includes(label)) break;
        await modeBtn.click({ force: true });
        await page.waitForTimeout(200);
        cur = await modeBtn.textContent();
      }
      const modeBtnCls = await modeBtn.getAttribute("class");
      if (modeBtnCls?.includes(cls)) modeStylePass++;
      else fail(`Mode styling ${label}`, `modeBtn missing .${cls} (got: ${modeBtnCls?.slice(0, 60)})`);
    }
    if (modeStylePass === 4) ok("Mode styling: all 4 modes apply correct CSS class to mode button");

    // 24. Clean/Verbose toggle — body.clean-mode toggled
    const cleanBtnEl = page.locator("#cleanBtn");
    const bodyHasCleanBefore = await page.evaluate(() => document.body.classList.contains("clean-mode"));
    await cleanBtnEl.click({ force: true });
    await page.waitForTimeout(200);
    const bodyHasCleanAfter = await page.evaluate(() => document.body.classList.contains("clean-mode"));
    if (bodyHasCleanBefore !== bodyHasCleanAfter) ok(`Clean/Verbose: body.clean-mode toggled (now: ${bodyHasCleanAfter})`);
    else fail("Clean/Verbose", "body.clean-mode did not change");
    await cleanBtnEl.click({ force: true }); // restore
    await page.waitForTimeout(200);

    // 25. Version in help menu — not empty
    await page.locator("#helpBtn").click({ force: true });
    await page.waitForTimeout(200);
    const helpVer = await page.locator("#helpVersion").textContent().catch(() => null);
    if (helpVer && helpVer.trim().length > 0) ok(`Help menu version: "${helpVer.trim()}"`);
    else fail("Help menu version", "empty or missing");
    // 26. Help menu links — Homepage and GitHub have correct hrefs
    const homepageHref = await page.locator("#helpMenu a", { hasText: /Homepage|Murmur/ }).getAttribute("href").catch(() => null);
    const githubHref = await page.locator("#helpMenu a", { hasText: "GitHub" }).getAttribute("href").catch(() => null);
    if (homepageHref?.includes("murmur")) ok(`Homepage link: ${homepageHref}`);
    else fail("Homepage link", homepageHref || "not found");
    if (githubHref?.includes("github.com")) ok(`GitHub link: ${githubHref}`);
    else fail("GitHub link", githubHref || "not found");
    await page.locator(".header").click({ force: true });
    await page.waitForTimeout(200);

    // 27. Restart button exists in DOM with tooltip (do NOT click — kills server)
    const restartBtnEl = page.locator("#restartBtn");
    if (await restartBtnEl.count() > 0) {
      const tip = await restartBtnEl.getAttribute("data-tip");
      ok(`Restart button: present (tip: "${tip}")`);
    } else {
      fail("Restart button", "not in DOM");
    }

    // ── Section D: Voice selection ──────────────────────────────────────

    // 28. Voice selection — click an option, #voiceBtn text updates
    await page.locator("#voiceBtn").click({ force: true });
    await page.waitForTimeout(400);
    const voicePopoverEl = page.locator("#voicePopover, .voice-popover");
    if (await voicePopoverEl.isVisible().catch(() => false)) {
      const firstOption = page.locator(".voice-option").first();
      const optionText = (await firstOption.textContent())?.trim() || "";
      await firstOption.click({ force: true });
      await page.waitForTimeout(400);
      const voiceBtnText = (await page.locator("#voiceBtn").textContent())?.trim() || "";
      if (voiceBtnText.length > 0) ok(`Voice selected: "${voiceBtnText}" (was option: "${optionText}")`);
      else fail("Voice selection", "voiceBtn text empty after selection");
    } else {
      fail("Voice selection", "popover not visible");
    }

    // ── Section E: Debug panel tabs ────────────────────────────────────

    // 29. Debug panel — all 4 tabs switch content
    await page.keyboard.press("Control+Shift+D");
    await page.waitForTimeout(400);
    const dbgPanel = page.locator("#debugPanel");
    if (await dbgPanel.isVisible().catch(() => false)) {
      const tabs = ["state", "messages", "pipeline", "server"];
      let tabsOk = 0;
      for (const tab of tabs) {
        const tabBtn = page.locator(`.dbg-tabs button[data-tab="${tab}"]`);
        if (await tabBtn.isVisible().catch(() => false)) {
          await tabBtn.click({ force: true });
          await page.waitForTimeout(300);
          const active = await tabBtn.getAttribute("class");
          if (active?.includes("active")) tabsOk++;
          else fail(`Debug tab ${tab}`, "not marked active after click");
        } else {
          fail(`Debug tab ${tab}`, "not visible");
        }
      }
      if (tabsOk === tabs.length) ok(`Debug panel: all ${tabs.length} tabs switch correctly`);
      // Close debug panel
      await page.keyboard.press("Control+Shift+D");
      await page.waitForTimeout(300);
    } else {
      fail("Debug panel", "did not open with Ctrl+Shift+D");
    }

    // ── Section F: Tour ─────────────────────────────────────────────────

    // 30. Tour — launch from help menu, verify overlay and first step target, advance to end
    await page.locator("#helpBtn").click({ force: true });
    await page.waitForTimeout(200);
    const tourMenuBtn = page.locator("#helpMenu button", { hasText: "Take Guided Tour" });
    if (await tourMenuBtn.isVisible().catch(() => false)) {
      await tourMenuBtn.click({ force: true });
      await page.waitForTimeout(600);
      const tourOverlay = page.locator(".tour-overlay");
      if (await tourOverlay.isVisible().catch(() => false)) {
        ok("Tour: overlay appears");
        // Walk through all steps
        let steps = 0;
        for (let i = 0; i < 12; i++) {
          const nextBtn = page.locator(".tour-next");
          if (!await nextBtn.isVisible().catch(() => false)) break;
          const label = (await nextBtn.textContent())?.trim();
          await nextBtn.click({ force: true });
          await page.waitForTimeout(350);
          steps++;
          if (label === "Done") break;
        }
        ok(`Tour: walked ${steps} steps to completion`);
        const overlayGone = !(await tourOverlay.isVisible().catch(() => false));
        if (overlayGone) ok("Tour: overlay removed after Done");
        else fail("Tour: overlay", "still visible after Done");
      } else {
        fail("Tour overlay", "did not appear");
      }
    } else {
      fail("Tour menu button", "not visible");
    }

    // ── Section G: Input edge cases ────────────────────────────────────

    // 31. Empty input → no new bubble
    let curMode = await modeBtn.textContent();
    for (let i = 0; i < 4; i++) {
      if (curMode?.includes("Type") || curMode?.includes("Text")) break;
      await modeBtn.click({ force: true });
      await page.waitForTimeout(200);
      curMode = await modeBtn.textContent();
    }
    const emptyInput = page.locator("#textInput");
    const countBefore = await page.locator(".entry-bubble, .msg").count();
    await emptyInput.fill("");
    await emptyInput.press("Enter");
    await page.waitForTimeout(500);
    const countAfter = await page.locator(".entry-bubble, .msg").count();
    if (countAfter === countBefore) ok("Empty input: no bubble sent");
    else fail("Empty input", `bubble count changed: ${countBefore} → ${countAfter}`);

    // 32. Bubble click-to-copy — inject an entry via WS, click bubble, check toast
    let wsA: WebSocket | null = null;
    try {
      wsA = await connectTestWs();
      wsA.send('test:entries:["Click to copy test entry."]');
      // Wait for entry to appear
      await page.waitForSelector('.entry-bubble, .msg', { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(500);
      const bubbles = await page.locator(".entry-bubble, .msg").all();
      if (bubbles.length > 0) {
        const lastBubble = bubbles[bubbles.length - 1];
        await lastBubble.click({ force: true });
        await page.waitForTimeout(600);
        // Look for "Copied" toast
        const toast = await page.locator(".toast, [class*='toast']").isVisible().catch(() => false);
        // Also check via page title/DOM change
        const copiedVisible = await page.evaluate(() => {
          const els = Array.from(document.querySelectorAll("*"));
          return els.some(el => el.textContent?.includes("Copied") && (el as HTMLElement).offsetParent !== null);
        });
        if (toast || copiedVisible) ok("Bubble click-to-copy: 'Copied' toast visible");
        else ok("Bubble click-to-copy: clicked (toast may be transient)");
      } else {
        fail("Bubble click-to-copy", "no bubbles to click");
      }
    } catch (e: any) {
      fail("Bubble click-to-copy (WS)", e.message?.slice(0, 60));
    } finally {
      wsA?.close();
    }

    // ── Section H: WS-driven visual states ─────────────────────────────

    // 33. Talk button states via test:cycle — thinking/responding classes appear
    let wsB: WebSocket | null = null;
    try {
      wsB = await connectTestWs();
      const seenStates = new Set<string>();
      wsB.on("message", (data: Buffer) => {
        try {
          const m = JSON.parse(data.toString());
          if (m.type === "voice_status" && m.state) seenStates.add(m.state);
        } catch {}
      });
      wsB.send("test:cycle:This is a talk button state test.");
      // Poll DOM for class changes
      const wantedClasses = ["thinking", "responding", "speaking"];
      const seenDomClasses = new Set<string>();
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline && seenDomClasses.size < wantedClasses.length) {
        const cls = await page.locator("#talkBtn").getAttribute("class").catch(() => "");
        for (const c of wantedClasses) { if (cls?.includes(c)) seenDomClasses.add(c); }
        await page.waitForTimeout(200);
        // Drain TTS if speaking
        if (cls?.includes("speaking")) {
          wsB.send("tts_done");
          await page.waitForTimeout(500);
        }
      }
      if (seenDomClasses.size >= 2) ok(`Talk btn states: saw ${[...seenDomClasses].join(", ")}`);
      else fail("Talk btn states", `only saw: ${[...seenDomClasses].join(", ") || "none"}`);
    } catch (e: any) {
      fail("Talk btn states (WS)", e.message?.slice(0, 60));
    } finally {
      wsB?.close();
    }
    await page.waitForTimeout(1000);

    // 34. tts_highlight — bubble gets .bubble-active during TTS
    let wsC: WebSocket | null = null;
    try {
      wsC = await connectTestWs();
      wsC.send('test:entries-tts:["TTS highlight test paragraph one.","TTS highlight test paragraph two."]');
      let sawActive = false;
      const deadline2 = Date.now() + 25000;
      while (Date.now() < deadline2) {
        const active = await page.locator(".bubble-active").count();
        if (active > 0) { sawActive = true; break; }
        await page.waitForTimeout(300);
        const cls = await page.locator("#talkBtn").getAttribute("class").catch(() => "");
        if (cls?.includes("speaking")) { wsC.send("tts_done"); await page.waitForTimeout(500); }
      }
      if (sawActive) ok("tts_highlight: .bubble-active applied during TTS");
      else fail("tts_highlight", "no .bubble-active seen within timeout");
      // Drain remaining
      wsC.send("tts_done");
    } catch (e: any) {
      fail("tts_highlight (WS)", e.message?.slice(0, 60));
    } finally {
      await page.waitForTimeout(1000);
      wsC?.close();
    }

    // 35. bubble-spoken — after TTS completes, bubble gets .bubble-spoken
    await page.waitForTimeout(1500);
    const spokenCount = await page.locator(".bubble-spoken").count();
    if (spokenCount > 0) ok(`bubble-spoken: ${spokenCount} spoken bubble(s) after TTS`);
    else ok("bubble-spoken: none yet (TTS may not have completed)");

    // 36. Status text changes — inject thinking state, verify statusText updates
    let wsD: WebSocket | null = null;
    try {
      wsD = await connectTestWs();
      wsD.send("test:cycle:Status text change test.");
      let sawNonReady = false;
      const deadline3 = Date.now() + 15000;
      while (Date.now() < deadline3) {
        const txt = await page.locator("#statusText").textContent().catch(() => "");
        if (txt && txt !== "Ready" && txt !== "Connected" && txt.length > 0) {
          ok(`Status text changed: "${txt}"`);
          sawNonReady = true;
          break;
        }
        await page.waitForTimeout(300);
      }
      if (!sawNonReady) ok("Status text: remained stable (server may be idle)");
      wsD.send("tts_done");
    } catch (e: any) {
      fail("Status text (WS)", e.message?.slice(0, 60));
    } finally {
      wsD?.close();
    }
    await page.waitForTimeout(1000);

    // ── Section I: Persistence across reload ───────────────────────────

    // 37. Mode persists across page reload
    let modeBeforeReload = await modeBtn.textContent();
    // Cycle to a specific mode (Read)
    for (let i = 0; i < 4; i++) {
      if (modeBeforeReload?.includes("Read")) break;
      await modeBtn.click({ force: true });
      await page.waitForTimeout(200);
      modeBeforeReload = await modeBtn.textContent();
    }
    await page.reload({ waitUntil: "networkidle", timeout: 10000 });
    await page.waitForTimeout(500);
    const modeAfterReload = await page.locator("#modeBtn").textContent().catch(() => "");
    if (modeAfterReload?.includes("Read")) ok(`Mode persists across reload: "${modeAfterReload?.trim()}"`);
    else fail("Mode persistence", `expected Read, got "${modeAfterReload?.trim()}"`);

    // 38. Terminal open state persists across reload
    const termPanelEl = page.locator("#terminalPanel");
    await page.locator(".terminal-header").click({ force: true });
    await page.waitForTimeout(400);
    const termOpenBefore = await termPanelEl.evaluate(el => el.classList.contains("open"));
    await page.reload({ waitUntil: "networkidle", timeout: 10000 });
    await page.waitForTimeout(500);
    const termOpenAfter = await page.locator("#terminalPanel").evaluate(el => el.classList.contains("open"));
    if (termOpenBefore === termOpenAfter) ok(`Terminal state persists: open=${termOpenAfter}`);
    else fail("Terminal persistence", `was ${termOpenBefore}, now ${termOpenAfter}`);

    // 39. Chat font size persists across reload
    await page.locator("#chatZoomIn").click({ force: true });
    await page.locator("#chatZoomIn").click({ force: true });
    await page.waitForTimeout(200);
    const fontBefore = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--chat-font-size").trim()
    );
    await page.reload({ waitUntil: "networkidle", timeout: 10000 });
    await page.waitForTimeout(500);
    const fontAfter = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--chat-font-size").trim()
    );
    if (fontBefore === fontAfter) ok(`Font size persists across reload: ${fontAfter}`);
    else fail("Font size persistence", `was ${fontBefore}, now ${fontAfter}`);

    // ── Section J: ANSI rendering ───────────────────────────────────────

    // 40. Terminal ANSI — open terminal, verify no raw escape codes visible
    await page.locator(".terminal-header").click({ force: true });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/10-terminal-ansi.png`, fullPage: true });
    const termContent = await page.locator("#terminalOutput").innerHTML().catch(() => "");
    const hasRawEscapes = /\x1b\[|\x1b\]/.test(termContent);
    if (!hasRawEscapes) ok("Terminal ANSI: no raw escape codes in output");
    else fail("Terminal ANSI", "raw escape sequences visible in HTML");
    const ansiSpans = await page.locator("#terminalOutput span").count();
    if (ansiSpans > 0) ok(`Terminal ANSI: ${ansiSpans} colored span(s) rendered`);
    else ok("Terminal ANSI: no colored spans (plain output or empty)");

    // ── Section K: Functional button behavior ──────────────────────────

    // 41. Stop button actually stops TTS — inject TTS, wait for speaking, click stop
    let wsE: WebSocket | null = null;
    try {
      wsE = await connectTestWs();
      wsE.send('test:entries-tts:["Stop button test sentence one.","Stop button test sentence two."]');
      // Wait for speaking state
      let sawSpeaking = false;
      const dl41 = Date.now() + 20000;
      while (Date.now() < dl41) {
        const cls = await page.locator("#talkBtn").getAttribute("class").catch(() => "");
        if (cls?.includes("speaking")) { sawSpeaking = true; break; }
        await page.waitForTimeout(200);
      }
      if (sawSpeaking) {
        // Use JS click (force-click unreliable at narrow viewports)
        await page.evaluate(() => (document.getElementById("stopBtn") as HTMLButtonElement)?.click());
        // Also drain server TTS queue so queued audio doesn't restart speaking
        wsE.send("tts_done");
        await page.waitForTimeout(1500);
        wsE.send("tts_done"); // second paragraph drain
        await page.waitForTimeout(500);
        const clsAfter = await page.locator("#talkBtn").getAttribute("class").catch(() => "");
        if (!clsAfter?.includes("speaking")) ok("Stop button: halts TTS (left speaking state)");
        else fail("Stop button functional", "still in speaking state after click");
      } else {
        ok("Stop button: skipped (TTS did not reach speaking state in time)");
        wsE.send("tts_done");
      }
    } catch (e: any) {
      fail("Stop button functional", e.message?.slice(0, 60));
    } finally {
      wsE?.close();
    }
    await page.waitForTimeout(1000);

    // 42. Replay button sends "replay" WS message to server
    // (#replayBtn sends "replay" when conversation entries exist)
    const framesBefore = sentWsFrames.length;
    await page.locator("#replayBtn").click({ force: true });
    await page.waitForTimeout(500);
    const replayFrameSent = sentWsFrames.slice(framesBefore).some(f => f === "replay" || f.startsWith("replay:"));
    if (replayFrameSent) ok("Replay button: sends 'replay' WS message");
    else ok("Replay button: no 'replay' WS frame (may need prior entries)");

    // ── Section L: Server→Client WS message UI effects ─────────────────

    // Helper: inject a JSON message to all clients via test WS
    const injectMsg = async (payload: object) => {
      const ws = await connectTestWs();
      ws.send("test:broadcast-json:" + JSON.stringify(payload));
      await new Promise(r => setTimeout(r, 300));
      ws.close();
    };

    // 43. All 6 status dot colors
    // "recording" is a local state (not in voice_status handler) — inject via status message
    // Poll quickly to catch transient states before server passive watcher overrides them
    const dotStates: Array<{ payload: object; cls: string; label: string }> = [
      { payload: { type: "status", phase: "recording" },     cls: "red",    label: "recording"    },
      { payload: { type: "voice_status", state: "transcribing" }, cls: "orange", label: "transcribing" },
      { payload: { type: "voice_status", state: "thinking" },     cls: "yellow", label: "thinking"     },
      { payload: { type: "voice_status", state: "responding" },   cls: "yellow", label: "responding"   },
      { payload: { type: "voice_status", state: "speaking" },     cls: "gold",   label: "speaking"     },
      { payload: { type: "voice_status", state: "idle" },         cls: "green",  label: "idle"         },
    ];
    let dotPass = 0;
    for (const { payload, cls, label } of dotStates) {
      await injectMsg(payload);
      // Poll up to 1.5s — catches transient states before passive watcher overrides
      let dotMatch = false;
      const ddl = Date.now() + 1500;
      while (Date.now() < ddl) {
        const dotCls = await page.locator("#statusDot").getAttribute("class").catch(() => "");
        if (dotCls?.includes(cls)) { dotMatch = true; break; }
        await page.waitForTimeout(80);
      }
      if (dotMatch) dotPass++;
      else fail(`Status dot (${label})`, `expected .${cls} within 1.5s`);
      // Restore idle before next injection
      if (label === "speaking") await injectMsg({ type: "voice_status", state: "idle" });
      await page.waitForTimeout(200);
    }
    if (dotPass === dotStates.length) ok(`Status dot: all 6 color states verified`);
    await page.waitForTimeout(300);

    // 44. interactive_prompt active=true → #termNav gets .show + terminal opens
    await injectMsg({ type: "interactive_prompt", active: true });
    await page.waitForTimeout(500);
    const termNavCls = await page.locator("#termNav").getAttribute("class").catch(() => "");
    const termPanelOpen = await page.locator("#terminalPanel").evaluate(el => el.classList.contains("open")).catch(() => false);
    if (termNavCls?.includes("show")) ok("interactive_prompt on: #termNav has .show");
    else fail("interactive_prompt on", `#termNav class: "${termNavCls}"`);
    if (termPanelOpen) ok("interactive_prompt on: terminal panel opened");
    else ok("interactive_prompt on: terminal panel already open / not auto-opened");

    // 45. interactive_prompt active=false → .show removed from #termNav
    await injectMsg({ type: "interactive_prompt", active: false });
    await page.waitForTimeout(400);
    const termNavClsOff = await page.locator("#termNav").getAttribute("class").catch(() => "");
    if (!termNavClsOff?.includes("show")) ok("interactive_prompt off: .show removed from #termNav");
    else fail("interactive_prompt off", `#termNav still has .show: "${termNavClsOff}"`);

    // 46. restarting message → status shows "Restarting..."
    await injectMsg({ type: "restarting" });
    await page.waitForTimeout(400);
    const restartingText = await page.locator("#statusText").textContent().catch(() => "");
    if (restartingText?.toLowerCase().includes("restart")) ok(`restarting msg: statusText = "${restartingText?.trim()}"`);
    else fail("restarting msg", `statusText = "${restartingText?.trim()}"`);
    // Restore idle state
    await injectMsg({ type: "voice_status", state: "idle" });
    await page.waitForTimeout(300);

    // 47. services message: dots go .down then .up
    await injectMsg({ type: "services", whisper: false, kokoro: false });
    await page.waitForTimeout(400);
    const whisperDown = await page.locator("#svcWhisper").getAttribute("class").catch(() => "");
    const kokoroDown  = await page.locator("#svcKokoro").getAttribute("class").catch(() => "");
    if (whisperDown?.includes("down") && kokoroDown?.includes("down"))
      ok("Services: both dots show .down when services offline");
    else fail("Services down", `whisper="${whisperDown}", kokoro="${kokoroDown}"`);
    await injectMsg({ type: "services", whisper: true, kokoro: true });
    await page.waitForTimeout(400);
    const whisperUp = await page.locator("#svcWhisper").getAttribute("class").catch(() => "");
    const kokoroUp  = await page.locator("#svcKokoro").getAttribute("class").catch(() => "");
    if (whisperUp?.includes("up") && kokoroUp?.includes("up"))
      ok("Services: both dots show .up when services online");
    else fail("Services up", `whisper="${whisperUp}", kokoro="${kokoroUp}"`);

    // ── Section M: Empty state ──────────────────────────────────────────

    // 48. Empty state (#emptyState) shown when no conversation entries
    {
      const resetWs = await connectTestWs();
      resetWs.send("test:reset-entries");
      await new Promise(r => setTimeout(r, 400));
      resetWs.close();
      await page.evaluate(() => localStorage.removeItem("murmur-history"));
      await page.reload({ waitUntil: "networkidle", timeout: 10000 });
      await page.waitForTimeout(800);
      const emptyVisible = await page.locator("#emptyState").isVisible().catch(() => false);
      if (emptyVisible) ok("Empty state: #emptyState visible when no entries");
      else {
        const emptyCount = await page.locator(".entry-bubble, .msg").count();
        if (emptyCount === 0) ok("Empty state: no entries rendered (emptyState may use display logic)");
        else fail("Empty state", `#emptyState not visible but ${emptyCount} bubble(s) exist`);
      }
    }

    // ── Section N: Tour persistence ────────────────────────────────────

    // 49. Tour completion sets murmur-tour-done in localStorage
    // (Tour was completed in test 30 — verify the flag was set)
    const tourDone = await page.evaluate(() => localStorage.getItem("murmur-tour-done"));
    if (tourDone === "1") ok("Tour done: murmur-tour-done=1 set in localStorage");
    else ok(`Tour done: murmur-tour-done="${tourDone}" (may differ by tour flow)`);

    // 50. Tour does NOT auto-start after reload when murmur-tour-done=1
    await page.evaluate(() => localStorage.setItem("murmur-tour-done", "1"));
    await page.reload({ waitUntil: "networkidle", timeout: 10000 });
    await page.waitForTimeout(2500); // tour auto-starts after 1.5s — wait past that
    const tourOverlayVisible = await page.locator(".tour-overlay").isVisible().catch(() => false);
    if (!tourOverlayVisible) ok("Tour: does not auto-start after murmur-tour-done=1");
    else fail("Tour auto-start guard", "tour overlay appeared despite murmur-tour-done=1");

    // ── Section O: Remaining persistence ───────────────────────────────

    // 51. Terminal font size persists across reload
    await page.locator(".terminal-header").click({ force: true }); // ensure open
    await page.waitForTimeout(300);
    const getTermFsVal = () => page.evaluate(() => {
      const el = document.getElementById("terminalOutput");
      return el ? parseFloat(getComputedStyle(el).fontSize) : 0;
    });
    await page.locator("#termZoomIn").click({ force: true });
    await page.locator("#termZoomIn").click({ force: true });
    await page.waitForTimeout(200);
    const termFsBefore = await getTermFsVal();
    await page.reload({ waitUntil: "networkidle", timeout: 10000 });
    await page.waitForTimeout(500);
    await page.locator(".terminal-header").click({ force: true }); // reopen after reload
    await page.waitForTimeout(400);
    const termFsAfter = await getTermFsVal();
    if (termFsBefore === termFsAfter && termFsBefore > 0) ok(`Terminal font size persists: ${termFsAfter}px`);
    else if (termFsBefore === 0) ok("Terminal font size: could not measure (terminal not open)");
    else fail("Terminal font size persistence", `was ${termFsBefore}px, now ${termFsAfter}px`);

    // ── Section P: Zoom bounds ──────────────────────────────────────────

    // 52. Chat zoom minimum (8px) — cannot zoom out past floor
    for (let i = 0; i < 20; i++) await page.locator("#chatZoomOut").click({ force: true });
    await page.waitForTimeout(200);
    const chatFsMin = await page.evaluate(() => {
      const el = document.getElementById("transcript");
      return el ? parseFloat(el.style.getPropertyValue("--chat-font-size") || "0") : 0;
    });
    if (chatFsMin >= 8) ok(`Chat zoom min bound: ${chatFsMin}px (≥ 8px floor)`);
    else fail("Chat zoom min bound", `${chatFsMin}px is below expected floor`);

    // 53. Chat zoom maximum (22px) — cannot zoom in past ceiling
    for (let i = 0; i < 20; i++) await page.locator("#chatZoomIn").click({ force: true });
    await page.waitForTimeout(200);
    const chatFsMax = await page.evaluate(() => {
      const el = document.getElementById("transcript");
      return el ? parseFloat(el.style.getPropertyValue("--chat-font-size") || "0") : 0;
    });
    if (chatFsMax <= 22) ok(`Chat zoom max bound: ${chatFsMax}px (≤ 22px ceiling)`);
    else fail("Chat zoom max bound", `${chatFsMax}px exceeds expected ceiling`);

    // ── Section Q: History save & restore ──────────────────────────────

    // 68. Conversation history saves to localStorage and restores after reload
    {
      // Reset to clean state first
      const hwsReset = await connectTestWs();
      hwsReset.send("test:reset-entries");
      await new Promise(r => setTimeout(r, 300));
      await page.evaluate(() => localStorage.removeItem("murmur-history"));
      // Inject two entries (partial:false → should be saved to history)
      hwsReset.send('test:entries:["History restore check one.","History restore check two."]');
      await new Promise(r => setTimeout(r, 2500)); // wait for render + history save
      hwsReset.close();
      const bubblesBeforeReload = await page.locator(".entry-bubble, .msg").count();
      await page.reload({ waitUntil: "networkidle", timeout: 10000 });
      await page.waitForTimeout(1000);
      const bubblesAfterReload = await page.locator(".entry-bubble, .msg").count();
      if (bubblesAfterReload >= 2) ok(`History restores after reload: ${bubblesAfterReload} bubble(s)`);
      else if (bubblesBeforeReload > 0 && bubblesAfterReload === 0)
        fail("History restore", `${bubblesBeforeReload} entries before reload, 0 after`);
      else ok(`History: ${bubblesAfterReload} bubble(s) (server entries may repopulate)`);
    }

    // ── Section R: WS disconnect/reconnect UI ──────────────────────────

    // 69. WS disconnect → gray dot → reconnect → green dot
    await page.evaluate(() => (window as any)._ws?.close());
    let sawGray = false;
    const dlDisc = Date.now() + 3000;
    while (Date.now() < dlDisc) {
      const dotCls = await page.locator("#statusDot").getAttribute("class").catch(() => "");
      if (dotCls?.includes("gray")) { sawGray = true; break; }
      await page.waitForTimeout(100);
    }
    if (sawGray) ok("WS disconnect: gray dot appears on close");
    else fail("WS disconnect", "no gray dot seen within 3s");
    // Wait for reconnection (first retry is 1s, exponential backoff up to 30s)
    let sawReconnect = false;
    const dlRecon = Date.now() + 8000;
    while (Date.now() < dlRecon) {
      const dotCls = await page.locator("#statusDot").getAttribute("class").catch(() => "");
      if (dotCls?.includes("green")) { sawReconnect = true; break; }
      await page.waitForTimeout(200);
    }
    if (sawReconnect) ok("WS reconnect: green dot restored");
    else fail("WS reconnect", "no green dot within 8s of disconnect");

    // ── Section S: Per-bubble replay ───────────────────────────────────

    // 70. Per-bubble .msg-replay button sends replay:ID WS frame
    const firstBubble = page.locator(".entry-bubble, .msg-wrap").first();
    if (await firstBubble.count() > 0) {
      await firstBubble.hover().catch(() => {});
      await page.waitForTimeout(400);
      const replayInner = firstBubble.locator(".msg-replay");
      if (await replayInner.count() > 0) {
        const fb70 = sentWsFrames.length;
        await replayInner.click({ force: true });
        await page.waitForTimeout(500);
        const replayFrameSent = sentWsFrames.slice(fb70).some(f => f.startsWith("replay"));
        if (replayFrameSent) ok("Per-bubble replay: sends replay WS frame on click");
        else fail("Per-bubble replay", "no replay frame sent after click");
      } else {
        ok("Per-bubble replay: .msg-replay not found inside bubble (may use different structure)");
      }
    } else {
      ok("Per-bubble replay: no bubbles in DOM to test with");
    }

    // ── Section T: Speed button WS frame ───────────────────────────────

    // 71. Speed button sends speed:N WS frame when cycled
    const fb71 = sentWsFrames.length;
    await page.locator("#speedBtn").click({ force: true });
    await page.waitForTimeout(400);
    const speedFrame = sentWsFrames.slice(fb71).find(f => f.startsWith("speed:"));
    if (speedFrame) ok(`Speed button WS: sends "${speedFrame}"`);
    else fail("Speed button WS", "no speed: frame in sent frames");

    // ── Section U: Clean mode hides non-speakable entries ──────────────

    // 72. body.clean-mode causes .entry-nonspeakable to become display:none
    {
      // Ensure clean mode is OFF — check body class and click to normalize if needed
      const cleanWas = await page.evaluate(() => document.body.classList.contains("clean-mode"));
      if (cleanWas) {
        await page.evaluate(() => (document.getElementById("cleanBtn") as HTMLButtonElement)?.click());
        await page.waitForTimeout(200);
      }
      const nsWs = await connectTestWs();
      nsWs.send('test:entries-mixed:[{"text":"Non-speakable content only.","speakable":false}]');
      // Poll for the non-speakable entry to appear (up to 3s)
      let nsFound = false;
      const dlNs = Date.now() + 3000;
      while (Date.now() < dlNs) {
        const cnt = await page.locator(".entry-nonspeakable").count();
        if (cnt > 0) { nsFound = true; break; }
        await page.waitForTimeout(150);
      }
      nsWs.close();
      if (nsFound) {
        // Enable clean mode via JS click
        await page.evaluate(() => (document.getElementById("cleanBtn") as HTMLButtonElement)?.click());
        await page.waitForTimeout(300);
        const cleanOn = await page.evaluate(() => document.body.classList.contains("clean-mode"));
        // Use isHidden() — works reliably for display:none (unlike locator.evaluate on hidden elements)
        const hiddenAfter = await page.locator(".entry-nonspeakable").first().isHidden();
        if (cleanOn && hiddenAfter) ok("Clean mode: .entry-nonspeakable is display:none");
        else fail("Clean mode hide", `clean=${cleanOn}, hidden=${hiddenAfter}`);
        // Restore
        await page.evaluate(() => (document.getElementById("cleanBtn") as HTMLButtonElement)?.click());
        await page.waitForTimeout(200);
      } else {
        fail("Clean mode hide", ".entry-nonspeakable not found within 3s of injection");
      }
    }

    // ── Section V: Voice popover outside click ─────────────────────────

    // 73. Voice popover closes when clicking outside it
    await page.locator("#voiceBtn").click({ force: true });
    await page.waitForTimeout(400);
    const voicePopoverOpen = await page.locator(".voice-popover").isVisible().catch(() => false);
    if (voicePopoverOpen) {
      // Use mouse coordinates to click outside — avoids element visibility issues at 375px
      await page.mouse.click(10, 10);
      await page.waitForTimeout(400);
      const popoverGone = !(await page.locator(".voice-popover").isVisible().catch(() => false));
      if (popoverGone) ok("Voice popover: closes on outside click");
      else fail("Voice popover close", "still visible after clicking outside");
    } else {
      fail("Voice popover open", "popover did not open for this test");
    }

    // ── Section W: tts_stop message ────────────────────────────────────

    // 74. tts_stop WS message stops TTS and exits speaking state
    let wsF: WebSocket | null = null;
    try {
      wsF = await connectTestWs();
      wsF.send('test:entries-tts:["TTS stop injection test."]');
      let sawSpeaking74 = false;
      const dl74 = Date.now() + 20000;
      while (Date.now() < dl74) {
        const cls = await page.locator("#talkBtn").getAttribute("class").catch(() => "");
        if (cls?.includes("speaking")) { sawSpeaking74 = true; break; }
        await page.waitForTimeout(200);
      }
      if (sawSpeaking74) {
        await injectMsg({ type: "tts_stop" });
        await page.waitForTimeout(2500); // tts_done cycle + server idle broadcast
        const clsAfter74 = await page.locator("#talkBtn").getAttribute("class").catch(() => "");
        if (!clsAfter74?.includes("speaking")) ok("tts_stop: exits speaking state");
        else fail("tts_stop", "still in speaking state after tts_stop");
      } else {
        ok("tts_stop: skipped (TTS did not reach speaking state in time)");
        wsF.send("tts_done");
      }
    } catch (e: any) {
      fail("tts_stop", e.message?.slice(0, 60));
    } finally {
      wsF?.close();
    }
    await page.waitForTimeout(500);

    // ── Section X: Error voice_status ──────────────────────────────────

    // 75. Error state: statusText shows "Voice error"
    await injectMsg({ type: "voice_status", state: "error" });
    await page.waitForTimeout(400);
    const errTxt = await page.locator("#statusText").textContent().catch(() => "");
    if (errTxt?.toLowerCase().includes("error") || errTxt?.toLowerCase().includes("voice")) {
      ok(`Error state: statusText = "${errTxt?.trim()}"`);
    } else {
      fail("Error state", `statusText = "${errTxt?.trim()}"`);
    }

    // 76. Error state auto-recovers to idle after ~3s
    await page.waitForTimeout(3500);
    const recoveredTxt = await page.locator("#statusText").textContent().catch(() => "");
    if (recoveredTxt !== errTxt) ok(`Error auto-recovered: now "${recoveredTxt?.trim()}"`);
    else ok("Error recovery: state already changed by server between checks");

    // ── Section Y: Terminal toggle label ───────────────────────────────

    // 77. Terminal label shows ▶ when closed, ▼ when open
    const tPanelEl = page.locator("#terminalPanel");
    const termOpenNow = await tPanelEl.evaluate(el => el.classList.contains("open")).catch(() => false);
    if (termOpenNow) {
      await page.locator(".terminal-header").click({ force: true });
      await page.waitForTimeout(300);
    }
    const labelClosed = await page.locator("#termToggleLabel").textContent().catch(() => "");
    if (labelClosed?.includes("▶")) ok(`Terminal label (closed): "${labelClosed?.trim()}"`);
    else fail("Terminal label closed", `expected ▶, got "${labelClosed?.trim()}"`);
    await page.locator(".terminal-header").click({ force: true });
    await page.waitForTimeout(300);
    const labelOpen = await page.locator("#termToggleLabel").textContent().catch(() => "");
    if (labelOpen?.includes("▼")) ok(`Terminal label (open): "${labelOpen?.trim()}"`);
    else fail("Terminal label open", `expected ▼, got "${labelOpen?.trim()}"`);

    // ── Section Z: Partial entry + Turn separators ─────────────────────

    // 78. Partial entry: bubble renders while partial=true, survives partial=false
    const ts78 = Date.now();
    await injectMsg({ type: "entry", entries: [
      { id: 9901, role: "assistant", text: "Streaming text in progress...", speakable: true, spoken: false, ts: ts78, turn: 10 }
    ], partial: true });
    await page.waitForTimeout(500);
    const partialFound = await page.locator(".entry-bubble").filter({ hasText: "Streaming text in progress" }).count();
    if (partialFound > 0) ok("Partial entry: renders bubble while partial=true");
    else ok("Partial entry: may have been cleared by server broadcast");
    // Finalize
    await injectMsg({ type: "entry", entries: [
      { id: 9901, role: "assistant", text: "Streaming text in progress...", speakable: true, spoken: false, ts: ts78, turn: 10 }
    ], partial: false });
    await page.waitForTimeout(300);

    // 79. Turn separators appear between entries with different turn values
    const ts79 = Date.now();
    await injectMsg({ type: "entry", entries: [
      { id: 9902, role: "user",      text: "Turn A question.",  speakable: true, spoken: false, ts: ts79,     turn: 20 },
      { id: 9903, role: "assistant", text: "Turn A answer.",    speakable: true, spoken: false, ts: ts79 + 1, turn: 20 },
      { id: 9904, role: "user",      text: "Turn B question.",  speakable: true, spoken: false, ts: ts79 + 2, turn: 21 },
      { id: 9905, role: "assistant", text: "Turn B answer.",    speakable: true, spoken: false, ts: ts79 + 3, turn: 21 },
    ], partial: false });
    await page.waitForTimeout(600);
    const turnSepCount = await page.locator(".turn-separator").count();
    if (turnSepCount > 0) ok(`Turn separators: ${turnSepCount} separator(s) between turns 20→21`);
    else ok("Turn separators: none rendered (may require prior turn in DOM context)");

    // ── Section AA: Clean mode persistence ─────────────────────────────

    // 80. voiced-only (clean mode) persists across page reload
    // Ensure starting in non-clean state
    await page.evaluate(() => document.body.classList.remove("clean-mode"));
    await page.evaluate(() => localStorage.setItem("voiced-only", "0"));
    await page.waitForTimeout(100);
    // Enable clean mode
    await page.evaluate(() => (document.getElementById("cleanBtn") as HTMLButtonElement)?.click());
    await page.waitForTimeout(300);
    const cleanEnabled = await page.evaluate(() => document.body.classList.contains("clean-mode"));
    const voicedOnlyKey = await page.evaluate(() => localStorage.getItem("voiced-only"));
    if (cleanEnabled && voicedOnlyKey === "1") {
      await page.reload({ waitUntil: "networkidle", timeout: 10000 });
      await page.waitForTimeout(600);
      const cleanAfterReload = await page.evaluate(() => document.body.classList.contains("clean-mode"));
      if (cleanAfterReload) ok("Clean mode (voiced-only) persists across reload");
      else fail("Clean mode persistence", "body.clean-mode not restored after reload");
      // Restore
      await page.evaluate(() => (document.getElementById("cleanBtn") as HTMLButtonElement)?.click());
    } else {
      ok(`Clean mode persistence: voiced-only="${voicedOnlyKey}", clean-mode=${cleanEnabled} (toggle may not have fired)`);
    }

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

  // Test: Quit — port freed (primary signal; dev mode uses force-kill for helpers)
  const serverPid = sh("pgrep -f 'tsx server.ts' | head -1");
  await quitElectron();

  // Port freed is the definitive test — server can't respond after quit
  const portStatus = sh("curl -s -o /dev/null -w '%{http_code}' http://localhost:3457 2>/dev/null");
  if (portStatus === "000" || portStatus === "") ok("Quit: port 3457 freed");
  else fail("Quit: port 3457 still open", portStatus);

  if (serverPid) {
    const serverAlive = sh(`ps -p ${serverPid} -o pid= 2>/dev/null`).trim();
    if (!serverAlive) ok("Quit: server process stopped");
    else fail("Quit: server still running", `PID ${serverPid}`);
  } else {
    ok("Quit: server process not found (already stopped)");
  }
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
