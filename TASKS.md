# Murmur — Backlog

## Completed

### #4 — Primary audio client mechanism ✓
- Server tracks `activeAudioClient`; last connected real client auto-claims
- TTS binary and `local_tts` unicast to audio client only via `sendToAudioClient()`
- `claim:audio` WS message lets any client explicitly take control
- `audio_control` WS message (server→client): `{ hasControl: bool }`
- UI: 🔊 dot in header — green=has audio, orange=another device has audio, click to claim
- Test clients yield audio back to main browser page on `test:client` identification

### #5 — Remote/mobile access docs ✓
- Added "Remote & Mobile Access" as 11th in-app tour step
- Added "Remote & Mobile Access" section to site/index.html (Tailscale setup, multi-device audio)

### #6 — iOS home screen iconography ✓
- `manifest.json`: updated with accurate 180×256×512 sizes, proper icon-512.png asset
- `apple-touch-icon` now points to `icon-180.png` (correct 180×180 PNG)
- All icon files are real PNGs with soundwave design (dark bg + gold bars)
- Server routes added for `icon-180.png` and `icon-512.png`

### #7 — Fix device voices on iPhone ✓
- `_local:Samantha` etc. now checks AUDIO CLIENT for voice availability, not any client
- Falls through to Kokoro when audio client (e.g. iPhone) doesn't support the local voice

### #8 — tmux session/window selector ✓
- `TmuxBackend`: dynamic target (`session` + `window` instance vars), `switchTarget()`, `listTmuxSessions()`
- `interface.ts`: `TmuxWindowInfo`, `TmuxSessionInfo` types; optional `switchTarget`/`listTmuxSessions`/`currentTarget`
- Server WS: `tmux:list` → `tmux_sessions` response; `tmux:switch:SESSION:WINDOW` → switch + resend context
- UI: session dropdown button in terminal header; popover lists all sessions + windows; switch sends context to new target

### #9 — Interrupt button sends all queued messages at once ✓
- Interrupt button now flushes all queued messages at once
- idle+queue → sends `flush_queue` WS message to drain all pending
- active → sends interrupt, cascade drains remaining queue items
- Added `flush_queue` WS handler on server
- Button badge updates via server broadcasts (not immediate client clear)

### #10 — Fix TTS replay loop ✓
- Guarded `handleTtsDone` unspoken-entries catch-all to skip during active streaming
- For partially-spoken entries, speak tail text only (not full text) to avoid replay

### #11 — Fix tmux session/window name mismatch ✓
- Added `displayTarget` getter to TmuxBackend + interface for human-readable `session:window`
- Updated all 3 server broadcast sites to use `displayTarget`

### #12 — VAD environment adaptation ✓
- Added Quiet/Normal/Noisy presets with per-environment thresholds
- UI in both normal settings popover and flow settings sheet, persists to localStorage

### #13 — Think mode silence-based detection ✓
- Timer is now silence tolerance, not recording cap; recording continues while user speaks

### #14 — Streaming STT ✓
- Client sends audio chunks every 3s via `voice:partial`, server transcribes asynchronously
- Partial text rendered via `_ltRenderText` (prelim bubble + floating element)

### #15 — Flow mode mute mic button ✓
- Bottom-right, 44px touch target, diagonal slash overlay, bidirectional sync with normal mode

### #19 — Center Murmur logo in toolbar ✓
- Absolute positioning with `left:50%` + `translateX(-50%)`, removed redundant spacer

### #25 — TTS Pipeline v2 ✓
- Full redesign: queueTts/fetchKokoroAudio/drainAudioBuffer replaces curl-based speakText()
- Entry-ID labeling end-to-end, chunk-level ack protocol
- Fixes BUG-077 (red text flicker), BUG-081 (audio duplication)

### #26 — Pipeline Observability ✓
- 8 debug endpoints: kokoro-log, chunk-flow, playback-state, tts-jobs, input-log, generation-log, highlight-log, tts-history

