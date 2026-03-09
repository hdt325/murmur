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

**Status**: Fixed
**Severity**: Medium
**Found**: 2026-03-06 (audit)
**Symptom**: Malicious client can flood server with rapid WebSocket messages.
**Root cause**: No per-client rate limiting on incoming WS messages.
**Fix** (`server.ts`): Rate limiter implemented — `RATE_LIMIT_MAX=100` messages per `RATE_LIMIT_WINDOW_MS=1000ms`. Tracks `_rateMsgCount` and `_rateWindowStart` per connection. Excess messages logged as "rate-limited" in wslog.

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

**Status**: Fixed
**Severity**: Low
**Found**: 2026-03-06 (audit)
**Symptom**: Users can't adjust how loud they need to speak to interrupt TTS in flow mode.
**Root cause**: Barge-in threshold is hardcoded.
**Fix**: Echo gate (2x threshold during TTS) + VAD presets provide adjustable sensitivity.

---

## BUG-053: No visual feedback during STT transcription

**Status**: Fixed
**Severity**: Low
**Found**: 2026-03-06 (audit)
**Symptom**: After recording stops, there's no visual indication that transcription is in progress until text appears.
**Root cause**: `voice_status: transcribing` state exists but UI may not show it clearly.
**Fix** (`index.html`): "Transcribing..." header text + talk button gets `transcribing` CSS class with pulsing animation. `setHeaderState("transcribing", "Transcribing...")` fires on voice_status transcribing state.

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

## BUG-073: Duplicate conversation bubbles from history + entry overlap

**Status**: Fixed
**Severity**: Critical
**Found**: 2026-03-07
**Symptom**: Same Claude message appears multiple times in the conversation view. Duplicates appear on every page load.
**Root cause**: Two independent rendering paths coexist: `restoreHistory()` creates `.msg` elements from localStorage, then `renderEntries()` creates `.entry-bubble` elements from server data. The `renderEntries` cleanup only removes stale `.entry-bubble` elements — it never touches the legacy `.msg` bubbles from `restoreHistory`. Both show the same content.
**Fix** (`index.html`): `renderEntries()` now clears all `.msg:not(.entry-bubble)` elements at the start of each call, removing legacy history bubbles when the entry system takes over.
**Test**: Smoke + E2E pass (40/43, 100/105 — no regressions).

---

## BUG-074: Positional paragraph shift creates duplicate entries during streaming

**Status**: Fixed
**Severity**: High
**Found**: 2026-03-07
**Symptom**: During long Claude responses, the same text appears in multiple entry bubbles.
**Root cause**: `broadcastCurrentOutput()` matches extracted paragraphs to existing entries by array index. During long responses, early content scrolls off the tmux pane, reducing the paragraph count. The positional match then shifts — paragraph 3 overwrites entry 1, paragraph 4 overwrites entry 2, etc. — while the original entries 3+ retain their old text. Result: same text in multiple entries.
**Fix** (`server.ts`): (1) During RESPONDING, skip positional update if the first 20 chars don't match (detects shifted content). (2) Dedup new assistant entries against existing same-turn entries by exact text match. Applied in both `broadcastCurrentOutput` and `handleStreamDone`.
**Test**: Smoke + E2E pass — no regressions.

---

## BUG-075: Duplicate user bubble from whitespace-variant text

**Status**: Fixed
**Severity**: High
**Found**: 2026-03-07
**Symptom**: `addUserEntry()` dedup fails to catch duplicates where text differs only in whitespace.
**Root cause**: Original turn-based dedup only checked entries within the current turn. Concurrent turn increments caused the dedup window to miss duplicates.
**Fix**: Cross-turn dedup now checks last 20 entries regardless of turn boundary.
**Test**: `test-bugs.ts` — regression test.

---

## BUG-076: Double TTS drain from duplicate tts_done callbacks

**Status**: Fixed
**Severity**: High
**Found**: 2026-03-07
**Symptom**: TTS queue drained twice from duplicate `tts_done` callbacks arriving within milliseconds.
**Fix**: 50ms dedup window in `handleTtsDone` guards against fast-queue-drain race.

---

## BUG-077: Red text highlight flicker on unspoken entries (bubble-dropped race)

**Status**: Fixed
**Severity**: High
**Found**: 2026-03-07
**Symptom**: Entries briefly flash red (bubble-dropped) then return to normal.
**Fix**: ttsPendingIds prevents red flash during TTS fetch. Replaces previous approach of hoisted `_ttsStillActive` check.

---

## BUG-078: Entry count drops during THINKING state

**Status**: Fixed
**Severity**: Critical
**Found**: 2026-03-07 (Monitor alert)
**Symptom**: Entry count drops to 0 repeatedly during test runs.
**Root cause**: `test:reset-entries` nuked global `conversationEntries[]` array.
**Fix**: Replaced with scoped `test:clear-entries` using per-connection `_testEntryIds` tracking.

---

## BUG-079: TTS queue stalls with items remaining when ttsInProgress is false

**Status**: Fixed (stall recovery mechanism)
**Severity**: Critical
**Found**: 2026-03-07 (Monitor alert)
**Symptom**: TTS queue has items but `ttsInProgress` is false — audio stops. Severe instance: 42 items queued, nothing playing (07:46 UTC). Also causes highlight mismatches (tts counter vs highlight counter out of sync).
**Fix** (`server.ts`): `sweepStaleTtsJobs()` runs every 15s. `TtsJob.playingSince` timestamp set when job enters playing state. If playing > `TTS_PLAYING_TIMEOUT_MS` (30s) without client ack, job force-drained with `tts_stop` reason `"stall_recovery"`. Also see BUG-114/BUG-123 for related stall fixes.

---

## BUG-080: MURMUR_EXIT (Prose mode off) leaks to CLI when last WS client disconnects

**Status**: Fixed (v3)
**Severity**: High
**Found**: 2026-03-08 (UX-Expert investigation)
**Symptom**: Test browser disconnecting triggers `MURMUR_EXIT` to live CLI.
**Fix**: (v1) Debounce timer checks for real clients. (v3) Session target guard — only fire for `claude-voice` session. Also added prose mode filter for tmux-wrapped continuation lines.

---

## BUG-081: TTS audio briefly duplicated during playback

