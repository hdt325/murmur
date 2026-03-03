# Murmur — Backlog

## Pending

### #4 — Primary audio client mechanism
When both Electron and iPhone are connected, TTS audio broadcasts to all clients (double playback) and mic input can conflict. Need a "primary audio client" concept:
- Last connected client auto-takes audio control
- OR explicit "claim audio" button per client
- Server only sends TTS binary to active audio client
- Other clients get text/status only
- Client UI shows whether it has audio control

**Files:** `server.ts` (track activeAudioClient, add `claim:audio` WS handler), `index.html` (audio control indicator)

---

### #5 — Remote/mobile access docs
Users don't know how to access from iPhone. Add clarifications in:

1. **Site (murmur.happythakkar.com)** — "Remote Access" section: Tailscale setup, `tailscale ip`, use `https://<ip>:3458`, Mac must be running, mute desktop when using phone
2. **In-app tour** — add step explaining remote/mobile access and multi-client audio limitation

---

### #6 — Unify app iconography for iOS home screen
Adding Murmur to iPhone home screen shows a generic "M" icon. Need proper PWA icons:
- `apple-touch-icon` 180x180px with Murmur branding
- `manifest.json` icons array: 192x192, 512x512
- `apple-mobile-web-app-title`, `apple-mobile-web-app-capable` already set
- Ensure favicon, Electron icon, and web icon are all consistent
