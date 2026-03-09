# Murmur — Claude Code Reference

## MANDATORY: Coordinator Role — YOU ARE NOT A CODER

**This session is the COORDINATOR. You do NOT write code, fix bugs, or implement features.**

Your job:
1. **Dispatch work** to agents via tmux send-keys
2. **Monitor agents** by checking `/tmp/murmur-agent-pipeline.jsonl` and tmux capture-pane
3. **Merge code** from agent worktrees to main (copy files + git commit)
4. **Restart server** when fixes are merged (`kill` old process + `npm start`)
5. **Report to user** ONLY when input is needed (merge approval, stuck agent, test decision, alert)
6. **Send Telegram** when user attention is needed

**You do NOT:**
- Write or edit application code (server.ts, index.html, tests, etc.)
- Diagnose bugs yourself
- Propose code fixes
- Run tests yourself
- Read source code to investigate issues

**If a bug needs fixing → assign it to the Coder agent.**
**If a test needs running → assign it to the UX Expert agent.**
**If something needs investigating → assign it to the relevant agent.**

## MANDATORY: Agent Brief Protocol — NO INLINE BRIEFS

**NEVER paste long text into `tmux send-keys`.** The full text echoes in the coordinator's tmux pane, gets captured by the passive watcher as conversation entries, and is spoken via TTS. This pollutes the conversation view with agent briefs.

**Correct pattern:**
1. Write the brief to a temp file using the `Write` tool (produces zero terminal output):
   ```
   Write /tmp/coder-task-name.md → full spec/brief content
   ```
2. Send a short reference command via tmux:
   ```bash
   tmux send-keys -t murmur:Coder "Read /tmp/coder-task-name.md and implement. Files: server.ts, index.html. Compile check: npx tsc --noEmit" Enter
   ```

Only the short "Read /tmp/..." line appears in the coordinator pane — not the full brief.

**NEVER do this:**
```bash
tmux send-keys -t murmur:Coder "FIX BUG: long description of the bug with multiple paragraphs explaining root cause and fix approach..." Enter
```

## Agent Team

| tmux Window | Role | Worktree | What They Do |
|-------------|------|----------|-------------|
| murmur:UX-Expert | Quality Gate | murmur-agent1 | Runs tests, verifies fixes, reports regressions |
| murmur:Coder | Implementation | murmur-agent2 | Writes code, fixes bugs, adds regression tests |
| murmur:Monitor | Log Watcher | murmur-agent3 | Polls API/debug endpoints, alerts on anomalies |
| murmur:Release | CI/CD | murmur-agent4 | Monitors GitHub Actions, verifies builds |
| murmur:Profiler | Performance | murmur-agent5 | Tracks memory, latency, service health |
| murmur:iOS-QA | iOS Specialist | murmur-agent6 | Tests iOS Safari, touch targets, scroll, audio |
| murmur:Docs | Documentation | murmur-agent7 | Updates BUGS.md, TASKS.md, CHANGELOG.md |
| murmur:Reviewer | Code Review | murmur-agent8 | Security audit, state mgmt, blast radius |

### Pipeline Flow
```
Coder (fix_complete) → Reviewer (review) → UX-Expert (test) → Docs (update)
Monitor/Profiler → alert → Coordinator dispatches to Coder
```

### Respawning Agents
Each agent's full charter is in `murmur-agent<N>/CLAUDE.md`. To respawn:
```bash
tmux send-keys -t murmur:<Window> "cd /Users/happythakkar/Desktop/Programming/murmur-agent<N> && claude --dangerously-skip-permissions" Enter
```
Then brief with current task context. See memory file `agent-charters.md` for full reference.

### Telegram Notifications
When user attention is needed:
```bash
curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" -H "Content-Type: application/json" -d '{"chat_id":"1063408704","text":"🔔 [summary]"}'
```

## MANDATORY: Voice Conversation Parameters

When using the VoiceMode converse tool for standby listening (empty message, skip_tts=true):

**NEVER pass `disable_silence_detection`.**
**ALWAYS use `listen_duration_max: 60`, `listen_duration_min: 1.5`, `vad_aggressiveness: 2`.**

Silence detection must stay enabled so recording stops when the user finishes speaking.
Using disable_silence_detection causes a 30-second freeze which is unacceptable.

## What This Is

Desktop voice interface for terminal-based AI coding agents. Speak naturally, hear responses read aloud, watch your agent work in a live terminal. Cross-platform (macOS + Windows) via Electron.

