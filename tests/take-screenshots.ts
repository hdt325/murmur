/**
 * Marketing screenshot capture script
 * Run via test-runner: node --import tsx/esm tests/take-screenshots.ts
 */
import { chromium } from "playwright";

const BASE = "http://localhost:3457?testmode=1";
const OUT = "/Users/happythakkar/Desktop/Programming/murmur/site/screenshots";

const USER1 = "Can you refactor the authentication module to use JWT tokens instead of session cookies?";
const ASST1 = `I'll refactor the auth module to use JWT. Here's my plan:\n\nFirst, I'll install the jsonwebtoken package. Then I'll create a token generation utility that signs tokens with a secret key and sets expiration.\n\nThe session middleware will be replaced with a JWT verification middleware that checks the Authorization header. Existing endpoints won't need changes since the middleware handles auth transparently.\n\nLet me start with the token utility...`;
const USER2 = "Sounds good, go ahead";
const ASST2 = `Done. I've made these changes:\n\n\u2022 Created lib/jwt.ts with sign and verify functions\n\u2022 Replaced express-session middleware with a new jwtAuth middleware\n\u2022 Updated the login endpoint to return a JWT instead of setting a session cookie\n\nAll 47 tests pass with the new auth flow.`;

function escHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function setupPage(page: any, flowMode: boolean) {
  // First navigate to set localStorage (needs origin)
  await page.goto(BASE);
  await page.evaluate((flow: boolean) => {
    localStorage.setItem("murmur-tour-done", "1");
    localStorage.setItem("murmur-flow-tour-done", "1");
    localStorage.setItem("murmur-flow-mode", flow ? "1" : "0");
  }, flowMode);
  // Reload with localStorage set
  await page.goto(BASE);
  await page.waitForTimeout(2000);
  // Wait for WS
  await page.waitForFunction(
    () => document.querySelector(".status-dot.green") !== null || (window as any).__wsConnected,
    { timeout: 8000 }
  ).catch(() => console.log("  WS timeout — proceeding"));
  await page.waitForTimeout(500);

  // Clear existing entries via WS
  await page.evaluate(() => {
    var ws = (window as any).__ws;
    if (ws && ws.readyState === 1) ws.send("test:clear-entries");
  });
  await page.waitForTimeout(800);
  // Intercept WS onmessage to block entry broadcasts that would wipe our DOM injection
  await page.evaluate(() => {
    var ws = (window as any).__ws;
    if (ws) {
      var origHandler = ws.onmessage;
      ws.onmessage = function(ev: any) {
        try {
          var d = JSON.parse(ev.data);
          if (d && d.type === "entry") return; // Block entry re-renders
        } catch(e) {}
        if (origHandler) origHandler.call(ws, ev);
      };
    }
  });
  await page.waitForTimeout(200);
}

async function injectRegularMode(page: any) {
  // Inject conversation entries via DOM as proper bubbles
  await page.evaluate(({ u1, a1, u2, a2 }: any) => {
    const transcript = document.getElementById("transcript");
    if (!transcript) return;
    // Remove any existing entry bubbles
    transcript.querySelectorAll(".msg-wrap, .entry-bubble").forEach((e: Element) => e.remove());

    const entries = [
      { role: "user", text: u1 },
      { role: "assistant", text: a1 },
      { role: "user", text: u2 },
      { role: "assistant", text: a2 },
    ];

    for (const msg of entries) {
      const wrap = document.createElement("div");
      wrap.className = "msg-wrap";
      wrap.style.cssText = msg.role === "user"
        ? "align-self: flex-end; max-width: 85%;"
        : "align-self: flex-start; max-width: 85%;";

      const bubble = document.createElement("div");
      bubble.className = `msg ${msg.role} entry-bubble`;
      const textEl = document.createElement("div");
      textEl.className = "msg-text";
      textEl.innerHTML = msg.text.replace(/\n/g, "<br>");
      bubble.appendChild(textEl);

      // Add role label
      const label = document.createElement("div");
      label.className = "msg-role";
      label.textContent = msg.role === "user" ? "YOU" : "CLAUDE";
      label.style.cssText = "font-size:10px; font-weight:700; opacity:0.5; margin-bottom:4px; text-transform:uppercase;";
      bubble.insertBefore(label, textEl);

      wrap.appendChild(bubble);
      transcript.appendChild(wrap);
    }

    // Scroll to show conversation
    transcript.scrollTop = transcript.scrollHeight;
  }, { u1: USER1, a1: ASST1, u2: USER2, a2: ASST2 });
  await page.waitForTimeout(500);
}

