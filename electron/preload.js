/**
 * Murmur Electron preload — bridge for startup diagnostics + runtime info.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("murmurElectron", {
  platform: process.platform,
  isElectron: true,
  // Startup diagnostics
  onStartupStatus: (callback) => ipcRenderer.on("startup-status", (_e, data) => callback(data)),
  retry: () => ipcRenderer.send("retry-startup"),
  close: () => ipcRenderer.send("close-panel"),
  // One-click prerequisite installs
  installPrereq: (name) => ipcRenderer.invoke("install-prereq", name),
});
