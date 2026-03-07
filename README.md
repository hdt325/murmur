# Murmur

A cross-platform (macOS + Windows) voice interface for hands-free conversations with Claude Code.

## What it does

- **Voice input** via local Whisper STT -- speak naturally, get transcribed on-device
- **Voice output** via local Kokoro TTS -- responses read aloud with selectable voices and speed
- **Live terminal view** of Claude Code running in a managed session
- **Electron app** with floating window, global hotkey (Right Cmd / Right Ctrl), and auto-managed server lifecycle
- **Cross-platform terminal abstraction** -- tmux on macOS, node-pty on Windows, same API

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Electron App (main.js)                                        │
│    ├── BrowserWindow → loads localhost:3457                     │
│    ├── Auto-starts server.ts if not running                    │
│    └── Global hotkey, tray icon, window management             │
└──────────────┬──────────────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────────────┐
│  Express + WebSocket server (localhost:3457)                     │
│                                                                  │
│  server.ts ──▶ TerminalManager (terminal/interface.ts)          │
│                   ├── TmuxBackend (macOS)  ── tmux session       │
│                   └── PtyBackend  (Windows) ── node-pty process  │
│                          │                                       │
│                          ▼                                       │
│                     Claude Code CLI                               │
│                                                                  │
│  VoiceMode MCP orchestrates the audio pipeline:                  │
│    audio ──▶ Whisper STT (:2022) ──▶ text ──▶ Claude Code       │
│    response ◀── capture-pane / pty read ◀── Claude Code          │
│    response ──▶ Kokoro TTS (:8880) ──▶ audio ──▶ speaker         │
└──────────────────────────────────────────────────────────────────┘
```

## Prerequisites

| Requirement | macOS | Windows |
|---|---|---|
| Node.js 18+ | Required | Required |
| tmux | `brew install tmux` | Not needed (uses node-pty) |
| Claude Code CLI | `npm i -g @anthropic-ai/claude-code` | `npm i -g @anthropic-ai/claude-code` |
| VoiceMode + services | `uv tool install voicemode` | `uv tool install voicemode` |
| Xcode Command Line Tools | Optional (legacy Swift panel) | N/A |

## Quick Start

### macOS

```bash
# 1. Install tmux
brew install tmux

# 2. Clone and install
git clone <repo-url> murmur
cd murmur
npm install
cd electron && npm install && cd ..

# 3. Verify voice services are running
curl http://127.0.0.1:2022/health    # Whisper STT
curl -s http://127.0.0.1:8880/docs | head -5  # Kokoro TTS

# 4. Launch
./launch.sh
# or:
npm run electron
```

### Windows

```powershell
# 1. Clone and install
git clone <repo-url> murmur
cd murmur
npm install
cd electron && npm install && cd ..

# 2. Verify voice services are running
curl http://127.0.0.1:2022/health    # Whisper STT