**Status**: Fixed
**Severity**: High
**Found**: 2026-03-08 (user report)
**Symptom**: TTS audio briefly plays duplicate/overlapping audio. Monitor evidence: same text spoken twice with 3041ms gap.
**Fix**: Chunk-level ack protocol in TTS Pipeline v2 eliminates overlap. Previous partial fixes (pregen race, queue flush on disconnect) were insufficient.

---

## BUG-082: TTS highlight on wrong chat bubble during playback

**Status**: Fixed
**Severity**: High
**Found**: 2026-03-08 (user report)
**Symptom**: TTS highlight appears on wrong bubble during playback.
**Fix**: Fixed pregen race condition. Added debug API ring buffers for tts-history, highlight-log, entry-log.

---

## BUG-083: Server RSS memory escalating across sessions (potential leak)

**Status**: Open
**Severity**: Medium
**Found**: 2026-03-08 (Profiler alert)
**Symptom**: RSS memory escalating: 109→113→116→123→134 MB across sessions.
**Proposed fix**: Profile heap snapshots to identify growing objects.

---

## BUG-084: Temporal dead zone crashes page on load

**Status**: Fixed
**Severity**: Critical
**Found**: 2026-03-08
**Symptom**: Page crashes entirely on load due to `let` temporal dead zone errors.
**Root cause**: Three variables (`ttsPlaying`, `autoListenEnabled`, `_vadPresetKey`) declared with `let` after their first usage sites in index.html.
**Fix**: Hoisted declarations to global state section above first usage sites. Original declaration sites changed to reassignments.

---

## BUG-085: preInputSnapshot timing gap (precision issue S14)

**Status**: Fixed
**Severity**: Medium
**Found**: 2026-03-08 (TTS redesign audit)
**Symptom**: Passive watcher could capture stale pre-input snapshot, causing diff to include user's own text as Claude output.
**Root cause**: Snapshot captured too early — gap between snapshot and sendText allowed terminal content to change.
**Fix**: Snapshot captured immediately before sendText; passive watcher saves only when idle.

---

## BUG-086: Passive watcher text matching for CLI input (precision issue S15)

**Status**: Fixed
**Severity**: Medium
**Found**: 2026-03-08 (TTS redesign audit)
**Symptom**: Passive watcher continuation detection didn't stop at separator lines, matching across boundaries.
**Root cause**: Missing separator line detection (─━═) in continuation loop.
**Fix**: Added `^[─━═]{3,}` check to passive watcher continuation line loop.

---

## BUG-087: _flowWordPos vs text mutation during streaming (precision issue S16)

**Status**: Fixed
**Severity**: Medium
**Found**: 2026-03-08 (TTS redesign audit)
**Symptom**: Flow mode karaoke word position drifted when entry text mutated during streaming updates.
**Root cause**: `_flowWordPos` tracked absolute index but DOM word spans could be re-created on text update.
**Fix**: Word position derives from DOM (spoken span count); re-wraps on mismatch.

---

## BUG-088: ttsPlaying boolean race (precision issue T3)

**Status**: Fixed
**Severity**: Medium
**Found**: 2026-03-08 (TTS redesign audit)
**Symptom**: `ttsPlaying` flag could get stuck true if client disconnected mid-playback.
**Root cause**: Flag set/cleared at wrong lifecycle points; no disconnect cleanup.
**Fix**: Flag set at audio start/end; disconnect handler prevents stale state.

---

## BUG-089: clearFlowWordHighlight save/restore fragility (precision issue T6)

**Status**: Fixed
**Severity**: Medium
**Found**: 2026-03-08 (TTS redesign audit)
**Symptom**: clearFlowWordHighlight saved/restored DOM state, but restore could apply stale snapshot after text mutation.
**Root cause**: Fragile save/restore pattern for DOM state.
**Fix**: Marks unspoken text red (dropped indicator); no fragile save/restore needed.

---

## BUG-090: renderEntries removes actively-highlighted DOM (precision issue T7)

**Status**: Fixed
**Severity**: Medium
**Found**: 2026-03-08 (TTS redesign audit)
**Symptom**: renderEntries innerHTML update destroyed active word highlight spans mid-karaoke.
**Root cause**: renderEntries overwrote entry bubble innerHTML unconditionally.
**Fix**: renderEntries skips innerHTML update if entry has active word spans.

---

## BUG-091: pipe-pane vs capture-pane content divergence (precision issue T8)

**Status**: Fixed
**Severity**: Medium
**Found**: 2026-03-08 (TTS redesign audit)
**Symptom**: pipe-pane and capture-pane saw different terminal content, causing inconsistent output detection.
**Root cause**: pipe-pane streams continuously while capture-pane snapshots — timing creates divergence.
**Fix**: pipe-pane used as activity signal only; capture-pane is the content source of truth.

---

## BUG-092: entryTextToHtml vs word-span innerHTML churn (precision issue T11)

**Status**: Fixed
**Severity**: Medium
**Found**: 2026-03-08 (TTS redesign audit)
**Symptom**: entryTextToHtml and karaoke word-span wrapping both set innerHTML, causing churn and flicker.
**Root cause**: Two competing innerHTML writers for the same entry bubble.
**Fix**: entryTextToHtml handles plain text only; word spans added separately by karaoke system.

---

## BUG-093: PtyBackend sendText has no retry logic (precision issue T9)

**Status**: Open
**Severity**: Low
**Found**: 2026-03-08 (TTS redesign audit)
**Symptom**: Windows pty backend has no retry logic for sendText, unlike tmux backend which has 3 retries with stuck detection.
**Root cause**: PtyBackend.sendText implemented without retry mechanism.
**Proposed fix**: Add retry logic matching tmux backend pattern. Low priority — macOS only right now.

---

## BUG-094: Entry cap causes entries to disappear (filter+reassign race)

**Status**: Fixed
**Severity**: High
**Found**: 2026-03-08
**Symptom**: Conversation entries disappear when the entry array hits the cap limit.
**Root cause**: Entry cap enforcement used `filter()` + array reassignment, which could race with concurrent array mutations and produce an empty array.
**Fix**: Entry cap uses `splice()` instead of `filter()`+reassign (in-place mutation). Safety guard prevents the array from being emptied entirely.
**Test**: `test-bugs.ts` — regression test.

