/**
 * TmuxBackend — TerminalManager implementation using tmux (macOS/Linux).
 *
 * Extracted from server.ts — pure refactor, no behavior change.
 */

import { execSync, execFileSync } from "child_process";
import type { TerminalManager, TerminalKey, TmuxSessionInfo, TmuxWindowInfo } from "./interface.js";

const DEFAULT_SESSION = "claude-voice";
const SENT_INPUT_TTL_MS = 30000; // How long to remember programmatically sent inputs

export class TmuxBackend implements TerminalManager {
  private _session: string;
  private _window: number; // -1 = use active window
  private _paneId: string | null = null; // Pinned pane ID (e.g. "%3") — prevents agent panes stealing focus
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
      }
    } catch {
      console.log(`[tmux] Could not pin pane — will use session target`);
    }
  }

  /** Switch target to a different session and optional window index. */
  switchTarget(session: string, window = -1): void {
    this._session = session;
    this._window = window;
    this._paneId = null; // Clear pinned pane — re-pin to new target
    this._pinCurrentPane();
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
      return execFileSync("tmux", ["capture-pane", "-t", this.currentTarget, "-p"], {
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
      return execFileSync("tmux", ["capture-pane", "-t", this.currentTarget, "-p", "-S", "-2000"], {
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
    this.stopPipeStream();
    // Kill the tmux session to prevent leaking
    try {
      execFileSync("tmux", ["kill-session", "-t", this._session], {
        stdio: "ignore",
        timeout: 5000,
      });
    } catch {}
  }
}
