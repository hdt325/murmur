/**
 * Comprehensive flow mode tests — simulates real user behavior end-to-end.
 *
 * Unlike test-smoke.ts (which uses synthetic DOM insertions), these tests:
 *  - Call renderEntries() with real server-format entry data
 *  - Test the user entry as the LAST item (no content below — the real scenario)
 *  - Test TTS word highlight via onTtsAudioStart (the actual code path)
 *  - Simulate a full conversation turn-by-turn
 *
 * Requires: server running on localhost:3457
 * ⚠️  MUST be run in the `test-runner` tmux session — NOT inside the claude-voice session.
 * Via helper:  tests/run.sh flow
 * Direct:      node --import tsx/esm tests/test-flow.ts  (in test-runner only)
 */

import { chromium, Browser, Page } from "playwright";
import { mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const BASE = "http://localhost:3457?testmode=1";
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = join(__dirname, "screenshots-flow");
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

async function shot(label: string) {
  screenshotIdx++;
  const filename = `${String(screenshotIdx).padStart(2, "0")}-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`;
  await page.screenshot({ path: join(SCREENSHOTS_DIR, filename) });
}

// Reload into flow mode with clean state
async function loadFlowMode() {
  // Navigate first so localStorage is accessible
  if (!page.url().startsWith(BASE)) {
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);
  }
  await page.evaluate(() => {
    localStorage.setItem("murmur-flow-mode", "1");
    localStorage.setItem("murmur-tour-done", "1");
  });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1800);
  // Wipe the transcript DOM so real server entries don't interfere with test IDs
  await page.evaluate(() => {
    const t = document.getElementById("transcript")!;
    // Remove all entry bubbles and separators (leave other children like emptyState)
    t.querySelectorAll(".entry-bubble, .turn-separator").forEach(el => el.remove());
  });
  // Reset flow initial render flag so we control when "first render" happens
  await page.evaluate(() => { (window as any).__murmur.flowInitialRender = false; });
}

// Call renderEntries via test hook
async function render(entries: object[], partial = false) {
  await page.evaluate(([ents, p]) => {
    (window as any).__murmur.renderEntries(ents, p);
  }, [entries, partial] as [object[], boolean]);
}

// Get scroll position of transcript
async function scrollInfo() {
  return page.evaluate(() => {
    const t = document.getElementById("transcript")!;
    return { scrollTop: t.scrollTop, scrollHeight: t.scrollHeight, clientHeight: t.clientHeight };
  });
}

// Get bounding of an entry relative to transcript top
async function entryTopRelative(entryId: string | number) {
  return page.evaluate((id) => {
    const t = document.getElementById("transcript")!;
    const el = document.querySelector(`.entry-bubble[data-entry-id="${id}"]`) as HTMLElement | null;
    if (!el) return null;
    const cR = t.getBoundingClientRect();
    const eR = el.getBoundingClientRect();
    return Math.round(eR.top - cR.top);
  }, String(entryId));
}

// Build a realistic conversation entry
function entry(id: number, role: "user" | "assistant", text: string, turn = 1, speakable = role === "assistant", spoken = false) {
  return { id, role, text, speakable, spoken, ts: Date.now(), turn };
}

// ═════════════════════════════════════════════════════════
// Group 1: Initial load with history
// ═════════════════════════════════════════════════════════
async function testGroup1_InitialLoad() {
  console.log("\n[Group 1] Initial load with history");

  await loadFlowMode();

  // Simulate history: 5 turn pairs (user + assistant each)
  const history: object[] = [];
  for (let i = 1; i <= 5; i++) {
    history.push(entry(i * 2 - 1, "user", `This is what I said in turn ${i}. It is a voice message.`, i));
    history.push(entry(i * 2, "assistant",
      `Sure! Here is my response for turn ${i}. It has multiple sentences to add some height. ` +
      `The assistant prose flows naturally without bullet points or markdown. ` +
      `This is how it looks in flow mode.`, i, true, true));
  }

  await render(history);
  await page.waitForTimeout(300);

  const info = await scrollInfo();
  const atBottom = info.scrollTop >= info.scrollHeight - info.clientHeight - 30;
  report("Initial render: scrolls to bottom with history", atBottom,
    `scrollTop=${info.scrollTop} max=${info.scrollHeight - info.clientHeight}`);
  await shot("initial-load-bottom");

  // All existing user entries should have data-scrolled-to
  const allMarked = await page.evaluate(() => {
    const els = document.querySelectorAll(".entry-bubble.user");
    return Array.from(els).every(el => (el as HTMLElement).dataset.scrolledTo === "1");
  });
  report("Initial render: all history user entries marked data-scrolled-to", allMarked);

  // _flowInitialRender should now be true
  const initRenderSet = await page.evaluate(() => !!(window as any).__murmur.flowInitialRender);
  report("Initial render: _flowInitialRender set to true", initRenderSet);
}

