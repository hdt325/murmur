/**
 * TerminalManager — abstraction over tmux (macOS) and node-pty (Windows).
 *
 * All interaction with the Claude Code CLI session goes through this interface.
 */

export type TerminalKey = "Up" | "Down" | "Enter" | "Escape" | "Tab" | "C-u";

export interface TerminalManager {
  /** Check if the Claude CLI session is alive */
  isSessionAlive(): boolean;

  /** Create a new session and launch Claude CLI */
  createSession(): void;

  /** Send text followed by Enter (submit a command/message) */
  sendText(text: string): void;

  /** Send a single control key */
  sendKey(key: TerminalKey): void;

  /** Capture visible pane content (plain text, no ANSI codes) */
  capturePane(): string;

  /** Capture visible pane content with ANSI escape codes (for terminal panel) */
  capturePaneAnsi(): string;

  /** Capture extended scrollback (last ~2000 lines) */
  capturePaneScrollback(): string;

  /** Start streaming pane output to a file (real-time activity signal) */
  startPipeStream(filePath: string): void;

  /** Stop streaming pane output */
  stopPipeStream(): void;

  /** Clean up resources */
  destroy(): void;
}

/**
 * Factory: auto-select backend based on platform and tmux availability.
 * - macOS with tmux → TmuxBackend
 * - Windows or no tmux → PtyBackend
 */
export async function createTerminalManager(): Promise<TerminalManager> {
  if (process.platform !== "win32") {
    try {
      const { execSync } = await import("child_process");
      execSync("which tmux", { stdio: "ignore", timeout: 3000 });
      const { TmuxBackend } = await import("./tmux-backend.js");
      return new TmuxBackend();
    } catch {
      // tmux not available, fall through to pty
    }
  }
  const { PtyBackend } = await import("./pty-backend.js");
  return new PtyBackend();
}
