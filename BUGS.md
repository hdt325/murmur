# Murmur Bug Repository

A log of bugs found, root cause, fix, and test coverage.

---

## BUG-001: CLI-typed input appears as Claude's assistant response

**Status**: Fixed
**Severity**: Critical
**Found**: 2026-03-06
**Symptom**: When user types directly into the Claude Code CLI (tmux pane), line 2+ of the typed text appears as Claude's assistant response in the conversation bubbles.
**Root cause**: `lastPassiveSnapshot` was saved mid-typing. When the spinner fired on the next passive watcher poll, `preInputSnapshot = lastPassiveSnapshot` contained a partial user message. The diff approach in `getLinesAfterInput` matched line 1 of the message (already in preSnapshot) and returned lines 2+ as Claude's output.
**Fix** (`server.ts`): Only save `lastPassiveSnapshot` when the `>` prompt is empty (user is idle, not mid-typing). Check: `/^>\s*$/` on the last > line.
**Test**: No automated test (hard to inject mid-typing state). Manual verification.

---

## BUG-002: Flow mode initial scroll shows oldest content on open

**Status**: Fixed
**Severity**: Critical
**Found**: 2026-03-06
**Symptom**: Opening flow mode with a large conversation scrolls to the very top (oldest messages) instead of the most recent content.
**Root cause**: The initial scroll RAF looked for `.entry-bubble.user` elements. If none existed or the formula evaluated to <= 0, the scroll stayed at 0.
**Fix** (`index.html`): Initial flow mode entry scrolls to BOTTOM. Subsequent new user entries always snap to near-top.
**Test**: `test-e2e.ts` -- flow mode scroll tests.

---

## BUG-003: Test messages leak into active Claude Code session

**Status**: Fixed
**Severity**: Critical
**Found**: 2026-03-06
**Symptom**: Running smoke/flow/bug tests causes test text inputs ("Hello smoke test", "test-paste-content") to appear in the active Claude Code conversation.
**Root cause**: Test files loaded `http://localhost:3457` without `?testmode=1`. The frontend passes `location.search` to the WebSocket URL. Without `testmode=1`, server treats the Playwright browser as a real client and forwards `text:` messages to the tmux terminal via `terminal.sendText()`. `test-e2e.ts` already had `BASE_TEST` with `?testmode=1` but the other three test files did not.
**Fix** (`tests/test-smoke.ts`, `tests/test-flow.ts`, `tests/test-bugs.ts`): Added `?testmode=1` to the `BASE` URL. Server sets `_isTestMode=true` on WebSocket connections with this param, rendering text in UI but not forwarding to terminal.
**Test**: Manual verification -- test messages no longer appear in Claude session.

---

## BUG-004: Command injection in /info endpoint

**Status**: Fixed
**Severity**: Critical
**Found**: 2026-03-06 (audit)
**Symptom**: The `/info` endpoint interpolated `pid` directly into a shell command string, allowing command injection via crafted PID values.
**Root cause**: `lsof -p ${pid}` used template string interpolation with unsanitized input.
**Fix** (`server.ts`): Force `parseInt(String(pid), 10)` before interpolation.
**Test**: `test-bugs.ts` -- code path check for parseInt.

---

## BUG-005: Shell injection in Whisper STT curl

**Status**: Fixed
**Severity**: Critical
**Found**: 2026-03-06 (audit)
**Symptom**: STT transcription used `execSync` with template string interpolation for the curl command, allowing injection via crafted temp file paths.
**Root cause**: `execSync(\`curl ... -F file=@${tmpFile} ...\`)` -- tmpFile could contain shell metacharacters.
**Fix** (`server.ts`): Switched to `execFileSync("curl", [...args])` which bypasses shell entirely.
**Test**: `test-bugs.ts` -- code path check for execFileSync.

---

## BUG-006: _isSystemContext flag stuck forever on sendMurmurContext failure

**Status**: Fixed
**Severity**: Critical
**Found**: 2026-03-06 (audit)
**Symptom**: If `sendMurmurContext` failed or timed out, `_isSystemContext` remained true, silently suppressing all future entry creation.
**Root cause**: No safety timeout on the `_isSystemContext = true` flag.
**Fix** (`server.ts`): Added 30s safety timeout that resets `_isSystemContext = false`.
**Test**: `test-bugs.ts` -- code path check for timeout.

