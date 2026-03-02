/**
 * Murmur Electron — cross-platform floating panel for Claude Code voice interface.
 * Replaces panel.swift (macOS-only) with Electron (macOS + Windows).
 */

const { app, BrowserWindow, globalShortcut, Tray, Menu, screen, session, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn, execSync } = require("child_process");
const net = require("net");

const SERVER_PORT = 3457;
const SERVER_URL = `http://localhost:${SERVER_PORT}`;

let win = null;
let tray = null;
let serverProcess = null;

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

// Start the Express server if not already running
async function ensureServer() {
  if (await isServerRunning()) {
    console.log("Server already running on port", SERVER_PORT);
    return;
  }

  const murmurDir = path.resolve(__dirname, "..");

  // Install deps if needed
  const nodeModules = path.join(murmurDir, "node_modules");
  if (!fs.existsSync(nodeModules)) {
    console.log("Installing dependencies...");
    execSync("npm install --silent", { cwd: murmurDir, stdio: "inherit" });
  }

  // Start server
  const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
  serverProcess = spawn(npxCmd, ["tsx", "server.ts"], {
    cwd: murmurDir,
    stdio: "ignore",
    detached: false,
    env: {
      ...process.env,
      // Ensure Homebrew Node is in PATH on macOS
      PATH: process.platform === "darwin"
        ? `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`
        : process.env.PATH,
    },
  });

  serverProcess.on("error", (err) => {
    console.error("Failed to start server:", err.message);
  });

  serverProcess.on("exit", (code) => {
    console.log("Server exited with code", code);
    serverProcess = null;
  });

  // Wait for server to come up (max 10s)
  for (let i = 0; i < 100; i++) {
    if (await isServerRunning()) {
      console.log("Server ready");
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  console.warn("Server did not start within 10s");
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
    if (permission === "media") {
      callback(true);
    } else {
      callback(true);
    }
  });

  win.loadURL(SERVER_URL);

  win.on("closed", () => {
    win = null;
  });
}

// Global hotkey: Right Cmd (macOS) / Right Ctrl (Windows) toggles recording
function registerHotkey() {
  const accelerator = process.platform === "darwin"
    ? "CommandOrControl+Right"
    : "Control+Right";

  // Note: Electron's globalShortcut can't distinguish left/right modifier keys.
  // For Right Cmd specifically on macOS, we'd need native event monitoring.
  // Using Cmd+Right as a reasonable cross-platform alternative.
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
  // Use a simple tray icon (Electron requires a png/ico)
  // On macOS, use a template image for the menu bar
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

  await ensureServer();
  createWindow();
  createTray();
  registerHotkey();

  app.on("activate", () => {
    // macOS: re-create window when dock icon is clicked
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  // Don't quit on macOS when all windows are closed (standard behavior)
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();

  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});
