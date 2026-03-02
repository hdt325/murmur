/**
 * Murmur Electron — cross-platform floating panel for Claude Code voice interface.
 * Replaces panel.swift (macOS-only) with Electron (macOS + Windows).
 */

const { app, BrowserWindow, globalShortcut, Tray, Menu, screen, session, nativeImage, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn, execSync } = require("child_process");
const net = require("net");
const http = require("http");
const { autoUpdater } = require("electron-updater");

const SERVER_PORT = 3457;
const SERVER_URL = `http://localhost:${SERVER_PORT}`;

// macOS GUI apps don't inherit shell PATH — add common tool locations
if (process.platform === "darwin") {
  const extraPaths = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/local/sbin"];
  const currentPath = process.env.PATH || "";
  const missing = extraPaths.filter(p => !currentPath.includes(p));
  if (missing.length > 0) {
    process.env.PATH = missing.join(":") + ":" + currentPath;
  }
  // Also try to source the user's shell PATH for globally installed npm packages
  try {
    const shellPath = execSync("zsh -ilc 'echo $PATH'", { encoding: "utf8", timeout: 5000 }).trim();
    if (shellPath) {
      const shellParts = shellPath.split(":").filter(p => !process.env.PATH.includes(p));
      if (shellParts.length > 0) {
        process.env.PATH = process.env.PATH + ":" + shellParts.join(":");
      }
    }
  } catch {}
}

let win = null;
let tray = null;
let serverProcess = null;
let startupComplete = false;

// Send status messages to the loading page renderer
function sendStatus(msg, type = "info", extra = {}) {
  if (win && !win.isDestroyed()) {
    win.webContents.send("startup-status", { msg, type, ...extra });
  }
}

// Check if server is already running
function isServerRunning() {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(1000);
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("error", () => { sock.destroy(); resolve(false); });
    sock.once("timeout", () => { sock.destroy(); resolve(false); });
    sock.connect(SERVER_PORT, "127.0.0.1");
  });
}

