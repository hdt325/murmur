# Murmur Test Suite

Complete test suite documentation — 9 files, ~4,200 lines of test code, 8 server test protocol handlers.

## Quick Reference

```bash
# Prerequisites: server on localhost:3457
# Generate test audio (requires Kokoro TTS + ffmpeg):
npx tsx tests/generate-test-audio.ts

# Run suites:
npx tsx tests/test-smoke.ts              # UI only, no voice services needed
npx tsx tests/test-e2e.ts                # Full E2E (visible browser)
HEADLESS=1 npx tsx tests/test-e2e.ts     # Full E2E (headless)
npx tsx tests/test-audio-pipeline.ts     # Audio pipeline (needs Whisper+Kokoro)
npx tsx tests/test-tts-pipeline.ts       # TTS pipeline integration
npx tsx tests/test-bugs.ts               # Bug regression checks
npx tsx tests/test-detection.ts          # Poll detection unit tests
bash tests/test-poll.sh                  # Poll integration (needs tmux)
bash tests/test-voice-cycle.sh           # Full voice cycle (needs tmux+Claude)
```

## Service Requirements

| Suite | Server | Whisper (STT) | Kokoro (TTS) | Claude CLI | tmux |
|-------|--------|---------------|--------------|------------|------|
| test-smoke | Yes | No | No | No | No |
| test-e2e | Yes | For STT tests | For TTS tests | No | No |
| test-audio-pipeline | Yes | For STT tests | For TTS tests | No | No |
| test-tts-pipeline | Yes | For STT tests | For TTS tests | No | No |
| test-bugs | Yes | No | No | No | No |
| test-detection | No | No | No | No | Optional |
| test-poll.sh | Yes | No | No | Yes | Yes |
| test-voice-cycle.sh | Yes | No | No | Yes | Yes |

---

## 1. test-smoke.ts (388 lines, ~20 tests)

**Purpose:** Quick UI smoke tests — core interactions, no voice services needed.

**Run:** `npx tsx tests/test-smoke.ts` or `HEADLESS=1 npx tsx tests/test-smoke.ts`

| # | Test | What it checks |
|---|------|----------------|
| 1 | `testPageLoad` | Page loads, `#statusDot` visible, status text present |
| 2 | `testWsConnection` | WebSocket connects (dot green/yellow, not red) |
| 3 | `testTextInput` | Type in `#textInput` + Enter → user bubble appears |
| 4 | `testTourAutoStart` | Clear localStorage → `.tour-overlay` appears on reload |
| 5 | `testTourWalkthrough` | Walk 10 tour steps, click Next/Done, verify completion |
| 6 | `testTourDoesNotRestart` | Tour skipped after `murmur-tour-done=1` set |
| 7 | `testModeCycling` | `#modeBtn` cycles 4 modes and wraps back |
| 8 | `testTerminalToggle` | `#terminalHeader` click toggles `.terminal-panel.open` |
| 9 | `testTerminalPersistence` | Terminal state persists in localStorage across reload |
| 10 | `testHelpMenu` | `#helpBtn` opens menu, has Tour/Debug/GitHub/Homepage items |
| 11 | `testFontZoom` | `#chatZoomIn` increases `--chat-font-size`, `#chatZoomOut` decreases |
| 12 | `testDebugPanel` | Ctrl+Shift+D opens panel, has 4 tabs (State/Messages/Pipeline/Server) |
| 13 | `testServiceDots` | `#svcWhisper` and `#svcKokoro` indicator dots visible |
| 14 | `testCleanVerboseToggle` | `#cleanBtn` toggles active/inactive state |
| 15 | `testResponsiveLayout` | Talk btn, text input, header all visible at 320px width |

---

## 2. test-e2e.ts (930 lines, ~74 tests)

**Purpose:** Comprehensive end-to-end tests — every user-facing feature, visible browser.

**Run:** `npx tsx tests/test-e2e.ts` or `HEADLESS=1 npx tsx tests/test-e2e.ts`

### Section 1: STT Tests (require Whisper + test audio)

