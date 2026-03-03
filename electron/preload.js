/**
 * Murmur Electron preload — bridge for startup diagnostics + runtime info.
 */

const { contextBridge, ipcRenderer } = require("electron");

let appVersion;
try { appVersion = require("./package.json").version; } catch { appVersion = "unknown"; }

contextBridge.exposeInMainWorld("murmurElectron", {
  platform: process.platform,
  isElectron: true,
  version: appVersion,
  // Startup diagnostics
  onStartupStatus: (callback) => ipcRenderer.on("startup-status", (_e, data) => callback(data)),
  retry: () => ipcRenderer.send("retry-startup"),
  close: () => ipcRenderer.send("close-panel"),
  // One-click prerequisite installs
  installPrereq: (name) => ipcRenderer.invoke("install-prereq", name),
  // App updates
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
});
