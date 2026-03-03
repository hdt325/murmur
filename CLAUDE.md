# Murmur — Claude Code Reference

## MANDATORY: Voice Conversation Parameters

When using the VoiceMode converse tool for standby listening (empty message, skip_tts=true):

**NEVER pass `disable_silence_detection`.**
**ALWAYS use `listen_duration_max: 60`, `listen_duration_min: 1.5`, `vad_aggressiveness: 2`.**

Silence detection must stay enabled so recording stops when the user finishes speaking.
Using disable_silence_detection causes a 30-second freeze which is unacceptable.

## What This Is

Desktop voice interface for Claude Code. Speak naturally, hear responses read aloud, watch Claude work in a live terminal. Cross-platform (macOS + Windows) via Electron.

## Architecture

```
index.html (SPA, inline CSS/JS)
     ↕ WebSocket
server.ts (Express + WS, port 3457/3458)
     ↕ TerminalManager interface
tmux (macOS) / node-pty (Windows)
     ↕
Claude Code CLI session
```

- **Frontend**: `index.html` — Single-file SPA (3.5K LOC), all CSS/JS inline
- **Server**: `server.ts` — Express + WebSocket bridge (~2.9K LOC). Manages terminal session, TTS queue, STT transcription, conversation entry model, passive watcher polling
- **Electron**: `electron/main.js` — App shell (~680 LOC). Startup checks, auto-update (electron-updater), content auto-update from GitHub raw
- **Terminal**: `terminal/` — `interface.ts` (abstraction), `tmux-backend.ts` (macOS), `pty-backend.ts` (Windows)
- **Site**: `site/index.html` — Marketing/download page deployed to Cloudflare Pages

### Key Ports

| Port | Protocol | Purpose |
|------|----------|---------|
| 3457 | HTTP/WS | Main server (localhost) |
| 3458 | HTTPS/WSS | Tailscale remote access |
| 2022 | HTTP | Whisper STT (local, `/v1/audio/transcriptions`) |
| 8880 | HTTP | Kokoro TTS (local, `/v1/audio/speech`) |

## Key Files

| File | LOC | Purpose |
|------|-----|---------|
| `server.ts` | 2915 | Core server: WS handlers, TTS queue, STT, entry model, passive watcher |
| `index.html` | 3475 | Full frontend: CSS, HTML, JS inline. Conversation UI, terminal panel, controls |
| `electron/main.js` | 683 | Electron shell: startup, auto-update, content update, window management |
| `terminal/interface.ts` | 59 | TerminalManager abstraction (sendText, sendKey, capturePane, etc.) |
| `terminal/tmux-backend.ts` | 185 | tmux implementation (macOS) |
| `terminal/pty-backend.ts` | 159 | node-pty implementation (Windows) |
| `site/index.html` | 994 | Download/marketing page |
| `electron/loading.html` | — | Startup diagnostics page |
| `electron/preload.js` | — | Electron context bridge |

## Server Architecture (server.ts)

### Conversation Entry Model

Single source of truth for display + TTS. Each entry has: `id`, `role`, `text`, `speakable`, `spoken`, `ts`, `turn`.

- `conversationEntries[]` — Ordered array, broadcast to all clients via `{ type: "entry", entries, partial }`
- `extractStructuredOutput()` — Parses tmux pane content into tagged paragraphs (speakable vs non-speakable)
- `getLinesAfterInput()` — Strips echoed user input from tmux capture
- `reflowText()` — Joins tmux-wrapped lines within paragraphs

### TTS Pipeline

```
speakText(text) → curl to Kokoro TTS → WAV file → readFileSync → broadcastBinary to clients
     ↓
ttsQueue[] (max 50) → generation counter (stale callback detection) → tts_done from client → drain queue
```

- `ttsGeneration` — Incremented on each new TTS call; old callbacks check `myGen === ttsGeneration`
- `ttsQueue[]` / `ttsEntryIdQueue[]` — Pending texts; drained via `handleTtsDone()`
- `ttsRetryCount` — Retries failed curl up to 3x with backoff, resets on success OR empty file
- Voice change flushes queue + bumps generation + broadcasts `tts_stop`
- `_local:` voices use client-side Web Speech API (no Kokoro)

### STT Pipeline

```
Client records audio → sends binary WebSocket → server writes /tmp WAV → curl to Whisper → text returned
```

- Pre-buffer WAV support for capturing speech onset
- Wake word detection: `/\bclaude\b/` (or "clyde", "hey cloud")

### System Context

`MURMUR_CONTEXT_LINES` sent to Claude on session start via `sendMurmurContext()`.
`MURMUR_CONTEXT_FILTER` regex catches leaked context lines in tmux output.
`_isSystemContext` flag suppresses entry creation during context send.

### Passive Watcher

Polls tmux every 2s (`passiveWatcherInterval`). Detects spinner (Claude working) vs prompt (idle).
Captures pane output and broadcasts structured entries + ANSI terminal content.

### WebSocket Messages (server → client)