| # | Test | What it checks |
|---|------|----------------|
| 1 | `testSttShort` | STT on ~5s speech WAV |
| 2 | `testSttMedium` | STT on ~15s speech WAV |
| 3 | `testSttLong` | STT on ~30s speech WAV |
| 4 | `testSttQuiet` | STT on speech at -20dB (loudnorm test) |
| 5 | `testSttSpeechWithPauses` | STT on speech with 3s mid-utterance pause |
| 6 | `testSilenceRejection` | Silence → `voice_status=blank` |
| 7 | `testNoiseRejection` | Pink noise filtered/rejected |

### Section 2: TTS Tests (require Kokoro)

| # | Test | What it checks |
|---|------|----------------|
| 8 | `testTtsShort` | Short text TTS → audio >100 bytes |
| 9 | `testTtsLong` | 5-sentence TTS → audio received |
| 10 | `testTtsParagraph` | 8-sentence 425-char paragraph → audio >2000 bytes |

### Section 3: Long Text & Paragraph Tests

| # | Test | What it checks |
|---|------|----------------|
| 11 | `testCycleLongParagraph` | 6-sentence 501-char cycle with state verification |
| 12 | `testCycleMultiSentenceOutput` | 5 sentences → all present in transcription |
| 13 | `testEntriesMultiParagraph` | 3 paragraphs via `test:entries:` → last 3 entries match |
| 14 | `testEntriesLongParagraph` | 822-char paragraph → exact text match in entry |

### Section 4: Interactive Prompt Tests

| # | Test | What it checks |
|---|------|----------------|
| 15 | `testInteractivePrompt` | `test:interactive:` → `interactive_prompt active=true` |
| 16 | `testInteractivePromptEntries` | Entry contains question + all 4 numbered options |
| 17 | `testInteractivePromptFormat` | Options use `❯ 1.` / `❯ 2.` / `❯ 3.` format |

### Section 5: Text Input Tests

| # | Test | What it checks |
|---|------|----------------|
| 18 | `testTextInput` | `test:cycle:` accepted, state transitions |
| 19 | `testTextInputTriggersState` | Input → thinking → responding states |

### Section 6: True E2E Bubble ↔ TTS (entryId chain)

| # | Test | What it checks |
|---|------|----------------|
| 20 | `testReplayCorrectEntry` | Create 3 entries (cats/dogs/fish), replay middle → highlight matches + audio |
| 21 | `testReplayFirstVsLast` | Replay first then last → different highlight entryIds |
| 22 | `testHighlightClearsAfterTtsDone` | `tts_highlight` set then cleared (null) after done |
| 23 | `testMultiBubbleTtsSync` | 3 long paragraphs via `test:entries-tts:` → all 3 highlighted in order + 3 audio chunks |

### Section 7: Full Cycle + Debug

| # | Test | What it checks |
|---|------|----------------|
| 24 | `testFullCycle` | think → respond → TTS states |
| 25 | `testDebugEndpoints` | `/debug`, `/debug/pipeline`, `/debug/log`, `/debug/ws-log` respond |

### Section 8: Playwright UI Tests

(These are the browser-based tests using Playwright — page load, tour, modes, terminal, help menu, font zoom, debug panel, service dots, clean/verbose toggle, responsive layout, etc.)

#### 4b. Long Text & Paragraph Input (Playwright)

| # | Test | What it checks |
|---|------|----------------|
| 26 | `testLongParagraphInput` | 294-char paragraph fills input + creates bubble |
| 27 | `testLongParagraphBubbleRendering` | Full text renders, fits 320px viewport |
| 28 | `testMultipleSequentialMessages` | 3 long messages → ≥3 bubbles |
| 29 | `testSpecialCharacterInput` | Quotes, unicode, math symbols preserved |
| 30 | `testMultiLineInput` | 349-char single line preserved |

#### 18. True E2E: Bubble ↔ TTS Highlight Chain (Playwright + Node.js WS)

| # | Test | What it checks |
|---|------|----------------|
| 31 | `testEntryBubblesRender` | Inject 3 entries via Node.js WS → `data-entry-id` in DOM |
| 32 | `testEntryBubbleTextsMatch` | Last 3 bubbles have expected text fragments |
| 33 | `testReplayHighlightsCorrectBubble` | Click replay on middle → `bubble-active` class on correct bubble |
| 34 | `testReplayDifferentBubble` | Replay first → highlight shifts to first bubble |

#### 19. Clean vs Verbose + Modes × Long Text

