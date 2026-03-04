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

## Pending

_(no pending tasks)_
