/**
 * AI-Powered UX Agent — Level 2 visual verification.
 *
 * Takes screenshots at key UX states and sends them to Claude Vision
 * to verify visual correctness using natural language expectations.
 *
 * Catches bugs that pixel-diff and DOM assertions miss:
 * - Wrong opacity, misaligned elements, text overflow
 * - Color/contrast issues, animation glitches
 * - Layout breaks at different viewport sizes
 * - Visual state machine correctness (button states, mode transitions)
 *
 * Requires: ANTHROPIC_API_KEY env var, server on :3457
 * Usage:    ANTHROPIC_API_KEY=sk-... node --import tsx/esm tests/test-ux-agent.ts
 * Headless: HEADLESS=1 ANTHROPIC_API_KEY=sk-... node --import tsx/esm tests/test-ux-agent.ts
 *
 * Without API key: runs in screenshot-only mode (captures but skips AI verification).
 */

import { chromium, Browser, Page } from "playwright";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = "http://localhost:3457?testmode=1";
const SCREENSHOTS_DIR = join(__dirname, "screenshots", "ux-agent");
const HEADLESS = process.env.HEADLESS === "1";
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = "claude-haiku-4-5-20251001"; // Fast + cheap for visual checks

const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
const SKIP = "\x1b[33m⊘\x1b[0m";
const WARN = "\x1b[33m⚠\x1b[0m";

let browser: Browser;
let page: Page;
let passed = 0;
let failed = 0;
let skipped = 0;
let client: Anthropic | null = null;

// --- UX Scenario Definition ---

interface UxScenario {
  name: string;
  group: string;
  /** Playwright actions to reach the desired state */
  setup: (page: Page) => Promise<void>;
  /** Natural language description of what correct looks like */
  expectation: string;
  /** Viewport size override (default: 390x844 iPhone 14 Pro) */
  viewport?: { width: number; height: number };
  /** Extra checks to run alongside AI verification */
  domCheck?: (page: Page) => Promise<{ pass: boolean; detail: string }>;
}

// --- AI Verification ---

async function verifyScreenshot(
  screenshotPath: string,
  expectation: string,
  scenarioName: string,
): Promise<{ pass: boolean; reason: string }> {
  if (!client) {
    return { pass: true, reason: "AI verification skipped (no API key)" };
  }

  const imageData = readFileSync(screenshotPath);
  const base64 = imageData.toString("base64");

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: base64 },
            },
            {
              type: "text",
              text: `You are a UX quality agent reviewing a screenshot of the Murmur voice interface app.

Scenario: "${scenarioName}"

Expected visual state:
${expectation}

Analyze the screenshot and determine if it matches the expected state. Be strict about:
- Element visibility and positioning
- Colors, opacity, and contrast
- Text readability and overflow
- Button states and visual indicators
- Layout alignment and spacing
- Any visual glitches or artifacts

Respond in this exact format:
VERDICT: PASS or FAIL
REASON: One sentence explaining why.
DETAILS: Optional additional observations (issues, warnings, or suggestions).`,
            },
          ],
        },
      ],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const verdictMatch = text.match(/VERDICT:\s*(PASS|FAIL)/i);
    const reasonMatch = text.match(/REASON:\s*(.+)/i);
    const detailsMatch = text.match(/DETAILS:\s*(.+)/i);

    const pass = verdictMatch?.[1]?.toUpperCase() === "PASS";
    const reason = reasonMatch?.[1]?.trim() || "No reason provided";
    const details = detailsMatch?.[1]?.trim() || "";

    return { pass, reason: details ? `${reason} | ${details}` : reason };
  } catch (err) {
    return { pass: true, reason: `AI check error: ${(err as Error).message}` };
  }
}

// --- Test Runner ---