// Check if a local HTTP service is reachable
function isServiceUp(port, urlPath = "/") {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}${urlPath}`, { timeout: 3000 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

// Check prerequisites and report to loading page
async function checkPrerequisites() {
  let hasBlocker = false;

  // Node.js (always available since we're running in Electron, but check anyway)
  try {
    const ver = execSync("node -v", { timeout: 3000, encoding: "utf8" }).trim();
    sendStatus(`Node.js ${ver}`, "info", { check: "node", checkStatus: "ok" });
  } catch {
    sendStatus("Node.js not found", "error", { check: "node", checkStatus: "fail", checkHint: "Install from nodejs.org" });
    hasBlocker = true;
  }

  // Claude Code CLI
  try {
    const ver = execSync("claude --version", { timeout: 5000, encoding: "utf8" }).trim();
    sendStatus(`Claude Code CLI ${ver}`, "info", { check: "claude", checkStatus: "ok" });
  } catch {
    sendStatus("Claude Code CLI not found", "warn", { check: "claude", checkStatus: "warn", checkHint: "npm i -g @anthropic-ai/claude-code" });
  }

  // tmux (macOS only)
  if (process.platform === "darwin") {
    try {
      execSync("which tmux", { timeout: 3000 });
      sendStatus("tmux available", "info", { check: "tmux", checkStatus: "ok" });
    } catch {
      sendStatus("tmux not found", "warn", { check: "tmux", checkStatus: "warn", checkHint: "brew install tmux" });
    }
  } else {
    sendStatus("", "info", { check: "tmux", checkStatus: "ok" });
  }

  return hasBlocker;
}

// Check optional voice services
async function checkVoiceServices() {
  const whisperUp = await isServiceUp(2022, "/health");
  if (whisperUp) {
    sendStatus("Whisper STT running", "info", { check: "whisper", checkStatus: "ok" });
  } else {
    sendStatus("Whisper STT not detected — voice input unavailable", "warn", { check: "whisper", checkStatus: "warn", checkHint: "voicemode service whisper start" });
  }

  const kokoroUp = await isServiceUp(8880, "/docs");
  if (kokoroUp) {
    sendStatus("Kokoro TTS running", "info", { check: "kokoro", checkStatus: "ok" });
  } else {
    sendStatus("Kokoro TTS not detected — voice output unavailable", "warn", { check: "kokoro", checkStatus: "warn", checkHint: "voicemode service kokoro start" });
  }
}

// Start the Express server if not already running
async function ensureServer() {
  // Check if already running
  if (await isServerRunning()) {
    sendStatus("Server already running", "success", { check: "server", checkStatus: "ok" });
    return true;
  }

  const murmurDir = path.resolve(__dirname, "..");

  // Install deps if needed
  const nodeModules = path.join(murmurDir, "node_modules");
  if (!fs.existsSync(nodeModules)) {
    sendStatus("Installing dependencies...", "info", { check: "deps", checkStatus: "pending" });
    try {
      execSync("npm install", { cwd: murmurDir, timeout: 120000 });
      sendStatus("Dependencies installed", "info", { check: "deps", checkStatus: "ok" });
    } catch (err) {
      sendStatus(`npm install failed: ${err.message}`, "error", { check: "deps", checkStatus: "fail" });
      return false;
    }
  } else {
    sendStatus("Dependencies OK", "info", { check: "deps", checkStatus: "ok" });
  }

  // Start server
  sendStatus("Starting server...", "info");
  const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
  serverProcess = spawn(npxCmd, ["tsx", "server.ts"], {
    cwd: murmurDir,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
    env: {
      ...process.env,
      PATH: process.platform === "darwin"
        ? `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`
        : process.env.PATH,
    },
  });

  // Forward server output to loading page
  serverProcess.stdout.on("data", (d) => {
    const text = d.toString().trim();
    if (text) sendStatus(text, "info");
  });
  serverProcess.stderr.on("data", (d) => {
    const text = d.toString().trim();
    if (text) sendStatus(text, "warn");
  });

  serverProcess.on("error", (err) => {
    console.error("Failed to start server:", err.message);
    sendStatus(`Server failed to start: ${err.message}`, "error", { check: "server", checkStatus: "fail" });
  });

  serverProcess.on("exit", (code) => {
    console.log("Server exited with code", code);
    serverProcess = null;
    if (!startupComplete) {
      sendStatus(`Server exited unexpectedly (code ${code})`, "error", { check: "server", checkStatus: "fail" });
    } else if (code !== 0 && win && !win.isDestroyed()) {
      // Server crashed after startup — show loading page with error
      win.loadFile(path.join(__dirname, "loading.html"));
      setTimeout(() => {
        sendStatus(`Server crashed (exit code ${code}). Click Retry to restart.`, "error", { check: "server", checkStatus: "fail" });
      }, 500);
      startupComplete = false;
    }
  });

  // Wait for server to come up (max 15s)
  for (let i = 0; i < 150; i++) {
    if (await isServerRunning()) {
      sendStatus("Server ready!", "success", { check: "server", checkStatus: "ok" });
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  sendStatus("Server did not start within 15s", "error", { check: "server", checkStatus: "fail" });
  return false;
}

// Full startup sequence
async function startup() {
  startupComplete = false;

  // Check prerequisites
  sendStatus("Checking prerequisites...", "info");
  const hasBlocker = await checkPrerequisites();
  if (hasBlocker) {
    sendStatus("Fix the issues above, then click Retry", "fatal");
    return;
  }

  // Start server
  const serverOk = await ensureServer();
  if (!serverOk) {
    sendStatus("Server failed to start. Click Retry to try again.", "fatal");
    return;
  }

  // Check voice services (non-blocking — these are optional)
  await checkVoiceServices();

  // All good — redirect to Murmur
  sendStatus("Loading Murmur...", "success");
  startupComplete = true;
  setTimeout(() => {
    if (win && !win.isDestroyed()) {
      win.loadURL(SERVER_URL);
    }
  }, 600);
}

function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
  const winWidth = 320;
  const winHeight = screenHeight - 40;

  win = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x: screenWidth - winWidth - 20,
    y: 20,
    frame: false,
    alwaysOnTop: true,
    resizable: true,
    hasShadow: true,
    minWidth: 240,
    minHeight: 300,
    backgroundColor: "#1a1a1e",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Float above other windows (like panel.swift's .floating level)
  win.setAlwaysOnTop(true, "floating");

  // macOS: show on all spaces
  if (process.platform === "darwin") {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  // Inject drag CSS after page loads — ensures it applies even if index.html caches
  win.webContents.on("did-finish-load", () => {
    win.webContents.insertCSS(`
      .header { -webkit-app-region: drag !important; }
      .header * { -webkit-app-region: no-drag !important; }
    `);
  });

  // Auto-grant microphone permission for localhost
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(true);
  });

  // Load the startup diagnostics page first
  win.loadFile(path.join(__dirname, "loading.html"));

  win.on("closed", () => {
    win = null;
  });
}

// Global hotkey: Right Cmd (macOS) / Right Ctrl (Windows) toggles recording
function registerHotkey() {
  const accelerator = process.platform === "darwin"
    ? "CommandOrControl+Right"
    : "Control+Right";

  try {
    globalShortcut.register(accelerator, () => {
      if (win && !win.isDestroyed()) {
        win.webContents.executeJavaScript(
          "window.toggleRecording && window.toggleRecording()"
        );
      }
    });
  } catch (err) {
    console.warn("Failed to register global hotkey:", err.message);
  }
}

function createTray() {
  const iconName = process.platform === "darwin" ? "icon_16x16.png" : "icon.ico";
  const iconPath = path.join(__dirname, "icons", iconName);

  if (!fs.existsSync(iconPath)) {
    console.log("Tray icon not found, skipping tray");
    return;
  }

  tray = new Tray(iconPath);
  tray.setToolTip("Murmur");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Show/Hide",
      click: () => {
        if (win) {
          win.isVisible() ? win.hide() : win.show();
        }
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => app.quit(),
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on("click", () => {
    if (win) {
      win.isVisible() ? win.hide() : win.show();
    }
  });
}

// Auto-updater: check GitHub Releases for new versions
function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-available", (info) => {
    console.log("Update available:", info.version);
  });

  autoUpdater.on("update-downloaded", (info) => {
    // Notify user that an update is ready
    const response = dialog.showMessageBoxSync(win, {
      type: "info",
      title: "Update Ready",
      message: `Murmur ${info.version} is ready to install.`,
      detail: "The update will be applied when you restart the app.",
      buttons: ["Restart Now", "Later"],
      defaultId: 0,
    });
    if (response === 0) {
      autoUpdater.quitAndInstall();
    }
  });

  autoUpdater.on("error", (err) => {
    console.log("Auto-updater error (non-fatal):", err.message);
  });

  // Check for updates silently
  autoUpdater.checkForUpdatesAndNotify().catch(() => {});
}

// Handle retry from loading page
ipcMain.on("retry-startup", () => {
  startup();
});

// Handle close from panel UI
ipcMain.on("close-panel", () => {
  app.quit();
});

// App lifecycle
app.whenReady().then(async () => {
  // macOS: force dock icon visibility and set custom icon
  if (process.platform === "darwin" && app.dock) {
    app.dock.show();
    const iconPath = path.join(__dirname, "icons", "icon.png");
    if (fs.existsSync(iconPath)) {
      app.dock.setIcon(nativeImage.createFromPath(iconPath));
    }
  }

  createWindow();
  createTray();
  registerHotkey();
  setupAutoUpdater();

  // Run startup sequence (loading page is already showing)
  // Small delay to ensure loading page is rendered before sending messages
  setTimeout(() => startup(), 300);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      setTimeout(() => startup(), 300);
    }
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();

  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});