---

## BUG-007: Multi-client tts_done deadlock

**Status**: Fixed
**Severity**: Critical
**Found**: 2026-03-06 (audit)
**Symptom**: With multiple browser tabs open, `tts_done` from a non-audio client was ignored, causing TTS queue to permanently stall.
**Root cause**: `handleTtsDone` only accepted `tts_done` from `activeAudioClient`. If that client disconnected, no client could drain the queue.
**Fix** (`server.ts`): Accept `tts_done` if `activeAudioClient` is disconnected (readyState !== OPEN).
**Test**: `test-bugs.ts` -- code path check.

---

## BUG-008: TTS queue race condition on flush

**Status**: Fixed
**Severity**: Critical
**Found**: 2026-03-06 (audit)
**Symptom**: Queue flush via `ttsQueue = []` could race with concurrent `push()` calls, losing queued items.
**Root cause**: Array reassignment (`ttsQueue = []`) is not atomic with respect to other code paths that reference the same array.
**Fix** (`server.ts`): Use `ttsQueue.splice(0, ttsQueue.length)` to mutate in-place.
**Test**: `test-bugs.ts` -- code path check for splice.

---

## BUG-009: TTS pre-generation generation counter race

**Status**: Fixed
**Severity**: Critical
**Found**: 2026-03-06 (audit)
**Symptom**: Pre-generated TTS audio could play with stale generation counter, causing audio from interrupted conversations to play.
**Root cause**: `ttsGeneration` was incremented after the async promise resolved, allowing a window where stale callbacks passed the generation check.
**Fix** (`server.ts`): Moved `++ttsGeneration` and `ttsActiveGen` assignment BEFORE the async promise resolution.
**Test**: `test-bugs.ts` -- code path check.

---

## BUG-010: DoS via malformed JSON in test WS handlers

**Status**: Fixed
**Severity**: Critical
**Found**: 2026-03-06 (audit)
**Symptom**: Sending malformed JSON to `test:entries:`, `test:entries-mixed:`, `test:entries-tts:`, or `test:interactive:` WS handlers crashed the server.
**Root cause**: `JSON.parse()` without try-catch on user-controlled input.
**Fix** (`server.ts`): Added try-catch to all four test WS handlers.
**Test**: `test-bugs.ts` -- code path check.

---

## BUG-011: Newline injection in node-pty sendText

**Status**: Fixed
**Severity**: Critical
**Found**: 2026-03-06 (audit)
**Symptom**: Text containing `\r` or `\n` could inject arbitrary commands via node-pty on Windows.
**Root cause**: `sendText` wrote raw text + `\r` without sanitizing embedded newlines.
**Fix** (`terminal/pty-backend.ts`): Sanitize `[\r\n]+` to space before writing.
**Test**: `test-bugs.ts` -- code path check.

---

## BUG-012: Unsafe redirect in Electron content auto-update

**Status**: Fixed
**Severity**: Critical
**Found**: 2026-03-06 (audit)
**Symptom**: Content auto-updater followed HTTP redirects without validating the destination domain, allowing MITM to redirect to malicious content.
**Root cause**: No domain whitelist on redirect `location` header.
**Fix** (`electron/main.js`): Validate redirect URL starts with `https://raw.githubusercontent.com/` or `https://github.com/`.
**Test**: `test-bugs.ts` -- code path check.

---

## BUG-013: Shell injection in tmux pipe-pane filePath

**Status**: Fixed
**Severity**: Critical
**Found**: 2026-03-06 (audit)
**Symptom**: `startPipeStream()` interpolated filePath into a shell command, allowing injection via crafted paths.
**Root cause**: `cat >> ${filePath}` used unescaped interpolation.
**Fix** (`terminal/tmux-backend.ts`): Shell-escape filePath with single-quote wrapping and internal quote escaping.
**Test**: `test-bugs.ts` -- code path check.

---

## BUG-014: Flow mode _pendingHighlightEntryId never cleared

