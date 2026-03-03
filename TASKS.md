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
- `manifest.json`: added 192×192 and 512×512 icon entries
- `apple-touch-icon` updated with `sizes="180x180"`
- Added `apple-mobile-web-app-title` meta tag

## Pending

_(no pending tasks)_