| # | Test | What it checks |
|---|------|----------------|
| 35 | `testCleanModeHidesNonSpeakable` | `clean-mode` class hides non-speakable, shows speakable |
| 36 | `testVerboseModeShowsAll` | Remove `clean-mode` → all entries visible |
| 37 | `testTextModeNoTtsHighlight` | Text mode (micOff, ttsOff) → 0 `bubble-active` |
| 38 | `testTalkModeEntriesWithReplay` | Talk mode → entries render with replay buttons |
| 39 | `testTypeModeMultiParagraphInput` | Type mode → 341-char paragraph creates bubble |
| 40 | `testReadModeEntriesRender` | Read mode (mic, no TTS) → entries render, 0 highlights |

*(Plus all smoke test equivalents — page load, tour, modes, terminal, etc. — totaling ~74 tests)*

---

## 3. test-audio-pipeline.ts (930 lines, ~29 tests)

**Purpose:** Audio pipeline tests via WebSocket — STT/TTS round-trips, entry system, interactive prompts, replay chain.

**Run:** `npx tsx tests/test-audio-pipeline.ts`

### STT Tests (require Whisper + test audio files)

| # | Test | What it checks |
|---|------|----------------|
| 1 | `testSttShort` | ~5s speech transcription |
| 2 | `testSttMedium` | ~15s speech transcription |
| 3 | `testSttLong` | ~30s speech transcription |
| 4 | `testSttQuiet` | Quiet speech (-20dB) loudnorm |
| 5 | `testSttSpeechWithPauses` | Speech with 3s pause |
| 6 | `testSilenceRejection` | Silence → blank/filtered |
| 7 | `testNoiseRejection` | Pink noise → filtered |

### TTS Tests (require Kokoro)

| # | Test | What it checks |
|---|------|----------------|
| 8 | `testTtsShort` | Short text → audio >100 bytes |
| 9 | `testTtsLong` | 5 sentences → audio >1000 bytes |
| 10 | `testTtsParagraph` | 8-sentence paragraph → audio >2000 bytes |

### Long Text & Paragraph Tests

| # | Test | What it checks |
|---|------|----------------|
| 11 | `testCycleLongParagraph` | 501-char cycle, full text in transcription |
| 12 | `testCycleMultiSentenceOutput` | 5 sentences → all present in output |
| 13 | `testEntriesMultiParagraph` | 3 paragraphs via entry system, text matches |
| 14 | `testEntriesLongParagraph` | 500+ char paragraph, exact text match |

### Interactive Prompt Tests

| # | Test | What it checks |
|---|------|----------------|
| 15 | `testInteractivePrompt` | `interactive_prompt active=true` broadcast |
| 16 | `testInteractivePromptEntries` | Entry has question + all numbered options |
| 17 | `testInteractivePromptFormat` | `❯ N.` numbered format |

### Text Input Tests

| # | Test | What it checks |
|---|------|----------------|
| 18 | `testTextInput` | `test:cycle:` accepted |
| 19 | `testTextInputTriggersState` | Input → thinking → responding |

### True E2E: Bubble ↔ TTS (entryId chain)

| # | Test | What it checks |
|---|------|----------------|
| 20 | `testReplayCorrectEntry` | Replay middle of 3 → correct highlight + audio |
| 21 | `testReplayFirstVsLast` | Replay first vs last → different highlights |
| 22 | `testHighlightClearsAfterTtsDone` | Highlight set then cleared after TTS done |
| 23 | `testMultiBubbleTtsSync` | 3 entries → all 3 highlighted in order + audio |

### Full Cycle

| # | Test | What it checks |
|---|------|----------------|
| 24 | `testFullCycle` | think → respond → TTS → idle cycle |

---

## 4. test-tts-pipeline.ts (801 lines)

**Purpose:** TTS pipeline integration — full pipeline exercise with timing and assertions.

**Run:** `npx tsx tests/test-tts-pipeline.ts`

| # | Test | What it checks |
|---|------|----------------|
| 1 | `testSTT(short)` | STT transcription of short speech (if WAV exists) |
| 2 | `testSTT(medium)` | STT transcription of medium speech |
| 3 | `testSTT(long)` | STT transcription of long speech |
| 4 | `testSingleParagraphTTS` | Single paragraph cycle → transcription before audio, speaking→idle |
| 5 | `testMultiParagraphTTS` | 3 paragraphs → multiple audio chunks >20KB, speaking→idle |
| 6 | `testSilence` | Silence WAV → blank/idle, no transcription, no audio |
| 7 | `testDirectTTS` | Direct `test:tts:` → audio, speaking→idle |
| 8 | `testRapidFire` | Two `test:cycle:` back-to-back → at least one transcription + audio |