---

## BUG-095: Redundant TTS requeue warnings from speculative path

**Status**: Fixed
**Severity**: Low
**Found**: 2026-03-08
**Symptom**: Console flooded with TTS requeue warnings when speculative generation re-queued entries already in the TTS pipeline.
**Root cause**: Speculative path had its own logging that duplicated queueTts logging. No dedup check for already-queued entries.
**Fix**: Removed redundant ttslog from speculative path. `queueTts` handles all logging via `source` parameter and skips duplicate queue for already-queued entries.
**Test**: `test-bugs.ts` — regression test.

---

## BUG-096: Entry cap overflow — entries exceeding 200 cap

**Status**: Fixed
**Severity**: High
**Found**: 2026-03-08
**Symptom**: `conversationEntries` array exceeds the 200 entry cap, growing unbounded.
**Root cause**: `trimEntriesToCap` not called consistently from all entry creation paths.
**Fix**: `trimEntriesToCap` called from 3 sites: addUserEntry, addAssistantEntry, and broadcastCurrentOutput.
**Test**: `test-bugs.ts` — regression test.

---

## BUG-097: Triplicate user entries from passive watcher re-detection

**Status**: Fixed
**Severity**: High
**Found**: 2026-03-08
**Symptom**: Same user message appears 3 times as separate entries.
**Root cause**: Passive watcher re-detected already-processed user input from terminal, calling `addUserEntry` again.
**Fix**: `_lastPassiveUserInput` with 30s dedup window prevents passive watcher from re-creating entries for recently submitted text.
**Test**: `test-bugs.ts` — regression test.

---

## BUG-098: Positional shift in broadcastCurrentOutput (BUG-A v2)

**Status**: Fixed
**Severity**: High
**Found**: 2026-03-08
**Symptom**: During streaming, entry text gets assigned to wrong entry IDs as tmux content scrolls.
**Root cause**: Array-index-based paragraph-to-entry matching fails when content scrolls off tmux pane.
**Fix**: Text-similarity matching (exact match → prefix match → fallback) replaces array index. Entries matched by content, not position.
**Test**: `test-bugs.ts` — regression test.

---

## BUG-099: File path filter too aggressive — filters legitimate responses

**Status**: Fixed
**Severity**: Medium
**Found**: 2026-03-08
**Symptom**: Claude responses containing file paths (e.g., `/src/utils.ts`) filtered out as system context.
**Root cause**: Path detection regex matched any line containing a `/`-prefixed path, even in normal conversation.
**Fix**: Word count guard (lines with >5 words kept) + standalone path detection (only filters lines that are purely paths).

---

## BUG-100: Status line filter captures spinner characters incorrectly

**Status**: Fixed
**Severity**: Medium
**Found**: 2026-03-08
**Symptom**: Lines starting with spinner animation characters (⠋⠙⠹ etc.) incorrectly kept as response content.
**Root cause**: Complex spinner detection regex had false negatives.
**Fix**: Simplified to check if line starts with any spinner character from the known set.

---

## BUG-101: Stale TTS playback after new user input

**Status**: In progress (Coder working)
**Severity**: High
**Found**: 2026-03-08
**Symptom**: Old TTS audio keeps playing after user sends a new message and Claude starts responding to it.
**Root cause**: TTS jobs from previous turn not cancelled when new turn begins.
**Proposed fix**: Cancel old-turn jobs when first new assistant entry arrives; play transition tone.

---

## BUG-102: Tool output leaking to conversation view

**Status**: In progress (Coder working)
**Severity**: High
**Found**: 2026-03-08
**Symptom**: Bash(), ⏺, ⎿ lines from Claude's tool execution appearing as conversation bubbles.
**Root cause**: Output parser not filtering tool execution markers from captured terminal content.
**Proposed fix**: Add tool output pattern matching to entry filter.

---

## BUG-103: Background task notifications leaking to conversation

**Status**: In progress (Coder working)
**Severity**: Medium
**Found**: 2026-03-08
**Symptom**: "Background command completed" text appearing as conversation bubbles.
**Root cause**: Background task completion messages not filtered by entry creation pipeline.
**Proposed fix**: Add background task notification pattern to filter list.

---

## BUG-104: Flashing CLI text from mid-execution capture

**Status**: Diagnosed
**Severity**: Medium
**Found**: 2026-03-08
**Symptom**: Tool output text briefly appears as a bubble then vanishes.
**Root cause**: capture-pane snapshot taken mid-tool-execution captures transient content. Next capture sees different content and the entry gets removed/overwritten.
**Proposed fix**: Debounce entry creation during tool execution; only create entries from stable content.

---

## BUG-105: Replay button not wired — zero WS messages sent

**Status**: Fixed
**Severity**: Medium
**Found**: 2026-03-08 (Monitor confirmed)
**Symptom**: Tapping replay button on a bubble does nothing. Monitor confirmed zero WS messages sent.
**Root cause**: Client-side replay handler not firing — event delegation or selector mismatch.
**Fix** (`index.html`): Event delegation on `#transcript` for `.msg-replay` buttons. Per-bubble replay sends `replay:ENTRY_ID`. Control bar `#replayBtn` sends `"replay"`, `#replayAllBtn` sends `"replay:all"`. All check `WebSocket.OPEN` before sending.

---

## BUG-106: Labeled generation bump refinement — new_input split

**Status**: In progress (Coder working)
**Severity**: Medium
**Found**: 2026-03-08
**Symptom**: `new_input` generation bump cancels TTS even for passive re-detection (not genuine new input).
**Root cause**: Single `new_input` reason used for both genuine user input and passive watcher re-detection.
**Proposed fix**: Split into `user_input` (cancels TTS) and `passive_redetect` (preserves current playback).

---

## BUG-107: Recursive _sendTtsDone causes stack overflow (Reviewer audit)

**Status**: Fixed
**Severity**: Critical
**Found**: 2026-03-08 (Reviewer audit)
**Symptom**: Local function `_sendTtsDone` in `playLocalTts()` shadows global `_sendTtsDone()` and calls itself recursively → stack overflow.
**Root cause**: Local variable shadows global function of same name; recursive call at index.html:6655.
**Fix** (`index.html`): No local shadowing in current code. `_sendTtsDone` defined once at line 6596 as a global function; `playLocalTts` calls it correctly without redefinition. Shadowing removed during TTS v2 redesign.