**Status**: Fixed
**Severity**: Critical
**Found**: 2026-03-06 (audit)
**Symptom**: After TTS highlight ends, `_pendingHighlightEntryId` retained its value, causing stale highlight behavior on next TTS playback.
**Root cause**: `clearFlowWordHighlight()` didn't reset `_pendingHighlightEntryId`.
**Fix** (`index.html`): Clear `_pendingHighlightEntryId` in `clearFlowWordHighlight()`.
**Test**: `test-bugs.ts` -- code path check.

---

## BUG-015: Audio WebSocket send without readyState check

**Status**: Fixed
**Severity**: Critical
**Found**: 2026-03-06 (audit)
**Symptom**: Audio binary sends could throw if WebSocket was closing/closed, crashing the recording flow.
**Root cause**: `ws.send(audioBlob)` called without checking `ws.readyState === WebSocket.OPEN`.
**Fix** (`index.html`): Audio sends use async/await with WS state checks.
**Test**: `test-bugs.ts` -- code path check.

---

## BUG-016: Silent TTS failure on max retries

**Status**: Fixed
**Severity**: High
**Found**: 2026-03-06 (audit)
**Symptom**: After 3 failed TTS curl retries, Kokoro service status stayed "up" and queue was not cleared, causing permanent stall.
**Root cause**: Max retry path didn't clear queue or update service status.
**Fix** (`server.ts`): Clear queue + set `serviceStatus.kokoro = "down"` on max retries.
**Test**: `test-bugs.ts` -- code path check.

---

## BUG-017: getLinesAfterInput greedy prompt match

**Status**: Fixed
**Severity**: High
**Found**: 2026-03-06 (audit)
**Symptom**: `getLinesAfterInput` could match a `>` character deep inside Claude's output, cutting off the response.
**Root cause**: Prompt regex matched `>` anywhere in a line.
**Fix** (`server.ts`): Tightened to match only near line start (within first 10 chars) with minimum 5 char requirement.
**Test**: `test-bugs.ts` -- code path check.

---

## BUG-018: entryTtsCursor memory leak

**Status**: Fixed
**Severity**: High
**Found**: 2026-03-06 (audit)
**Symptom**: `entryTtsCursor` Map grew without bound as entries were trimmed from `conversationEntries`.
**Root cause**: Entry trimming didn't clean up corresponding `entryTtsCursor` entries.
**Fix** (`server.ts`): Clean up `entryTtsCursor` keys when entries are trimmed.
**Test**: `test-bugs.ts` -- code path check.

---

## BUG-019: Voice queue drain lock not released on exception

**Status**: Fixed
**Severity**: High
**Found**: 2026-03-06 (audit)
**Symptom**: If `_voiceQueueDraining` threw an exception, the lock remained true, permanently blocking all future voice input.
**Root cause**: No try/finally wrapper around the drain logic.
**Fix** (`server.ts`): Wrapped drain logic in try/finally to always release lock.
**Test**: `test-bugs.ts` -- code path check.

---

## BUG-020: Whisper STT no retry on failure

**Status**: Fixed
**Severity**: High
**Found**: 2026-03-06 (audit)
**Symptom**: A single transient Whisper failure (network hiccup, service restart) lost the user's audio with no recovery.
**Root cause**: STT had no retry logic.
**Fix** (`server.ts`): Added one retry attempt + error broadcast to client.
**Test**: `test-bugs.ts` -- code path check.

---

## BUG-021: Flow mode exit doesn't clean up flow-recording class

**Status**: Fixed
**Severity**: High
**Found**: 2026-03-06 (audit)
**Symptom**: Exiting flow mode while recording left `flow-recording` class on body, causing visual glitches in normal mode.
**Root cause**: Exit handlers didn't remove `flow-recording` or call `stopBargeIn()`.
**Fix** (`index.html`): Both exit paths (flowExitBtn + flowModeBtn) remove `flow-recording` and call `stopBargeIn()`.
**Test**: `test-bugs.ts` -- code path check.

---

## BUG-022: combineAudioBuffers temp file collision

**Status**: Fixed
**Severity**: High
**Found**: 2026-03-06 (audit)
**Symptom**: Concurrent TTS calls could overwrite each other's temp files in `combineAudioBuffers`.
**Root cause**: Static temp file path without unique identifier.
**Fix** (`server.ts`): Unique IDs per call using counter + timestamp.
**Test**: `test-bugs.ts` -- code path check.

