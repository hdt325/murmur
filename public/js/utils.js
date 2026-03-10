/**
 * Murmur frontend utilities.
 * Shared helpers used across all frontend modules.
 */

/** HTML-escape a string to prevent XSS in innerHTML contexts. */
export function escHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Safe localStorage.setItem — no-op if storage is full or disabled (Safari private mode). */
export function lsSet(k, v) {
  try { localStorage.setItem(k, v); } catch {}
}

/** Safe localStorage.getItem — returns fallback if storage is unavailable. */
export function lsGet(k, d) {
  try { return localStorage.getItem(k); } catch { return d || null; }
}

/** Safe localStorage.removeItem. */
export function lsRemove(k) {
  try { localStorage.removeItem(k); } catch {}
}

/** Format timestamp for display. */
export function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

/** Format elapsed time in human-readable form. */
export function elapsedStr(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

/** Trigger device vibration (haptic feedback). */
export function haptic(pattern) {
  try { navigator.vibrate?.(pattern); } catch {}
}

/** Strip ANSI escape codes from terminal text. */
export function stripAnsi(str) {
  return str
    .replace(/\x1B\[[0-9;?]*[A-Za-z]/g, "")       // CSI sequences (includes ? for DEC private modes)
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, "")  // OSC sequences (BEL or ST terminator)
    .replace(/\x1B[()][A-B0-2]/g, "")               // Charset switching (e.g. \x1B(B, \x1B)0)
    .replace(/\x1B[#%][A-Za-z0-9]/g, "")            // Line attrs & charset designators
    .replace(/\x1B[78DMEHNOcn><=]/g, "");            // Single-character escape commands (save/restore cursor, etc.)
}

/** Platform detection. */
export const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
export const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/** Debounce a function call. */
export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** Safe JSON parse with fallback. */
export function safeJsonParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}