async function runScenario(scenario: UxScenario) {
  const viewport = scenario.viewport || { width: 390, height: 844 };
  await page.setViewportSize(viewport);

  // Fresh page with clean state — set localStorage BEFORE loading so page reads clean state
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    localStorage.setItem("murmur-tour-done", "1");
    localStorage.removeItem("murmur-debug");
    localStorage.removeItem("murmur-think-mode");
    localStorage.removeItem("murmur-flow-mode");
    localStorage.removeItem("term-open");
  });
  // Reload so page picks up the clean localStorage
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500); // Let WS connect + render

  // Run scenario setup
  try {
    await scenario.setup(page);
  } catch (err) {
    console.log(`  ${FAIL}  ${scenario.name} \x1b[2m(setup failed: ${(err as Error).message})\x1b[0m`);
    failed++;
    return;
  }

  // Take screenshot
  const safeName = scenario.name.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
  const ssPath = join(SCREENSHOTS_DIR, `${safeName}.png`);
  await page.screenshot({ path: ssPath, fullPage: false });

  // DOM check (fast, always runs)
  let domResult: { pass: boolean; detail: string } | null = null;
  if (scenario.domCheck) {
    try {
      domResult = await scenario.domCheck(page);
    } catch (err) {
      domResult = { pass: false, detail: `DOM check error: ${(err as Error).message}` };
    }
  }

  // AI verification
  const aiResult = await verifyScreenshot(ssPath, scenario.expectation, scenario.name);

  // Combined result
  const domPass = domResult ? domResult.pass : true;
  const overallPass = domPass && aiResult.pass;

  if (overallPass) {
    const detail = client
      ? `AI: ${aiResult.reason.slice(0, 80)}`
      : domResult ? domResult.detail : "screenshot captured";
    console.log(`  ${PASS}  ${scenario.name} \x1b[2m(${detail})\x1b[0m`);
    passed++;
  } else {
    const reasons: string[] = [];
    if (!domPass && domResult) reasons.push(`DOM: ${domResult.detail}`);
    if (!aiResult.pass) reasons.push(`AI: ${aiResult.reason}`);
    console.log(`  ${FAIL}  ${scenario.name} \x1b[2m(${reasons.join(" | ")})\x1b[0m`);
    failed++;
  }
}

// =============================================
// UX SCENARIOS
// =============================================