// ═════════════════════════════════════════════════════════
// Group 2: New user entry scrolls to near top
// ═════════════════════════════════════════════════════════
async function testGroup2_NewUserEntryScroll() {
  console.log("\n[Group 2] New user entry scroll (user entry IS the last item — no content below)");

  await loadFlowMode();

  // First: render history so _flowInitialRender becomes true
  const history: object[] = [];
  for (let i = 1; i <= 4; i++) {
    history.push(entry(i * 2 - 1, "user", `Earlier question number ${i}.`, i));
    history.push(entry(i * 2, "assistant",
      `Earlier answer for question ${i}. It spans a few sentences to create some height ` +
      `so the transcript has real content and real scroll range.`, i, true, true));
  }
  await render(history);
  await page.waitForTimeout(300);

  // Now add a NEW user entry as the LAST item — nothing below it yet (real scenario)
  const withNewUser = [...history, entry(9, "user", "Hey, can you tell me a joke?", 5)];
  await render(withNewUser);
  await page.waitForTimeout(300);

  const top = await entryTopRelative(9);
  const scrolledToTop = top !== null && top >= -10 && top <= 120;
  report("New user entry (last item, nothing below): scrolls to near top", scrolledToTop,
    `entryTop=${top}px (target 0–120px)`);
  await shot("new-user-entry-last-item");

  // Verify data-scrolled-to is set on the new entry
  const marked = await page.evaluate(() => {
    const el = document.querySelector('.entry-bubble[data-entry-id="9"]') as HTMLElement | null;
    return el ? el.dataset.scrolledTo === "1" : false;
  });
  report("New user entry: data-scrolled-to set after scroll", marked);

  // Verify transcript has enough padding-bottom to allow this scroll
  const hasPaddingBottom = await page.evaluate(() => {
    const t = document.getElementById("transcript")!;
    const style = window.getComputedStyle(t);
    const pb = parseFloat(style.paddingBottom);
    return pb > 200; // 80vh should be >>200px
  });
  report("Flow transcript has sufficient padding-bottom for scroll", hasPaddingBottom);
}

// ═════════════════════════════════════════════════════════
// Group 3: Streaming assistant update does not re-scroll user entry
// ═════════════════════════════════════════════════════════
async function testGroup3_NoReScrollOnStreaming() {
  console.log("\n[Group 3] Streaming update must NOT re-scroll the user entry");

  await loadFlowMode();

  const history: object[] = [];
  for (let i = 1; i <= 3; i++) {
    history.push(entry(i * 2 - 1, "user", `Turn ${i} question.`, i));
    history.push(entry(i * 2, "assistant", `Turn ${i} answer with some text.`, i, true, true));
  }
  await render(history);
  await page.waitForTimeout(200);

  // Add new user entry — should scroll to top
  await render([...history, entry(7, "user", "What is the meaning of life?", 4)]);
  await page.waitForTimeout(200);
  const topAfterUserEntry = await entryTopRelative(7);

  // Now simulate streaming: assistant starts responding (entry 8 partial)
  await render([...history,
    entry(7, "user", "What is the meaning of life?", 4),
    entry(8, "assistant", "Great question. Let me think...", 4, true, false)
  ], true); // partial=true
  await page.waitForTimeout(200);
  const topAfterStreaming1 = await entryTopRelative(7);

  // More streaming
  await render([...history,
    entry(7, "user", "What is the meaning of life?", 4),
    entry(8, "assistant", "Great question. Let me think... The meaning of life is to find your own meaning.", 4, true, false)
  ], true);
  await page.waitForTimeout(200);
  const topAfterStreaming2 = await entryTopRelative(7);

  const userEntryStable = (
    topAfterUserEntry !== null &&
    topAfterStreaming1 !== null &&
    topAfterStreaming2 !== null &&
    Math.abs(topAfterStreaming1 - topAfterUserEntry) < 5 &&
    Math.abs(topAfterStreaming2 - topAfterUserEntry) < 5
  );
  report("Streaming update does not re-scroll user entry", userEntryStable,
    `positions: ${topAfterUserEntry}px → ${topAfterStreaming1}px → ${topAfterStreaming2}px`);
  await shot("no-re-scroll-on-streaming");
}