### #27 — TTS Speed Optimizations ✓
- Smaller first chunk (100 chars) for faster time-to-audio
- Speculative generation during RESPONDING state
- Filler audio for perceived latency reduction

### #28 — Karaoke Word Highlighting ✓
- chunkWordCounts sum guarantee, DOM span re-wrap on mismatch
- Highlight logging via WebSocket for debugging
- Visual state machine: grey (pending) → black word-by-word (spoken) → red (failure/dropped)

### #29 — Barge-in Improvements ✓
- Echo gate (2x threshold during TTS playback)
- Pause + resume (2s auto-recover)
- Separate `barge_in` WS message type

### #30 — Tagged Generation Counter ✓
- `bumpGeneration(reason, entryId?)` with /debug/generation-log
- Replaces raw `ttsGeneration++` for traceability

### #31 — Input Tracking ✓
- `crypto.randomUUID()` inputId from client through Whisper through entry creation
- End-to-end traceability for voice input pipeline

### Precision Issues — 8/9 resolved ✓
- S14 (preInputSnapshot timing), S15 (separator detection), S16 (flowWordPos mutation): Fixed
- T3 (ttsPlaying race), T6 (highlight save/restore), T7 (renderEntries vs spans): Fixed
- T8 (pipe-pane vs capture-pane), T11 (innerHTML churn): Fixed
- T9 (Windows pty retry): Still open (BUG-093) — low priority

## Pending

### #16 — Redesign flow mode tour from scratch
**Priority**: Medium

### #17 — Flow mode scroll behavior (top-down fill, iOS compatible)
**Priority**: High

### #18 — tmux session management from Murmur UI (create, close, merge)
**Priority**: High

### #20 — Seamless conversational flow: pause vs submit in recording
**Priority**: High

### #21 — Persistent audio/mic when app is backgrounded or closed
**Priority**: High

### #23 — Flow mode amber glow for system tasks (compacting, memory update)
**Priority**: Medium
**Area**: server.ts (passive watcher), index.html (flow mode CSS)
**Problem**:
- When Claude runs system tasks ("Compacting conversation", "Updating memory") the talk button should show amber/thinking glow in flow mode
- The `tool_status` text line is hidden in flow mode by CSS (`display: none`)
- The cooldown thinking detection (10s window) may miss system tasks that start later
- User reports no visual feedback during these operations in flow mode
**Requirements**:
- Amber glow on talk button during system tasks in flow mode (CSS already supports it)
- Investigate why `voice_status: thinking` isn't reaching the frontend during these tasks
- Consider showing tool status text in flow mode (currently hidden)
- Ensure system tasks outside the 10s cooldown window are still detected

### #24 — TTS highlight walks through bubbles even when TTS is down/not speaking
**Priority**: High
**Area**: server.ts (TTS highlight logic, handleTtsDone)
**Problem**:
- When Kokoro TTS is down (or TTS otherwise fails), the server still sequentially highlights each of Claude's conversation bubbles as if they were being spoken
- The highlight walks through every bubble one by one despite no audio playing
- User sees bubbles lighting up with no sound — confusing and broken UX
**Root cause (investigate)**:
- `speakText()` likely fails (curl to Kokoro times out or errors), but the highlight broadcast happens BEFORE the curl call
- The `tts_done` timeout fallback may fire, draining the queue and highlighting the next entry even though nothing was spoken
- The highlight chain continues because `handleTtsDone` processes unspoken entries regardless of whether audio was actually delivered
**Requirements**:
- Do NOT highlight a bubble unless TTS audio was successfully generated and sent to the client
- If Kokoro is unreachable, skip TTS entirely (don't queue, don't highlight)
- Consider a health check before attempting TTS — if Kokoro was down on last attempt, backoff before retrying

### #22 — Test suite leaking into live CLI session (BUG-003 regression)
**Priority**: Critical
