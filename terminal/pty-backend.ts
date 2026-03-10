/**
 * PtyBackend — TerminalManager implementation using node-pty.
 *
 * Works on Windows (and as fallback on macOS/Linux without tmux).
 * Spawns Claude CLI in a pseudo-terminal and maintains a rolling buffer
 * of terminal output for capturePane/capturePaneScrollback.
 */

import { appendFileSync } from "fs";
import type { TerminalManager, TerminalKey } from "./interface.js";

// node-pty is an optional dependency — only loaded when PtyBackend is used
let pty: typeof import("node-pty");
try {
  pty = await import("node-pty");
} catch {
  throw new Error(
    "node-pty is required for PtyBackend. Install with: npm install node-pty"
  );
}

// Strip ANSI escape codes from text
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

const MAX_BUFFER_SIZE = 100 * 1024; // 100KB rolling buffer
const VISIBLE_ROWS = 30; // Match tmux 120x30 config

export class PtyBackend implements TerminalManager {
  private proc: ReturnType<typeof pty.spawn> | null = null;
  private buffer = ""; // Plain text (ANSI stripped)
  private ansiBuffer = ""; // With ANSI codes
  private alive = false;
  private pipeListener: ((data: string) => void) | null = null;
  private pipeFilePath: string | null = null;

  isSessionAlive(): boolean {
    return this.alive && this.proc !== null;
  }

  createSession(): void {
    if (this.alive && this.proc) {
      console.log("PTY session already exists");
      return;
    }

    const shell =
      process.platform === "win32" ? "cmd.exe" : "/bin/bash";
    const shellArgs =
      process.platform === "win32" ? [] : ["--login"];

    this.proc = pty.spawn(shell, shellArgs, {
      name: "xterm-256color",
      cols: 120,
      rows: VISIBLE_ROWS,
      cwd: process.env.HOME || process.env.USERPROFILE || ".",
      env: process.env as Record<string, string>,
    });

    this.alive = true;
    this.buffer = "";
    this.ansiBuffer = "";

    this.proc.onData((data: string) => {
      // Accumulate in both buffers
      this.ansiBuffer += data;
      this.buffer += stripAnsi(data);

      // Trim buffers to prevent unbounded growth
      if (this.ansiBuffer.length > MAX_BUFFER_SIZE) {
        this.ansiBuffer = this.ansiBuffer.slice(-MAX_BUFFER_SIZE);
      }
      if (this.buffer.length > MAX_BUFFER_SIZE) {
        this.buffer = this.buffer.slice(-MAX_BUFFER_SIZE);
      }

      // Write to pipe file if active
      if (this.pipeFilePath) {
        try {
          appendFileSync(this.pipeFilePath, data);
        } catch {}
      }
    });

    this.proc.onExit(() => {
      this.alive = false;
      console.log("PTY process exited");
    });

    // Wait for shell to be ready, then start Claude
    setTimeout(() => {
      if (this.proc && this.alive) {
        this.proc.write("claude --dangerously-skip-permissions\r");
        console.log("PTY session created with claude");
      }
    }, 1000);
  }

  sendText(text: string): void {
    if (!this.proc || !this.alive) {
      console.error("PTY session not alive — cannot send text");
      return;
    }
    // Collapse newlines (Whisper multi-line transcriptions) to prevent command injection
    const sanitized = text.replace(/[\r\n]+/g, " ").trim();
    this.proc.write(sanitized + "\r");
  }

  sendKey(key: TerminalKey): void {
    if (!this.proc || !this.alive) return;

    const keyMap: Record<TerminalKey, string> = {
      Up: "\x1b[A",
      Down: "\x1b[B",
      Enter: "\r",
      Escape: "\x1b",
      Tab: "\t",
      "C-u": "\x15",
    };

    this.proc.write(keyMap[key]);
  }

  capturePane(): string {
    return this.lastNLines(this.buffer, VISIBLE_ROWS);
  }

  capturePaneAnsi(): string {
    return this.lastNLines(this.ansiBuffer, VISIBLE_ROWS);
  }

  capturePaneScrollback(): string {
    return this.lastNLines(this.buffer, 2000);
  }

  startPipeStream(filePath: string): void {
    // Validate path: no traversal, no shell metacharacters
    if (filePath.includes("..")) {
      console.error(`[pty] Rejected path traversal: ${filePath.slice(0, 80)}`);
      return;
    }
    if (!/^[a-zA-Z0-9._\-\/]+$/.test(filePath)) {
      console.error(`[pty] Rejected unsafe pipe path: ${filePath.slice(0, 80)}`);
      return;
    }
    this.pipeFilePath = filePath;
  }

  stopPipeStream(): void {
    this.pipeFilePath = null;
  }

  destroy(): void {
    this.stopPipeStream();
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {}
      this.proc = null;
    }
    this.alive = false;
  }

  private lastNLines(buf: string, n: number): string {
    const lines = buf.split("\n");
    return lines.slice(-n).join("\n");
  }
}