// ═════════════════════════════════════════════════════════
// Group 4: Second user entry in same session
// ═════════════════════════════════════════════════════════
async function testGroup4_SecondUserEntry() {
  console.log("\n[Group 4] Second user entry also scrolls to near top");

  await loadFlowMode();

  // Full first turn
  const turn1 = [
    entry(1, "user", "Tell me about the weather today.", 1),
    entry(2, "assistant", "The weather today is sunny with a high of 72 degrees. Great day to go outside! " +
      "You might want to bring sunscreen if you plan to be out for a while.", 1, true, true),
  ];
  await render(turn1);
  await page.waitForTimeout(200);

  // Second user entry arrives — should also scroll to near top
  const turn2start = [...turn1, entry(3, "user", "What about tomorrow?", 2)];
  await render(turn2start);
  await page.waitForTimeout(300);

  const top = await entryTopRelative(3);
  const scrolledToTop = top !== null && top >= -10 && top <= 120;
  report("Second user entry (after completed turn): scrolls to near top", scrolledToTop,
    `entryTop=${top}px`);
  await shot("second-user-entry-scroll");

  // First user entry should still have data-scrolled-to (unchanged)
  const firstStillMarked = await page.evaluate(() => {
    const el = document.querySelector('.entry-bubble[data-entry-id="1"]') as HTMLElement | null;
    return el ? el.dataset.scrolledTo === "1" : false;
  });
  report("First user entry still marked scrolled-to after second entry", firstStillMarked);
}