---

## BUG-023: Zombie curl processes on TTS timeout

**Status**: Fixed
**Severity**: High
**Found**: 2026-03-06 (audit)
**Symptom**: If TTS curl hung beyond the Node timeout, the curl process continued running as a zombie.
**Root cause**: No explicit process kill on timeout.
**Fix** (`server.ts`): Added 35s kill timer on TTS curl spawn.
**Test**: `test-bugs.ts` -- code path check.

---

## BUG-024: broadcastCurrentOutput trims stale entries while responding

**Status**: Fixed
**Severity**: High
**Found**: 2026-03-06 (audit)
**Symptom**: During active Claude response, `broadcastCurrentOutput` trimmed entries that were still being built, causing content loss.
**Root cause**: Entry trimming logic ran unconditionally regardless of stream state.
**Fix** (`server.ts`): Only trim stale entries when NOT responding (streamState === "IDLE" or "DONE").
**Test**: `test-bugs.ts` -- code path check.

---

## BUG-025: XSS in session row rendering

**Status**: Fixed
**Severity**: High
**Found**: 2026-03-06 (audit)
**Symptom**: Tmux session/window names containing HTML could execute arbitrary JavaScript in the session popover.
**Root cause**: `sess.name` and `win.name` interpolated into innerHTML without escaping.
**Fix** (`index.html`): Added `escHtml()` utility, applied to session and window names.
**Test**: `test-bugs.ts` -- code path check for escHtml.

---

## BUG-026: XSS in TTS word highlight

**Status**: Fixed
**Severity**: High
**Found**: 2026-03-06 (audit)
**Symptom**: Word highlight markup could execute injected HTML if message text contained HTML tags.
**Root cause**: Word split + span wrapping used raw text without escaping.
**Fix** (`index.html`): Both highlight locations use `escHtml(m)` for each word.
**Test**: `test-bugs.ts` -- code path check for escHtml in highlight.

---

## BUG-027: Initial flow render darkens partial streaming entries

**Status**: Fixed
**Severity**: High
**Found**: 2026-03-06 (audit)
**Symptom**: When entering flow mode during active streaming, partial entries appeared dimmed/darkened.
**Root cause**: Flow entry rendering applied opacity reduction to all non-final entries.
**Fix** (`index.html`): Skip opacity reduction for entries in the active streaming turn.
**Test**: `test-e2e.ts` -- flow mode rendering tests.

---

## BUG-028: TTS highlight retry uses parallel timeouts

**Status**: Fixed
**Severity**: Medium
**Found**: 2026-03-06 (audit)
**Symptom**: Multiple parallel retry timeouts could fire simultaneously, causing duplicate highlights and race conditions.
**Root cause**: Each retry spawned a new `setTimeout` without cancelling previous ones.
**Fix** (`index.html`): Single chained timeout instead of parallel retries.
**Test**: `test-bugs.ts` -- code path check.

---

## BUG-029: entryTtsCursor.clear() called before stopClientPlayback

**Status**: Fixed
**Severity**: Medium
**Found**: 2026-03-06 (audit)
**Symptom**: Clearing TTS cursor before stopping playback could cause `handleTtsDone` to reference missing cursor state.
**Root cause**: Order of operations in cleanup path.
**Fix** (`server.ts`): Moved `entryTtsCursor.clear()` after `stopClientPlayback()`.
**Test**: `test-bugs.ts` -- code path check.

---

## BUG-030: Local TTS timeout too generous

**Status**: Fixed
**Severity**: Medium
**Found**: 2026-03-06 (audit)
**Symptom**: Local TTS (`_local:` voices) had a 15s minimum timeout, causing long hangs when Web Speech API froze.
**Root cause**: `Math.max(15000, ...)` was too high for local voices.
**Fix** (`server.ts`): Changed to `Math.max(8000, wordCount * 400 + 5000)`.
**Test**: `test-bugs.ts` -- code path check.

---

## BUG-031: Kokoro TTS duration estimation inaccurate for VBR MP3

