/**
 * TmuxBackend — TerminalManager implementation using tmux (macOS/Linux).
 *
 * Extracted from server.ts — pure refactor, no behavior change.
 */

import { execSync, execFileSync } from "child_process";
import type { TerminalManager, TerminalKey } from "./interface.js";

const TMUX_SESSION = "claude-voice";

export class TmuxBackend implements TerminalManager {
  readonly sessionName = TMUX_SESSION;

  isSessionAlive(): boolean {
    try {
      execSync(`tmux has-session -t ${TMUX_SESSION} 2>/dev/null`, {
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
      console.log(`tmux session "${TMUX_SESSION}" already exists`);
      return;
    }

    try {
      execSync(
        `tmux new-session -d -s ${TMUX_SESSION} -x 120 -y 30`,
        { stdio: "ignore", timeout: 5000 }
      );

      execSync(
        `tmux send-keys -t ${TMUX_SESSION} 'claude --dangerously-skip-permissions' Enter`,
        { stdio: "ignore", timeout: 5000 }
      );

      console.log(`tmux session "${TMUX_SESSION}" created with claude`);
      console.log(`  Attach with: tmux attach -t ${TMUX_SESSION}`);
    } catch (err) {
      console.error("Failed to create tmux session:", (err as Error).message);
    }
  }

  sendText(text: string): void {
    try {
      execFileSync("tmux", ["send-keys", "-t", TMUX_SESSION, "-l", text], {
        stdio: "ignore",
        timeout: 5000,
      });
      execFileSync("tmux", ["send-keys", "-t", TMUX_SESSION, "Enter"], {
        stdio: "ignore",
        timeout: 5000,
      });
    } catch (err) {
      console.error("tmux send-keys failed:", (err as Error).message);
    }

    // Fallback: if text got stuck as a bracketed paste, retry Enter
    setTimeout(() => {
      try {
        const pane = execSync(
          `tmux capture-pane -t ${TMUX_SESSION} -p`,
          { encoding: "utf-8", timeout: 2000 }
        ).trim();
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
            execFileSync(
              "tmux",
              ["send-keys", "-t", TMUX_SESSION, "Enter"],
              { stdio: "ignore", timeout: 2000 }
            );
          }
        }
      } catch {}
    }, 800);
  }

  sendKey(key: TerminalKey): void {
    const tmuxKey =
      key === "C-u" ? "C-u" : key; // tmux uses same key names
    try {
      execFileSync("tmux", ["send-keys", "-t", TMUX_SESSION, tmuxKey], {
        stdio: "ignore",
        timeout: 2000,
      });
    } catch {}
  }

  capturePane(): string {
    try {
      return execSync(`tmux capture-pane -t ${TMUX_SESSION} -p`, {
        encoding: "utf-8",
        timeout: 2000,
      });
    } catch {
      return "";
    }
  }

  capturePaneAnsi(): string {
    try {
      return execSync(`tmux capture-pane -t ${TMUX_SESSION} -e -p`, {
        encoding: "utf-8",
        timeout: 2000,
      });
    } catch {
      return "";
    }
  }

  capturePaneScrollback(): string {
    try {
      return execSync(`tmux capture-pane -t ${TMUX_SESSION} -p -S -2000`, {
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
      execSync(`tmux pipe-pane -t ${TMUX_SESSION}`, {
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
        "pipe-pane", "-O", "-t", TMUX_SESSION,
        `cat >> ${filePath}`
      ], { stdio: "ignore", timeout: 2000 });
    } catch (e) {
      console.error("[tmux] Failed to start pipe-pane:", e);
    }
  }

  stopPipeStream(): void {
    try {
      execSync(`tmux pipe-pane -t ${TMUX_SESSION}`, {
        stdio: "ignore",
        timeout: 2000,
      });
    } catch {}
  }

  destroy(): void {
    this.stopPipeStream();
    // Kill the tmux session to prevent leaking
    try {
      execSync(`tmux kill-session -t ${TMUX_SESSION}`, {
        stdio: "ignore",
        timeout: 5000,
      });
    } catch {}
  }
}