// ═════════════════════════════════════════════════════════
// Group 5: TTS word highlight via onTtsAudioStart
// ═════════════════════════════════════════════════════════
async function testGroup5_TtsWordHighlight() {
  console.log("\n[Group 5] TTS word-by-word highlight via onTtsAudioStart");

  await loadFlowMode();

  await render([
    entry(1, "user", "Tell me a short story.", 1),
    entry(2, "assistant", "Once upon a time there was a small cat.", 1, true, false),
  ]);
  await page.waitForTimeout(300);

  // Entry 2 should be dim (not yet spoken) — color has alpha < 0.5
  const isDimBefore = await page.evaluate(() => {
    const el = document.querySelector('.entry-bubble[data-entry-id="2"]') as HTMLElement | null;
    if (!el) return false;
    const color = window.getComputedStyle(el).color;
    // Match rgba(r, g, b, alpha) where alpha < 0.5
    const m = color.match(/rgba?\(\s*[\d.]+,\s*[\d.]+,\s*[\d.]+(?:,\s*([\d.]+))?\s*\)/);
    const alpha = m && m[1] != null ? parseFloat(m[1]) : 1;
    return alpha < 0.5;
  });
  report("Assistant entry is dim before TTS starts", isDimBefore);

  // Simulate TTS starting: set pending highlight, call onTtsAudioStart
  await page.evaluate(() => {
    const m = (window as any).__murmur;
    m.pendingHighlightEntryId = "2";
    m.pendingHighlightSpeakableText = "Once upon a time there was a small cat.";
  });

  // Call onTtsAudioStart with a realistic duration (2500ms for ~8 words)
  await page.evaluate(() => {
    (window as any).__murmur.onTtsAudioStart(2500);
  });
  await page.waitForTimeout(100);

  // Entry should now have bubble-active
  const hasBubbleActive = await page.evaluate(() => {
    const el = document.querySelector('.entry-bubble[data-entry-id="2"]');
    return el ? el.classList.contains("bubble-active") : false;
  });
  report("onTtsAudioStart: entry gets bubble-active class", hasBubbleActive);

  // Entry text should be wrapped in tts-word spans
  const hasWordSpans = await page.evaluate(() => {
    const el = document.querySelector('.entry-bubble[data-entry-id="2"]');
    if (!el) return false;
    const spans = el.querySelectorAll(".tts-word, .tts-word-spoken");
    return spans.length > 0;
  });
  report("onTtsAudioStart: text wrapped in tts-word spans", hasWordSpans);

  // At t=0, at least first word should still be grey (animation hasn't finished)
  const firstWordGrey = await page.evaluate(() => {
    const el = document.querySelector('.entry-bubble[data-entry-id="2"]');
    if (!el) return false;
    const greySpans = el.querySelectorAll(".tts-word");
    return greySpans.length > 0;
  });
  report("onTtsAudioStart: some words start as grey (tts-word)", firstWordGrey);

  await shot("tts-highlight-start");

  // Wait for ~half the words to animate
  await page.waitForTimeout(1400);

  const someSpoken = await page.evaluate(() => {
    const el = document.querySelector('.entry-bubble[data-entry-id="2"]');
    if (!el) return false;
    const spoken = el.querySelectorAll(".tts-word-spoken").length;
    const unspoken = el.querySelectorAll(".tts-word").length;
    return spoken > 0 && unspoken >= 0;
  });
  report("onTtsAudioStart: words progressively become tts-word-spoken", someSpoken);

  // Wait for all words to complete
  await page.waitForTimeout(1500);

  const allSpoken = await page.evaluate(() => {
    const el = document.querySelector('.entry-bubble[data-entry-id="2"]');
    if (!el) return false;
    const unspoken = el.querySelectorAll(".tts-word").length;
    const spoken = el.querySelectorAll(".tts-word-spoken").length;
    return unspoken === 0 && spoken > 0;
  });
  report("onTtsAudioStart: all words become tts-word-spoken by end of duration", allSpoken);
  await shot("tts-highlight-complete");
}

// ═════════════════════════════════════════════════════════
// Group 6: TTS scroll — speaking entry scrolls to near top
// ═════════════════════════════════════════════════════════
async function testGroup6_TtsScroll() {
  console.log("\n[Group 6] TTS scroll — speaking assistant entry scrolls to near top");

  await loadFlowMode();

  // Build up content so assistant entries are off-screen below
  const entries: object[] = [];
  for (let i = 1; i <= 3; i++) {
    entries.push(entry(i * 2 - 1, "user", `Previous question ${i}.`, i));
    entries.push(entry(i * 2, "assistant",
      `Previous answer ${i}. This is a longer response to ensure the transcript has enough ` +
      `height that later entries are off-screen when scrolled to top.`, i, true, true));
  }
  // New user entry
  entries.push(entry(7, "user", "New question right now.", 4));
  // First assistant paragraph (not yet spoken)
  entries.push(entry(8, "assistant", "Here is the first paragraph of my answer.", 4, true, false));
  // Second assistant paragraph (not yet spoken, further down)
  entries.push(entry(9, "assistant", "And here is the second paragraph continuing the answer.", 4, true, false));

  await render(entries);
  await page.waitForTimeout(300);

  // Scroll to bottom first (simulate app state during recording/thinking)
  await page.evaluate(() => {
    document.getElementById("transcript")!.scrollTop = 999999;
  });
  await page.waitForTimeout(100);

  // TTS starts on entry 8 (first assistant paragraph)
  await page.evaluate(() => {
    const m = (window as any).__murmur;
    m.pendingHighlightEntryId = "8";
    m.pendingHighlightSpeakableText = "Here is the first paragraph of my answer.";
    m.onTtsAudioStart(1500);
  });
  await page.waitForTimeout(200);

  const top8 = await entryTopRelative(8);
  const entry8NearTop = top8 !== null && top8 >= -20 && top8 <= 80;
  report("TTS start scrolls speaking assistant entry to near top", entry8NearTop,
    `entryTop=${top8}px`);
  await shot("tts-scroll-entry8");

  // TTS moves to entry 9 (second paragraph)
  await page.waitForTimeout(1600); // let first chunk finish

  await page.evaluate(() => {
    const m = (window as any).__murmur;
    m.pendingHighlightEntryId = "9";
    m.pendingHighlightSpeakableText = "And here is the second paragraph continuing the answer.";
    m.onTtsAudioStart(1500);
  });
  await page.waitForTimeout(200);

  const top9 = await entryTopRelative(9);
  const entry9NearTop = top9 !== null && top9 >= -20 && top9 <= 80;
  report("TTS advances to next paragraph: scrolls new speaking entry to near top", entry9NearTop,
    `entryTop=${top9}px`);
  await shot("tts-scroll-entry9");
}