**Status**: Fixed
**Severity**: Medium
**Found**: 2026-03-06 (audit)
**Symptom**: TTS playback timeout was too short for longer responses because duration was estimated at 16KB/s (WAV rate) instead of VBR MP3 rate.
**Root cause**: Duration formula used WAV byte rate for MP3 content.
**Fix** (`server.ts`): Changed from 16KB/s to 12KB/s for VBR MP3 estimation.
**Test**: `test-bugs.ts` -- code path check.

---

## BUG-032: Voice name not validated at load

**Status**: Fixed
**Severity**: Medium
**Found**: 2026-03-06 (audit)
**Symptom**: Invalid voice name in settings could cause TTS failures on every request.
**Root cause**: Voice name loaded from settings.json without validation.
**Fix** (`server.ts`): Validate against VALID_VOICES regex at load, fallback to default.
**Test**: `test-bugs.ts` -- code path check.

---

## BUG-033: Barge-in AudioContext never closed

**Status**: Fixed
**Severity**: Medium
**Found**: 2026-03-06 (audit)
**Symptom**: Each barge-in recording created a new AudioContext that was never closed, leaking system audio resources.
**Root cause**: `stopBargeIn()` didn't close the AudioContext.
**Fix** (`index.html`): Track barge-in AudioContext as `_bargeInCtx` and close in `stopBargeIn()`.
**Test**: `test-bugs.ts` -- code path check.

---

## BUG-034: Barge-in baseline too few samples

**Status**: Fixed
**Severity**: Medium
**Found**: 2026-03-06 (audit)
**Symptom**: Barge-in detection had unreliable baseline with only 15 samples, causing false triggers in noisy environments.
**Root cause**: 15 samples (~250ms) insufficient for stable ambient level estimation.
**Fix** (`index.html`): Increased baseline samples from 15 to 30 (~500ms).
**Test**: `test-bugs.ts` -- code path check.

---

## BUG-035: VAD baseline not updated during recording

**Status**: Fixed
**Severity**: Medium
**Found**: 2026-03-06 (audit)
**Symptom**: Long recordings in changing noise environments (e.g., entering a car) used stale baseline, causing premature silence detection.
**Root cause**: Ambient baseline was set once at recording start and never updated.
**Fix** (`index.html`): Slow EMA update of baseline during recording.
**Test**: `test-bugs.ts` -- code path check.

---

## BUG-036: Word highlight scroll fires on every word

**Status**: Fixed
**Severity**: Medium
**Found**: 2026-03-06 (audit)
**Symptom**: During TTS playback, scroll position update on every highlighted word caused jank and performance issues.
**Root cause**: No debounce on highlight scroll.
**Fix** (`index.html`): Debounced to every 5 words.
**Test**: `test-bugs.ts` -- code path check.

---

## BUG-037: Empty state visible in flow mode

**Status**: Fixed
**Severity**: Low
**Found**: 2026-03-06 (audit)
**Symptom**: "No messages yet" empty state overlay showed in flow mode, conflicting with the voice-only interface.
**Root cause**: No CSS rule to hide empty state in flow mode.
**Fix** (`index.html`): Added `body.flow-mode .empty-state { display: none; }`.
**Test**: `test-bugs.ts` -- code path check.

---

## BUG-038: scrollTranscript doesn't scroll to active TTS entry

**Status**: Fixed
**Severity**: Low
**Found**: 2026-03-06 (audit)
**Symptom**: During TTS playback, manual scroll or auto-scroll didn't prioritize the entry being spoken.
**Root cause**: `scrollTranscript` had no awareness of which entry was actively playing.
**Fix** (`index.html`): `scrollTranscript` scrolls to active TTS entry when speaking.
**Test**: `test-bugs.ts` -- code path check.

---

## BUG-039: Fallback audio double-done callback

**Status**: Fixed
**Severity**: Low
**Found**: 2026-03-06 (audit)
**Symptom**: Fallback audio path (Web Audio API) could fire `tts_done` twice, causing queue to skip an entry.
**Root cause**: Both `onended` and error path could trigger done callback.
**Fix** (`index.html`): Added `_fbDone` guard flag to prevent double invocation.
**Test**: `test-bugs.ts` -- code path check.

---

## BUG-040: Electron graceful shutdown timeout too short