# 3. Launch
.\launch.ps1
# or:
npm run electron
```

If Whisper or Kokoro are not running, start them:

```bash
voicemode service whisper start
voicemode service kokoro start
```

## Usage

| Action | How |
|---|---|
| Record | Tap the mic button or press **Right Cmd** (macOS) / **Right Ctrl** (Windows) |
| Stop | Click **Stop** to interrupt recording, thinking, or TTS |
| Mute | Click **Mute** to silence TTS output |
| Speed | Cycle through playback speeds (0.5x -- 3x) |
| Voice | Pick a Kokoro voice from the dropdown |
| Replay | Re-speak the last assistant response |
| Terminal | Toggle the live terminal panel showing Claude Code output |
| Text input | Type directly in the terminal input bar |

## Configuration

### `settings.json`

Auto-created on first run. Controls voice and playback speed:

```json
{
  "voice": "bf_alice",
  "speed": 2
}
```

Available voices: `af_sky`, `af_heart`, `af_nova`, `am_adam`, `am_echo`, `bf_emma`, `bf_alice`, `bm_george`, `bm_daniel`, `ff_siwis`, `ef_dora`, `jf_alpha`, `zf_xiaoxiao`

### `~/.voicemode/voicemode.env`

Tune STT/TTS behavior (silence detection thresholds, model paths, etc). See VoiceMode docs.

### Remote access (optional)

For accessing the panel from an iPhone or another device, set up Tailscale HTTPS:

```bash
# Generate certs for your Tailscale hostname
tailscale cert <your-hostname>.tail<id>.ts.net
```

The server automatically serves HTTPS on port **3458** if `tailscale-cert.pem` and `tailscale-key.pem` exist in the project root. Browsers require HTTPS for `getUserMedia` (mic access) on non-localhost origins.

### Signal files

The server writes signal files for VoiceMode integration:

| File | Purpose |
|---|---|
| `/tmp/claude-tts-voice` | Current selected voice |
| `/tmp/claude-tts-speed` | Current playback speed |
| `/tmp/claude-mute` | Mute state |

On Windows, these are written to the system temp directory (`%TEMP%`). Settings persist across server restarts so VoiceMode picks up the last saved values.

## How It Works

1. **Electron app** launches, starts `server.ts` in the background, and loads `localhost:3457` in a BrowserWindow
2. **Express + WebSocket server** runs on `:3457` (HTTP) / `:3458` (HTTPS)
3. **TerminalManager** creates a Claude Code session using the appropriate backend:
   - **macOS**: `TmuxBackend` -- tmux session named `claude-voice`, polls via `capture-pane`
   - **Windows**: `PtyBackend` -- `node-pty` pseudoterminal, reads output directly
4. **VoiceMode MCP** orchestrates the audio pipeline -- watches `~/.voicemode/logs/events/` for real-time status and `~/.voicemode/logs/conversations/` for transcriptions
5. Voice audio is sent over WebSocket, transcribed by **Whisper** (local, `127.0.0.1:2022`)
6. Transcribed text is sent to Claude Code via the TerminalManager
7. **Response detection** -- the server polls terminal output looking for spinner lines, prompt-ready state, with 600ms debounce
8. The response is extracted, cleaned (strips URLs, code blocks, markdown, file paths), and sent to **Kokoro** (local, `127.0.0.1:8880`) for TTS
9. Audio is normalized (ffmpeg loudnorm + highpass/lowpass), streamed back over WebSocket for playback

### Robustness

- Atomic settings writes (write to `.tmp`, rename to prevent corruption)
- Service health checks at startup + every 60s (broadcasts status to clients)
- Auto-recreation of terminal session if it dies
- Orphaned temp file cleanup (stale TTS temp files)
- Generation counters for TTS (discards stale callbacks if interrupted)
- Timeout fallbacks for TTS (estimated duration + 3s buffer)

## Building from Source

```bash
# macOS -- produces .dmg in electron/dist/
npm run build:mac

