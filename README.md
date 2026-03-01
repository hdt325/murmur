# Murmur

A floating macOS panel for hands-free voice conversations with Claude Code.

## What it does

- **Voice input** via local Whisper STT — speak naturally, get transcribed on-device
- **Voice output** via local Kokoro TTS — responses read aloud with selectable voices and speed
- **Live terminal view** of Claude Code running in a tmux session
- **Native macOS floating window** with global hotkey (Right Cmd) — works from any app

## Architecture

```
┌─────────┐      ┌───────────────────────────────────────────────────┐
│   Mic   │─────▶│  Murmur (Express + WS on :3457)                  │
└─────────┘      │                                                   │
                 │  VoiceMode MCP orchestrates the audio pipeline:   │
                 │                                                   │
                 │  audio ──▶ Whisper STT (:2022) ──▶ text           │
                 │      event logs ◀── ~/.voicemode/logs/events/     │
                 │      exchanges ◀── ~/.voicemode/logs/conversations/│
                 │                                    │              │
                 │              tmux "claude-voice"    │              │
                 │                 ┌──────────┐       │              │
                 │  text ────────▶│Claude Code│       │              │
                 │                 └──────────┘       │              │
                 │                      │             │              │
                 │  capture-pane + poll ▼             │              │
                 │  (600ms debounce, spinner detect)  │              │
                 │                      │             │              │
                 │  response ◀──────────┘             │              │
                 │      │                             │              │
                 │      ▼         signal files (/tmp/)│              │
                 │  Kokoro TTS (:8880) ──▶ audio      │              │
                 │  (normalize + ffmpeg)              │              │
└─────────┐      └───────────────────────────────────────────────────┘
│ Speaker │◀─────
└─────────┘
```

## Prerequisites

| Requirement | Notes |
|---|---|
| macOS 13+ (Ventura) | Apple Silicon recommended |
| Node.js 18+ | `node -v` to check |
| tmux | `brew install tmux` |
| Claude Code CLI | `npm i -g @anthropic-ai/claude-code` |
| VoiceMode + services | `uv tool install voicemode` — provides Whisper STT (port 2022) + Kokoro TTS (port 8880) + event/log infrastructure |
| Xcode Command Line Tools | `xcode-select --install` (needed for `swiftc`) |
| Python 3.10+ with Pillow | Optional — only needed to regenerate the app icon |

## Install

```bash
# 1. Clone
git clone <repo-url> murmur
cd murmur

# 2. Install Node dependencies
npm install

# 3. Verify Whisper STT is running (should return OK)
curl http://127.0.0.1:2022/health

# 4. Verify Kokoro TTS is running (should return docs page)
curl -s http://127.0.0.1:8880/docs | head -5

# 5. Verify tmux
tmux -V
```

If Whisper or Kokoro aren't running, start them:

```bash
voicemode service whisper start
voicemode service kokoro start
```

## Quick Start

One command does everything — installs deps, compiles the Swift panel, starts the server, and opens the floating window:

```bash
./launch.sh
```

### Manual start

```bash
# Start just the server
npx tsx server.ts

# Then open http://localhost:3457 in a browser
# Or launch the native panel separately:
open Murmur.app
```

## Usage

| Action | How |
|---|---|
| Record | Tap the mic button or press **Right Cmd** (global hotkey) |
| Stop | Click **Stop** to interrupt recording, thinking, or TTS |
| Mute | Click **Mute** to silence TTS output |
| Speed | Cycle through playback speeds (0.5x – 3x) |
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

The server writes signal files to `/tmp/` for VoiceMode integration:

- `/tmp/claude-tts-voice` — current selected voice
- `/tmp/claude-tts-speed` — current playback speed
- `/tmp/claude-mute` — mute state

These persist across server restarts so VoiceMode picks up the last saved settings.

## How It Works

1. **Express + WebSocket server** runs on `:3457` (HTTP) / `:3458` (HTTPS)
2. A **tmux session** named `claude-voice` runs Claude Code
3. **VoiceMode MCP** orchestrates the audio pipeline — watches `~/.voicemode/logs/events/` for real-time status and `~/.voicemode/logs/conversations/` for transcriptions
4. Voice audio is sent over WebSocket → transcribed by **Whisper** (local, `127.0.0.1:2022`)
5. Transcribed text is sent to Claude Code via `tmux send-keys`
6. **Response detection** — the server polls `tmux capture-pane` looking for:
   - Spinner lines (✳, ✢, ·) indicating Claude is working
   - Prompt ready (empty `❯` with no spinner) indicating done
   - 600ms debounce + continuous poll, scoped between user input and pane bottom
