/**
 * Murmur Electron preload — bridge for startup diagnostics + runtime info.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("murmurElectron", {
  platform: process.platform,
  isElectron: true,
  version: ipcRenderer.sendSync("get-app-version"),
  // Startup diagnostics
  onStartupStatus: (callback) => ipcRenderer.on("startup-status", (_e, data) => callback(data)),
  retry: () => ipcRenderer.send("retry-startup"),
  close: () => ipcRenderer.send("close-panel"),
  // One-click prerequisite installs
  installPrereq: (name) => ipcRenderer.invoke("install-prereq", name),
  // Mic permission — triggers native macOS permission dialog from main process
  requestMicPermission: () => ipcRenderer.invoke("request-mic-permission"),
  // Open System Settings → Privacy → Microphone directly
  openMicSettings: () => ipcRenderer.send("open-mic-settings"),
  // App updates
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  onUpdateReady: (callback) => ipcRenderer.on("update-ready", (_e, info) => callback(info)),
  installUpdate: () => ipcRenderer.send("install-update"),
  openReleasesPage: () => ipcRenderer.send("open-releases-page"),
});