# Windows -- produces .exe installer in electron/dist/
npm run build:win
```

Both commands run `electron-builder` from the `electron/` directory. The build bundles `server.ts`, `index.html`, `terminal/`, and dependencies as extra resources inside the app.

## API

### HTTP endpoints

| Endpoint | Method | Returns |
|---|---|---|
| `/` | GET | `index.html` |
| `/version` | GET | `{ version }` |
| `/debug` | GET | WebSocket client count, stream state, TTS status, VoiceMode state |
| `/info` | GET | Claude CLI info (PID, cwd, version, session status) |

### WebSocket messages

The server broadcasts JSON messages to all connected clients:

| Type | Payload | When |
|---|---|---|
| `voice_status` | `{ state, message? }` | Status changes: `idle`, `recording`, `transcribing`, `thinking`, `responding`, `speaking`, `error` |
| `transcription` | `{ role, text, ts }` | User input transcribed or assistant response received |
| `tts_stop` | `{}` | TTS playback interrupted |
| `terminal` | `{ text }` | Terminal pane content (every 500ms if changed) |
| `services` | `{ whisper, kokoro }` | Service health status changes |
| `settings` | `{ voice, speed }` | Settings persisted |

Binary WebSocket frames from clients are treated as audio input (mic data).

## Project Structure

```
murmur/
├── server.ts              # Express + WS server, terminal bridge, VoiceMode integration
├── index.html             # Web UI -- dark theme, transcript, controls, terminal panel
├── terminal/              # Cross-platform terminal abstraction
│   ├── interface.ts       #   TerminalManager interface + factory (auto-selects backend)
│   ├── tmux-backend.ts    #   macOS backend (tmux session: capture-pane, send-keys)
│   └── pty-backend.ts     #   Windows backend (node-pty pseudoterminal)
├── electron/              # Electron desktop app
│   ├── main.js            #   Main process (BrowserWindow, server lifecycle, hotkeys)
│   ├── preload.js         #   Preload script (context bridge)
│   ├── loading.html       #   Loading screen shown while server starts
│   ├── icons/             #   App icons (.icns for macOS, .ico for Windows)
│   └── package.json       #   Electron + electron-builder config
├── panel.swift            # Legacy macOS floating panel (still works, Electron is primary)
├── launch.sh              # macOS launcher (deps, compile, start, open)
├── launch.ps1             # Windows launcher (deps, start server, open Electron)
├── settings.json          # Voice + speed config (auto-created, gitignored)
├── make-icon.py           # Generates app icons from PIL (optional)
├── manifest.json          # Web app manifest
├── Murmur.app/            # Compiled legacy macOS app bundle (gitignored)
├── package.json           # Node dependencies (express, ws, chokidar, node-pty)
├── tsconfig.json          # TypeScript config
├── CLAUDE.md              # VoiceMode parameter constraints for Claude Code
└── tests/
    ├── test-e2e.ts        # Full Playwright browser test suite (UI + voice flow)
    ├── test-detection.ts  # Unit tests for terminal state detection (spinner, prompt)
    ├── test-bugs.ts       # Regression tests for specific bug fixes
    ├── test-poll.sh       # Bash integration test for poll detection
    ├── test-voice-cycle.sh # Bash integration test for full voice cycle
    └── test-audio/        # Sample WAV files for E2E testing
```

## Testing

> ⚠️ Tests must be run in the **`test-runner`** tmux session — not inside the active Claude Code session.
> Use the helper script which routes commands to the correct session:

```bash
tests/run.sh all       # ← SINGLE COMMAND: full suite, auto-skips audio if services unavailable
tests/run.sh e2e       # E2E + flow mode only (~105 tests)
tests/run.sh flow      # Flow mode deep tests
tests/run.sh bugs      # Regression tests
tests/run.sh smoke     # UI smoke tests only

# Bash integration tests (macOS only, run directly in test-runner)
bash tests/test-poll.sh
bash tests/test-voice-cycle.sh
```

## Troubleshooting

**Services not running**
```bash
# macOS
launchctl list | grep voicemode
voicemode service whisper status
voicemode service kokoro status

# Both platforms
curl http://127.0.0.1:2022/health
```

**Terminal session dead**
```bash
# macOS (tmux)
tmux has-session -t claude-voice 2>/dev/null && echo "alive" || echo "dead"

# The server recreates the session automatically on both platforms
```

**No audio / mic not working**
- macOS: Check System Settings > Privacy & Security > Microphone
- Windows: Check Settings > Privacy > Microphone -- ensure the app has permission
- Ensure the Electron app or browser has mic access

**Port already in use**
```bash
# macOS
lsof -i :3457

# Windows (PowerShell)
Get-NetTCPConnection -LocalPort 3457
```

**Whisper returning errors**
```bash
curl http://127.0.0.1:2022/health
# If unhealthy, restart:
voicemode service whisper restart
```

**Windows: node-pty build issues**
```
node-pty requires build tools. If npm install fails:
  1. Install Visual Studio Build Tools (C++ workload)
  2. Or: npm install --global windows-build-tools
  3. Re-run: npm install
```

**Legacy Swift panel (macOS only)**
```bash
# Compile and run the native macOS panel instead of Electron
xcode-select --install
swiftc --version
./launch.sh  # auto-compiles panel.swift if Murmur.app is missing
```

## License

MIT
