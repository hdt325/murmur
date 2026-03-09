# Murmur — Shared Agent Context

Reference for all agents. See CLAUDE.md for full architecture and constraints.

## Entry Lifecycle

- **Creation**: tmux pane → `extractStructuredOutput()` → `broadcastCurrentOutput()` → `conversationEntries[]`
- **User entries**: `addUserEntry(text, inputId)` — deduplicates against last 20 entries regardless of turn
- **Assistant entries**: Created in `broadcastCurrentOutput()` by matching parsed paragraphs to existing entries via text similarity (not array index)
- **Broadcast**: `broadcast({ type: "entry", entries, partial, ttsPendingIds })` — full array sent each time
- **Key fields** on `ConversationEntry` (server/types.ts):
  - `id` — monotonic counter, unique per entry
  - `role` — "user" | "assistant"
  - `text` — full content
  - `speakable` — true for prose, false for tool output/chrome
  - `spoken` — true after TTS completes for this entry
  - `turn` — incremented on each new user input
  - `inputId` — UUID linking voice/text input through STT to entry
  - `filler` — true for auto-generated filler phrases

## TTS Pipeline

- **Queue**: `queueTts(entryId, text, source)` → creates `TtsJob` with chunks → fetches audio from Kokoro in parallel
- **Chunk splitting**: sentence boundaries, first chunk max 120 chars (fast first audio), subsequent max 250 chars
- **Playback**: `drainAudioBuffer()` sends `tts_play` metadata + binary audio to client. Client sends `chunk_done:ID:INDEX` → server sends next chunk. Client sends `tts_done:ID` when finished.
- **Generation counter**: `ttsGeneration` bumped via `bumpGeneration(reason)` on every interrupt/stop. Jobs created with a generation snapshot; stale jobs (generation mismatch) are discarded after async fetch.
- **Dedup**: `queueTts` skips if entryId already has a non-done/non-failed job in queue
- **Constants**: `TTS_MAX_QUEUE=50`, `TTS_MAX_PARALLEL=10`, `TTS_PLAYING_TIMEOUT_MS=30000`

## TTS Highlight

- Server sends `tts_play` with `{ entryId, fullText, speakableText, chunkCount, chunkWordCounts }` when a job starts playing
- Client finds `.entry-bubble[data-entry-id="X"]` and adds `bubble-active` class (amber highlight)
- Flow mode: word-level karaoke — grey text ungrey word-by-word as spoken, red = failed/dropped
- `ttsPendingIds` array attached to every entry broadcast — lists entries with in-flight TTS (prevents red flash during fetch)
- Highlight removed on `tts_stop` or `tts_done`

## Clean vs Verbose Mode

- **Client flag**: `voicedOnly` (localStorage "voiced-only") — toggled by clean/verbose button
- **Clean mode** (`voicedOnly=true`): `.entry-nonspeakable` hidden via CSS, TTS only speaks `speakable=true` entries
- **Verbose mode** (`voicedOnly=false`): All entries visible, TTS speaks all entries
- **Rule**: What the user **sees** = what they **hear** and see **highlighted**
- Server marks `speakable=false` on tool output, file paths, status lines during `extractStructuredOutput()`

## Passive Watcher

- Polls tmux every ~2s via `startPassiveWatcher()`
- Detects: spinner (Claude working) → broadcasts `voice_status: thinking`; prompt idle → extracts output
- Captures user input from `❯ ` prompt line + continuation lines (stops at `─━═` separators)
- **Dedup guard**: `_lastPassiveUserInput` with 30s window prevents re-creating entries for same text
- **Cooldown**: 10s after stream ends (`PASSIVE_COOLDOWN_MS`) — still checks for spinner to show thinking UI
- **Pitfalls**: empty `lastPassiveSnapshot` fallback, tmux wrap boundary mismatch, positional shift on long responses

## Multi-TTS Engines

- **Kokoro** (primary): `http://127.0.0.1:8880` — voices prefixed `af_*`, `am_*`, `bf_*`, `bm_*`, etc.
- **Local** (Web Speech API): `_local:VoiceName` — client-side, no server audio; used as fallback on iOS
- Default voice: `af_heart`. Voice validated against `VALID_VOICES` set at load.
- Voice change flushes TTS queue and bumps generation

## System Context Filtering

- `MURMUR_CONTEXT_LINES` — sent to terminal once (e.g., "Prose mode on — no markdown, short sentences.")
- `MURMUR_CONTEXT_FILTER` — regex strips these from scrollback, entry creation, and output parsing
- **Critical**: Both must stay in sync. If context lines change, filter regex MUST be updated or context leaks as bubbles.
- `MURMUR_EXIT` sent when last real client disconnects ("Prose mode off — resume normal formatting.")

## Key WebSocket Messages

### Client → Server
| Message | Purpose |
|---|---|
| Binary frames | Audio input (mic data) |
| `text:TEXT` | Text input (blocked terminal send in testmode) |
| `tts_done` / `tts_done:ID` | Client finished playing audio → drain queue |
| `chunk_done:ID:INDEX` | Client finished one chunk → send next |
| `stop` / `interrupt` | Stop Claude + clear TTS |
| `barge_in` | User spoke over TTS → pause/interrupt |
| `voice:NAME` / `speed:N` | Change TTS voice/speed |
| `claim:audio` | Claim audio output from multi-client setup |
| `replay:ID` / `replay:all` | Re-speak entry or all |

### Server → Client
| Message | Purpose |
|---|---|
| `{ type: "entry", entries, ttsPendingIds }` | Full entry array + pending TTS IDs |
| `{ type: "voice_status", state }` | idle, recording, transcribing, thinking, responding, speaking, error |
| `{ type: "tts_stop", reason }` | Stop client TTS playback |
| `tts_play` + Binary frames | TTS metadata then audio chunks |
| `{ type: "terminal", html }` | Terminal panel content |
| `{ type: "restarting" }` | Server restart signal |

## Testing Constraints

- **Tests MUST use `?testmode=1`** in URL — prevents text from reaching terminal/Claude
- Tests MUST run in `test-runner` tmux session, NEVER via Bash tool directly
- Route commands: `tmux send-keys -t test-runner "CMD" Enter` + `Read /tmp/results.txt`
- NEVER use cat/tail/grep via Bash (output appears in claude-voice pane)
- Test client auto-cleanup: entries created during test removed on disconnect

## Key State Variables (server.ts)

| Variable | Purpose |
|---|---|
| `conversationEntries[]` | Global entry array, single source of truth |
| `entryIdCounter` | Monotonic entry ID generator |
| `currentTurn` | Incremented on new user input |
| `ttsGeneration` | Bumped on interrupt/stop, invalidates stale TTS jobs |
| `ttsJobQueue[]` | Ordered TTS jobs awaiting/playing |
| `ttsCurrentlyPlaying` | Active TTS job on client |
| `streamState` | IDLE → WAITING → THINKING → RESPONDING → FINALIZING → DONE |
| `preInputSnapshot` | Tmux pane content before user sends input |
| `lastPassiveSnapshot` | Last passive watcher tmux capture |
| `entryTtsCursor` | Map tracking TTS progress per entry ID |

## Ports

- **3457** — HTTP/WS (localhost)
- **3458** — HTTPS/WSS (Tailscale remote)
- **2022** — Whisper STT
- **8880** — Kokoro TTS
