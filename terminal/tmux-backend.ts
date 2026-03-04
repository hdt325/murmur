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
    const target = this.currentTarget;
    try {
      execFileSync("tmux", ["send-keys", "-t", target, "-l", text], {
        stdio: "ignore",
        timeout: 5000,
      });
      execFileSync("tmux", ["send-keys", "-t", target, "Enter"], {
        stdio: "ignore",
        timeout: 5000,
      });
    } catch (err) {
      console.error("tmux send-keys failed:", (err as Error).message);
    }

    // Fallback: if text got stuck as a bracketed paste, retry Enter
    setTimeout(() => {
      try {
        const pane = execFileSync("tmux", ["capture-pane", "-t", target, "-p"], {
          encoding: "utf-8", timeout: 2000,
        }).trim();
        const lines = pane.split("\n");
        const lastLines = lines.slice(-5).join("\n");
        // Stuck = prompt has text but no spinner/response started
        if (
          lastLines.includes("❯ ") &&
          !lastLines.includes("✻") &&
          !lastLines.includes("⏺")
        ) {
          const promptLine =
            lines.filter((l) => l.includes("❯ ")).pop() || "";
          const afterPrompt = promptLine.replace(/^.*❯\s*/, "").trim();
          if (afterPrompt.length > 5) {
            console.log(
              `[sendText] Text stuck on prompt — sending Enter to confirm`
            );
            execFileSync("tmux", ["send-keys", "-t", target, "Enter"], {
              stdio: "ignore", timeout: 2000,
            });
          }
        }
      } catch {}
    }, 800);
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
        `cat >> ${filePath}`
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
