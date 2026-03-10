/**
 * TmuxBackend — TerminalManager implementation using tmux (macOS/Linux).
 *
 * Extracted from server.ts — pure refactor, no behavior change.
 */

import { execSync, execFileSync } from "child_process";
import { statSync, openSync, readSync, closeSync, writeFileSync, watch as fsWatch } from "fs";
import type { TerminalManager, TerminalKey, TmuxSessionInfo, TmuxWindowInfo } from "./interface.js";

const DEFAULT_SESSION = "claude-voice";
const SENT_INPUT_TTL_MS = 30000; // How long to remember programmatically sent inputs

export class TmuxBackend implements TerminalManager {
  private _session: string;
  private _window: number; // -1 = use active window
  private _paneId: string | null = null; // Pinned pane ID (e.g. "%3") — prevents agent panes stealing focus
  private _retryTimeout: ReturnType<typeof setTimeout> | null = null; // switchTarget retry timer
  // Track text sent via Murmur text box or STT so passive watcher skips re-detection
  private _sentInputs: Array<{ normalized: string; ts: number }> = [];

  get sessionName(): string { return this._session; }

  get currentTarget(): string {
    // Prefer pinned pane ID — immune to active-pane changes when agents spawn
    if (this._paneId) return this._paneId;
    return this._window >= 0 ? `${this._session}:${this._window}` : this._session;
  }

  /** Human-readable session:window label (never a pane ID) */
  get displayTarget(): string {
    return this._window >= 0 ? `${this._session}:${this._window}` : this._session;
  }

  /** The pinned pane ID (e.g. "%3") or null if pin failed */
  get pinnedPaneId(): string | null {
    return this._paneId;
  }

  constructor(session = DEFAULT_SESSION) {
    this._session = session;
    this._window = -1;
    // Pin the current active pane ID so it doesn't shift when sub-agents spawn new panes
    this._pinCurrentPane();
  }

  /** Capture and lock the current active pane ID for this session+window */
  private _pinCurrentPane(): void {
    try {
      // Target must include window index if set — otherwise tmux returns the
      // session's active pane, which may be a different window entirely.
      // This was the root cause of per-window conversations not working:
      // switching to window 1 still pinned the pane from window 0.
      const target = this._window >= 0
        ? `${this._session}:${this._window}`
        : this._session;
      const paneId = execFileSync("tmux", [
        "display-message", "-t", target, "-p", "#{pane_id}"
      ], { encoding: "utf-8", timeout: 3000 }).trim();
      if (paneId && paneId.startsWith("%")) {
        this._paneId = paneId;
        console.log(`[tmux] Pinned to pane ${paneId} in ${target}`);
        return;
      }
      console.log(`[tmux] display-message returned unexpected pane ID: "${paneId}" for ${target}`);
    } catch (err) {
      // Window index may not exist — fall back to validating and retrying
      console.log(`[tmux] Could not pin pane for ${this._session}:${this._window} — ${(err as Error).message?.slice(0, 120)} — validating window index`);
    }

    // Fallback: validate the window index exists, try first available window
    if (this._window >= 0) {
      try {
        const windowList = execFileSync("tmux", [
          "list-windows", "-t", this._session, "-F", "#{window_index}"
        ], { encoding: "utf-8", timeout: 3000 }).trim();
        const validWindows = windowList.split("\n").map(w => parseInt(w.trim())).filter(w => !isNaN(w));
        if (validWindows.length > 0 && !validWindows.includes(this._window)) {
          const fallback = validWindows[0];
          console.log(`[tmux] Window ${this._window} not found in ${this._session} (valid: ${validWindows.join(",")}), falling back to :${fallback}`);
          this._window = fallback;
          try {
            const paneId = execFileSync("tmux", [
              "display-message", "-t", `${this._session}:${this._window}`, "-p", "#{pane_id}"
            ], { encoding: "utf-8", timeout: 3000 }).trim();
            if (paneId && paneId.startsWith("%")) {
              this._paneId = paneId;
              console.log(`[tmux] Pinned to fallback pane ${paneId} in ${this._session}:${this._window}`);
              return;
            }
          } catch (err2) {
            console.log(`[tmux] Fallback pin failed for ${this._session}:${this._window} — ${(err2 as Error).message?.slice(0, 120)}`);
          }
        }
      } catch (err3) {
        console.log(`[tmux] Could not list windows for ${this._session} — ${(err3 as Error).message?.slice(0, 120)}`);
      }
    }
  }

