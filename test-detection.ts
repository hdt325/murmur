#!/usr/bin/env npx tsx
/**
 * Self-contained unit tests for poll detection functions.
 * Tests against real tmux pane fixtures — no manual testing needed.
 *
 * Run: npx tsx test-detection.ts
 */

import { execSync } from "child_process";

// ═══════════════════════════════════════════════════════════════
// Copy of detection functions from server.ts for isolated testing
// ═══════════════════════════════════════════════════════════════

const SPINNER_REGEX = /^[^\w\d\s]\s+\w+…/;

function isSpinnerLine(trimmed: string): boolean {
  return trimmed.length < 120 && SPINNER_REGEX.test(trimmed);
}

function findUserInputLine(lines: string[], userInput: string): number {
  const firstLine = userInput.trim().split("\n")[0].trim();
  const inputStart = firstLine.slice(0, 35);
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("❯ ") && trimmed.slice(2).trim().startsWith(inputStart)) {
      return i;
    }
  }
  return -1;
}

function hasSpinnerChars(pane: string, userInput: string): boolean {
  const lines = pane.split("\n");
  let bottomPromptIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^❯\s*$/.test(lines[i].trim())) { bottomPromptIdx = i; break; }
  }
  let contentEnd = bottomPromptIdx >= 0 ? bottomPromptIdx : lines.length;
  if (bottomPromptIdx > 0) {
    for (let i = bottomPromptIdx - 1; i >= Math.max(0, bottomPromptIdx - 3); i--) {
      if (/^[─━═]{3,}/.test(lines[i].trim())) { contentEnd = i; break; }
    }
  }
  const inputIdx = findUserInputLine(lines, userInput);
  const startIdx = inputIdx >= 0 ? inputIdx + 1 : Math.max(0, contentEnd - 30);
  for (let i = startIdx; i < contentEnd; i++) {
    if (isSpinnerLine(lines[i].trim())) return true;
  }
  return false;
}

