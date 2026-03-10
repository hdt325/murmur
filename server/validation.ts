/**
 * Input validation helpers — centralized boundary sanitization.
 * Prevents injection (XSS, shell, path traversal) at system boundaries.
 */

// Valid Kokoro TTS voice names — whitelist
export const VALID_VOICES = new Set([
  // American English female
  "af_heart", "af_bella", "af_nicole", "af_sky", "af_nova",
  "af_alloy", "af_aoede", "af_kore", "af_sarah", "af_jessica", "af_river",
  // American English male
  "am_fenrir", "am_michael", "am_puck", "am_echo", "am_eric", "am_liam", "am_onyx", "am_adam",
  // British English female
  "bf_emma", "bf_isabella", "bf_alice", "bf_lily",
  // British English male
  "bm_fable", "bm_george", "bm_daniel", "bm_lewis",
  // French / Spanish
  "ff_siwis", "ef_dora", "em_alex",
  // Hindi
  "hf_alpha", "hf_beta", "hm_omega", "hm_psi",
  // Italian
  "if_sara", "im_nicola",
  // Japanese
  "jf_alpha", "jf_gongitsune", "jf_nezumi", "jf_tebukuro", "jm_kumo",
  // Portuguese
  "pf_dora", "pm_alex", "pm_santa",
  // Chinese
  "zf_xiaoxiao", "zf_xiaobei", "zf_xiaoni", "zf_xiaoyi",
  "zm_yunjian", "zm_yunxi", "zm_yunxia", "zm_yunyang",
]);

/** Validate voice name against whitelist. Returns default if invalid. */
export function validateVoice(voice: string | undefined, fallback = "af_heart"): string {
  if (!voice) return fallback;
  if (voice.startsWith("_local:")) {
    // Local voices: allow only safe characters
    const localName = voice.slice(7);
    return /^[a-zA-Z0-9 _\-().]+$/.test(localName) ? voice : fallback;
  }
  return VALID_VOICES.has(voice) ? voice : fallback;
}

/** Sanitize text for shell-safe tmux send-keys (strip embedded newlines). */
export function sanitizeForTerminal(text: string): string {
  return text.replace(/[\r\n]+/g, " ").trim();
}

/** Force integer from untrusted input (prevents injection in shell interpolation). */
export function safeInt(value: unknown, fallback = 0): number {
  const n = parseInt(String(value), 10);
  return isNaN(n) ? fallback : n;
}

/** Validate file path component (no path traversal). */
export function isValidPathComponent(s: string): boolean {
  return /^[a-zA-Z0-9._\-]+$/.test(s);
}

/** Shell-escape a string for single-quote wrapping. */
export function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}

/** Safe JSON parse with fallback. */
export function safeJsonParse<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

/** HTML escape for any string interpolated into HTML context. */
export function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