  /** Switch target to a different session and optional window index. */
  switchTarget(session: string, window = -1): void {
    // Cancel any pending retry from a previous switchTarget call
    if (this._retryTimeout) {
      clearTimeout(this._retryTimeout);
      this._retryTimeout = null;
    }
    this._session = session;
    this._window = window;
    this._paneId = null; // Clear pinned pane — re-pin to new target
    this._pinCurrentPane();
    if (!this._paneId) {
      console.warn(`[tmux] WARNING: pane pin failed for ${session}:${window} — falling back to session:window target`);
      // Retry once after a short delay (tmux may be busy)
      this._retryTimeout = setTimeout(() => {
        this._retryTimeout = null;
        if (!this._paneId) {
          this._pinCurrentPane();
          if (this._paneId) {
            console.log(`[tmux] Retry succeeded — pinned to ${this._paneId}`);
          } else {
            console.warn(`[tmux] Retry also failed for ${session}:${window}`);
          }
        }
      }, 500);
    }
    // Restart always-on pipe for new target
    this.restartPipe();
  }

  /** List all tmux sessions and their windows. */
  listTmuxSessions(): TmuxSessionInfo[] {
    try {
      const rawSessions = execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"], {
        encoding: "utf-8", timeout: 3000,
      }).trim();
      if (!rawSessions) return [];