---

## BUG-108: Incomplete ANSI strip regex in validation.ts (Reviewer audit)

**Status**: Fixed
**Severity**: High
**Found**: 2026-03-08 (Reviewer audit)
**Symptom**: ANSI strip regex only handles CSI sequences (`ESC[...letter`). Misses OSC (`ESC]...BEL`), APC, 8-bit CSI (`\x9b`).
**Root cause**: Regex `/\x1b\[[0-9;]*[A-Za-z]/g` too narrow.
**Fix** (`server/validation.ts`): Regex expanded to cover CSI, OSC (`\x1b\][^\x07]*\x07`), APC/PM (`\x1b[_^][^\x1b]*\x1b\\`), and 8-bit CSI (`\x9b[0-9;]*[A-Za-z]`).

---

## BUG-109: Missing .catch() on server.ts TTS promise chains (Reviewer audit)

**Status**: Fixed
**Severity**: High
**Found**: 2026-03-08 (Reviewer audit)
**Symptom**: `checkService().then(...)` and `fetchKokoroAudio().then(() => drainAudioBuffer())` lack `.catch()` handlers. Unhandled rejection in `drainAudioBuffer()` would crash the process.
**Fix** (`server.ts`): All `.then(() => drainAudioBuffer())` chains now have `.catch(err => ...)` handlers for fetchKokoroAudio, fetchPiperAudio, and fetchElevenLabsAudio. Both the initial fetch path and the in-flight resume path have catch handlers.

---

## BUG-110: Settings save mutex swallows errors (Reviewer audit)

**Status**: Open (audit finding)
**Severity**: Medium
**Found**: 2026-03-08 (Reviewer audit)
**Symptom**: Mutex `.catch()` in settings.ts logs error and returns `undefined` → next queued write proceeds as if previous succeeded.
**Root cause**: Error handler doesn't re-throw, masking write failures.
**Fix needed**: Re-throw after logging to maintain mutex integrity.

---

## BUG-111: iOS double-tap zoom on mic button

**Status**: In progress
**Severity**: Medium
**Found**: 2026-03-08
**Symptom**: Double-tapping mic button on iOS triggers Safari's zoom instead of cancel-recording action.
**Root cause**: Missing `touch-action: manipulation` CSS on mic button.
**Fix**: Add `touch-action: manipulation` to mic/talk button.

---

## BUG-112: Filler phrases not appearing as conversation bubbles

**Status**: Queued for Coder
**Severity**: Medium
**Found**: 2026-03-08
**Symptom**: Filler phrases ("Got it", "Let me dig into that") are spoken via TTS but don't appear as entries in conversation view.
**Root cause**: Filler audio bypasses entry creation — sent directly to TTS without `addAssistantEntry`.
**Proposed fix**: Create proper conversation entries for filler phrases before TTS queuing.

---

## BUG-113: Filler phrases triggering mic/VAD feedback loop

**Status**: Open
**Severity**: High
**Found**: 2026-03-08
**Symptom**: Filler audio played through speakers is picked up by mic, triggering VAD as if user is speaking → creates a feedback loop.
**Root cause**: Filler audio not routed through full TTS pipeline, so echo gate doesn't activate during filler playback.
**Fix needed**: Route fillers through full TTS pipeline so echo gate (2x threshold) is active during filler playback.

---

## BUG-114: TTS stall — job stuck in playing state

**Status**: Fixed (stall recovery, root cause partially addressed)
**Severity**: Critical
**Found**: 2026-03-08
**Symptom**: TTS job stuck in "playing" state; client never sends `tts_done`, blocking entire queue.
**Root cause**: Client-side audio playback completes but `tts_done` message not sent (race or error in completion handler).
**Fix** (`server.ts`): `TtsJob.playingSince` timestamp + `TTS_PLAYING_TIMEOUT_MS=30000` timeout. `sweepStaleTtsJobs()` runs every 15s, detects jobs in "playing" state beyond timeout, force-drains them. See also BUG-079, BUG-123.

---

## BUG-115: Role misattribution — assistant text as user bubble

**Status**: Diagnosed (Monitor)
**Severity**: High
**Found**: 2026-03-08
**Symptom**: Assistant response text appears in a user-role bubble. Monitor confirmed: entry 21 (role=user src=passive-watcher) contained assistant suggestion text. Passive watcher always assigns role=user.
**Root cause**: Passive watcher treats all text after `❯` as user input. When shell commands or assistant text appears near the prompt, it gets tagged as user role.
**Proposed fix**: Investigate role assignment logic in entry creation pipeline.

---

## BUG-116: Raw command output leaks into conversation (PS-OUTPUT-LEAK)