| Type | Purpose |
|------|---------|
| `entry` | Updated conversation entries array |
| `status` | VoiceMode state (phase, micActive, ttsPlaying, conversationActive) |
| `voice_status` | TTS state machine (idle, speaking, recording, transcribing) |
| `tts_stop` | Stop audio playback |
| `tts_highlight` | Highlight specific entry being spoken |
| `terminal` | ANSI terminal content for terminal panel |
| `pipeline_trace` | Debug timing events |
| `conversation` | Conversation lifecycle (starting, stopped) |
| `restarting` | Server restart signal |
| Binary | Raw audio data for TTS playback |

### WebSocket Messages (client → server)

| Message | Purpose |
|---------|---------|
| Binary data | Audio recording (WAV) |
| `voice:prebuffer` | Next binary is WAV pre-buffer |
| `voice:wake_check` | Next binary checked for wake word |
| `conversation:start` | Start /conversation in terminal |
| `conversation:stop` | Stop everything |
| `stop` | Interrupt Claude + stop TTS |
| `tts_done` | Client finished playing audio |
| `speed:N` | Set TTS speed (0.5-3.0) |
| `voice:NAME` | Set TTS voice |
| `mute:0/1` | Toggle mic mute |
| `key:up/down/enter/escape/tab` | Terminal navigation |
| `replay:ID` | Replay entry by ID |
| `restart` | Restart server (exit 0) |
| `log:TEXT` | Client-side log relay |
| `text:TEXT` | Text input (type mode) |

## Frontend Architecture (index.html)

### Event Delegation

Transcript click handling uses event delegation on `#transcript`:
- `data-copy-text` on `.msg` elements → click-to-copy
- `data-replay-payload` on `.msg` elements → replay via WebSocket
- `.msg-replay` button clicks → replay

**Do NOT add individual `addEventListener` on dynamically created bubbles.** Use data attributes and the delegated handler.

### Rendering Paths

Two rendering paths coexist:
1. `addMessage(role, text, ts)` — Legacy path for restored history
2. `renderEntries(entries, partial)` — Entry-based keyed update (primary path)

`renderEntries` does keyed reconciliation: existing elements updated in-place, new ones created, stale ones removed. Turn separators inserted between different turns.

### Interaction Modes

| Mode | Mic | TTS | Description |
|------|-----|-----|-------------|
| Talk | On | On | Full voice conversation |
| Type | Off | On | Type input, hear response |
| Read | On | Off | Speak input, read response |
| Text | Off | Off | Keyboard only |

### WebSocket Reconnection

Exponential backoff: 1s → 2s → 4s → ... → 30s max. Resets on successful connection.

## Electron (electron/main.js)

### Startup Sequence

1. `createWindow()` → show `loading.html`
2. `checkPrerequisites()` → Node.js, Claude CLI, tmux, VoiceMode
3. `contentUpdateCheck()` → compare SHA256 of local files vs GitHub raw (packaged builds only)
4. `ensureServer()` → spawn `npx tsx server.ts`, wait up to 15s for port 3457
5. `checkVoiceServices()` → ping Whisper (2022) and Kokoro (8880)
6. Load `http://localhost:3457`

### Auto-Update

- **App update**: `electron-updater` checks GitHub Releases, auto-downloads, prompts install
- **Content update**: Compares SHA256 of `CONTENT_FILES` vs GitHub raw, prompts to apply + restart server

### Server Process Lifecycle

- Exit code 0 (clean restart) → reload `loading.html` → `startServer()` after 1s
- Exit code !== 0 (crash after startup) → show error on loading page
- `will-quit` → SIGTERM → wait for exit (3s SIGKILL fallback)

### Permission Whitelist

Only these Electron permissions are granted: `media`, `microphone`, `notifications`, `clipboard-read`, `clipboard-sanitized-write`.

## CI/CD

### Workflows

| Workflow | Trigger | What |
|----------|---------|------|
| `release.yml` | push to main | Build DMG + exe → GitHub Release v1.0.N |
| `deploy-site.yml` | push to main | Deploy site/ to Cloudflare Pages |

### Versioning

Commit-count based: `git rev-list --count HEAD` → `1.0.N`. No manual tags needed.

### Release Pipeline

```
Push to main
  ├─→ release.yml: build-mac (DMG) + build-win (exe) → GitHub Release → verify-release
  │     └─→ electron-updater finds new release → existing users get update prompt
  ├─→ deploy-site.yml: deploy site → download buttons resolve to latest release
  └─→ (already works) content auto-updater: pulls latest files from raw.github
```

### Security

- All GitHub Actions pinned to commit SHAs (not tags)
- Artifact validation: DMG and exe must be >1MB
- `verify-release` job confirms both platform assets in release
- No code signing yet (macOS Gatekeeper + Windows SmartScreen warnings expected)

## Testing

```bash
npm test              # Smoke tests (fast, server only)
npm run test:e2e      # Full E2E (needs server + Claude session)
npm run test:bugs     # Regression tests
```