7. The response is extracted, cleaned (strips URLs, code blocks, markdown, file paths), and sent to **Kokoro** (local, `127.0.0.1:8880`) for TTS
8. Audio is normalized (ffmpeg loudnorm + highpass/lowpass), streamed back over WebSocket for playback
9. The **native Swift panel** wraps everything in a floating, always-on-top macOS window with a global Right Cmd hotkey

### Robustness

- Atomic settings writes (write to `.tmp`, rename to prevent corruption)
- Service health checks at startup + every 60s (broadcasts status to clients)
- Auto-recreation of tmux session if it dies
- Orphaned temp file cleanup (stale TTS temp files)
- Generation counters for TTS (discards stale callbacks if interrupted)
- Timeout fallbacks for TTS (estimated duration + 3s buffer)

## API

### HTTP endpoints

| Endpoint | Method | Returns |
|---|---|---|
| `/` | GET | `index.html` |
| `/version` | GET | `{ version }` |
| `/debug` | GET | WebSocket client count, stream state, TTS status, VoiceMode state |
| `/info` | GET | Claude CLI info (PID, cwd, version, tmux session status) |

### WebSocket messages

The server broadcasts JSON messages to all connected clients:

| Type | Payload | When |
|---|---|---|
| `voice_status` | `{ state, message? }` | Status changes: `idle`, `recording`, `transcribing`, `thinking`, `responding`, `speaking`, `error` |
| `transcription` | `{ role, text, ts }` | User input transcribed or assistant response received |
| `tts_stop` | `{}` | TTS playback interrupted |
| `terminal` | `{ text }` | tmux pane content (every 500ms if changed) |
| `services` | `{ whisper, kokoro }` | Service health status changes |
| `settings` | `{ voice, speed }` | Settings persisted |

Binary WebSocket frames from clients are treated as audio input (mic data).

## Native Panel

The Swift app (`panel.swift` → `Murmur.app`) provides:

- **Floating window** — always-on-top, borderless, resizable, 320x500 default
- **Global hotkey** — Right Cmd (keyCode 54) toggles recording from any app
- **WebKit embed** — loads `http://localhost:3457`, auto-grants mic permission
- **Server management** — auto-starts `npx tsx server.ts` if port 3457 is not responding
- **Dark theme** — dark background (0.1, 0.1, 0.18), 12px corner radius, drag handle

## Project Structure

```
murmur/
├── server.ts            # Express + WS server, tmux bridge, VoiceMode integration
├── index.html           # Web UI — dark theme, transcript, controls, terminal panel
├── panel.swift          # Native macOS floating window (WebKit + global hotkey)
├── launch.sh            # One-command launcher (deps, compile, start, open)
├── settings.json        # Voice + speed config (auto-created, gitignored)
├── make-icon.py         # Generates AppIcon.icns from PIL (optional)
├── Murmur.app/      # Compiled macOS app bundle (gitignored)
├── package.json         # Node dependencies (express, ws, chokidar)
├── tsconfig.json        # TypeScript config
├── CLAUDE.md            # VoiceMode parameter constraints for Claude Code
└── tests/
    ├── test-e2e.ts      # Full Playwright browser test suite (UI + voice flow)
    ├── test-detection.ts# Unit tests for tmux state detection (spinner, prompt)
    ├── test-bugs.ts     # Regression tests for 11 specific bug fixes
    ├── test-poll.sh     # Bash integration test for poll detection
    ├── test-voice-cycle.sh # Bash integration test for full voice cycle
    └── test-audio/      # Sample WAV files for E2E testing
```

## Testing

```bash
# Full E2E browser tests (launches Chromium via Playwright)
npx tsx tests/test-e2e.ts

# tmux state detection unit tests
npx tsx tests/test-detection.ts

# Bug regression tests
npx tsx tests/test-bugs.ts

# Bash integration tests
bash tests/test-poll.sh
bash tests/test-voice-cycle.sh
```

## Troubleshooting

**Services not running**
```bash
launchctl list | grep voicemode
voicemode service whisper status
voicemode service kokoro status
```

**tmux session dead**
```bash
# Check if session exists
tmux has-session -t claude-voice 2>/dev/null && echo "alive" || echo "dead"

# The server recreates it automatically, or manually:
tmux new-session -d -s claude-voice
```

**No audio / mic not working**
- Check System Settings → Privacy & Security → Microphone
- Ensure the browser or Murmur.app has mic permission

**Swift compilation errors**
```bash
xcode-select --install
# Verify:
swiftc --version
```

**Port already in use**
```bash
lsof -i :3457
# Kill the process, or let launch.sh handle it (it cleans up automatically)
```

**Whisper returning errors**
```bash
curl http://127.0.0.1:2022/health
# If unhealthy, restart:
voicemode service whisper restart
```

## License

MIT