**Status**: Fixed
**Severity**: Low
**Found**: 2026-03-06 (audit)
**Symptom**: Server process killed with SIGKILL after 3s, before it could finish cleanup (save settings, close tmux session).
**Root cause**: 3s timeout too short for cleanup operations.
**Fix** (`electron/main.js`): Increased graceful shutdown timeout from 3s to 5s.
**Test**: `test-bugs.ts` -- code path check.

---

## BUG-041: localStorage access not wrapped in try-catch

**Status**: Fixed
**Severity**: Low
**Found**: 2026-03-06 (audit)
**Symptom**: In Safari private mode or when storage is full, `localStorage.getItem/setItem` throws, crashing the UI.
**Root cause**: Direct localStorage calls without error handling.
**Fix** (`index.html`): Added `lsSet()`/`lsGet()` safe wrappers.
**Test**: `test-bugs.ts` -- code path check.

---

## BUG-042: MURMUR_CONTEXT_FILTER doesn't cover all context lines

**Status**: Investigated / Partial
**Severity**: Medium
**Found**: 2026-03-06 (audit)
**Symptom**: If `MURMUR_CONTEXT_LINES` is edited without updating `MURMUR_CONTEXT_FILTER`, leaked context appears as conversation bubbles.
**Root cause**: Two separate constants must be kept in sync manually.
**Fix**: Documented in CLAUDE.md Critical Gotchas. `addUserEntry` returns sentinel `id: -1` for filtered messages.
**Test**: `test-bugs.ts` -- existing regex coverage tests.

---

## BUG-043: passiveWatcher polling interval not configurable

**Status**: Open
**Severity**: Low
**Found**: 2026-03-06 (audit)
**Symptom**: Fixed 2s polling interval too fast for low-power devices, too slow for responsive UI.
**Root cause**: Hardcoded `passiveWatcherInterval = 2000`.
**Proposed fix**: Make configurable via environment variable or settings.

---

## BUG-044: No rate limiting on WebSocket messages

**Status**: Open
**Severity**: Medium
**Found**: 2026-03-06 (audit)
**Symptom**: Malicious client can flood server with rapid WebSocket messages.
**Root cause**: No per-client rate limiting on incoming WS messages.
**Proposed fix**: Add simple rate limiter (e.g., 100 messages/second per client).

---

## BUG-045: Terminal ANSI content broadcast on every poll

**Status**: Open
**Severity**: Low
**Found**: 2026-03-06 (audit)
**Symptom**: Terminal panel content re-broadcast every 2s even when unchanged, wasting bandwidth.
**Root cause**: No diff check before broadcasting terminal content.
**Proposed fix**: Hash or compare previous terminal content, skip broadcast if unchanged.

---

## BUG-046: No WebSocket ping/pong keepalive

**Status**: Open
**Severity**: Low
**Found**: 2026-03-06 (audit)
**Symptom**: Stale WebSocket connections not detected, accumulating in `clients` Set.
**Root cause**: No ping/pong heartbeat mechanism.
**Proposed fix**: Add periodic ping from server, remove clients that don't respond.

---

## BUG-047: ttsQueue unbounded growth

**Status**: Open (partially mitigated)
**Severity**: Low
**Found**: 2026-03-06 (audit)
**Symptom**: Long Claude responses can queue 50+ TTS items, causing minutes of delayed audio.
**Root cause**: Queue max is 50 but that's still very large for real-time conversation.
**Proposed fix**: Dynamic queue limit based on conversation pace, or auto-flush old items.

---

## BUG-048: Flow mode recording state not synced across tabs

**Status**: Open
**Severity**: Low
**Found**: 2026-03-06 (audit)
**Symptom**: Starting recording in one tab doesn't reflect in another tab's UI.
**Root cause**: Recording state is per-tab, not broadcast via WebSocket.
**Proposed fix**: Broadcast recording state changes to all clients.

---

## BUG-049: Electron content update check blocks startup

**Status**: Open
**Severity**: Low
**Found**: 2026-03-06 (audit)
**Symptom**: Slow GitHub connection delays app startup while checking for content updates.
**Root cause**: Content update check is sequential in startup flow.
**Proposed fix**: Move content check to background after initial load.

---

## BUG-050: No graceful handling of Kokoro service restart

