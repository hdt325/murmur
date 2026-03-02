/**
 * Murmur Electron preload — minimal bridge.
 * The web UI (index.html) communicates with server.ts via WebSocket,
 * so no IPC bridge is needed. This preload exists for security isolation.
 */

const { contextBridge } = require("electron");

// Expose minimal info to the renderer
contextBridge.exposeInMainWorld("murmurElectron", {
  platform: process.platform,
  isElectron: true,
});
