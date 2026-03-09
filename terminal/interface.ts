/**
 * TerminalManager — abstraction over tmux (macOS) and node-pty (Windows).
 *
 * All interaction with the Claude Code CLI session goes through this interface.
 */

export type TerminalKey = "Up" | "Down" | "Enter" | "Escape" | "Tab" | "C-u";

export interface TmuxWindowInfo {
  index: number;
  name: string;
  active: boolean;
}

export interface TmuxSessionInfo {
  name: string;
  windows: TmuxWindowInfo[];
}

/** Callback type for input line detection (when user presses Enter after typing) */
export type InputLineCallback = (text: string) => void;

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

  /** Switch to a different tmux session/window (tmux only — no-op on pty) */
  switchTarget?(session: string, window?: number): void;

  /** List all tmux sessions and their windows (tmux only — returns [] on pty) */
  listTmuxSessions?(): TmuxSessionInfo[];

  /** The current tmux target string (e.g. "claude-voice" or "main:1") — may be a pane ID */
  readonly currentTarget?: string;

  /** Human-readable session:window label (never a pane ID like %3) */
  readonly displayTarget?: string;

  /**
   * Record that text was sent programmatically (via Murmur text box or STT).
   * The passive watcher uses this to skip re-detecting the same input from the terminal.
   */
  recordSentInput?(text: string): void;

  /**
   * Check if text was recently sent programmatically (within last 30s).
   * Returns true if the passive watcher should skip this input (already captured by source #1/#2).
   */
  wasRecentlySent?(text: string): boolean;
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