// ═════════════════════════════════════════════════════════
// Group 7: Visual CSS states
// ═════════════════════════════════════════════════════════
async function testGroup7_VisualStates() {
  console.log("\n[Group 7] Visual CSS states");

  await loadFlowMode();

  await render([
    entry(1, "user", "Hello there.", 1),
    entry(2, "assistant", "Unspoken response — should be dim.", 1, true, false),
    entry(3, "assistant", "Already spoken — should stay dark.", 1, true, true),
  ]);
  await page.waitForTimeout(300);

  // Mark entry 3 as bubble-spoken (simulating it was spoken)
  await page.evaluate(() => {
    const el = document.querySelector('.entry-bubble[data-entry-id="3"]');
    if (el) { el.classList.add("bubble-spoken"); }
  });

  // User entry is right-aligned (align-self: flex-end)
  const userRightAligned = await page.evaluate(() => {
    const el = document.querySelector('.entry-bubble[data-entry-id="1"]') as HTMLElement | null;
    if (!el) return false;
    return window.getComputedStyle(el).alignSelf === "flex-end";
  });
  report("User entry is right-aligned (align-self: flex-end)", userRightAligned);

  // User entry has pill shape (border-radius)
  const userHasPill = await page.evaluate(() => {
    const el = document.querySelector('.entry-bubble[data-entry-id="1"]') as HTMLElement | null;
    if (!el) return false;
    const br = window.getComputedStyle(el).borderRadius;
    return br !== "0px" && br !== "";
  });
  report("User entry has pill/rounded shape", userHasPill);

  // Unspoken assistant entry is dim — color has alpha < 0.5
  const assistantDim = await page.evaluate(() => {
    const el = document.querySelector('.entry-bubble[data-entry-id="2"]') as HTMLElement | null;
    if (!el) return false;
    const color = window.getComputedStyle(el).color;
    const m = color.match(/rgba?\(\s*[\d.]+,\s*[\d.]+,\s*[\d.]+(?:,\s*([\d.]+))?\s*\)/);
    const alpha = m && m[1] != null ? parseFloat(m[1]) : 1;
    return alpha < 0.5;
  });
  report("Unspoken assistant entry is dim (low opacity color)", assistantDim);

  // No backgrounds on assistant entries in flow mode
  const noBackground = await page.evaluate(() => {
    const el = document.querySelector('.entry-bubble[data-entry-id="2"]') as HTMLElement | null;
    if (!el) return false;
    const bg = window.getComputedStyle(el).backgroundColor;
    return bg === "rgba(0, 0, 0, 0)" || bg === "transparent";
  });
  report("Assistant entry has no background in flow mode", noBackground);

  // Spoken entry (bubble-spoken) stays dark
  const spokenDark = await page.evaluate(() => {
    const el = document.querySelector('.entry-bubble[data-entry-id="3"]') as HTMLElement | null;
    if (!el) return false;
    const color = window.getComputedStyle(el).color;
    const opacity = window.getComputedStyle(el).opacity;
    // should be #1a1a1e (rgb(26,26,30)) and opacity 1
    return (color === "rgb(26, 26, 30)" || color.includes("26, 26, 30")) && opacity === "1";
  });
  report("Spoken entry (bubble-spoken) stays fully dark, opacity=1", spokenDark);

  // Header is hidden in flow mode
  const headerHidden = await page.evaluate(() => {
    const h = document.getElementById("header");
    return h ? window.getComputedStyle(h).display === "none" : true;
  });
  report("Header hidden in flow mode", headerHidden);

  // Controls bar hidden in flow mode
  const controlsHidden = await page.evaluate(() => {
    const c = document.getElementById("controlsBar");
    return c ? window.getComputedStyle(c).display === "none" : true;
  });
  report("Controls bar hidden in flow mode", controlsHidden);

  await shot("visual-states");
}

