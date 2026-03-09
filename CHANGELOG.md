# Murmur Changelog

All notable changes to this project are documented here.
Categories: **Fixed**, **Added**, **Changed**, **Security**

---

## 2026-03-07

### Fixed
- BUG-044: Added per-client WebSocket rate limiting (server.ts)
- BUG-073: Fixed duplicate conversation bubbles from history + entry overlap (index.html)
- BUG-074: Fixed positional paragraph shift creating duplicate entries during streaming (server.ts)
- BUG-075: Fix duplicate user bubble from whitespace-variant text — time-based 30s dedup window in addUserEntry (server.ts)
- BUG-076: Fix double TTS drain from duplicate tts_done callbacks — 50ms dedup window in handleTtsDone (server.ts)
- BUG-077: Fix red text highlight flicker — hoist _ttsStillActive guard, reorder handleTtsDone (server.ts, index.html)
- Fix test-e2e.ts BASE URL missing testmode=1 — add regression test for testmode in all test files
- Block ALL control messages (stop/interrupt/key/flush_queue) from testmode WS connections via allowlist guard
- Fix BUG-A/BUG-C test isolation — fresh page load + diff-based count, pendingHighlightEntryId setter
- Task #9: Interrupt button now flushes all queued messages — added `flush_queue` WS handler, server-driven badge updates (server.ts, index.html)
- Fix garbled TUI text leaking into TTS output, add stall recovery
- Fix interrupt button: flush all queued messages at once, add debug API, filter TUI chrome from TTS
- Fix scrollback flooding, sentence-boundary TTS bug, client `ttsPlaying` reset
- Fix TTS queue: accurate spoken flags, dedup codepaths, pin tmux pane width
- Fix TTS highlight bugs (red/gray highlight race), add UX interaction tests, filter agent output from TTS
- Fix amber glow flicker: use `broadcastIdleIfSafe` for all TTS error paths
- Fix flow tour: lighter overlay, light-themed tooltip, click-to-dismiss, longer delay
- Fix TTS double-drain race: timeout + late `tts_done` for same chunk
- Fix interrupt detection: run before stream state guard, end active stream
- Fix amber glow flicker: don't broadcast idle while stream is active
- Task #10: Fix TTS replay loop — guard handleTtsDone unspoken-entries catch-all during active streaming, speak tails not full text for partially-spoken entries (server.ts)
- BUG-078: Fix test:reset-entries nuking global conversationEntries — replaced with scoped test:clear-entries using per-connection _testEntryIds tracking (server.ts, tests/test-bugs.ts)
- Task #13: Think mode now uses silence-based detection — timer is silence tolerance, not recording cap; recording continues while user speaks (index.html)
- BUG-080: Fix MURMUR_EXIT prose mode leak — guard checks `_isTestMode`, debounce rechecks for real clients (server.ts)
- Task #12: VAD environment adaptation — Quiet/Normal/Noisy presets with per-environment thresholds, UI in settings + flow gear panel (index.html)
- Task #14: Streaming STT — partial audio chunks sent every 3s, server transcribes asynchronously, partial text rendered in prelim bubble (server.ts, index.html)
- Task #11: Fix tmux session name mismatch — added `displayTarget` getter for human-readable session:window format (tmux-backend.ts, server.ts)
- Task #15: Flow mode mute mic button — bottom-right, 44px touch target, diagonal slash overlay, bidirectional sync with normal mode (index.html)
- Task #19: Center Murmur logo in toolbar — absolute positioning, removed redundant spacer (index.html)
- BUG-080 v3: Prose mode target guard — only send context/exit to claude-voice session, skip agent/coordinator sessions (server.ts)
- BUG-081: Fix TTS audio duplication — pregen race condition causing duplicate playback (server.ts)
- BUG-082: Fix TTS highlight on wrong bubble — pregen race condition, added debug ring buffers (server.ts)
- Fix prose mode filter missing tmux-wrapped continuation lines (server.ts)
- Flush TTS queue on last client disconnect (server.ts)
- BUG-084: Fix temporal dead zone crash — hoist ttsPlaying, autoListenEnabled, _vadPresetKey declarations (index.html)
- BUG-077: REGRESSED — red text highlight flicker returned (7 dropped entries), previously fixed in 8e01e51

### Added
- Flow mode guided tour (6 steps)
- 2-minute safety timeout for thinking/responding amber glow state
- Flow mode choice card for interactive prompts
- Stronger amber glow + breathing pulse for thinking/responding in flow mode
- Tool status line detection for flow mode activity indicators
- "Interrupted — waiting for direction" status display
- Debug API endpoint for runtime inspection

### Changed
- Hide tool status text in flow mode — button animation only
- Filter tree-style agent output, plan/bypass mode indicators from TTS
- Broaden interrupt detection regex with debug logging

---

## 2026-03-06