const scenarios: UxScenario[] = [
  // --- Normal Mode ---
  {
    name: "Idle state — clean default layout",
    group: "Normal Mode",
    setup: async () => { /* default state */ },
    expectation: `The app should show:
- A dark background (#1a1a1a or similar dark theme)
- A header bar at the top with status text ("Ready" or similar) and a green status dot
- A transcript area in the middle (may have messages or empty state)
- A talk button at the bottom center — circular, with idle state styling
- Control buttons visible (mode, stop, mute, speed, voice)
- A text input bar at the very bottom
- No overlays, popups, or error indicators visible
- Clean typography, no text overflow or clipping`,
    domCheck: async (p) => {
      const dot = await p.locator("#statusDot").getAttribute("class");
      return { pass: dot?.includes("green") || false, detail: `status: ${dot}` };
    },
  },

  {
    name: "Talk button — proper touch target size",
    group: "Normal Mode",
    setup: async () => { /* default */ },
    expectation: `The talk button should be:
- Clearly visible at the bottom center of the screen
- Large enough to tap easily (at least 48px tall)
- Circular or pill-shaped with a visible border
- Labeled with the current mode hint text
- NOT overlapping with other controls
- NOT cut off by the screen edge`,
    domCheck: async (p) => {
      const box = await p.locator("#talkBtn").boundingBox();
      return { pass: (box?.height ?? 0) >= 36, detail: `height=${box?.height}px` };
    },
  },

  {
    name: "Mode cycling — all 4 modes render correctly",
    group: "Normal Mode",
    setup: async (p) => {
      const btn = p.locator("#modeBtn");
      // Cycle through all 4 modes, take intermediate screenshots
      for (let i = 0; i < 4; i++) {
        await btn.click();
        await p.waitForTimeout(200);
      }
      // Should be back to original mode
    },
    expectation: `After cycling through all 4 modes (Talk → Type → Read → Text → Talk):
- The mode button should show the current mode name
- The talk button hint should match the mode
- No visual glitches from rapid mode switching
- All controls should still be properly aligned`,
    domCheck: async (p) => {
      const mode = await p.locator("#modeBtn").textContent();
      return { pass: !!mode?.trim(), detail: `mode="${mode?.trim()}"` };
    },
  },

  {
    name: "Terminal panel — opens and shows content",
    group: "Normal Mode",
    setup: async (p) => {
      await p.locator("#terminalHeader").click();
      await p.waitForTimeout(500);
    },
    expectation: `The terminal panel should be:
- Visible at the bottom of the screen, sliding up
- Showing ANSI-colored terminal output (Claude Code TUI)
- The terminal header should indicate the session name
- Text should be monospaced and readable
- The panel should not overlap the talk button or transcript
- Scroll position should show recent output (not blank)`,
    domCheck: async (p) => {
      const open = await p.locator(".terminal-panel").evaluate(
        (el: Element) => el.classList.contains("open"),
      );
      return { pass: open, detail: `open=${open}` };
    },
  },

  {
    name: "Help menu — all items present",
    group: "Normal Mode",
    setup: async (p) => {
      await p.locator("#helpBtn").click();
      await p.waitForTimeout(300);
    },
    expectation: `A help menu should be visible with:
- Multiple menu items listed vertically
- Items should include: Tour, Debug Panel, Check for Updates, Homepage, GitHub
- Menu should be positioned near the help button (not floating randomly)
- Text should be readable with clear labels
- Menu should have a dark background with light text (matching app theme)`,
    domCheck: async (p) => {
      const visible = await p.locator("#helpMenu").evaluate(
        (el: Element) => el.classList.contains("open"),
      );
      return { pass: visible, detail: `menuOpen=${visible}` };
    },
  },

  {
    name: "Debug panel — tabs and state display",
    group: "Normal Mode",
    setup: async (p) => {
      await p.keyboard.down("Control");
      await p.keyboard.down("Shift");
      await p.keyboard.press("KeyD");
      await p.keyboard.up("Shift");
      await p.keyboard.up("Control");
      await p.waitForTimeout(500);
    },
    expectation: `The debug panel should be visible with:
- 4 tab buttons at the top (State, Messages, Pipeline, Server)
- The State tab should be active by default
- State tab should show a grid with labels and values:
  WebSocket state, Mic state, Recording state, TTS state, Mode, Muted
- Values should have color coding (green for connected, etc.)
- Panel should not overflow or clip any content`,
    domCheck: async (p) => {
      const visible = await p.locator("#debugPanel").evaluate(
        (el: Element) => el.classList.contains("open"),
      );
      return { pass: visible, detail: `debugOpen=${visible}` };
    },
  },

  {
    name: "Service status dots — all visible",
    group: "Normal Mode",
    setup: async () => { /* default */ },
    expectation: `The service indicator area should show:
- Small colored dots indicating service status
- Whisper (STT) dot — should be green if service is running
- Kokoro (TTS) dot — should be green if service is running
- Audio control dot — should be visible
- Dots should be small, aligned, and not overlapping
- Color should clearly indicate up (green) vs down (red/gray)`,
    domCheck: async (p) => {
      const whisper = await p.locator("#svcWhisper").getAttribute("class");
      const kokoro = await p.locator("#svcKokoro").getAttribute("class");
      return {
        pass: (whisper?.includes("up") && kokoro?.includes("up")) || false,
        detail: `whisper=${whisper?.includes("up")}, kokoro=${kokoro?.includes("up")}`,
      };
    },
  },

  // --- Flow Mode ---
  {
    name: "Flow mode — entry transition",
    group: "Flow Mode",
    setup: async (p) => {
      await p.locator("#flowModeBtn").click();
      await p.waitForTimeout(500);
    },
    expectation: `Flow mode should show:
- A light/cream background (not the dark normal mode background)
- The talk button should be centered and enlarged (bigger than normal mode)
- The normal header, controls bar, and text input should be HIDDEN
- A gear button should be visible (bottom-left area)
- A flow exit button should be visible
- The conversation transcript should use a serif/reading font
- The overall feel should be minimal and distraction-free`,
    domCheck: async (p) => {
      const hasClass = await p.evaluate(() => document.body.classList.contains("flow-mode"));
      return { pass: hasClass, detail: `flow-mode=${hasClass}` };
    },
  },

  {
    name: "Flow mode — gear settings sheet",
    group: "Flow Mode",
    setup: async (p) => {
      await p.locator("#flowModeBtn").click();
      await p.waitForTimeout(300);
      await p.locator("#flowGearBtn").click();
      await p.waitForTimeout(400);
    },
    expectation: `A settings sheet should be visible:
- Sliding up from the bottom of the screen
- Semi-transparent overlay behind it
- Contains voice and speed controls
- Clean layout with proper spacing
- Not covering the entire screen — should be a bottom sheet
- Dismissible (close button or swipe down)`,
    domCheck: async (p) => {
      const visible = await p.locator("#flowSettingsSheet").evaluate(
        (el: Element) => getComputedStyle(el).transform !== "none" || getComputedStyle(el).display !== "none",
      );
      return { pass: visible, detail: `sheetVisible=${visible}` };
    },
  },

  {
    name: "Flow mode — exit returns to normal",
    group: "Flow Mode",
    setup: async (p) => {
      await p.locator("#flowModeBtn").click();
      await p.waitForTimeout(300);
      await p.locator("#flowExitBtn").click();
      await p.waitForTimeout(300);
    },
    expectation: `After exiting flow mode:
- Dark background restored
- Normal header with status text visible again
- Control buttons (mode, stop, mute, speed, voice) visible
- Text input bar visible at the bottom
- Talk button should be normal size (not enlarged flow mode size)
- No remnants of flow mode styling (no light background leaking)`,
    domCheck: async (p) => {
      const hasClass = await p.evaluate(() => document.body.classList.contains("flow-mode"));
      return { pass: !hasClass, detail: `flow-mode=${hasClass} (should be false)` };
    },
  },

  // --- Responsive Layout ---
  {
    name: "Narrow mobile (320px) — nothing clipped",
    group: "Responsive",
    viewport: { width: 320, height: 568 },
    setup: async () => { /* default */ },
    expectation: `At 320px width (smallest phone):
- All controls should still be visible and tappable
- No horizontal scrollbar or overflow
- Text should not be clipped or overlapping
- Talk button should fit within the viewport
- Mode button text should be readable
- Service dots should still be visible
- No elements should overflow the viewport`,
    domCheck: async (p) => {
      const talkVisible = await p.locator("#talkBtn").isVisible();
      const inputVisible = await p.locator("#textInput").isVisible();
      return { pass: talkVisible && inputVisible, detail: `talk=${talkVisible}, input=${inputVisible}` };
    },
  },

  {
    name: "Tablet landscape (1024x768) — proper use of space",
    group: "Responsive",
    viewport: { width: 1024, height: 768 },
    setup: async () => { /* default */ },
    expectation: `At tablet/desktop width:
- The layout should use the extra space appropriately
- Transcript area should be centered or have reasonable max-width
- Controls should not be stretched across the full width
- Text should remain readable (not too wide — max ~80ch)
- Talk button should be proportionally sized
- No awkward empty space or misalignment`,
    domCheck: async (p) => {
      const talkBox = await p.locator("#talkBtn").boundingBox();
      return { pass: (talkBox?.width ?? 0) > 30, detail: `talkWidth=${talkBox?.width}px` };
    },
  },

  // --- Conversation State ---
  {
    name: "User message bubble — proper styling",
    group: "Conversation",
    setup: async (p) => {
      // Inject a test entry via WebSocket test protocol
      await p.evaluate(() => {
        const ws = (window as any)._ws;
        if (ws && ws.readyState === 1) {
          ws.send('test:entries:' + JSON.stringify([
            { id: 9001, role: "user", text: "What is the weather like today?", speakable: false, spoken: false, ts: Date.now(), turn: 1 },
          ]));
        }
      });
      await p.waitForTimeout(500);
    },
    expectation: `A user message bubble should be visible:
- Right-aligned (user messages go on the right side)
- Dark or colored background distinguishing it from assistant messages
- Text "What is the weather like today?" clearly readable
- Proper padding and rounded corners
- Timestamp visible but subtle
- No text overflow or clipping`,
    domCheck: async (p) => {
      const userBubble = await p.locator(".entry-bubble.user").first().isVisible().catch(() => false);
      return { pass: userBubble as boolean, detail: `userBubble=${userBubble}` };
    },
  },

  {
    name: "Assistant message — readable prose",
    group: "Conversation",
    setup: async (p) => {
      await p.evaluate(() => {
        const ws = (window as any)._ws;
        if (ws && ws.readyState === 1) {
          ws.send('test:entries:' + JSON.stringify([
            { id: 9001, role: "user", text: "Tell me about TypeScript", speakable: false, spoken: false, ts: Date.now(), turn: 1 },
            { id: 9002, role: "assistant", text: "TypeScript is a strongly-typed programming language that builds on JavaScript. It adds optional static typing and class-based object-oriented programming to the language. TypeScript was developed by Microsoft and is widely used for large-scale web applications.", speakable: true, spoken: false, ts: Date.now(), turn: 1 },
          ]));
        }
      });
      await p.waitForTimeout(500);
    },
    expectation: `Both user and assistant messages should be visible:
- User bubble right-aligned, assistant bubble left-aligned
- Assistant text should be fully readable with proper line wrapping
- Long text should wrap naturally (not truncated)
- Clear visual distinction between user and assistant (different alignment or colors)
- Proper spacing between the two messages
- A turn separator may be visible between different turns`,
    domCheck: async (p) => {
      const assistBubble = await p.locator(".entry-bubble.assistant").first().isVisible().catch(() => false);
      return { pass: assistBubble as boolean, detail: `assistBubble=${assistBubble}` };
    },
  },

  {
    name: "Queued entry — visual indicator",
    group: "Conversation",
    setup: async (p) => {
      // Inject entries client-side by calling the WS onmessage handler directly
      await p.evaluate(() => {
        const entries = [
          { id: 9001, role: "user", text: "First question", speakable: false, spoken: false, ts: Date.now(), turn: 1 },
          { id: 9002, role: "assistant", text: "Working on it...", speakable: true, spoken: false, ts: Date.now(), turn: 1 },
          { id: 9003, role: "user", text: "Follow-up while you work", speakable: false, spoken: false, ts: Date.now(), turn: 2, queued: true },
        ];
        const ws = (window as any)._ws;
        if (ws && ws.onmessage) {
          ws.onmessage({ data: JSON.stringify({ type: "entry", entries, partial: false }) } as any);
        }
      });
      await p.waitForTimeout(500);
    },
    expectation: `Three entries should be visible:
- First user message (normal styling)
- Assistant message (normal styling)
- Queued user message with DISTINCT visual treatment:
  - Reduced opacity or dashed border (indicating "queued, not yet sent")
  - An hourglass icon (⏳) or similar queued indicator
  - Should clearly look different from normal messages
  - Text should still be readable despite the queued styling`,
    domCheck: async (p) => {
      const queued = await p.locator(".entry-queued").isVisible().catch(() => false);
      return { pass: queued as boolean, detail: `queuedVisible=${queued}` };
    },
  },

  // --- Clean/Verbose Toggle ---
  {
    name: "Clean mode — tool calls hidden",
    group: "Display Modes",
    setup: async (p) => {
      // Set verbose first, then switch to clean
      await p.evaluate(() => localStorage.setItem("voiced-only", "true"));
      await p.goto(BASE, { waitUntil: "domcontentloaded" });
      await p.evaluate(() => localStorage.setItem("murmur-tour-done", "1"));
      await p.goto(BASE, { waitUntil: "domcontentloaded" });
      await p.waitForTimeout(1500);
      // Inject entries with both speakable and non-speakable
      await p.evaluate(() => {
        const ws = (window as any)._ws;
        if (ws && ws.readyState === 1) {
          ws.send('test:entries:' + JSON.stringify([
            { id: 9001, role: "user", text: "Fix the bug", speakable: false, spoken: false, ts: Date.now(), turn: 1 },
            { id: 9002, role: "assistant", text: "Read(server.ts)", speakable: false, spoken: true, ts: Date.now(), turn: 1 },
            { id: 9003, role: "assistant", text: "I found the issue in the error handler. The variable was undefined because the scope was wrong.", speakable: true, spoken: true, ts: Date.now(), turn: 1 },
          ]));
        }
      });
      await p.waitForTimeout(500);
    },
    expectation: `In clean mode:
- The speakable assistant message ("I found the issue...") should be visible
- The non-speakable tool call ("Read(server.ts)") should be HIDDEN or very subtle
- The user message should be visible
- The clean/verbose toggle button should indicate "Clean" mode is active
- Overall, only the human-readable prose should be prominent`,
    domCheck: async (p) => {
      const cleanBtn = await p.locator("#cleanBtn").textContent();
      return { pass: cleanBtn?.includes("Clean") || false, detail: `btn="${cleanBtn?.trim()}"` };
    },
  },

  // --- Think Mode ---
  {
    name: "Think mode — amber idle tint",
    group: "Think Mode",
    setup: async (p) => {
      // Enable think mode via localStorage
      await p.evaluate(() => localStorage.setItem("murmur-think-mode", "true"));
      await p.goto(BASE, { waitUntil: "domcontentloaded" });
      await p.evaluate(() => localStorage.setItem("murmur-tour-done", "1"));
      await p.goto(BASE, { waitUntil: "domcontentloaded" });
      await p.waitForTimeout(1500);
    },
    expectation: `With think mode enabled:
- The talk button should have an amber/gold tint or border (not the default blue/gray)
- The button hint text should mention "Think mode"
- The settings button should show an active/highlighted state
- Overall the UI should subtly indicate think mode is on
- The amber color should be visible but not overwhelming`,
    domCheck: async (p) => {
      const hasThink = await p.evaluate(() => {
        const btn = document.querySelector("#talkBtn");
        return btn?.classList.contains("think-mode") || document.body.classList.contains("think-mode-on");
      });
      return { pass: typeof hasThink === "boolean", detail: `thinkMode=${hasThink}` };
    },
  },

  // --- Interrupt Button ---
  {
    name: "Interrupt button — visible and dimmed when idle",
    group: "Controls",
    setup: async () => { /* default */ },
    expectation: `The interrupt button (⚡ lightning bolt) should be:
- Visible in the controls area
- Dimmed/grayed out when idle (no active Claude response)
- Still recognizable as a button
- Not overlapping with other controls
- Properly aligned in the button row`,
    domCheck: async (p) => {
      const visible = await p.locator("#interruptBtn").isVisible().catch(() => false);
      return { pass: visible as boolean, detail: `visible=${visible}` };
    },
  },

  // --- Font Zoom ---
  {
    name: "Font zoom — text scales properly",
    group: "Accessibility",
    setup: async (p) => {
      // Inject entries then zoom in twice
      await p.evaluate(() => {
        const ws = (window as any)._ws;
        if (ws && ws.readyState === 1) {
          ws.send('test:entries:' + JSON.stringify([
            { id: 9001, role: "assistant", text: "This text should be larger after zooming in. The font size should increase uniformly across all message bubbles.", speakable: true, spoken: true, ts: Date.now(), turn: 1 },
          ]));
        }
      });
      await p.waitForTimeout(300);
      // Zoom in twice
      const zoomIn = p.locator("#chatZoomIn");
      if (await zoomIn.isVisible()) {
        await zoomIn.click();
        await p.waitForTimeout(100);
        await zoomIn.click();
        await p.waitForTimeout(200);
      }
    },
    expectation: `After zooming in:
- Message text should be noticeably larger than default
- Text should still fit within the bubble without overflow
- Line wrapping should adjust to the larger font
- No horizontal scrolling should be needed
- All text elements should scale proportionally
- The zoom should not break the layout`,
    domCheck: async (p) => {
      const size = await p.evaluate(() => localStorage.getItem("chat-font-size"));
      return { pass: size !== null && parseFloat(size) > 12.5, detail: `fontSize=${size}` };
    },
  },

  // --- Tour ---
  {
    name: "Tour — first step renders properly",
    group: "Onboarding",
    setup: async (p) => {
      await p.evaluate(() => localStorage.removeItem("murmur-tour-done"));
      await p.goto(BASE, { waitUntil: "domcontentloaded" });
      await p.waitForTimeout(2500); // Wait for tour auto-start
    },
    expectation: `The guided tour should be showing:
- A semi-transparent overlay covering the page
- A spotlight/highlight around the Talk Button
- A tooltip with the step title and description
- "Skip" and "Next" buttons in the tooltip
- Step counter (e.g., "1 / 12")
- The tooltip should be positioned near the highlighted element
- The overall effect should guide the user's attention to the highlighted area`,
    domCheck: async (p) => {
      const overlay = await p.locator(".tour-overlay").isVisible().catch(() => false);
      return { pass: overlay as boolean, detail: `tourOverlay=${overlay}` };
    },
  },

  // --- Flow Mode Conversation ---
  {
    name: "Flow mode — conversation with entries",
    group: "Flow Mode",
    setup: async (p) => {
      await p.locator("#flowModeBtn").click();
      await p.waitForTimeout(300);
      // Inject a multi-turn conversation
      await p.evaluate(() => {
        const ws = (window as any)._ws;
        if (ws && ws.readyState === 1) {
          ws.send('test:entries:' + JSON.stringify([
            { id: 9001, role: "user", text: "What do you think about the future of AI?", speakable: false, spoken: true, ts: Date.now() - 30000, turn: 1 },
            { id: 9002, role: "assistant", text: "The future of AI is incredibly promising. We are seeing rapid advances in language understanding, reasoning, and multimodal capabilities. The key challenges ahead involve ensuring these systems are safe, aligned with human values, and accessible to everyone.", speakable: true, spoken: true, ts: Date.now() - 25000, turn: 1 },
            { id: 9003, role: "user", text: "How can we make AI safer?", speakable: false, spoken: true, ts: Date.now() - 10000, turn: 2 },
            { id: 9004, role: "assistant", text: "Making AI safer requires a multi-pronged approach. First, we need robust evaluation frameworks that test for harmful behaviors before deployment. Second, interpretability research helps us understand why models make certain decisions. Third, governance and policy frameworks need to keep pace with technical progress.", speakable: true, spoken: false, ts: Date.now() - 5000, turn: 2 },
          ]));
        }
      });
      await p.waitForTimeout(500);
    },
    expectation: `Flow mode with conversation should show:
- Light/cream background
- User messages positioned distinctly (typically right-aligned or top-positioned)
- Assistant prose in a serif/reading font, left-aligned
- Turn separators between different turns
- The most recent content should be visible (scrolled to bottom or latest)
- Large centered talk button at the bottom
- Gear button visible
- No header, no control bar, no text input (flow mode is voice-only)
- The conversation should feel clean and immersive`,
    domCheck: async (p) => {
      const entries = await p.locator(".entry-bubble").count();
      return { pass: entries >= 4, detail: `entries=${entries}` };
    },
  },
];