| Test File | Purpose | Requires |
|-----------|---------|----------|
| `test-smoke.ts` | 14 UI smoke tests | server:3457 |
| `test-e2e.ts` | 60+ E2E tests (all features) | server:3457 + Claude session |
| `test-bugs.ts` | 11+ regression tests | server:3457 |
| `test-detection.ts` | Poll detection unit tests | optional: tmux |
| `test-audio-pipeline.ts` | STT/TTS integration | server + Whisper + Kokoro |
| `test-tts-pipeline.ts` | TTS formatting/codec | server + Kokoro |
| `test-poll.sh` | Shell integration | tmux + Claude |
| `test-voice-cycle.sh` | Full voice cycle | tmux + Claude |

Tests use Playwright. Run from project root, server must be running on :3457.

### Known Flaky Tests

5 tests are flaky due to state leakage (prior interactions affect later tests):
- "Empty state shown" — messages exist from prior runs
- "Entry bubble text matches injected entries" — stale entries from previous conversations
- "Read mode entries render as text" — leftover TTS highlight
- "Spoken entries have bubble-spoken class" — test state dependency
- "Unspoken entry has full opacity" — entry marked spoken by earlier test

These require a fresh server restart between full runs for 91/91 pass.

## Security Hardening

These protections are in place — preserve them:

1. **tmux pipe-pane**: `startPipeStream()` validates filePath against `[a-zA-Z0-9._\-\/]+` and uses `execFileSync` (not `execSync`) to prevent command injection
2. **Voice names**: `_local:` voice names validated against `[a-zA-Z0-9 _\-().]+` to prevent path traversal
3. **Electron permissions**: Whitelist only needed permissions (not auto-grant all)
4. **WebSocket JSON.parse**: Wrapped in try-catch to prevent client crash on malformed messages
5. **Content updates**: Atomic writes (tmp → rename) to prevent corruption
6. **Process handlers**: `unhandledRejection` + `uncaughtException` handlers prevent silent crashes
7. **tmux session cleanup**: `destroy()` kills the tmux session to prevent leaks

## Common Tasks

### Run locally (development)
```bash
npm start              # Start server on :3457
# OR
npm run electron       # Start in Electron
```

### Deploy (push to main triggers both workflows)
```bash
git push origin main   # → release.yml + deploy-site.yml
```

### Add a new WebSocket message handler
1. Add handler in `server.ts` WS `onmessage` block (after line ~2226)
2. Add corresponding client-side handler in `index.html` `ws.onmessage` block
3. Document in tables above

### Add a new control button
1. Add HTML element in `index.html` controls section
2. Add `addEventListener` in init section (NOT on dynamic elements — use event delegation)
3. Ensure min-height 36px for mobile touch targets
4. Add `data-tip="..."` for tooltip

### Modify TTS behavior
- Voice selection: `voice:` handler (server.ts ~2335)
- TTS text cleaning: `speakable` processing in `speakText()` (server.ts ~394)
- Queue management: `ttsQueue[]`, `handleTtsDone()`, `ttsGeneration` counter
- **Always bump `ttsGeneration`** when interrupting TTS to invalidate stale callbacks

### Modify system context
- Edit `MURMUR_CONTEXT_LINES` array (server.ts ~179)
- **Also update `MURMUR_CONTEXT_FILTER` regex** (server.ts ~186) to match new lines — prevents leaked context from appearing as conversation bubbles

## Critical Gotchas

1. **Context leak**: If you change `MURMUR_CONTEXT_LINES`, you MUST also update `MURMUR_CONTEXT_FILTER`. Tmux wraps long lines, so the `❯` line filter alone won't catch continuation lines. The regex catches them directly.

2. **TTS generation counter**: Every path that stops/interrupts TTS MUST increment `ttsGeneration`. Otherwise stale callbacks from old curl processes will continue processing.

3. **Voice change race**: Changing voice flushes the TTS queue, bumps generation, and broadcasts `tts_stop`. Without this, old-voice audio continues playing alongside new-voice audio.

4. **Restart lifecycle**: `server.ts` exits with code 0 on restart. `electron/main.js` detects code 0 after `startupComplete` and relaunches via `startServer()`. If this handler is broken, restart closes the app without relaunching.

5. **Event delegation**: All click handlers on message bubbles use event delegation on `#transcript`. Do NOT add individual `addEventListener` on dynamically created elements — it causes closure accumulation during streaming.

6. **Atomic file writes**: Content updates in Electron use `writeFileSync(tmpPath) → renameSync(tmpPath, localPath)`. Direct `writeFileSync` to target risks corruption if process crashes mid-write.

7. **Touch targets**: All interactive elements must have `min-height: 36px` for iOS webapp usability. The controls bar buttons use this. Don't shrink them.

8. **WebSocket reconnect backoff**: Exponential backoff (1s→30s max) prevents server flood on disconnect. The `reconnectDelay` resets on successful `onopen`. Don't change to fixed-interval reconnect.

## Environment

- TypeScript strict mode (`tsconfig.json`)
- ESM modules (`"type": "module"` in package.json)
- `tsx` for TypeScript execution (no build step)
- Optional `node-pty` dependency (Windows terminal backend)
- Playwright for E2E tests