**Status**: Fixed
**Severity**: High
**Found**: 2026-03-09 (Monitor diagnosis)
**Symptom**: `ps` output ("3023 -zsh") appeared as a conversation bubble. Any raw command output (ps, ls, grep, curl) between prompts leaks through.
**Root cause**: `isToolOutputLine()` is a LINE-LEVEL filter — checks each line for tool markers (⏺, ⎿, Bash(). Raw command results have NO markers and pass through. The filter catches tool invocations but not tool results.
**Fix** (`server.ts`): Complete redesign — `extractStructuredOutput` now uses a 4-state machine parser replacing line-level filtering:
- `ParserState = "PROSE" | "TOOL_BLOCK" | "AGENT_BLOCK" | "STATUS"`
- **TOOL_BLOCK**: Entered on `isToolMarker()` (⏺ Bash, ⎿, Read(...), etc.). ALL continuation lines swallowed as non-speakable — no marker required. Exits on: (1) `isProseMarker()` (⏺ + prose text), (2) empty line, (3) new tool marker (flush + stay). This captures raw command output that line-level filters missed.
- **AGENT_BLOCK**: Entered on XML tags (`<teammate-message>`, `<task-notification>`, `<system-reminder>`). Swallows everything until closing tag.
- **PROSE**: Default state. Lines pass through `isChromeSkip()` (36+ patterns for TUI chrome, spinner, navigation, permissions, feedback, menu fragments) and `isNonSpeakableLine()` (timing, ctrl hints, file paths, tool summaries). Tool markers NOT in `isChromeSkip` — they must go through state machine to trigger TOOL_BLOCK transitions.
- `isToolOutputLine()` retained as secondary filter for streaming path.
- Helper functions extracted: `isToolMarker()`, `isProseMarker()`, `isChromeSkip()`, `isNonSpeakableLine()`.
**Test**: `testBug116_blockLevelToolParser` (12 assertions: ParserState type, state variable in extractStructuredOutput, isToolMarker/isProseMarker/isChromeSkip extracted, isChromeSkip excludes tool markers, TOOL_BLOCK continuation capture, exits on empty line and prose marker, AGENT_BLOCK for XML, isToolOutputLine retained, old inToolBlock boolean removed).
**Reviewer notes**: (1) `isChromeSkip` has a `low_alpha_ratio` heuristic (< 0.4 alpha chars for lines < 100 chars) — could false-positive on short prose with punctuation. (2) `isProseMarker` regex `!/^⏺\s+\w+[\s(]?$/` — the `?$` means a single word after ⏺ is treated as a tool name. Two-word tool names (unlikely) would incorrectly exit TOOL_BLOCK. (3) AGENT_BLOCK has no depth tracking — nested XML tags would break, though Claude Code doesn't nest these tags.

---

## BUG-117: Coordinator CLI session leaking into Murmur conversation (CLI-LEAK-PASSIVE-WATCHER)

**Status**: Mitigated (multiple defenses, residual risk)
**Severity**: Critical
**Found**: 2026-03-09 (Monitor diagnosis)
**Symptom**: User's typed messages to the coordinator agent appear as Murmur conversation bubbles (entries 51-52, sourceTag=passive-watcher). Full CLI conversation content leaks through.
**Root cause**: Passive watcher monitors tmux pane containing coordinator's Claude Code session (~23KB snapshots). `extractStructuredOutput` sees text after `❯` prompt as user input and unmarked text as assistant response.
**Mitigations applied**: (1) BUG-116: State machine parser with TOOL_BLOCK captures command output blocks. (2) BUG-119: Source tags distinguish `voice`/`text-input`/`terminal`. (3) BUG-127: Per-window entry isolation — different windows get separate entry arrays. (4) BUG-130: Pane pinning targets correct window. (5) Context guard skips non-`claude-voice` sessions for prose mode. **Residual risk**: If passive watcher is monitoring a non-voice pane, plain prose text (no tool markers) from another Claude session still passes through the state machine as PROSE.

---

## BUG-118: Piper TTS voice selection produces no audio (PIPER-TTS-SILENT)

**Status**: Fixed (monitoring + health checks added, underlying audio still depends on Piper binary/model installation)
**Severity**: Medium
**Found**: 2026-03-09 (Monitor diagnosis)
**Symptom**: User selects Piper voice but hears no audio. Zero Piper-engine TTS jobs in debug history — all events show engine=undefined.
**Root cause**: Piper binary at pyenv shim path, not in common bin locations. Piper voice models may not be installed. `fetchPiperAudio` existed but had no monitoring or health checks.
**Fix** (`server.ts`): 4-part fix: (1) `checkPiper()` health check at startup — verifies binary + model exist via `existsSync`, (2) `serviceStatus.piper` exposed in `/api/state` for debug visibility, (3) unified `logTtsFetch(engine, ...)` replaces engine-specific logging — Piper and ElevenLabs now log with same structure as Kokoro, (4) `resolveVoiceEngine()` routes voices to correct fetch function. `fetchPiperAudio` uses `spawn("python3", ...)` (not execSync) with `_activeFetchCount` semaphore and `isJobStale()` generation checks.
**Test**: `testTtsMonitoring_piperElevenlabs` (10 assertions — checkPiper exists, serviceStatus tracks piper, periodic check, TtsFetchLog engine field, logTtsFetch function, fetchPiper/fetchElevenLabs call logTtsFetch, /api/state includes services).
**Reviewer notes**: Python `-c` script interpolates `PIPER_MODEL` path — safe while hardcoded, fragile if ever configurable. stderr suppressed entirely in Piper spawn. ElevenLabs early-return paths (no API key, unknown voice) don't call logTtsFetch — minor monitoring gap.

---

## BUG-119: Missing input source tags for voice/STT entries (INPUT-SOURCE-TAGS)

**Status**: Fixed
**Severity**: Medium
**Found**: 2026-03-09 (Monitor audit)
**Symptom**: Only 2 source tags exist on user entries: `passive-watcher` and `text-testmode`. No `voice`/`stt`/`whisper`/`mic` tag found. Voice input either shares `passive-watcher` tag or hasn't been used. Production text box tag not seen either.
**Root cause**: Voice/STT entry creation path doesn't set a distinct sourceTag. `passive-watcher` tag is used for both legitimate terminal input AND leaked coordinator content — indistinguishable.
**Fix** (`server.ts`, `terminal/tmux-backend.ts`): Three-part fix:
- **3 distinct source tags**: `voice` (STT/Whisper), `text-input` (text box), `terminal` (passive watcher native detection). Plus `text-input-resend` for resend handler. Old tags (`passive-watcher`, `stt-direct`, `stt-queue`, `text-testmode`) eliminated.
- **`recordSentInput` / `wasRecentlySent`** on `TmuxBackend`: Records normalized text sent via Murmur (voice or text box) with 30s TTL. Passive watcher calls `wasRecentlySent()` before creating a `terminal` entry — skips entry creation but still starts streaming (spinner means Claude is processing). Prevents double user bubbles from voice→terminal echo.
- **Multi-line extraction hardening**: Continuation line loop now stops at Claude output markers (`✻`, `⏺`), CLI status lines (`Press up/down/esc`), and `Tokens:/Session:` lines — prevents TUI chrome from being concatenated into user input text.
- `TerminalManager` interface updated with optional `recordSentInput?()` and `wasRecentlySent?()` methods.
- `InputLog.source` type updated to `"voice" | "text-input" | "terminal"`.
**Test**: `testInputSourceTagging` (14 assertions: voice/text-input/terminal tags present, old tags absent, InputLog type, recordSentInput/wasRecentlySent calls, TmuxBackend methods, multi-line stop markers).

---

## BUG-120: TTS highlight broadcasts not reaching clients (HIGHLIGHT-MISMATCH)

**Status**: Fixed
**Severity**: Critical
**Found**: 2026-03-09 (Monitor deep diagnosis)
**Symptom**: Zero `tts_highlight` and zero `tts_play` outbound messages in WS log (200-entry ring buffer checked) despite active TTS playback. `highlight-log` ring buffer also empty. Audio IS playing (chunk_done and tts_done arriving from client).
**Root cause**: Three issues identified: (1) `tts_highlight` broadcasts may be dead code or gated behind a never-true condition, (2) duplicate queue insertion — entries queued 3x across generation bumps with out-of-order insertion, (3) `ttsPlayingEntryId` vs `playback.currentEntryId` diverge transiently — two code paths update at different times.
**Fix** (`server.ts`): TTS v2 redesign resolved all three: (1) `broadcast(tts_play)` fires on both local and server-side TTS paths (lines 1767, 1783) — NOT dead code. (2) `queueTts` dedup guard skips entries already queued (by entryId). (3) `_clientPlayback.currentEntryId` set atomically with `ttsCurrentlyPlaying` at line 1752-1753.

---

## BUG-121: Scroll position jumps on TTS stop (SCROLL-JUMP-STOP)

**Status**: Diagnosed (Monitor)
**Severity**: Medium
**Found**: 2026-03-09 (Monitor diagnosis)
**Symptom**: Conversation view jumps to different scroll position when TTS stops.
**Root cause**: Client-side — `tts_stop` handler removes `bubble-active` CSS class and clears flow word highlights, causing DOM reflow that shifts scroll position. Server side is clean (just sends tts_stop message).
**Proposed fix**: Client should save `scrollTop` before removing classes, then restore after DOM settles via `requestAnimationFrame`. No server change needed.

---

## BUG-122: User bubble alignment regression (BUBBLE-ALIGN-RECURRENCE)

**Status**: Fixed
**Severity**: Medium
**Found**: 2026-03-09
**Symptom**: User bubbles displayed left-aligned instead of right-aligned (recurring merge-loss bug).
**Root cause**: Hardcoded `align-self: flex-start` on `.msg-wrap` overriding role-based alignment.
**Fix** (`index.html`): Removed hardcoded alignment, added `:has()` selectors for user (flex-end) and assistant (flex-start).
**Test**: `test-bugs.ts` — `testBubbleAlignment_userRight_assistantLeft` (4 assertions). Regression test prevents future merge-loss.

---

## BUG-123: TTS stall — recurring stuck playing state (3+ occurrences)

**Status**: Partially fixed (stall recovery added, root cause open)
**Severity**: Critical
**Found**: 2026-03-09 (Monitor, 3 confirmed occurrences)
**Symptom**: TTS job stuck in `state=playing` with `playing=null` and `currentEntryId=null`. Client never sends `tts_done`. Job blocks all queued items. Observed on entries 80, 99, 36 — pattern is consistent. One instance stuck for 394s before recovery.
**Root cause**: Server sets `job.state=playing` when chunks sent, but client never acknowledges. Generation bumps (new_input) do NOT cancel playing-state jobs. No timeout on playing state.
**Fix (partial)**: Stall recovery with orphan detection + sweep + timeout added (8/9 tests pass). `playingSince` timestamp field name may differ from test expectation.

---

## BUG-124: Status line / TUI chrome leaking to conversation (STATUS-LEAK)

**Status**: Fixed (by BUG-116 state machine parser)
**Severity**: Medium
**Found**: 2026-03-09 (Monitor)
**Symptom**: TUI chrome lines like "✻ Crunched for 35s · 5 background tasks" and "Background command Restart server completed" appearing as conversation bubbles and getting queued for TTS.
**Root cause**: Status line filter not catching all TUI chrome patterns. `isToolOutputLine()` misses status characters in some contexts.
**Proposed fix**: Expand status line filter to catch `✻ Crunched`, `Background command ... completed`, and collapsed output hints (ctrl+o).

---

## BUG-125: Tmux window number missing from session dropdown (TMUX-DROPDOWN)

**Status**: Fixed (superseded by BUG-133 DROPDOWN-DISPLAY)
**Severity**: Low
**Found**: 2026-03-08 (user report)
**Symptom**: Tmux session/window dropdown in settings panel does not display window numbers alongside session names. User cannot distinguish between multiple windows in the same session.
**Root cause**: Dropdown population logic only includes session name, not `session:window` format.
**Proposed fix**: Include window index in dropdown options (e.g., `my-session:0`, `my-session:1`). Update `tmux list-windows` parsing to populate both session and window.

---

## BUG-126: Settings popover covers entire screen in flow mode (SETTINGS-POPOVER-OVERFLOW)

**Status**: Fixed (CSS, no regression test)
**Severity**: Medium
**Found**: 2026-03-08 (user report)
**Symptom**: Gear/settings panel in flow mode expands to cover the entire viewport, making it impossible to dismiss or interact with the conversation behind it.
**Root cause**: Settings popover had no `max-height` or `overflow` constraints. In flow mode, the panel grows unconstrained.
**Fix** (`index.html`): Added `max-height: 70vh; overflow-y: auto` to settings panel CSS.
**Test**: No regression test yet — needs one to verify panel height is bounded and scrollable.

---

## BUG-127: Cross-window entry leakage — no per-window conversation isolation (PER-WINDOW-ENTRIES)

**Status**: Fixed
**Severity**: High
**Found**: 2026-03-09 (related to BUG-117 CLI-LEAK-PASSIVE-WATCHER)
**Symptom**: When monitoring multiple tmux windows, entries from one window (test entries, CLI output, other agent sessions) leak into the conversation view of the current window. Switching windows shows a merged, confusing entry list.
**Root cause**: Single global `conversationEntries[]` array shared across all tmux windows. No isolation between windows.
**Fix** (`server.ts`): Per-window conversation isolation via 4 components:
- `windowEntries: Map<string, ConversationEntry[]>` — caches entries per window key
- `pushEntry(entry)` — stamps `entry.window = getWindowKey()` on every entry creation (replaces all raw `conversationEntries.push()`)
- `setConversationEntries(entries)` — syncs the global array + map atomically
- `tmux:switch:` handler — calls `saveCurrentWindowEntries()` before switch, loads from cache (or scrollback) for new window, clears `entryTtsCursor`, resets TTS/status, broadcasts entry list
- `/debug/entries?window=` — filter debug endpoint by window key
- `/api/state` — reports `currentWindow`, `windowCount`, `windows[]`
**Test**: `testPerWindowConversationIsolation` (13 assertions: map declaration, set/push/save/load helpers, switch handler save+load, ConversationEntry.window field, debug endpoints, live entry tagging).
**Reviewer notes**: (1) `windowEntries` Map never pruned — no `.delete()` or `.clear()` calls. Long-running server with many window switches will accumulate stale entries. Should add eviction for windows not seen in N minutes. (2) Test #5 checks `rawPushCount === 0` but `pushEntry()` itself contains `conversationEntries.push()` — test will report 1, not 0. Assertion is technically wrong though the code is correct (still present in latest). (3) `entryIdCounter` updated via `Math.max(entryIdCounter, ...entries.map(e => e.id))` on switch — correct, prevents ID collisions across windows.

---

## BUG-128: TTS audio continues playing after tmux window switch (PER-WINDOW-TTS)

**Status**: Fixed
**Severity**: High
**Found**: 2026-03-09 (extends BUG-127 PER-WINDOW-ENTRIES)
**Symptom**: Switching tmux windows while TTS is playing continues speaking entries from the old window. TTS queue from previous window bleeds into the new window context. Cached entries re-trigger auto-TTS on switch.
**Root cause**: TTS pipeline had no window awareness — `queueTts`, `TtsJob`, and `ttslog` all operated globally without window context. Window switch didn't flush TTS state.
**Fix** (`server.ts`): Per-window TTS isolation via 5 changes:
- `TtsJob.window: string` field — stamps `getWindowKey()` at job creation time (line 1429)
- `queueTts()` window guard — skips TTS for entries whose `.window` doesn't match current window (lines 1274-1279)
- `tmux:switch:` handler — calls `stopClientPlayback2("session_switch")` BEFORE loading new entries (line 4890). `session_switch` is in `USER_INITIATED_BUMP_REASONS` → full queue flush, abort in-flight fetches, bump generation, client `tts_stop`
- Loaded entries marked `spoken = true` (line 4910) — prevents auto-TTS re-queueing when switching back to a cached window
- `TtsHistoryEntry.window` field + `ttslog` stamps `getWindowKey()` — debug history tracks which window each TTS job belonged to
- `entryTtsCursor.clear()` on switch — resets sentence-level progress tracking
**Test**: `testTtsPerWindowIsolation` (9 assertions: TtsJob.window field, job stamps window, queueTts window guard, stop-before-load ordering, marks-spoken, session_switch in USER_INITIATED_BUMP_REASONS, TtsHistoryEntry.window, ttslog stamps window, live /debug/tts-history check).
**Reviewer notes**: (1) Window guard in `queueTts` uses `entry.window !== getWindowKey()` — requires entry to exist in `conversationEntries`. For null entryId (filler audio), guard is skipped — fillers will play regardless of window. This is acceptable since fillers are short-lived. (2) `stopClientPlayback2("session_switch")` correctly placed before `loadWindowEntries` — no race between old audio and new entry load. (3) Test #5 from BUG-127 (rawPushCount === 0) still has the false-negative assertion bug.

---

## BUG-129: Passive watcher state not reset on tmux window switch (PASSIVE-WATCHER-SWITCH-RESET)

**Status**: Fixed
**Severity**: High
**Found**: 2026-03-09 (root cause of entries keyed to wrong window)
**Symptom**: After switching tmux windows, passive watcher compares new pane content against stale snapshot from old pane. All existing content in the new pane is detected as "new" output, creating spurious entries. Stream state from old window carries over, causing incorrect spinner/prompt detection.
**Root cause**: `tmux:switch:` handler didn't reset passive watcher state variables. `lastPassiveSnapshot` from old pane caused diff to see all existing new-pane content as new assistant output. Stale `preInputSnapshot`, `_scrollbackCache`, `streamState`, `_cooldownThinking`, and `lastStreamEndTime` all contributed to incorrect behavior.
**Fix** (`server.ts`, lines 4918-4967): 7 state variables reset + snapshot re-initialization:
1. `lastPassiveSnapshot = ""` — clear stale pane snapshot
2. `_lastPassiveUserInput = ""` — clear dedup guard
3. `_lastPassiveUserInputTs = 0` — reset dedup timestamp
4. `_cooldownThinking = false` — clear cooldown thinking flag
5. `lastStreamEndTime = 0` — reset cooldown timer
6. `preInputSnapshot = ""` — clear stale pre-input baseline
7. `_scrollbackCache = { text: "", ts: 0 }` — invalidate scrollback cache
- `streamState = "IDLE"` if not already — new window starts clean
- After entry load: `lastPassiveSnapshot = captureTmuxPane()` + `preInputSnapshot = lastPassiveSnapshot` — initializes correct baseline for new pane so diff works correctly from the first poll
**Test**: 5 new assertions added to `testPerWindowConversationIsolation` (#14-#18): resets lastPassiveSnapshot, resets _scrollbackCache, resets streamState to IDLE, initializes passive snapshot from new pane via captureTmuxPane, resets preInputSnapshot.
**Reviewer notes**: `lastBroadcastText` is NOT reset on switch. If new window's first `broadcastCurrentOutput` produces text identical to old window's last broadcast, it will be silently dropped by the dedup guard at line 2877. Edge case but worth noting — could add `lastBroadcastText = ""` to the reset block.

---

## BUG-130: Pane pinning targets session instead of session:window (PANE-PIN-SESSION-ONLY)

**Status**: Fixed
**Severity**: High
**Found**: 2026-03-09 (root cause of per-window conversations all mapping to same pane)
**Symptom**: After switching to a different tmux window, all captures (passive watcher, streaming) still read from the original window's pane. Per-window conversation isolation (BUG-127) didn't work because `_paneId` was pinned to the wrong pane.
**Root cause**: `_pinCurrentPane()` used `tmux display-message -t SESSION` (session-only target). tmux resolves session-only targets to the session's *active* pane, which may be in a different window. When switching from window 0 to window 1, `_pinCurrentPane` re-pinned to window 0's pane (still the session's active pane) instead of window 1's pane.
**Fix** (`terminal/tmux-backend.ts`, line 47-49): Target includes window index when set:
```
const target = this._window >= 0
  ? `${this._session}:${this._window}`
  : this._session;
```
`execFileSync("tmux", ["display-message", "-t", target, ...])` now targets the correct window's pane. Uses `execFileSync` (not `execSync`) — correct pattern. `switchTarget()` clears `_paneId = null` before calling `_pinCurrentPane()` — ensures stale pane ID doesn't persist.
**Test**: Assertion #19 in `testPerWindowConversationIsolation` — verifies `_pinCurrentPane` contains `this._window >= 0` and `this._session}:${this._window}` template.
**Reviewer notes**: Clean fix. No security concerns — `session` and `window` come from client `tmux:switch:` message but are used as tmux `-t` args via `execFileSync` array (no shell interpolation). `_paneId` validation (`paneId.startsWith("%")`) prevents non-pane-ID strings from being stored.

---

## BUG-131: Test entries visible to real clients on reconnect (TEST-ENTRY-RECONNECT-LEAK)

**Status**: Fixed
**Severity**: Medium
**Found**: 2026-03-09
**Symptom**: When a real (non-test) client reconnects, the initial entry payload includes test entries created by `?testmode=1` clients. Test bubbles briefly appear in the user's conversation view until the next broadcast filters them out.
**Root cause**: Two issues: (1) Reconnect path filtered by `_testEntryIds` Set which races with `addUserEntry` — the entry broadcasts before the caller registers its ID in the Set. (2) `broadcast()` also used `_testEntryIds` approach, same race condition.
**Fix** (`server.ts`): `sourceTag`-based filtering replaces ID-based filtering:
- `ConversationEntry.sourceTag?: string` — stamped by `addUserEntry` from `_source` parameter (line 2457). Test mode uses `"text-input-test"`.
- `broadcast()` (lines 4160-4175): For entry broadcasts, checks `entries.some(e => e.sourceTag?.startsWith("text-input-test"))`. If found, creates `dataForReal` with test entries filtered out, sends filtered payload to non-test clients, full payload to test clients.
- Reconnect path (line 4268): Same filter — `recentEntries.filter(e => !e.sourceTag?.startsWith("text-input-test"))` for non-test clients.
- No race condition — `sourceTag` is set atomically in `addUserEntry` before `broadcast()` fires, so filtering always works.
**Test**: `testTestEntryBroadcastIsolation` (6 assertions: sourceTag field exists, addUserEntry stamps it, broadcast filters by sourceTag not ID, routes filtered payload to non-test clients, reconnect filters by sourceTag, test mode uses "text-input-test" tag).

---

## BUG-132: Thinking/responding labels confuse users (UI-WORKING-LABEL)

**Status**: Fixed
**Severity**: Low
**Found**: 2026-03-09
**Symptom**: Talk button shows "Thinking... (tap to queue)" and "Responding... (tap to queue)" as separate states. Users don't understand the distinction, and "tap to queue" is unclear.
**Fix** (`index.html`): Both states now show `"Working... (tap to record next message)"`. CSS classes (`thinking`, `responding`) remain separate for styling (different amber glow animations). Only the user-facing label text is unified.

---

## BUG-133: Tmux dropdown shows raw session:index without window name (DROPDOWN-DISPLAY)

**Status**: Fixed
**Severity**: Low
**Found**: 2026-03-09 (related to BUG-125 TMUX-DROPDOWN)
**Symptom**: Session dropdown and collapsed session button show `"claude-voice:0"` instead of the human-readable window name. Users with multiple windows can't tell which is which.
**Fix** (`index.html`): `_tmuxWindowNames` Map caches `"session:index" → windowName`. Built from `tmux_sessions` WS message in `renderSessPopover()`. Dropdown items show `"session:index windowName"` (line 7739). Collapsed button uses `getWindowDisplayName(target)` to show just the window name (line 7759). Window names populated from `win.name` field sent by `listTmuxSessions()`.
**Note**: Supersedes BUG-125 — window numbers now shown alongside window names in dropdown.

---

## BUG-134: Flow mode unspoken words upgrade to black on interrupt (FLOW-WORD-DROPPED)

**Status**: Fixed
**Severity**: Medium
**Found**: 2026-03-09
**Symptom**: When TTS is interrupted mid-sentence in flow mode, all remaining grey (unspoken) words upgrade to black (`tts-word-spoken`), making it look like everything was spoken. User can't tell where audio stopped.
**Root cause**: `clearFlowWordHighlight()` replaced all `tts-word` spans with `tts-word-spoken` regardless of whether they were actually spoken.
**Fix** (`index.html`): Unspoken words now get `tts-word-dropped` class (red text, 0.7 opacity) instead of `tts-word-spoken`. CSS: `body.flow-mode .msg.assistant .tts-word-dropped { color: #c0392b !important; opacity: 0.7 !important; }`. Same change in local TTS `onerror` handler — error'd words get `tts-word-dropped`.

---

## BUG-135: Flow mode VAD interrupts TTS playback on brief noise (FLOW-VAD-TTS-BARGE)

**Status**: Fixed
**Severity**: Medium
**Found**: 2026-03-09
**Symptom**: In flow mode, brief noise (echo, laughter, cough) during TTS playback triggers VAD → sends `stop` → kills active TTS. Multi-part responses (jokes, long explanations) get cut off by the user's own reaction sounds.
**Root cause**: Auto-listen speech detection sent `stop` + `stopTtsPlayback()` whenever VAD triggered during any active state (thinking, responding, OR speaking).
**Fix** (`index.html`): VAD interrupt now ONLY fires during `thinking` or `responding` states — NOT during `speaking` (active TTS playback). Real user speech during playback still records and interrupts naturally via the `new_input` path when the transcribed text is sent to terminal. Comment explains the rationale: "brief noise/echo/laughter can false-trigger the VAD and kill mid-playback".