**Status**: Open (partially fixed by BUG-016)
**Severity**: Medium
**Found**: 2026-03-06 (audit)
**Symptom**: If Kokoro TTS restarts mid-conversation, queued items fail and conversation stalls.
**Root cause**: No automatic reconnection/retry when service comes back.
**Proposed fix**: Periodic health check, auto-retry queued items when service recovers.

---

## BUG-051: tmux capture-pane truncation on very wide terminals

**Status**: Open
**Severity**: Low
**Found**: 2026-03-06 (audit)
**Symptom**: Terminal content truncated if tmux pane is wider than expected.
**Root cause**: `capturePane` doesn't specify `-J` flag for joined output on wide panes.
**Proposed fix**: Add `-J` flag to capture-pane calls.

---

## BUG-052: Flow mode barge-in sensitivity not adjustable

**Status**: Open
**Severity**: Low
**Found**: 2026-03-06 (audit)
**Symptom**: Users can't adjust how loud they need to speak to interrupt TTS in flow mode.
**Root cause**: Barge-in threshold is hardcoded.
**Proposed fix**: Add sensitivity slider in flow mode settings sheet.

---

## BUG-053: No visual feedback during STT transcription

**Status**: Open
**Severity**: Low
**Found**: 2026-03-06 (audit)
**Symptom**: After recording stops, there's no visual indication that transcription is in progress until text appears.
**Root cause**: `voice_status: transcribing` state exists but UI may not show it clearly.
**Proposed fix**: Add pulsing indicator or "Transcribing..." text during STT processing.

---

## BUG-054: Multiple rapid voice toggles can create duplicate AudioContexts

**Status**: Open
**Severity**: Low
**Found**: 2026-03-06 (audit)
**Symptom**: Rapidly toggling mic creates multiple AudioContexts without closing previous ones.
**Root cause**: No debounce on mic toggle, and previous context not always cleaned up.
**Proposed fix**: Debounce toggle, ensure previous context closed before creating new one.

---

## BUG-055: Conversation entries not persisted to disk

**Status**: Open
**Severity**: Medium
**Found**: 2026-03-06 (audit)
**Symptom**: Server restart loses all conversation entries; only tmux scrollback reconstruction available.
**Root cause**: Entries stored only in memory.
**Proposed fix**: Periodic save to JSON file, restore on startup.

---

## BUG-056: No CORS restriction on HTTP endpoints

**Status**: Open
**Severity**: Low
**Found**: 2026-03-06 (audit)
**Symptom**: Any website can make requests to Murmur's HTTP endpoints on localhost.
**Root cause**: No CORS headers set, browser allows same-origin localhost requests.
**Proposed fix**: Add CORS headers restricting to same-origin.

---

## BUG-057: Debug panel messages tab grows unbounded

**Status**: Open
**Severity**: Low
**Found**: 2026-03-06 (audit)
**Symptom**: Debug panel Messages tab accumulates all WS messages, eventually consuming significant memory.
**Root cause**: No limit on stored debug messages.
**Proposed fix**: Ring buffer with max 1000 messages.

---

## BUG-058: Tour step count hardcoded in test

**Status**: Known flaky
**Severity**: Low
**Found**: 2026-03-06
**Symptom**: Test expects 11 tour steps but actual count is 12 after feature additions.
**Root cause**: Test assertion not updated when new tour step added.
**Fix**: Update test assertion to match current step count.

---

## BUG-059: Flow mode word-span preservation test flaky

**Status**: Known flaky
**Severity**: Low
**Found**: 2026-03-06
**Symptom**: "Flow mode: word spans preserved during streaming update" test intermittently fails.
**Root cause**: Race condition between DOM update and assertion timing.
**Fix**: Add more robust waiting/retry in test.

---

## BUG-060: Pre-buffer WAV can be sent after recording stops

**Status**: Open
**Severity**: Low
**Found**: 2026-03-06 (audit)
**Symptom**: Race condition where pre-buffer audio arrives at server after main recording, confusing STT.
**Root cause**: Pre-buffer send is async and not synchronized with recording stop.
**Proposed fix**: Sequence pre-buffer and main audio with message ordering.

---

## BUG-061: Font zoom persists but doesn't apply on cold start