Works with any CLI agent that runs in a terminal — Claude Code is the primary supported integration, but the architecture is agent-agnostic. It watches tmux/pty for prompt patterns and reads text output, so it works with Aider, Continue, Cursor CLI, GitHub Copilot CLI, and others.

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

- **Frontend**: `index.html` — Single-file SPA (~6.6K LOC), all CSS/JS inline
- **Server**: `server.ts` — Express + WebSocket bridge (~3.5K LOC). Manages terminal session, TTS queue, STT transcription, conversation entry model, passive watcher polling
- **Electron**: `electron/main.js` — App shell (~800 LOC). Startup checks, auto-update (electron-updater), content auto-update from GitHub raw
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
| `server.ts` | ~3460 | Core server: WS handlers, TTS queue, STT, entry model, passive watcher |
| `index.html` | ~6607 | Full frontend: CSS, HTML, JS inline. Conversation UI, terminal panel, controls |
| `electron/main.js` | ~804 | Electron shell: startup, auto-update, content update, window management |
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

Short voice-mode signals sent to Claude — suppressed from conversation view via two mechanisms:
1. `_isSystemContext` flag — blocks entry creation during live send (`sendMurmurContext`)
2. `MURMUR_CONTEXT_FILTER` regex — strips matching lines from scrollback and `addUserEntry`

- `MURMUR_CONTEXT_LINES` = `["Voice mode on — prose only, no markdown, short sentences."]`
- `MURMUR_EXIT` = `"Voice mode off — resume normal formatting."`

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

> **MANDATORY: Real Claude Sessions for Testing — NO Fake Injection**
>
> ALL interaction tests MUST use real Claude Code sessions in isolated tmux windows.
> Do NOT use `test:entries-full` injection for tests that verify entry creation, scrollback,
> window switching, TTS pipeline, dedup, role detection, or clean/verbose filtering.
>
> **Why**: Injected entries bypass the entire server-side pipeline (`capturePaneScrollback` →
> `extractStructuredOutput` → `loadScrollbackEntries` → `broadcastCurrentOutput`). Bugs in
> this pipeline (bubbles disappearing on switch, zero assistant entries on fresh load) are
> INVISIBLE to injection-based tests.
>
> **How**:
> 1. Create isolated tmux session: `tmux new-session -d -s murmur-test-agents`
> 2. Spawn Claude: `tmux send-keys -t murmur-test-agents:0 "claude --dangerously-skip-permissions" Enter`
> 3. Send real prompts: `tmux send-keys -t murmur-test-agents:0 "Say hello" Enter`
> 4. Wait for response, verify entries appear through full pipeline
> 5. Kill agents + destroy session in teardown (`try/finally`)
>
> **NEVER use the `murmur` session or any agent windows the user is working in.**
> Test agents go in `murmur-test-agents` only.
>
> **Injection acceptable ONLY for**: pure CSS/layout checks, DOM structure, button sizes/colors,
> WebSocket message format validation — i.e., tests that don't touch the entry pipeline.

> **CRITICAL — SELF-INTERRUPTION PREVENTION**
> Tests MUST be run in the **`test-runner`** tmux session ONLY.
>
> **Why**: Every command run via the Bash tool executes in the claude-voice shell, and its output
> appears in the claude-voice tmux pane. The passive watcher captures that output as Claude's
> response. `tail`, `cat`, `grep`, running `tests/run.sh` directly — all of these pollute the
> terminal and break the conversation.
>
> **What is safe from the Bash tool:**
> - `tmux send-keys -t test-runner "CMD" Enter` — sends command to test-runner, produces no output here
> - `Read /tmp/murmur-test-results.txt` — file read via dedicated tool, no terminal output
>
> **What is NEVER safe from the Bash tool:**
> - Running `tests/run.sh` directly (its `tail -f` runs in claude-voice shell)
> - `cat`, `tail`, `tail -5`, `grep`, `wc`, `ls` on result files (output appears in pane)
> - `tmux capture-pane -t test-runner -p` (capture output appears in pane)
> - ANY Bash command that produces visible terminal output — including one-liners like `tail -5 /tmp/results.txt`
>
> **Correct protocol from Claude Code:**
> ```
> Step 1: tmux send-keys -t test-runner "cd /Users/happythakkar/Desktop/Programming/murmur && node --import tsx/esm tests/test-bugs.ts > /tmp/murmur-test-results.txt 2>&1; echo DONE" Enter
> Step 2: Wait a reasonable amount of time (tests take ~60-90s), then use Read tool to check
> Step 3: Read /tmp/murmur-test-results.txt  ← ALWAYS use Read tool, NEVER tail/cat via Bash
> ```
>
> The Read tool reads files without running any shell command — it is always safe.