      const sessions: TmuxSessionInfo[] = [];
      for (const sessionName of rawSessions.split("\n").filter(Boolean)) {
        try {
          const rawWindows = execFileSync(
            "tmux", ["list-windows", "-t", sessionName, "-F", "#{window_index}|#{window_name}|#{window_active}"],
            { encoding: "utf-8", timeout: 3000 }
          ).trim();

          const windows: TmuxWindowInfo[] = rawWindows.split("\n")
            .filter(Boolean)
            .map(line => {
              const parts = line.split("|");
              return {
                index: parseInt(parts[0] ?? "0"),
                name: parts[1] ?? "",
                active: parts[2] === "1",
              };
            });
          sessions.push({ name: sessionName, windows });
        } catch {
          sessions.push({ name: sessionName, windows: [] });
        }
      }
      return sessions;
    } catch {
      return [];
    }
  }

  isSessionAlive(): boolean {
    try {
      execFileSync("tmux", ["has-session", "-t", this._session], {
        stdio: "ignore",
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }

  createSession(): void {
    if (this.isSessionAlive()) {
      console.log(`tmux session "${this._session}" already exists`);
      return;
    }

    try {
      execFileSync("tmux", ["new-session", "-d", "-s", this._session, "-x", "120", "-y", "30"], {
        stdio: "ignore", timeout: 5000,
      });

      execFileSync("tmux", ["send-keys", "-t", this._session, "claude --dangerously-skip-permissions", "Enter"], {
        stdio: "ignore", timeout: 5000,
      });

      console.log(`tmux session "${this._session}" created with claude`);
      console.log(`  Attach with: tmux attach -t ${this._session}`);
    } catch (err) {
      console.error("Failed to create tmux session:", (err as Error).message);
    }
  }

  sendText(text: string): void {
    // Collapse newlines (Whisper multi-line transcriptions) and strip stray CR
    const sanitized = text.replace(/[\r\n]+/g, " ").trim();
    const target = this.currentTarget;
    console.log(`[sendText] ${sanitized.length} chars → ${target}: "${sanitized.slice(0, 60)}"`);

    try {
      // send-keys -l types each character literally into Claude Code's ink TUI.
      // paste-buffer was tried but doesn't reliably insert into the prompt.
      // Timeout scales with message length — very long messages need more time.
      const sendTimeout = Math.max(5000, Math.ceil(sanitized.length / 50) * 1000);
      execFileSync("tmux", ["send-keys", "-t", target, "-l", sanitized], {
        stdio: "ignore",
        timeout: sendTimeout,
      });
    } catch (err) {
      console.error("[sendText] send-keys -l failed:", (err as Error).message);
      return;
    }

    // For long messages (>80 chars), Claude Code's ink TUI event loop may need
    // time to process all the key events before Enter is accepted. Add a
    // proportional delay before sending Enter. Short messages get no delay.
    // Very long messages (500+ chars) need significantly more time.
    const enterDelayMs = sanitized.length > 80
      ? Math.min(200 + Math.floor(sanitized.length / 3), 3000)
      : 0;

    const doSendEnter = () => {
      try {
        console.log(`[sendText] Sending Enter to ${target}`);
        execFileSync("tmux", ["send-keys", "-t", target, "Enter"], {
          stdio: "ignore",
          timeout: 2000,
        });
      } catch (err) {
        console.error("[sendText] send-keys Enter failed:", (err as Error).message);
      }
    };

    if (enterDelayMs > 0) {
      setTimeout(doSendEnter, enterDelayMs);
    } else {
      doSendEnter();
    }

    // Retry: if Enter was dropped or not processed, detect stuck state and resend.
    // Check the LAST 15 lines (not full pane) — Claude Code's TUI shows ❯ in
    // conversation history too, causing false positives on full-pane checks.
    // For long wrapped messages: text spans multiple lines after ❯, so also check
    // continuation lines (lines after the prompt line that have content).
    const retryEnterIfStuck = () => {
      try {
        const pane = execFileSync("tmux", ["capture-pane", "-t", target, "-p"], {
          encoding: "utf-8", timeout: 2000,
        }).trim();
        const lines = pane.split("\n");
        const inputArea = lines.slice(-15); // extra lines for wrapped long text
        const inputAreaText = inputArea.join("\n");

        // Not stuck if Claude is already working (spinner visible)
        if (
          inputAreaText.includes("✻") ||
          inputAreaText.includes("✶") ||
          inputAreaText.includes("⏺") ||
          inputAreaText.includes("Transmuting") ||
          inputAreaText.includes("Press up to edit")
        ) return false;

        if (!inputAreaText.includes("❯")) return false;

        // Find the LAST prompt line (bottom of input area = actual active prompt)
        let promptLineIdx = -1;
        for (let i = inputArea.length - 1; i >= 0; i--) {
          if (inputArea[i].includes("❯")) { promptLineIdx = i; break; }
        }
        if (promptLineIdx === -1) return false;

        const promptLine = inputArea[promptLineIdx];
        const afterPrompt = promptLine.replace(/^.*❯\s*/, "").trim();

        // Content exists on same line after ❯, OR on continuation lines below ❯
        // (long messages wrap across multiple terminal lines)
        const continuationHasContent = inputArea
          .slice(promptLineIdx + 1)
          .some(l => l.trim().length > 0);

        if (afterPrompt.length > 0 || continuationHasContent) {
          console.log(`[sendText] Stuck — afterPrompt="${afterPrompt.slice(0, 40)}" hasContinuation=${continuationHasContent} — retrying Enter`);
          execFileSync("tmux", ["send-keys", "-t", target, "Enter"], {
            stdio: "ignore", timeout: 2000,
          });
          return true;
        }
        return false;
      } catch { return false; }
    };

    // First retry fires after Enter would have been sent + buffer.
    // Longer messages get more buffer. 3 total retries.
    const retryBuffer = sanitized.length > 300 ? 1000 : 500;
    const retryInterval = sanitized.length > 300 ? 1000 : 600;
    const firstRetryMs = enterDelayMs + retryBuffer;
    setTimeout(() => {
      if (!retryEnterIfStuck()) return;
      setTimeout(() => {
        if (!retryEnterIfStuck()) return;
        setTimeout(retryEnterIfStuck, retryInterval);
      }, retryInterval);
    }, firstRetryMs);
  }

  sendKey(key: TerminalKey): void {
    try {
      execFileSync("tmux", ["send-keys", "-t", this.currentTarget, key], {
        stdio: "ignore",
        timeout: 2000,
      });
    } catch {}
  }

  capturePane(): string {
    try {
      // -J joins wrapped lines to prevent truncation on wide terminals (BUG-051)
      return execFileSync("tmux", ["capture-pane", "-t", this.currentTarget, "-p", "-J"], {
        encoding: "utf-8",
        timeout: 2000,
      });
    } catch {
      return "";
    }
  }

  capturePaneAnsi(): string {
    try {
      return execFileSync("tmux", ["capture-pane", "-t", this.currentTarget, "-e", "-p"], {
        encoding: "utf-8",
        timeout: 2000,
      });
    } catch {
      return "";
    }
  }

  capturePaneScrollback(): string {
    try {
      return execFileSync("tmux", ["capture-pane", "-t", this.currentTarget, "-p", "-J", "-S", "-2000"], {
        encoding: "utf-8",
        timeout: 2000,
      });
    } catch {
      return "";
    }
  }

  startPipeStream(filePath: string): void {
    // Close any existing pipe first
    try {
      execFileSync("tmux", ["pipe-pane", "-t", this.currentTarget], {
        stdio: "ignore",
        timeout: 2000,
      });
    } catch {}
    // Sanitize filePath — only allow alphanumeric, dash, underscore, dot, slash
    if (!/^[a-zA-Z0-9._\-\/]+$/.test(filePath)) {
      console.error("[tmux] Rejected unsafe pipe-pane path:", filePath);
      return;
    }
    // Start new pipe using execFileSync to avoid shell injection
    try {
      execFileSync("tmux", [
        "pipe-pane", "-O", "-t", this.currentTarget,
        `cat >> '${filePath.replace(/'/g, "'\\''")}'`
      ], { stdio: "ignore", timeout: 2000 });
    } catch (e) {
      console.error("[tmux] Failed to start pipe-pane:", e);
    }
  }

  stopPipeStream(): void {
    try {
      execFileSync("tmux", ["pipe-pane", "-t", this.currentTarget], {
        stdio: "ignore",
        timeout: 2000,
      });
    } catch {}
  }

  // ── Push-based output stream ──
  private _outputCallback: ((data: string) => void) | null = null;
  private _pipeWatcher: ReturnType<typeof fsWatch> | null = null;
  private _pipeOffset = 0;
  private _alwaysPipeFile: string | null = null;
  private _pipeFallbackTimer: ReturnType<typeof setInterval> | null = null;
  private _pipeMaxSize = 10 * 1024 * 1024; // 10MB — truncate when exceeded

  /** Register push-based output callback. Starts always-on pipe-pane. */
  onOutput(callback: (data: string) => void): void {
    this._outputCallback = callback;
    this._startAlwaysPipe();
  }

  private _startAlwaysPipe(): void {
    const filePath = `/tmp/murmur-pipe-${process.pid}.raw`;
    this._alwaysPipeFile = filePath;
    try { writeFileSync(filePath, ""); } catch {}
    this._pipeOffset = 0;

    // Start tmux pipe-pane to this file
    this.startPipeStream(filePath);

    // Watch for changes via fs.watch (kqueue on macOS)
    try {
      this._pipeWatcher = fsWatch(filePath, () => this._readNewPipeData());
    } catch (err) {
      console.warn("[tmux] fs.watch failed, relying on fallback poll:", (err as Error).message);
    }

    // Fallback poll (250ms) in case fs.watch misses events
    this._pipeFallbackTimer = setInterval(() => this._readNewPipeData(), 250);
  }

  /** Stop always-on pipe and clean up watchers */
  private _stopAlwaysPipe(): void {
    if (this._pipeWatcher) { this._pipeWatcher.close(); this._pipeWatcher = null; }
    if (this._pipeFallbackTimer) { clearInterval(this._pipeFallbackTimer); this._pipeFallbackTimer = null; }
    this.stopPipeStream();
    this._alwaysPipeFile = null;
  }

  /** Restart always-on pipe for a new target (e.g. window switch) */
  restartPipe(): void {
    if (!this._outputCallback) return;
    this._stopAlwaysPipe();
    this._startAlwaysPipe();
  }

  private _readNewPipeData(): void {
    if (!this._alwaysPipeFile || !this._outputCallback) return;
    try {
      const stat = statSync(this._alwaysPipeFile);
      if (stat.size <= this._pipeOffset) return;
      // Truncate if file too large (prevents disk fill from long sessions)
      if (stat.size > this._pipeMaxSize) {
        try { writeFileSync(this._alwaysPipeFile, ""); } catch {}
        this._pipeOffset = 0;
        return;
      }
      const fd = openSync(this._alwaysPipeFile, "r");
      try {
        const buf = Buffer.alloc(stat.size - this._pipeOffset);
        readSync(fd, buf, 0, buf.length, this._pipeOffset);
        this._pipeOffset = stat.size;
        this._outputCallback(buf.toString("utf-8"));
      } finally {
        closeSync(fd);
      }
    } catch {}
  }

  /** Record that text was sent programmatically (via Murmur text box or STT) */
  recordSentInput(text: string): void {
    const normalized = text.trim().toLowerCase().replace(/\s+/g, "");
    this._sentInputs.push({ normalized, ts: Date.now() });
    // Prune old entries
    const cutoff = Date.now() - SENT_INPUT_TTL_MS;
    this._sentInputs = this._sentInputs.filter(e => e.ts >= cutoff);
  }

  /** Check if text was recently sent programmatically (within last 30s) */
  wasRecentlySent(text: string): boolean {
    const normalized = text.trim().toLowerCase().replace(/\s+/g, "");
    const cutoff = Date.now() - SENT_INPUT_TTL_MS;
    return this._sentInputs.some(e => e.ts >= cutoff && e.normalized === normalized);
  }

  destroy(): void {
    this._stopAlwaysPipe();
    // Kill only the targeted window — not the entire session (other windows may be in use)
    try {
      const target = this._window >= 0 ? `${this._session}:${this._window}` : this._session;
      execFileSync("tmux", ["kill-window", "-t", target], {
        stdio: "ignore",
        timeout: 5000,
      });
    } catch {}
  }
}