**Status**: Open
**Severity**: Low
**Found**: 2026-03-06 (audit)
**Symptom**: Saved font size in localStorage not applied until user interacts with zoom controls.
**Root cause**: Font size restoration happens after initial render.
**Proposed fix**: Apply saved font size in early initialization before first render.

---

## BUG-062: Session color palette only 8 colors

**Status**: Open
**Severity**: Low
**Found**: 2026-03-06 (audit)
**Symptom**: With >8 tmux sessions, colors repeat, making sessions harder to distinguish.
**Root cause**: `SESS_COLORS` array has only 8 entries.
**Proposed fix**: Expand palette or use hash-based color generation.

---

## BUG-063: Electron window position not saved

**Status**: Open
**Severity**: Low
**Found**: 2026-03-06 (audit)
**Symptom**: Window position resets to center on every app launch.
**Root cause**: Window bounds not persisted.
**Proposed fix**: Save/restore window bounds in electron-store or JSON file.

---

## BUG-064: No keyboard shortcut for flow mode toggle

**Status**: Open
**Severity**: Low
**Found**: 2026-03-06 (audit)
**Symptom**: Flow mode can only be toggled via button click, not keyboard.
**Root cause**: No keyboard shortcut defined.
**Proposed fix**: Add Ctrl+Shift+F or similar shortcut.

---

## BUG-065: Tmux session list not refreshed automatically

**Status**: Open
**Severity**: Low
**Found**: 2026-03-06 (audit)
**Symptom**: New tmux sessions created after Murmur starts don't appear in session popover until manual refresh.
**Root cause**: Session list only fetched on popover open.
**Proposed fix**: Refresh on popover open + periodic background refresh.

---

## BUG-066: TTS speed change doesn't affect currently playing audio

**Status**: Open
**Severity**: Low
**Found**: 2026-03-06 (audit)
**Symptom**: Changing TTS speed only affects next queued item, not current playback.
**Root cause**: Audio playback rate set at creation time, not dynamically updated.
**Proposed fix**: Update `playbackRate` on active AudioBufferSourceNode when speed changes.

---

## BUG-067: No error UI for failed text submission

**Status**: Open
**Severity**: Low
**Found**: 2026-03-06 (audit)
**Symptom**: If terminal.sendText fails (tmux not available), user gets no feedback that their message wasn't sent.
**Root cause**: sendText errors not propagated to frontend.
**Proposed fix**: Broadcast error state to client, show inline error on the user's entry.

---

## BUG-068: Content auto-update doesn't verify file integrity

**Status**: Open
**Severity**: Low
**Found**: 2026-03-06 (audit)
**Symptom**: Downloaded content update could be truncated or corrupted without detection.
**Root cause**: No checksum verification after download.
**Proposed fix**: Verify SHA256 of downloaded content matches expected hash.

---

## BUG-069: Reconnect backoff doesn't distinguish server restart from crash

**Status**: Open
**Severity**: Low
**Found**: 2026-03-06 (audit)
**Symptom**: After intentional server restart, client waits through exponential backoff instead of reconnecting immediately.
**Root cause**: `restarting` WS message received but backoff still applies.
**Proposed fix**: Reset backoff to 0 when `restarting` message received.

---

## BUG-070: Think mode recording always submits regardless of energy

**Status**: By design
**Severity**: N/A
**Found**: 2026-03-06
**Note**: Think mode intentionally bypasses energy check to always submit audio. This is a feature, not a bug -- user explicitly opted into think mode recording.

---

## BUG-071: Multiple concurrent pipe-pane streams possible

**Status**: Open
**Severity**: Low
**Found**: 2026-03-06 (audit)
**Symptom**: Calling `startPipeStream` multiple times without stopping could create duplicate pipe streams.
**Root cause**: No check for existing active pipe before starting new one.
**Proposed fix**: Stop existing pipe before starting new one.

---

## BUG-072: Wake word detection too permissive

**Status**: Open
**Severity**: Low
**Found**: 2026-03-06 (audit)
**Symptom**: Words like "clyde" and "cloud" trigger wake word detection, causing unintended activations.
**Root cause**: Fuzzy matching regex includes common words.
**Proposed fix**: Tighten wake word matching or add confirmation step.

---