// ═════════════════════════════════════════════════════════
// Group 8: Word highlight survives streaming update
// ═════════════════════════════════════════════════════════
async function testGroup8_WordHighlightSurvivesStreaming() {
  console.log("\n[Group 8] Word highlight spans survive streaming update mid-TTS");

  await loadFlowMode();

  await render([
    entry(1, "user", "Tell me something.", 1),
    entry(2, "assistant", "The first sentence is being spoken.", 1, true, false),
  ]);
  await page.waitForTimeout(200);

  // Simulate TTS starting on entry 2
  await page.evaluate(() => {
    const m = (window as any).__murmur;
    m.pendingHighlightEntryId = "2";
    m.pendingHighlightSpeakableText = "The first sentence is being spoken.";
    m.onTtsAudioStart(2000);
  });
  await page.waitForTimeout(100);

  // Verify spans exist before streaming update
  const spansBeforeUpdate = await page.evaluate(() => {
    const el = document.querySelector('.entry-bubble[data-entry-id="2"]');
    return el ? el.querySelectorAll(".tts-word, .tts-word-spoken").length : 0;
  });

  // Simulate streaming update: entry 2 gets more text
  await render([
    entry(1, "user", "Tell me something.", 1),
    entry(2, "assistant", "The first sentence is being spoken. And more is coming in now.", 1, true, false),
  ], true);
  await page.waitForTimeout(100);

  const spansAfterUpdate = await page.evaluate(() => {
    const el = document.querySelector('.entry-bubble[data-entry-id="2"]');
    return el ? el.querySelectorAll(".tts-word, .tts-word-spoken").length : 0;
  });

  const spansSurvived = spansBeforeUpdate > 0 && spansAfterUpdate > 0;
  report("Word highlight spans survive streaming update mid-TTS", spansSurvived,
    `spans before=${spansBeforeUpdate}, after=${spansAfterUpdate}`);

  // Entry should still have bubble-active
  const stillActive = await page.evaluate(() => {
    const el = document.querySelector('.entry-bubble[data-entry-id="2"]');
    return el ? el.classList.contains("bubble-active") : false;
  });
  report("bubble-active class survives streaming update mid-TTS", stillActive);

  await shot("spans-survive-streaming");
}