### Fixed
- BUG-001: CLI-typed input appearing as Claude's assistant response (server.ts)
- BUG-002: Flow mode initial scroll showing oldest content (index.html)
- BUG-003: Test messages leaking into active Claude Code session (test files)
- BUG-006: `_isSystemContext` flag stuck forever on `sendMurmurContext` failure (server.ts)
- BUG-007: Multi-client `tts_done` deadlock (server.ts)
- BUG-008: TTS queue race condition on flush — use `splice()` instead of reassignment (server.ts)
- BUG-009: TTS pre-generation generation counter race (server.ts)
- BUG-010: DoS via malformed JSON in test WS handlers (server.ts)
- BUG-014: Flow mode `_pendingHighlightEntryId` never cleared (index.html)
- BUG-015: Audio WebSocket send without readyState check (index.html)
- BUG-016: Silent TTS failure on max retries — clear queue + mark Kokoro down (server.ts)
- BUG-017: `getLinesAfterInput` greedy prompt match (server.ts)
- BUG-018: `entryTtsCursor` memory leak on entry trimming (server.ts)
- BUG-019: Voice queue drain lock not released on exception (server.ts)
- BUG-020: Whisper STT no retry on failure — added 1 retry + error broadcast (server.ts)
- BUG-021: Flow mode exit doesn't clean up `flow-recording` class (index.html)
- BUG-022: `combineAudioBuffers` temp file collision (server.ts)
- BUG-023: Zombie curl processes on TTS timeout — added 35s kill timer (server.ts)
- BUG-024: `broadcastCurrentOutput` trims stale entries while responding (server.ts)
- BUG-027: Initial flow render darkens partial streaming entries (index.html)
- BUG-028: TTS highlight retry uses parallel timeouts (index.html)
- BUG-029: `entryTtsCursor.clear()` called before `stopClientPlayback` (server.ts)
- BUG-030: Local TTS timeout too generous — reduced from 15s to 8s minimum (server.ts)
- BUG-031: Kokoro TTS duration estimation inaccurate for VBR MP3 (server.ts)
- BUG-032: Voice name not validated at load (server.ts)
- BUG-033: Barge-in AudioContext never closed (index.html)
- BUG-034: Barge-in baseline too few samples — increased from 15 to 30 (index.html)
- BUG-035: VAD baseline not updated during recording — added slow EMA (index.html)
- BUG-036: Word highlight scroll fires on every word — debounced to every 5 (index.html)
- BUG-037: Empty state visible in flow mode (index.html)
- BUG-038: `scrollTranscript` doesn't scroll to active TTS entry (index.html)
- BUG-039: Fallback audio double-done callback — added `_fbDone` guard (index.html)
- BUG-040: Electron graceful shutdown timeout too short — 3s → 5s (electron/main.js)
- BUG-041: localStorage access not wrapped in try-catch — added `lsSet`/`lsGet` (index.html)
- Fix flow mode scroll on mobile: account for fixed talk-bar height
- Fix flow mode bugs + Pipecat-inspired gapless audio pipeline
- Fix TTS highlight, prelim bubble, scroll, live transcription, audio

### Added
- Task #4: Primary audio client mechanism — `activeAudioClient`, `claim:audio`, `sendToAudioClient()`
- Task #5: Remote/mobile access docs — tour step + site/index.html section
- Task #6: iOS home screen iconography — proper manifest.json + real PNG icons
- Task #7: Device voice fix for iPhone — audio client voice availability check
- Task #8: Tmux session/window selector UI — dynamic switching, popover list
- Server module split: types.ts, validation.ts, logging.ts, stt.ts, settings.ts, context.ts
- Frontend module split: utils.js, debug.js, tour.js, ansi.js
- Flow mode as default (opt-out instead of opt-in)
- Prelim bubble with "..." on recording start in flow mode
- Red highlight for unspoken/dropped TTS entries in flow mode
- All starred voices in flow mode settings sheet
- Flow button repositioning: captured position before toggle, fixed placement

### Security
- BUG-004: Command injection in `/info` endpoint — force `parseInt` (server.ts)
- BUG-005: Shell injection in Whisper STT curl — switched to `execFileSync` (server.ts)
- BUG-011: Newline injection in node-pty `sendText` — sanitize `[\r\n]+` (pty-backend.ts)
- BUG-012: Unsafe redirect in Electron content auto-update — domain whitelist (electron/main.js)
- BUG-013: Shell injection in tmux `pipe-pane` filePath — shell-escape (tmux-backend.ts)
- BUG-025: XSS in session row rendering — added `escHtml()` (index.html)
- BUG-026: XSS in TTS word highlight — escape each word (index.html)

### Changed
- Test hardening: `?testmode=1` on all test files, pre-commit hooks
- Server modularization: extracted typed modules from monolithic server.ts