function hasPromptReady(pane: string, userInput: string): boolean {
  const lines = pane.split("\n");
  let bottomPromptIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^❯\s*$/.test(lines[i].trim())) { bottomPromptIdx = i; break; }
  }
  if (bottomPromptIdx < 0) return false;
  let contentEnd = bottomPromptIdx;
  for (let i = bottomPromptIdx - 1; i >= Math.max(0, bottomPromptIdx - 3); i--) {
    if (/^[─━═]{3,}/.test(lines[i].trim())) { contentEnd = i; break; }
  }
  const inputIdx = findUserInputLine(lines, userInput);
  const checkStart = inputIdx >= 0 ? inputIdx + 1 : Math.max(0, contentEnd - 30);
  for (let i = checkStart; i < contentEnd; i++) {
    if (isSpinnerLine(lines[i].trim())) return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════
// Test fixtures: real Claude Code pane states
// ═══════════════════════════════════════════════════════════════

// Fixture 1: Claude is actively working (spinner visible)
const PANE_SPINNER_ACTIVE = `
❯ hello what is 2 plus 2

⏺ I'll answer that for you.

✳ Galloping… (5s · ↓ 200 tokens)

─────────────────────────────────────────────────────────────────────────────────────────
❯
─────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on · 1 bash · ↓ to manage · esc to interrupt
`.trim();

// Fixture 2: Claude finished responding (no spinner, response visible)
const PANE_RESPONSE_DONE = `
❯ hello what is 2 plus 2

⏺ 2 + 2 = 4. Hello! How can I help you today?

─────────────────────────────────────────────────────────────────────────────────────────
❯
─────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on · ↓ to manage · esc to interrupt
`.trim();

// Fixture 3: Claude doing tool calls (spinner with tool output)
const PANE_TOOL_CALL = `
❯ read the server file

⏺ Read(server.ts)
  ⎿  1: import express from "express";
     2: import { WebSocketServer } from "ws";
     … +50 lines (ctrl+o to expand)

⏺ Searching…

✢ Galloping… (15s · ↓ 500 tokens · thought for 3s)

─────────────────────────────────────────────────────────────────────────────────────────
❯
─────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on · 2 bashes · ↓ to manage · esc to interrupt
`.trim();

// Fixture 4: Claude done after tool calls (prose response after tools)
const PANE_TOOL_DONE = `
❯ read the server file

⏺ Read(server.ts)
  ⎿  1: import express from "express";
     2: import { WebSocketServer } from "ws";
     … +50 lines (ctrl+o to expand)

⏺ The server file is an Express + WebSocket application that bridges a voice panel UI
  to Claude Code running in tmux. It handles TTS, STT, and tmux session management.

─────────────────────────────────────────────────────────────────────────────────────────
❯
─────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on · ↓ to manage · esc to interrupt
`.trim();

// Fixture 5: Long spinner with extended timing info
const PANE_LONG_SPINNER = `
❯ explain the codebase

⏺ Let me explore the codebase structure.

· Galloping… (13m 26s · ↓ 10.6k tokens · thought for 15s)

─────────────────────────────────────────────────────────────────────────────────────────
❯
─────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on · 1 bash · ↓ to manage · esc to interrupt
`.trim();

// Fixture 6: User input has scrolled off (long response, only recent content visible)
const PANE_SCROLLED_OFF_DONE = `
⏺ Here is a very long response that pushed the user input off the scrollback.
  This happens when Claude generates many tool calls and long output.

─────────────────────────────────────────────────────────────────────────────────────────
❯
─────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on · ↓ to manage · esc to interrupt
`.trim();

// Fixture 7: User input scrolled off but spinner still active
const PANE_SCROLLED_OFF_SPINNER = `
⏺ Working on something...

✢ Galloping… (30s · ↓ 1k tokens)

─────────────────────────────────────────────────────────────────────────────────────────
❯
─────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on · 1 bash · ↓ to manage · esc to interrupt
`.trim();

// Fixture 8: Multiple user inputs in scrollback (should find the latest one)
const PANE_MULTI_INPUT = `
❯ first question

⏺ Here's the answer to the first question.

❯ second question

⏺ Here's the answer to the second question.

─────────────────────────────────────────────────────────────────────────────────────────
❯
─────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on · ↓ to manage · esc to interrupt
`.trim();

// ═══════════════════════════════════════════════════════════════
// Test runner
// ═══════════════════════════════════════════════════════════════

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

console.log("═══════════════════════════════════════════════════════");
console.log("  Murmur Detection Unit Tests");
console.log("═══════════════════════════════════════════════════════");
console.log("");

// --- isSpinnerLine tests ---
console.log("isSpinnerLine:");
assert(isSpinnerLine("✳ Galloping…"), "basic spinner");
assert(isSpinnerLine("✢ Galloping… (15s · ↓ 500 tokens · thought for 3s)"), "spinner with timing");
assert(isSpinnerLine("· Galloping… (13m 26s · ↓ 10.6k tokens · thought for 15s)"), "long spinner with timing");
assert(isSpinnerLine("⏺ Searching…"), "search spinner");
assert(!isSpinnerLine("⏺ The server file is an Express + WebSocket application"), "prose line (not spinner)");
assert(!isSpinnerLine("❯ hello"), "prompt line (not spinner)");
assert(!isSpinnerLine("─────────────"), "separator (not spinner)");
assert(!isSpinnerLine("  ⏵⏵ bypass permissions on"), "status bar (not spinner)");
assert(!isSpinnerLine("Hello, 2 + 2 = 4."), "regular text (not spinner)");
console.log("");

// --- findUserInputLine tests ---
console.log("findUserInputLine:");
const lines1 = PANE_SPINNER_ACTIVE.split("\n");
assert(findUserInputLine(lines1, "hello what is 2 plus 2") >= 0, "finds input line");
assert(findUserInputLine(lines1, "nonexistent input") === -1, "returns -1 for missing input");

const lines6 = PANE_MULTI_INPUT.split("\n");
const idx1 = findUserInputLine(lines6, "first question");
const idx2 = findUserInputLine(lines6, "second question");
assert(idx2 > idx1, "finds later input after earlier one");

// Multi-line transcription test
const multiLineInput = "Hello how are you?\nI want to know about the weather.";
const paneWithMultiLine = `❯ Hello how are you?\n  I want to know about the weather.\n\n⏺ Response\n\n─────\n❯ \n─────`;
assert(findUserInputLine(paneWithMultiLine.split("\n"), multiLineInput) >= 0, "handles multi-line transcription");
console.log("");

// --- hasSpinnerChars tests ---
console.log("hasSpinnerChars:");
assert(hasSpinnerChars(PANE_SPINNER_ACTIVE, "hello what is 2 plus 2") === true, "detects spinner when active");
assert(hasSpinnerChars(PANE_RESPONSE_DONE, "hello what is 2 plus 2") === false, "no spinner when done");
assert(hasSpinnerChars(PANE_TOOL_CALL, "read the server file") === true, "detects spinner during tool calls");
assert(hasSpinnerChars(PANE_TOOL_DONE, "read the server file") === false, "no spinner after tool calls done");
assert(hasSpinnerChars(PANE_LONG_SPINNER, "explain the codebase") === true, "detects long spinner with timing");
console.log("");

// --- hasPromptReady tests ---
console.log("hasPromptReady:");
assert(hasPromptReady(PANE_SPINNER_ACTIVE, "hello what is 2 plus 2") === false, "NOT ready when spinner active");
assert(hasPromptReady(PANE_RESPONSE_DONE, "hello what is 2 plus 2") === true, "ready when response done");
assert(hasPromptReady(PANE_TOOL_CALL, "read the server file") === false, "NOT ready during tool calls");
assert(hasPromptReady(PANE_TOOL_DONE, "read the server file") === true, "ready after tool calls done");
assert(hasPromptReady(PANE_LONG_SPINNER, "explain the codebase") === false, "NOT ready with long spinner");
assert(hasPromptReady(PANE_MULTI_INPUT, "second question") === true, "ready for latest question");
assert(hasPromptReady(PANE_SCROLLED_OFF_DONE, "some input that scrolled off") === true, "ready when input scrolled off but no spinner");
assert(hasPromptReady(PANE_SCROLLED_OFF_SPINNER, "some input that scrolled off") === false, "NOT ready when input scrolled off and spinner active");
assert(hasSpinnerChars(PANE_SCROLLED_OFF_SPINNER, "some input that scrolled off") === true, "detects spinner when input scrolled off");
assert(hasSpinnerChars(PANE_SCROLLED_OFF_DONE, "some input that scrolled off") === false, "no spinner when input scrolled off and done");
console.log("");

// --- Live pane test (captures current state) ---
console.log("Live pane test:");
try {
  const livePaneFull = execSync("tmux capture-pane -t claude-voice -p -S -2000", { encoding: "utf-8", timeout: 3000 });
  const liveLines = livePaneFull.split("\n");
  console.log(`  Captured ${liveLines.length} lines from live pane`);

  // Find the most recent user input
  let lastInput = "";
  for (let i = liveLines.length - 1; i >= 0; i--) {
    const t = liveLines[i].trim();
    if (t.startsWith("❯ ") && t.length > 3) {
      lastInput = t.slice(2).trim();
      break;
    }
  }
  console.log(`  Last user input: "${lastInput.slice(0, 60)}..."`);

  const liveSpinner = hasSpinnerChars(livePaneFull, lastInput);
  const livePrompt = hasPromptReady(livePaneFull, lastInput);
  console.log(`  spinner=${liveSpinner} prompt=${livePrompt}`);

  // If this test is running from Claude Code, spinner should be true (we're generating output)
  if (liveSpinner) {
    console.log("  ✓ Live: spinner detected (Claude is working — expected while running this test)");
  } else if (livePrompt) {
    console.log("  ✓ Live: prompt ready (Claude is idle)");
  } else {
    console.log("  ? Live: neither spinner nor prompt — may need investigation");
  }
} catch (e) {
  console.log("  (skipped — tmux not available)");
}

console.log("");
console.log("═══════════════════════════════════════════════════════");
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log("═══════════════════════════════════════════════════════");

if (failed > 0) process.exit(1);
