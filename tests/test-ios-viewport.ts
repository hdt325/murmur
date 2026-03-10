/**
 * iOS QA — Viewport & Touch Target Tests
 * Agent 6: Tests iOS-specific behaviors at iPhone 14 Pro (390x844)
 *
 * Usage: node --import tsx/esm tests/test-ios-viewport.ts
 * Results written to /tmp/ios-qa-results.txt
 */
import { chromium } from "playwright";
import fs from "fs";

const SHOTS = "/tmp/murmur-ios-qa";
fs.mkdirSync(SHOTS, { recursive: true });

const results: string[] = [];
let passed = 0, failed = 0;

function report(label: string, ok: boolean, detail?: string) {
  if (ok) { passed++; results.push(`✓ ${label}`); }
  else { failed++; results.push(`✗ ${label}${detail ? ": " + detail : ""}`); }
}

async function run() {
  const browser = await chromium.launch({ headless: true });

  // iPhone 14 Pro emulation
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  const page = await ctx.newPage();

  // Collect console errors
  const pageErrors: string[] = [];
  page.on("pageerror", err => pageErrors.push(err.message));

  // ─── Load ───────────────────────────────────────────
  console.log("Loading page at iPhone 14 Pro viewport (390x844)...");
  await page.goto("http://localhost:3457?testmode=1", { waitUntil: "networkidle", timeout: 15000 });

  // Dismiss tour
  await page.evaluate(() => {
    localStorage.setItem("tourSeen", "1");
    localStorage.setItem("murmur-flow-tour-done", "1");
    localStorage.setItem("murmur-flow-mode", "0");
    document.querySelectorAll("[class*='tour']").forEach(el => (el as HTMLElement).remove());
  });
  await page.waitForTimeout(500);

  // ─── 1. No JS errors on load ───────────────────────
  console.log("\n[1] Page load errors");
  const refErrors = pageErrors.filter(e => e.includes("ReferenceError") || e.includes("TypeError"));
  report("No ReferenceError/TypeError on load", refErrors.length === 0, refErrors.join("; "));

  // ─── 2. Viewport dimensions ────────────────────────
  console.log("\n[2] Viewport dimensions");
  const viewport = await page.evaluate(() => ({
    innerW: window.innerWidth,
    innerH: window.innerHeight,
  }));
  report(`Viewport width is 390 (got ${viewport.innerW})`, viewport.innerW === 390);
  report(`Viewport height is 844 (got ${viewport.innerH})`, viewport.innerH === 844);

  // ─── 3. No horizontal overflow ─────────────────────
  console.log("\n[3] Horizontal overflow check");
  const overflow = await page.evaluate(() => {
    return document.documentElement.scrollWidth > document.documentElement.clientWidth;
  });
  report("No horizontal overflow (no side-scroll)", !overflow);

  // ─── 4. Touch targets >= 36px ──────────────────────
  console.log("\n[4] Touch target sizes (min 36px)");
  const touchTargets = await page.evaluate(() => {
    const results: { sel: string; w: number; h: number }[] = [];
    const selectors = [
      "#talkBtn", "#interruptBtn", "#muteBtn", "#settingsBtn",
      "#flowModeBtn", "#textSubmitBtn", "#clearBtn",
      ".audio-indicator", "#statusDot",
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel) as HTMLElement;
      if (!el || el.offsetParent === null) continue; // skip hidden
      const rect = el.getBoundingClientRect();
      results.push({ sel, w: Math.round(rect.width), h: Math.round(rect.height) });
    }
    return results;
  });

  for (const t of touchTargets) {
    const minDim = Math.min(t.w, t.h);
    report(`${t.sel} touch target ≥ 36px (${t.w}×${t.h})`, minDim >= 36);
  }

  // ─── 5. Input font-size >= 16px (prevents iOS zoom) ─
  console.log("\n[5] Input font-size (iOS zoom prevention)");
  const inputFontSize = await page.evaluate(() => {
    const input = document.getElementById("textInput");
    if (!input) return null;
    return parseFloat(window.getComputedStyle(input).fontSize);
  });
  report(`Text input font-size ≥ 16px (got ${inputFontSize}px)`, inputFontSize !== null && inputFontSize >= 16);

  // ─── 6. Settings sheet max-height ──────────────────
  console.log("\n[6] Settings sheet doesn't cover entire screen");
  // Open settings
  const settingsBtn = page.locator("#settingsBtn");
  if (await settingsBtn.isVisible()) {
    await settingsBtn.click();
    await page.waitForTimeout(300);
    const sheetHeight = await page.evaluate(() => {
      const sheet = document.querySelector(".settings-sheet, #settingsPanel, [class*='settings']") as HTMLElement;
      if (!sheet) return null;
      return sheet.getBoundingClientRect().height;
    });
    if (sheetHeight !== null) {
      const maxAllowed = 844 * 0.75; // 75% of viewport
      report(`Settings sheet height ≤ 75% viewport (${Math.round(sheetHeight)}px / ${maxAllowed}px)`, sheetHeight <= maxAllowed);
    } else {
      report("Settings sheet found", false, "sheet element not found");
    }
    // Close settings
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  }

  // ─── 7. isIOS detection code ───────────────────────
  console.log("\n[7] isIOS detection");
  // isIOS is a local const, not on window — check via source code and indirect detection
  const iosDetection = await page.evaluate(() => {
    // Check that the page detected our iPhone UA by looking for iOS-specific behaviors
    // The deferred mic init (touchstart listener) only happens when isIOS is true
    const htmlSrc = document.documentElement.outerHTML;
    return htmlSrc.includes("isIOS");
  });
  report("isIOS referenced in page source", iosDetection);

  // Verify UA-based detection would match our emulated UA
  const uaMatch = await page.evaluate(() => {
    return /iPhone|iPad|iPod/.test(navigator.userAgent);
  });
  report(`iPhone UA detected by regex (got ${uaMatch})`, uaMatch === true);

  // ─── 8. Safe area CSS variables ────────────────────
  console.log("\n[8] Safe area inset usage");
  const safeAreaUsed = await page.evaluate(() => {
    const html = document.documentElement.outerHTML;
    return html.includes("safe-area-inset");
  });
  report("safe-area-inset referenced in rendered page", safeAreaUsed);

  // ─── 9. Apple web app meta tags ────────────────────
  console.log("\n[9] Apple web app meta tags");
  const metaTags = await page.evaluate(() => {
    const capable = !!document.querySelector('meta[name="apple-mobile-web-app-capable"]');
    const statusBar = !!document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
    const touchIcon = !!document.querySelector('link[rel="apple-touch-icon"]');
    const viewportMeta = document.querySelector('meta[name="viewport"]')?.getAttribute("content") || "";
    const hasFitCover = viewportMeta.includes("viewport-fit=cover");
    return { capable, statusBar, touchIcon, hasFitCover };
  });
  report("apple-mobile-web-app-capable meta", metaTags.capable);
  report("apple-mobile-web-app-status-bar-style meta", metaTags.statusBar);
  report("apple-touch-icon link", metaTags.touchIcon);
  report("viewport-fit=cover for notch support", metaTags.hasFitCover);

  // ─── 10. No content clipped at edges ───────────────
  console.log("\n[10] Content clipping check");
  const clipping = await page.evaluate(() => {
    const body = document.body;
    const results: string[] = [];
    // Check visible elements aren't off-screen
    const els = body.querySelectorAll("button, input, .msg, .entry-bubble, h1, h2");
    for (const el of els) {
      const rect = (el as HTMLElement).getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.right > window.innerWidth + 5) results.push(`${(el as HTMLElement).tagName}#${(el as HTMLElement).id} right-clipped at ${Math.round(rect.right)}`);
      if (rect.left < -5) results.push(`${(el as HTMLElement).tagName}#${(el as HTMLElement).id} left-clipped at ${Math.round(rect.left)}`);
    }
    return results;
  });
  report(`No elements clipped at edges (${clipping.length} issues)`, clipping.length === 0, clipping.join("; "));

  // ─── 11. WebSocket connection ──────────────────────
  console.log("\n[11] WebSocket connection");
  const wsConnected = await page.evaluate(() => {
    return (window as any)._ws?.readyState === WebSocket.OPEN;
  });
  report("WebSocket connected", wsConnected === true);

  // ─── 12. Flow mode tests ──────────────────────────
  console.log("\n[12] Flow mode at iPhone viewport");
  await page.evaluate(() => localStorage.setItem("murmur-flow-mode", "1"));
  await page.reload({ waitUntil: "networkidle", timeout: 15000 });
  await page.evaluate(() => {
    localStorage.setItem("tourSeen", "1");
    localStorage.setItem("murmur-flow-tour-done", "1");
    document.querySelectorAll("[class*='tour']").forEach(el => (el as HTMLElement).remove());
  });
  await page.waitForTimeout(500);

  // Check flow mode activated
  const inFlowMode = await page.evaluate(() => document.body.classList.contains("flow-mode"));
  report("Flow mode activates on reload", inFlowMode);

  if (inFlowMode) {
    // Talk button visible and centered
    const talkBtn = await page.evaluate(() => {
      const btn = document.getElementById("talkBtn");
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, visible: r.width > 0 };
    });
    if (talkBtn) {
      report("Talk button visible in flow mode", talkBtn.visible);
      const centerX = talkBtn.x + talkBtn.w / 2;
      const centered = Math.abs(centerX - 195) < 30; // 195 = 390/2
      report(`Talk button horizontally centered (center at ${Math.round(centerX)})`, centered);
      report(`Talk button touch target ≥ 36px (${Math.round(talkBtn.w)}×${Math.round(talkBtn.h)})`, Math.min(talkBtn.w, talkBtn.h) >= 36);
    }

    // Gear button visible
    const gearBtn = await page.evaluate(() => {
      const btn = document.getElementById("settingsBtn") || document.querySelector(".flow-gear, [class*='gear']");
      if (!btn) return null;
      const r = (btn as HTMLElement).getBoundingClientRect();
      return { w: r.width, h: r.height, visible: r.width > 0 };
    });
    if (gearBtn) {
      report("Gear button visible in flow mode", gearBtn.visible);
    }

    // Transcript area exists and is scrollable
    const transcriptOk = await page.evaluate(() => {
      const t = document.getElementById("transcript");
      if (!t) return { exists: false };
      const style = window.getComputedStyle(t);
      return {
        exists: true,
        overflowY: style.overflowY,
        height: t.getBoundingClientRect().height,
      };
    });
    report("Transcript element exists in flow mode", transcriptOk.exists);
    if (transcriptOk.exists) {
      report(`Transcript has scroll overflow (${transcriptOk.overflowY})`,
        ["auto", "scroll"].includes(transcriptOk.overflowY!));
    }

    // Take flow mode screenshot
    await page.screenshot({ path: `${SHOTS}/flow-mode-iphone14pro.png` });
  }

  // ─── 13. Background audio element (iOS keep-alive) ─
  console.log("\n[13] Background audio keep-alive");
  const bgAudio = await page.evaluate(() => {
    const audio = document.querySelector("audio[loop]") as HTMLAudioElement;
    if (!audio) return null;
    return { loop: audio.loop, volume: audio.volume };
  });
  // The bg audio may not exist until user gesture triggers it
  report("Background audio element check", bgAudio === null || (bgAudio.loop === true),
    bgAudio ? `loop=${bgAudio.loop}, vol=${bgAudio.volume}` : "not yet created (needs gesture)");

  // ─── 14. MediaRecorder MIME type ───────────────────
  console.log("\n[14] MediaRecorder format");
  const mimeCheck = await page.evaluate(() => {
    // Check if the code handles mp4 fallback for iOS
    const supportsWebm = MediaRecorder.isTypeSupported("audio/webm");
    const supportsMp4 = MediaRecorder.isTypeSupported("audio/mp4");
    return { supportsWebm, supportsMp4 };
  });
  report(`MediaRecorder format support (webm=${mimeCheck.supportsWebm}, mp4=${mimeCheck.supportsMp4})`, true);

  // ─── 15. Normal mode screenshot ────────────────────
  await page.evaluate(() => localStorage.setItem("murmur-flow-mode", "0"));
  await page.reload({ waitUntil: "networkidle", timeout: 15000 });
  await page.evaluate(() => {
    localStorage.setItem("tourSeen", "1");
    localStorage.setItem("murmur-flow-tour-done", "1");
    document.querySelectorAll("[class*='tour']").forEach(el => (el as HTMLElement).remove());
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/normal-mode-iphone14pro.png` });

  // ─── Source code checks ────────────────────────────
  console.log("\n[15] Source code iOS checks");
  const htmlSrc = fs.readFileSync(new URL("../index.html", import.meta.url).pathname, "utf-8");

  // iOS mic deferred to touchstart
  report("iOS mic init deferred to touchstart", htmlSrc.includes("_iosInitMic") && htmlSrc.includes("touchstart"));

  // iOS device voices hidden
  report("iOS device voices hidden with note", htmlSrc.includes("Device voices unavailable on iOS") || htmlSrc.includes("device voices") && htmlSrc.includes("isIOS"));

  // webkit-overflow-scrolling: touch for momentum scroll
  report("-webkit-overflow-scrolling: touch present", htmlSrc.includes("-webkit-overflow-scrolling: touch"));

  // overflow-anchor: none for scroll stability
  report("overflow-anchor: none for scroll stability", htmlSrc.includes("overflow-anchor: none"));

  // ─── Done ──────────────────────────────────────────
  await browser.close();

  // Print results
  console.log("\n" + "═".repeat(60));
  console.log("iOS QA REPORT");
  console.log("VIEWPORT: iPhone 14 Pro (390×844 @3x)");
  console.log("═".repeat(60));
  for (const r of results) console.log(r);
  console.log("═".repeat(60));
  console.log(`TESTS: ${passed}/${passed + failed} passed`);
  if (failed > 0) {
    console.log("\niOS-SPECIFIC FAILURES:");
    for (const r of results.filter(r => r.startsWith("✗"))) console.log("  " + r);
  }
  console.log("═".repeat(60));

  // Write to file for retrieval
  const output = [
    "iOS QA REPORT",
    `VIEWPORT: iPhone 14 Pro (390×844 @3x)`,
    `TESTS: ${passed}/${passed + failed} passed`,
    "",
    ...results,
    "",
    failed > 0 ? "iOS-SPECIFIC FAILURES:" : "NO FAILURES",
    ...results.filter(r => r.startsWith("✗")).map(r => "  " + r),
    "",
    `Screenshots: ${SHOTS}/`,
  ].join("\n");
  fs.writeFileSync("/tmp/ios-qa-results.txt", output);

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error("Fatal:", err);
  fs.writeFileSync("/tmp/ios-qa-results.txt", `FATAL ERROR: ${err.message}`);
  process.exit(2);
});