Uses `PipelineTestClient` class with timeline tracking and assertion framework.

---

## 5. test-bugs.ts (349 lines, ~24 tests)

**Purpose:** Bug fix regression tests — verifies specific bugs stay fixed.

**Run:** `npx tsx tests/test-bugs.ts`

| # | Test | Bug | What it checks |
|---|------|-----|----------------|
| 1 | `testBug4_canvasScale` | Canvas scale accumulation | Scale = devicePixelRatio, not dpr^N |
| 2 | `testBug5_fallbackAudio` | Blob-in-Blob audio | Uses ArrayBuffer, not Blob wrapping |
| 3 | `testBug7_noBeepOnStop` | Beep after manual stop | `idleFromTtsCompletion` flag exists |
| 4 | `testBug6_ttsTimeout` | TTS timeout too high | `Math.max(5000, ...)` not 15000 |
| 5 | `testBug10_broadcastScope` | Wrong strip function | Uses `extractRawOutput` not `stripChrome` |
| 6 | `testBug11_partialFinalTransition` | Partial transcript flash | `removeAttribute` + `opacity=1` |
| 7 | `testBug8_terminalScroll` | Scroll position lost | Auto-scroll guard preserved |
| 8 | `testBug2_deadCodeRemoved` | Dead code | `speakNewContent` removed from server.ts |
| 9 | `testIntegration_wsConnect` | Connection health | WS connects, services report status |
| 10 | `testIntegration_textInput` | Text round-trip | Send text → thinking→responding cycle |

---

## 6. test-detection.ts (307 lines)

**Purpose:** Unit tests for poll detection functions against real tmux pane fixtures.

**Run:** `npx tsx tests/test-detection.ts`

| # | Test | What it checks |
|---|------|----------------|
| 1 | `testIsSpinnerLine` | Spinner regex matches `✳ Galloping…` etc. |
| 2 | `testFindUserInputLine` | Finds user input by prefix in pane lines |
| 3 | `testHasSpinnerChars` | Detects active/inactive spinners in pane content |
| 4 | `testHasPromptReady` | Detects ready prompt (no spinner) vs active spinner |
| 5 | `testLivePane` | (Optional) Tests against live tmux pane |

Uses 8 fixture panes: `PANE_SPINNER_ACTIVE`, `PANE_RESPONSE_DONE`, `PANE_TOOL_CALL`, `PANE_TOOL_DONE`, `PANE_LONG_SPINNER`, `PANE_SCROLLED_OFF_DONE`, `PANE_SCROLLED_OFF_SPINNER`, `PANE_MULTI_INPUT`.

---

## 7. test-poll.sh (108 lines)

**Purpose:** Poll detection integration test via WebSocket message + server log monitoring.

**Run:** `bash tests/test-poll.sh`

Sends a real message, monitors server logs for poll state transitions: spinner → prompt → poll done → display output → speaking.

---

## 8. test-voice-cycle.sh (130 lines)

**Purpose:** Full voice panel cycle — text → poll → extract → TTS → client playback.

**Run:** `bash tests/test-voice-cycle.sh`

Sends message via tmux, monitors pane for spinner → prompt ready → response text, checks TTS activity.

---

## 9. generate-test-audio.ts (221 lines)

**Purpose:** Generate test WAV files using Kokoro TTS for pipeline tests.

**Run:** `npx tsx tests/generate-test-audio.ts`

Generates 7 audio files in `tests/test-audio/`:

| File | Duration | Content |
|------|----------|---------|
| short.wav | ~5s | Natural speech (async/await question) |
| medium.wav | ~15s | WebSocket message queue problem |
| long.wav | ~30s | Voice panel architecture question |
| quiet.wav | ~5s | Speech at -20dB (loudnorm test) |
| speech-with-pauses.wav | ~10s | Speech + 3s silence + more speech |
| silence.wav | 10s | Pure silence (anullsrc) |
| noise.wav | 10s | Pink noise |

