/**
 * Murmur Electron — cross-platform floating panel for Claude Code voice interface.
 * Replaces panel.swift (macOS-only) with Electron (macOS + Windows).
 */

const { app, BrowserWindow, globalShortcut, Tray, Menu, screen, session, nativeImage, ipcMain, dialog, systemPreferences } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn, execSync } = require("child_process");
const net = require("net");
const http = require("http");
const { autoUpdater } = require("electron-updater");
const https = require("https");
const crypto = require("crypto");

const SERVER_PORT = 3457;
const SERVER_URL = `http://localhost:${SERVER_PORT}`;

// GitHub content update config
const GH_OWNER = "hdt325";
const GH_REPO = "murmur";
const GH_BRANCH = "main";
const GH_RAW_BASE = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_BRANCH}`;
// Files to auto-update from GitHub.
// String entries: same path in repo and murmurDir.
// Object entries: { src: "repo/path", dest: "local/path in murmurDir" }
const CONTENT_FILES = [
  "server.ts",
  "index.html",
  "manifest.json",
  "package.json",
  "tsconfig.json",
  "terminal/interface.ts",
  "terminal/tmux-backend.ts",
  "terminal/pty-backend.ts",
  // Electron UI files — fetched from electron/ in repo, stored flat in murmurDir
  { src: "electron/loading.html", dest: "loading.html" },
  // NOTE: settings.json excluded — it's per-user preferences
];

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

// Returns the best available loading.html path:
// murmurDir version (content-updatable) if it exists, else bundled asar version.
function getLoadingPath() {
  const murmurDir = app.isPackaged
    ? path.join(process.resourcesPath, "murmur")
    : path.resolve(__dirname, "..");
  const fromMurmur = path.join(murmurDir, "loading.html");
  return fs.existsSync(fromMurmur) ? fromMurmur : path.join(__dirname, "loading.html");
}

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

// Async command check: resolves with trimmed stdout, or null on failure/timeout
function spawnCheck(cmd, args, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    try {
      const proc = spawn(cmd, args, { env: process.env });
      proc.stdout.on("data", (d) => { out += d.toString(); });
      proc.on("error", () => finish(null));
      proc.on("close", (code) => finish(code === 0 ? out.trim() : null));
      setTimeout(() => { try { proc.kill(); } catch {} finish(null); }, timeoutMs);
    } catch { finish(null); }
  });
}

// Check prerequisites and report to loading page.
// All checks run in parallel via async spawn — never blocks the main process event loop.
async function checkPrerequisites() {
  // Node.js — always available in Electron; report version directly from process
  sendStatus(`Node.js ${process.version}`, "info", { check: "node", checkStatus: "ok" });

  // Run remaining checks in parallel (warnings only — no hard blockers)
  const [claudeVer, tmuxOk, voicemodeOk] = await Promise.all([
    spawnCheck("claude", ["--version"]),
    process.platform === "darwin" ? spawnCheck("which", ["tmux"]) : Promise.resolve("ok"),
    spawnCheck("which", ["voicemode"]),
  ]);

  if (claudeVer) {
    sendStatus(`Claude Code CLI ${claudeVer}`, "info", { check: "claude", checkStatus: "ok" });
  } else {
    sendStatus("Claude Code CLI not found", "warn", { check: "claude", checkStatus: "warn", checkHint: "npm i -g @anthropic-ai/claude-code" });
  }

  if (process.platform !== "darwin") {
    sendStatus("", "info", { check: "tmux", checkStatus: "ok" });
  } else if (tmuxOk) {
    sendStatus("tmux available", "info", { check: "tmux", checkStatus: "ok" });
  } else {
    sendStatus("tmux not found", "warn", { check: "tmux", checkStatus: "warn", checkHint: "brew install tmux" });
  }

  if (voicemodeOk) {
    sendStatus("VoiceMode available", "info", { check: "voicemode", checkStatus: "ok" });
  } else {
    sendStatus("VoiceMode not found", "warn", { check: "voicemode", checkStatus: "warn", checkHint: "uv tool install voicemode" });
  }

  return false; // Node is always present (we're inside Electron)
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

  const murmurDir = app.isPackaged
    ? path.join(process.resourcesPath, "murmur")
    : path.resolve(__dirname, "..");

  // Install deps if needed (async — avoids blocking the main process event loop)
  const nodeModules = path.join(murmurDir, "node_modules");
  if (!fs.existsSync(nodeModules)) {
    sendStatus("Installing dependencies...", "info", { check: "deps", checkStatus: "pending" });
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const ok = await new Promise((resolve) => {
      const proc = spawn(npmCmd, ["install"], { cwd: murmurDir, stdio: ["ignore", "pipe", "pipe"] });
      proc.stdout.on("data", (d) => { const t = d.toString().trim(); if (t) sendStatus(t, "info"); });
      proc.stderr.on("data", (d) => { const t = d.toString().trim(); if (t) sendStatus(t, "info"); });
      proc.on("error", (err) => { sendStatus(`npm install failed: ${err.message}`, "error", { check: "deps", checkStatus: "fail" }); resolve(false); });
      proc.on("close", (code) => {
        if (code === 0) { sendStatus("Dependencies installed", "info", { check: "deps", checkStatus: "ok" }); resolve(true); }
        else { sendStatus(`npm install failed (exit ${code})`, "error", { check: "deps", checkStatus: "fail" }); resolve(false); }
      });
    });
    if (!ok) return false;
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
      sendStatus(`Server exited unexpectedly (code ${code})`, "fatal", { check: "server", checkStatus: "fail" });
    } else if (code === 0 && win && !win.isDestroyed()) {
      // Clean exit (restart requested from UI) — reload startup sequence
      console.log("Server exited cleanly — restarting...");
      startupComplete = false;
      win.loadFile(getLoadingPath());
      setTimeout(() => startup(), 1000);
    } else if (code !== 0 && win && !win.isDestroyed()) {
      // Server crashed after startup — auto-restart after 5s
      console.log("Server crashed — auto-restarting in 5s...");
      startupComplete = false;
      win.loadFile(getLoadingPath());
      setTimeout(() => {
        sendStatus(`Server crashed (exit ${code}) — restarting automatically...`, "warn", { check: "server", checkStatus: "fail" });
        setTimeout(() => startup(), 3000);
      }, 500);
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

// =============================================
// Content auto-update from GitHub
// =============================================

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Murmur-Electron" } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return httpsGet(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

function fileHash(filePath) {
  try {
    const content = fs.readFileSync(filePath);
    return crypto.createHash("sha256").update(content).digest("hex");
  } catch {
    return null;
  }
}

async function checkContentUpdates(murmurDir) {
  // Fetch all files in parallel to avoid sequential network delays
  const results = await Promise.all(CONTENT_FILES.map(async (entry) => {
    const src  = typeof entry === "string" ? entry : entry.src;
    const dest = typeof entry === "string" ? entry : entry.dest;
    try {
      const localPath = path.join(murmurDir, dest);
      const localHash = fileHash(localPath);
      const remoteContent = await httpsGet(`${GH_RAW_BASE}/${src}`);
      // Reject GitHub error pages — they're HTML and typically >10KB
      const str = remoteContent.toString("utf8", 0, 200);
      if (str.trimStart().startsWith("<")) {
        console.log(`[update] Skip ${src}: received HTML (GitHub error page)`);
        return null;
      }
      const remoteHash = crypto.createHash("sha256").update(remoteContent).digest("hex");
      if (localHash !== remoteHash) return { file: dest, localPath, content: remoteContent };
    } catch (err) {
      console.log(`[update] Skip ${src}: ${err.message}`);
    }
    return null;
  }));
  return results.filter(Boolean);
}

async function applyContentUpdates(updates) {
  for (const { file, localPath, content } of updates) {
    // Ensure directory exists
    const dir = path.dirname(localPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // Atomic write: write to temp file then rename (prevents corruption on crash)
    const tmpPath = localPath + ".tmp";
    fs.writeFileSync(tmpPath, content);
    fs.renameSync(tmpPath, localPath);
    console.log(`[update] Updated ${file}`);
  }
}

async function contentUpdateCheck(murmurDir) {
  try {
    sendStatus("Checking for updates...", "info", { check: "update", checkStatus: "pending" });
    const updates = await checkContentUpdates(murmurDir);

    if (updates.length === 0) {
      sendStatus("Content up to date", "info", { check: "update", checkStatus: "ok" });
      return false;
    }

    const fileList = updates.map(u => u.file).join(", ");
    console.log(`[update] ${updates.length} files changed: ${fileList}`);

    // Apply silently — no dialog prompt. The always-on-top window means any
    // dialog can appear behind it and block startup indefinitely.
    sendStatus(`Applying ${updates.length} update${updates.length > 1 ? "s" : ""}...`, "info", { check: "update", checkStatus: "pending" });
    await applyContentUpdates(updates);
    sendStatus(`Updated: ${fileList}`, "success", { check: "update", checkStatus: "ok" });

    // If package.json changed, reinstall deps (async — avoids blocking event loop)
    if (updates.some(u => u.file === "package.json")) {
      sendStatus("Updating dependencies...", "info", { check: "deps", checkStatus: "pending" });
      const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
      await new Promise((resolve) => {
        const proc = spawn(npmCmd, ["install"], { cwd: murmurDir, stdio: ["ignore", "pipe", "pipe"] });
        proc.stdout.on("data", (d) => { const t = d.toString().trim(); if (t) sendStatus(t, "info"); });
        proc.stderr.on("data", (d) => { const t = d.toString().trim(); if (t) sendStatus(t, "info"); });
        proc.on("error", (err) => { sendStatus(`npm install failed: ${err.message}`, "warn", { check: "deps", checkStatus: "warn" }); resolve(); });
        proc.on("close", (code) => {
          if (code === 0) sendStatus("Dependencies updated", "info", { check: "deps", checkStatus: "ok" });
          else sendStatus(`npm install exited ${code}`, "warn", { check: "deps", checkStatus: "warn" });
          resolve();
        });
      });
    }

    return true;
  } catch (err) {
    console.log(`[update] Content update check failed: ${err.message}`);
    sendStatus("Update check failed (non-fatal)", "warn", { check: "update", checkStatus: "warn" });
    return false;
  }
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

  // Check for content updates from GitHub
  const murmurDir = app.isPackaged
    ? path.join(process.resourcesPath, "murmur")
    : path.resolve(__dirname, "..");
  if (app.isPackaged) {
    await contentUpdateCheck(murmurDir);
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
  setTimeout(async () => {
    if (win && !win.isDestroyed()) {
      // Clear cache to ensure fresh load after app updates
      await session.defaultSession.clearCache();
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
      backgroundThrottling: false, // Keep timers + AudioContext alive when Murmur is behind other windows
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

  // Grant only needed permissions for localhost (microphone for STT, notifications for updates)
  const ALLOWED_PERMISSIONS = new Set(["media", "microphone", "notifications", "clipboard-read", "clipboard-sanitized-write"]);
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return ALLOWED_PERMISSIONS.has(permission);
  });

  // Load the startup diagnostics page — prefer murmurDir version (content-updatable),
  // fall back to bundled asar version on first run before any content update.
  win.loadFile(getLoadingPath());

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
    console.log("Update downloaded:", info.version);
    // Show persistent in-app banner (can't be dismissed by accident)
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
      win.webContents.send("update-ready", { version: info.version });
    }
  });

  autoUpdater.on("error", (err) => {
    console.log("Auto-updater error (non-fatal):", err.message);
  });

  // Check for updates silently
  autoUpdater.checkForUpdatesAndNotify().catch(() => {});
}

// Install update from in-app banner button
ipcMain.on("install-update", () => {
  try {
    app.removeAllListeners("window-all-closed");
    app.removeAllListeners("will-quit");
    if (win && !win.isDestroyed()) {
      win.removeAllListeners("close");
      win.destroy();
    }
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
  } catch (err) {
    console.log("quitAndInstall failed:", err.message);
    // Fallback: open download page in browser
    const { shell } = require("electron");
    shell.openExternal("https://github.com/hdt325/murmur/releases/latest");
  }
});

// Open releases page in browser (Download fallback button)
ipcMain.on("open-releases-page", () => {
  const { shell } = require("electron");
  shell.openExternal("https://github.com/hdt325/murmur/releases/latest");
});

// Manual update check from UI
ipcMain.handle("check-for-updates", async () => {
  if (!app.isPackaged) {
    return { status: "dev", message: "Auto-update disabled in dev mode. Use git pull." };
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result || !result.updateInfo) return { status: "up-to-date", version: app.getVersion() };
    const latest = result.updateInfo.version;
    const current = app.getVersion();
    if (latest === current) return { status: "up-to-date", version: current };
    // Compare as version numbers (e.g. 1.0.63 vs 1.0.62)
    const latestNum = latest.split(".").reduce((a, n, i) => a + parseInt(n) * Math.pow(1000, 2 - i), 0);
    const currentNum = current.split(".").reduce((a, n, i) => a + parseInt(n) * Math.pow(1000, 2 - i), 0);
    if (latestNum <= currentNum) return { status: "up-to-date", version: current };
    return { status: "available", version: latest };
  } catch (err) {
    return { status: "error", message: err.message };
  }
});

// Handle retry from loading page
ipcMain.on("retry-startup", () => {
  startup();
});

// One-click prerequisite installs
ipcMain.handle("install-prereq", async (_event, name) => {
  const commands = {
    claude: "npm i -g @anthropic-ai/claude-code",
    tmux: "brew install tmux",
    voicemode: "uv tool install voicemode || pip install voicemode",
  };

  const cmd = commands[name];
  if (!cmd) return { ok: false, error: "Unknown prerequisite" };

  sendStatus(`Installing ${name}...`, "info", { check: name, checkStatus: "pending" });

  try {
    const output = execSync(cmd, {
      encoding: "utf8",
      timeout: 180000,
      env: {
        ...process.env,
        PATH: process.platform === "darwin"
          ? `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`
          : process.env.PATH,
      },
    });
    console.log(`[install] ${name} installed:`, output.slice(0, 200));
    sendStatus(`${name} installed`, "success", { check: name, checkStatus: "ok" });
    return { ok: true };
  } catch (err) {
    const msg = err.stderr || err.message || "Unknown error";
    console.error(`[install] ${name} failed:`, msg.slice(0, 500));
    sendStatus(`Failed to install ${name}: ${msg.slice(0, 100)}`, "error", { check: name, checkStatus: "fail" });
    return { ok: false, error: msg.slice(0, 200) };
  }
});

// Expose app version to preload
ipcMain.on("get-app-version", (e) => { e.returnValue = app.getVersion(); });

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

  // Show window immediately — never block on permission dialogs
  createWindow();
  createTray();
  registerHotkey();

  // Request microphone permission after window is visible (macOS).
  // Previously awaited before createWindow(), which caused the window to never
  // appear on first launch when the system permission dialog was pending.
  if (process.platform === "darwin") {
    systemPreferences.askForMediaAccess("microphone").catch(() => {});
  }
  // Auto-updater only works on packaged builds (not dev source runs)
  // For source installs, the content auto-updater in startup() handles updates
  if (app.isPackaged) {
    setupAutoUpdater();
  }

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

let quitting = false;
app.on("will-quit", (e) => {
  globalShortcut.unregisterAll();

  // Destroy tray so macOS doesn't keep the process alive
  if (tray) { tray.destroy(); tray = null; }

  if (serverProcess && !quitting) {
    // Prevent immediate quit — wait for server to exit cleanly
    quitting = true;
    e.preventDefault();
    const proc = serverProcess;
    const killTimeout = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
      serverProcess = null;
      app.quit();
    }, 3000);
    proc.once("exit", () => {
      clearTimeout(killTimeout);
      serverProcess = null;
      app.quit();
    });
    proc.kill("SIGTERM");
  }
});