// ═════════════════════════════════════════════════════════
// Group 9: Full realistic conversation simulation
// ═════════════════════════════════════════════════════════
async function testGroup9_FullConversation() {
  console.log("\n[Group 9] Full realistic conversation — two turns with TTS");

  await loadFlowMode();

  // Turn 1: user speaks, assistant responds in two paragraphs
  const t1user = entry(1, "user", "Can you tell me a joke in three parts?", 1);
  await render([t1user]);
  await page.waitForTimeout(200);

  const topAfterTurn1User = await entryTopRelative(1);
  const turn1UserNearTop = topAfterTurn1User !== null && topAfterTurn1User >= -10 && topAfterTurn1User <= 80;
  report("Turn 1 user entry scrolled to near top on arrival", turn1UserNearTop,
    `top=${topAfterTurn1User}px`);
  await shot("turn1-user-entry");

  // Assistant streams in paragraph 1
  await render([t1user, entry(2, "assistant", "Sure! Here's one for you.", 1, true, false)]);
  await page.waitForTimeout(100);

  // TTS speaks paragraph 1
  await page.evaluate(() => {
    const m = (window as any).__murmur;
    m.pendingHighlightEntryId = "2";
    m.pendingHighlightSpeakableText = "Sure! Here's one for you.";
    m.onTtsAudioStart(800);
  });
  await page.waitForTimeout(100);

  const topEntry2 = await entryTopRelative(2);
  const entry2NearTop = topEntry2 !== null && topEntry2 >= -20 && topEntry2 <= 80;
  report("Turn 1 assistant para 1: TTS scrolls it to near top", entry2NearTop,
    `top=${topEntry2}px`);

  // Finish TTS chunk 1, add paragraph 2
  await page.waitForTimeout(900);
  await render([
    t1user,
    entry(2, "assistant", "Sure! Here's one for you.", 1, true, true),
    entry(3, "assistant",
      `A guy walks into a bar and orders a drink. The bartender says, "That'll be five bucks." ` +
      `The guy hands over a five dollar bill and asks, "Hey, do you have any of those tiny horses around here?"`, 1, true, false),
  ]);
  await page.waitForTimeout(200);

  await page.evaluate(() => {
    const m = (window as any).__murmur;
    m.pendingHighlightEntryId = "3";
    m.pendingHighlightSpeakableText = "A guy walks into a bar and orders a drink.";
    m.onTtsAudioStart(2000);
  });
  await page.waitForTimeout(200);

  const topEntry3 = await entryTopRelative(3);
  const entry3NearTop = topEntry3 !== null && topEntry3 >= -20 && topEntry3 <= 80;
  report("Turn 1 assistant para 2: TTS scrolls it to near top", entry3NearTop,
    `top=${topEntry3}px`);
  await shot("turn1-complete");

  // Turn 2: user asks another question
  await page.waitForTimeout(2100);
  const fullHistory = [
    t1user,
    entry(2, "assistant", "Sure! Here's one for you.", 1, true, true),
    entry(3, "assistant", "A guy walks into a bar...", 1, true, true),
    entry(4, "user", "Can you explain the punchline?", 2),
  ];
  await render(fullHistory);
  await page.waitForTimeout(300);

  const topTurn2User = await entryTopRelative(4);
  const turn2UserNearTop = topTurn2User !== null && topTurn2User >= -10 && topTurn2User <= 80;
  report("Turn 2 user entry scrolled to near top on arrival", turn2UserNearTop,
    `top=${topTurn2User}px`);
  await shot("turn2-user-entry");

  // Verify turn 1 user entry is above viewport (scrolled past)
  const turn1UserAboveViewport = await page.evaluate(() => {
    const t = document.getElementById("transcript")!;
    const el = document.querySelector('.entry-bubble[data-entry-id="1"]') as HTMLElement | null;
    if (!el) return false;
    const cR = t.getBoundingClientRect();
    const eR = el.getBoundingClientRect();
    return eR.bottom < cR.top; // fully above viewport
  });
  report("After turn 2, turn 1 user entry is above viewport (scrolled past)", turn1UserAboveViewport);
  await shot("turn2-complete");
}

// ═════════════════════════════════════════════════════════
// Main
// ═════════════════════════════════════════════════════════
async function main() {
  browser = await chromium.launch({ headless: HEADLESS, slowMo: HEADLESS ? 0 : 50 });
  const ctx = await browser.newContext({
    permissions: ["microphone"],
    viewport: { width: 390, height: 844 }, // iPhone 14 Pro size
  });
  page = await ctx.newPage();
  // Silence console noise
  page.on("console", () => {});

  try {
    await testGroup1_InitialLoad();
    await testGroup2_NewUserEntryScroll();
    await testGroup3_NoReScrollOnStreaming();
    await testGroup4_SecondUserEntry();
    await testGroup5_TtsWordHighlight();
    await testGroup6_TtsScroll();
    await testGroup7_VisualStates();
    await testGroup8_WordHighlightSurvivesStreaming();
    await testGroup9_FullConversation();
  } finally {
    await browser.close();
  }

  const passed = results.filter(r => r.ok).length;
  const total = results.length;
  const failed = results.filter(r => !r.ok);

  console.log(`\n  Results: ${passed} passed, ${total - passed} failed\n`);
  if (failed.length > 0) {
    console.log("  Failed tests:");
    failed.forEach(r => console.log(`    ${FAIL} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`));
  }
  console.log(`  Screenshots saved to: ${SCREENSHOTS_DIR}`);
  process.exit(total - passed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