async function injectFlowMode(page: any) {
  // Build HTML string server-side to avoid esbuild __name issues in page.evaluate
  const entries = [
    { role: "user", text: USER1 },
    { role: "assistant", text: ASST1, spokenRatio: 1.0 },
    { role: "user", text: USER2 },
    { role: "assistant", text: ASST2, spokenRatio: 0.65 },
  ];

  let html = "";
  for (const msg of entries) {
    const isAsst = msg.role === "assistant";
    let inner = "";
    if (isAsst) {
      const words = msg.text.split(/(\s+)/);
      const ratio = (msg as any).spokenRatio || 0.5;
      const realWords = words.filter(w => /\S/.test(w));
      const spokenCount = Math.floor(realWords.length * ratio);
      let wordIdx = 0;
      for (const tok of words) {
        if (/^\s+$/.test(tok)) {
          inner += tok.replace(/\n/g, "<br>");
        } else {
          const cls = wordIdx < spokenCount ? "tts-word-spoken" : "tts-word";
          inner += `<span class="${cls}">${escHtml(tok)}</span>`;
          wordIdx++;
        }
      }
    } else {
      inner = escHtml(msg.text);
    }
    const spokenClass = isAsst && (msg as any).spokenRatio >= 1.0 ? " bubble-spoken" : "";
    const bubbleClass = `msg ${msg.role} entry-bubble${spokenClass}`;
    html += `<div class="msg-wrap"><div class="${bubbleClass}"><div class="msg-text">${inner}</div></div></div>`;
  }

  await page.evaluate((htmlStr: string) => {
    var transcript = document.getElementById("transcript");
    if (transcript) {
      transcript.innerHTML = htmlStr;
      transcript.scrollTop = 0;
      // Force scroll to top after a tick (some JS may reset it)
      setTimeout(function() { transcript!.scrollTop = 0; }, 100);
      setTimeout(function() { transcript!.scrollTop = 0; }, 300);
    }
  }, html);
  await page.waitForTimeout(600);
  // Double-check: force scroll and add visibility override
  await page.evaluate(() => {
    var t = document.getElementById("transcript");
    if (t) {
      t.scrollTop = 0;
      // Override flow-mode transcript padding to show content from top
      t.style.paddingTop = "50px";
      t.style.paddingBottom = "200px";
    }
  });
  await page.waitForTimeout(300);
}

async function main() {
  const browser = await chromium.launch({ headless: true });

  // --- 1. Regular mode desktop ---
  console.log("1/4: regular-mode-desktop.png");
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await setupPage(page, false);
    await injectRegularMode(page);
    await page.screenshot({ path: `${OUT}/regular-mode-desktop.png`, fullPage: false });
    console.log("  Done");
    await ctx.close();
  }

  // --- 2. Flow mode desktop ---
  console.log("2/4: flow-mode-desktop.png");
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await setupPage(page, true);
    await injectFlowMode(page);
    await page.screenshot({ path: `${OUT}/flow-mode-desktop.png`, fullPage: false });
    console.log("  Done");
    await ctx.close();
  }

  // --- 3. Regular mode mobile ---
  console.log("3/4: regular-mode-mobile.png");
  {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      isMobile: true,
      hasTouch: true,
    });
    const page = await ctx.newPage();
    await setupPage(page, false);
    await injectRegularMode(page);
    await page.screenshot({ path: `${OUT}/regular-mode-mobile.png`, fullPage: false });
    console.log("  Done");
    await ctx.close();
  }

  // --- 4. Flow mode mobile ---
  console.log("4/4: flow-mode-mobile.png");
  {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      isMobile: true,
      hasTouch: true,
    });
    const page = await ctx.newPage();
    await setupPage(page, true);
    await injectFlowMode(page);
    await page.screenshot({ path: `${OUT}/flow-mode-mobile.png`, fullPage: false });
    console.log("  Done");
    await ctx.close();
  }

  await browser.close();
  console.log(`\nAll 4 screenshots saved to ${OUT}/`);
}

main().catch(err => {
  console.error("Screenshot error:", err);
  process.exit(1);
});
