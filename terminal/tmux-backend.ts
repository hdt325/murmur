/**
 * TmuxBackend — TerminalManager implementation using tmux (macOS/Linux).
 *
 * Extracted from server.ts — pure refactor, no behavior change.
 */

import { execSync, execFileSync } from "child_process";
import type { TerminalManager, TerminalKey, TmuxSessionInfo, TmuxWindowInfo } from "./interface.js";

const DEFAULT_SESSION = "claude-voice";

export class TmuxBackend implements TerminalManager {
  private _session: string;
  private _window: number; // -1 = use active window

  get sessionName(): string { return this._session; }

  get currentTarget(): string {
    return this._window >= 0 ? `${this._session}:${this._window}` : this._session;
  }

  constructor(session = DEFAULT_SESSION) {
    this._session = session;
    this._window = -1;
  }

  /** Switch target to a different session and optional window index. */
  switchTarget(session: string, window = -1): void {
    this._session = session;
    this._window = window;
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
      execFileSync("tmux", ["send-keys", "-t", target, "-l", sanitized], {
        stdio: "ignore",
        timeout: 5000,
      });
    } catch (err) {
      console.error("[sendText] send-keys -l failed:", (err as Error).message);
      return;
    }

    // For long messages (>80 chars), Claude Code's ink TUI event loop may need
    // time to process all the key events before Enter is accepted. Add a small
    // proportional delay before sending Enter. Short messages get no delay.
    const enterDelayMs = sanitized.length > 80 ? Math.min(100 + Math.floor(sanitized.length / 10), 400) : 0;

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

    // First retry fires after Enter would have been sent + 500ms buffer.
    // Subsequent retries at 600ms intervals. 3 total retries.
    const firstRetryMs = enterDelayMs + 500;
    setTimeout(() => {
      if (!retryEnterIfStuck()) return;
      setTimeout(() => {
        if (!retryEnterIfStuck()) return;
        setTimeout(retryEnterIfStuck, 600);
      }, 600);
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