---

## Server Test Protocol

8 handlers in `server.ts` WebSocket message handler — all use `test:` prefix, none touch the real Claude terminal.

### test:client
Marks connection as test client. Suppresses context/exit messages to tmux.
```
ws.send("test:client")
```

### test:transcribe
Next binary audio is transcribed via Whisper but NOT sent to terminal.
```
ws.send("test:transcribe")
ws.send(audioBuffer)           // binary WAV data
// → receives: { type: "test_result", test: "audio", text: "..." }
```

### test:cycle:TEXT
Full pipeline simulation — thinking → responding → transcription → TTS.
```
ws.send("test:cycle:The answer is forty-two.")
// → voice_status=thinking (300ms) → responding → transcription → binary audio
```

### test:tts:TEXT
Direct TTS — bypasses cycle, speaks text immediately.
```
ws.send("test:tts:Hello world, this is a test.")
// → voice_status=speaking → binary audio
```

### test:audio:FILENAME
Loads WAV from `tests/test-audio/`, transcribes via Whisper.
```
ws.send("test:audio:short")
// → { type: "test_result", test: "audio", file: "short", text: "transcribed text" }
```

### test:entries:JSON
Multi-paragraph assistant entries via entry system (no TTS).
```
ws.send('test:entries:["First paragraph.","Second paragraph."]')
// → voice_status=thinking → responding → entry broadcasts → idle
```

### test:entries-tts:JSON
Like `test:entries:` but also speaks each entry via TTS with correct `currentTtsEntryId`.
```
ws.send('test:entries-tts:["Alpha text.","Beta text.","Gamma text."]')
// → thinking → responding → entries + tts_highlight per entry + audio chunks
```

### test:interactive:JSON
Simulates Claude presenting numbered multiple-choice options.
```
ws.send('test:interactive:{"question":"Pick one:","options":["Yes","No","Maybe"]}')
// → entry with "Pick one:\n❯ 1. Yes\n❯ 2. No\n❯ 3. Maybe"
// → interactive_prompt active=true
```

---

## Key Architecture Notes

### Entry System
- `ConversationEntry` = `{ id, role, text, speakable, spoken, ts }`
- Server is single source of truth — `conversationEntries[]` array
- Entries broadcast via `{ type: "entry", entries: [...], partial: bool }`
- `entryIdCounter` auto-increments

### TTS Highlight Chain
1. `currentTtsEntryId` set on server
2. `tts_highlight` broadcast with `{ entryId }` to all clients
3. Audio chunks sent as binary WebSocket frames
4. Client highlights bubble with matching `data-entry-id`
5. `tts_highlight null` broadcast clears highlight after done

### Replay
- Client sends `replay:ENTRY_ID`
- Server looks up entry, sets `currentTtsEntryId`, broadcasts `tts_highlight`, calls `speakText()`

### 4 Interaction Modes
| Mode | Mic | TTS | Entry highlights |
|------|-----|-----|-----------------|
| Talk | On | On | Yes |
| Type | Off | On | Yes |
| Read | On | Off | No |
| Text | Off | Off | No |

### Clean vs Verbose
- `body.clean-mode .entry-nonspeakable { display: none }` — clean hides non-speakable entries
- Toggle via `#cleanBtn`

### Hybrid Test Approach (Playwright + Node.js WS)
Browser's `ws` variable is closure-scoped (not on `window`), so E2E tests that need to inject server commands use a separate Node.js WebSocket via `connectTestWs()` while Playwright verifies DOM state.

---

## File Summary

| File | Lines | Tests | Type |
|------|-------|-------|------|
| test-smoke.ts | 388 | ~20 | Playwright UI |
| test-e2e.ts | 930 | ~74 | Playwright + WS E2E |
| test-audio-pipeline.ts | 930 | ~29 | WebSocket audio |
| test-tts-pipeline.ts | 801 | ~8 | Pipeline integration |
| test-bugs.ts | 349 | ~10 | Bug regression |
| test-detection.ts | 307 | ~25 | Unit (poll detection) |
| test-poll.sh | 108 | 1 | Bash integration |
| test-voice-cycle.sh | 130 | 1 | Bash integration |
| generate-test-audio.ts | 221 | — | Audio generation |
| **Total** | **~4,164** | **~168** | |