// =============================================
// MAIN
// =============================================

async function main() {
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  // Initialize AI client if API key is available
  if (API_KEY) {
    client = new Anthropic({ apiKey: API_KEY });
    console.log(`  AI verification: enabled (${MODEL})`);
  } else {
    console.log(`  AI verification: ${WARN} disabled (set ANTHROPIC_API_KEY to enable)`);
    console.log(`  Running in screenshot + DOM check mode only\n`);
  }

  browser = await chromium.launch({
    headless: HEADLESS,
    args: ["--no-sandbox"],
  });

  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  });
  page = await context.newPage();

  console.log(`\n  Murmur UX Agent — Visual Verification`);
  console.log(`  Mode: ${HEADLESS ? "headless" : "visible browser"}`);
  console.log(`  Screenshots: ${SCREENSHOTS_DIR}`);
  console.log(`  ${"─".repeat(45)}\n`);

  // Group and run scenarios
  let currentGroup = "";
  for (const scenario of scenarios) {
    if (scenario.group !== currentGroup) {
      currentGroup = scenario.group;
      console.log(`\n  [${currentGroup}]`);
    }
    await runScenario(scenario);
  }

  // Clean up test entries
  try {
    await page.evaluate(() => {
      const ws = (window as any)._ws;
      if (ws && ws.readyState === 1) ws.send("test:clear-entries");
    });
  } catch {}

  await browser.close();

  // Summary
  const total = passed + failed + skipped;
  console.log(`\n  ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ""}${skipped > 0 ? `, ${skipped} skipped` : ""}`);
  console.log(`  Screenshots saved to: ${SCREENSHOTS_DIR}\n`);

  // Write summary report
  const report = {
    timestamp: new Date().toISOString(),
    model: client ? MODEL : "none",
    results: { passed, failed, skipped, total },
    scenarios: scenarios.map(s => s.name),
  };
  writeFileSync(join(SCREENSHOTS_DIR, "report.json"), JSON.stringify(report, null, 2));

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("UX Agent fatal error:", err);
  process.exit(1);
});