```bash
tests/run.sh all      # ← SINGLE COMMAND: full suite, service-aware
tests/run.sh e2e      # E2E + flow mode only (~105 tests)
tests/run.sh flow     # Flow mode deep tests
tests/run.sh bugs     # Regression tests
tests/run.sh smoke    # UI smoke tests only
```

| Test File | Purpose | Requires |
|-----------|---------|----------|
| `test-smoke.ts` | ~20 UI smoke tests | server:3457 |
| `test-e2e.ts` | ~105 E2E + flow mode tests | server:3457 + Claude session |
| `test-flow.ts` | Comprehensive flow mode (real entry data, TTS highlight) | server:3457 |
| `test-bugs.ts` | Regression tests | server:3457 |
| `test-detection.ts` | Poll detection unit tests | optional: tmux |
| `test-audio-pipeline.ts` | STT/TTS integration | server + Whisper + Kokoro |
| `test-tts-pipeline.ts` | TTS formatting/codec | server + Kokoro |
| `test-poll.sh` | Shell integration | tmux + Claude |
| `test-voice-cycle.sh` | Full voice cycle | tmux + Claude |

Tests use Playwright. Run from project root, server must be running on :3457.

### Known Flaky Tests

Up to 5 tests are flaky due to state leakage (prior interactions affect later tests):
- "Empty state shown" — messages exist from prior runs
- "Entry bubble text matches injected entries" — stale entries from previous conversations
- "Read mode entries render as text" — leftover TTS highlight
- "Unspoken entry has full opacity" — entry marked spoken by earlier test
- "Opacity boundary" — passive watcher re-renders entries mid-animation during active Claude sessions

Typical results: **20/20 smoke**, **~100/105 E2E+flow** (with active Claude session), **105/105 E2E+flow** (fresh server + idle Claude).

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

## Bug Fixing Protocol — MANDATORY

Every bug fix MUST follow this sequence. Do NOT skip steps.

### Step 1: Investigate BEFORE Changing Code

- **Read the full function/module** involved in the bug — not just the line that looks wrong.
- **Trace the data flow** from input to output. Identify WHERE the state goes wrong, not just where the symptom appears.
- **Explain the root cause** in plain language before proposing any fix. If you can't explain why the bug happens, you don't understand it well enough to fix it.
- **Check for related state**: bugs in this codebase often involve stale state, missed cleanup, race conditions between TTS/polling/WebSocket, or event handler accumulation. Look for these patterns specifically.

### Step 2: Fix Narrowly

- Change the minimum code necessary. Do not refactor surrounding code.
- If the fix touches shared state (entries, TTS queue, generation counter, polling), check every other consumer of that state for breakage.

### Step 3: Run Tests After EVERY Change

After ANY code modification (bug fix, feature, refactor), run the full test suite:

```bash
tests/run.sh all
```

Then read `/tmp/murmur-test-results.txt` to confirm results.

**Do NOT consider a fix complete until tests pass.** If a test fails, investigate — do not ignore it.

### Step 4: Add a Regression Test

For every bug fix, add a test to `tests/test-bugs.ts` that:
1. Reproduces the conditions that caused the bug
2. Asserts the correct behavior
3. Would FAIL if the bug were reintroduced

Name it `testBugN_shortDescription` following the existing pattern.

### Step 5: Verify No Regressions

If you changed server.ts → run bugs + smoke + e2e.
If you changed index.html → run smoke + e2e.
If you changed TTS/entry logic → run e2e + flow.

Read the full output in `/tmp/murmur-test-results.txt` and confirm pass counts match or exceed previous run.

### Common Debugging Mistakes (DO NOT DO THESE)

- **Patching symptoms**: Adding a null check where the real bug is that state wasn't cleaned up. Find WHY the value is null.
- **Guess-and-check**: Making a change, seeing if it helps, making another change. Investigate first.
- **Ignoring test failures**: "That test was already flaky" — check if your change made it worse. Compare to the known flaky list in the Testing section.
- **Not reading enough code**: If a bug involves the entry system, read ALL of `extractStructuredOutput`, `getLinesAfterInput`, `reflowText`, and the entry broadcast path. Not just the function that seems related.
- **Breaking other features**: Every TTS change risks breaking highlight chain. Every entry change risks breaking clean/verbose mode. Every poll change risks breaking state detection. Check downstream consumers.

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
