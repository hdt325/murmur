/**
 * Speech-to-text module — Whisper integration.
 * Handles audio format detection, transcription with retry, and hallucination filtering.
 * Uses async fetch() instead of execFileSync to avoid blocking the event loop.
 */

import { plog, slog } from "./logging.js";
import type { ServiceStatus, BroadcastFn } from "./types.js";

const STT_PROMPT = "Claude, Murmur, tmux, TypeScript, JavaScript, npm, npx, Python, Git, terminal, code, function, variable, component, server, error, install, run, test.";

/** Detect audio format from magic bytes -- iOS sends mp4, desktop sends webm */
export function detectAudioExt(data: Buffer): string {
  if (data.length > 12) {
    if (data.slice(0, 4).toString("ascii") === "RIFF" && data.slice(8, 12).toString("ascii") === "WAVE") return "wav";
    if (data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) return "webm";
    if (data.slice(4, 8).toString("ascii") === "ftyp") return "mp4";
    if (data.slice(0, 4).toString("ascii") === "OggS") return "ogg";
  }
  return "webm";
}

const EXT_TO_MIME: Record<string, string> = {
  wav: "audio/wav",
  webm: "audio/webm",
  mp4: "audio/mp4",
  ogg: "audio/ogg",
};

// --- Whisper Debug Log ---
export interface WhisperLog {
  ts: number;
  inputId?: string;
  transcriptionStartTs: number;
  transcriptionEndTs: number;
  durationMs: number;
  audioSizeBytes: number;
  transcribedText: string;
  noSpeechProb: number;
  isRetry: boolean;
  wasFiltered: boolean;
  status: "success" | "failed" | "filtered";
}
export const whisperLog: WhisperLog[] = []; // ring buffer, last 30

function logWhisper(entry: WhisperLog): void {
  whisperLog.push(entry);
  if (whisperLog.length > 30) whisperLog.shift();
}

/** Send audio to Whisper via async fetch (non-blocking). */
async function whisperFetch(audioData: Buffer, audioExt: string, whisperUrl: string): Promise<any> {
  const mime = EXT_TO_MIME[audioExt] || "application/octet-stream";
  const boundary = "----MurmurBoundary" + Date.now();
  const fileName = `audio.${audioExt}`;

  // Build multipart/form-data body manually (Node fetch FormData doesn't support Buffer as File easily)
  const fields: Array<{ name: string; value: string }> = [
    { name: "model", value: "whisper-1" },
    { name: "language", value: "en" },
    { name: "response_format", value: "verbose_json" },
    { name: "prompt", value: STT_PROMPT },
  ];

  const parts: Buffer[] = [];
  for (const f of fields) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"\r\n\r\n${f.value}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mime}\r\n\r\n`));
  parts.push(audioData);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const resp = await fetch(`${whisperUrl}/v1/audio/transcriptions`, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body,
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`Whisper HTTP ${resp.status}: ${await resp.text()}`);
    return await resp.json();
  } finally {
    clearTimeout(timeout);
  }
}

/** Parse Whisper response, apply hallucination filter. Returns { text, noSpeechProb, filtered }. */
function parseWhisperResult(json: any): { text: string; noSpeechProb: number; filtered: boolean } {
  const noSpeechProb = json.segments?.[0]?.no_speech_prob ?? 0;
  if (noSpeechProb >= 0.6) {
    console.log(`[stt] Discarded -- no_speech_prob=${noSpeechProb.toFixed(2)} (likely hallucination)`);
    return { text: "", noSpeechProb, filtered: true };
  }
  return { text: json.text?.trim() || "", noSpeechProb, filtered: false };
}

export async function transcribeAudio(
  audioData: Buffer,
  whisperUrl: string,
  tempDir: string,
  serviceStatus: ServiceStatus,
  broadcast: BroadcastFn,
  checkService: (name: string, url: string) => Promise<boolean>,
  inputId?: string,
): Promise<string> {
  if (!serviceStatus.whisper) {
    serviceStatus.whisper = await checkService("Whisper STT", whisperUrl);
    if (!serviceStatus.whisper) {
      console.error("Whisper is not running -- cannot transcribe");
      broadcast({ type: "voice_status", state: "error", message: "Whisper STT not running" });
      return "";
    }
  }

  const audioExt = detectAudioExt(audioData);
  const sttStartTs = Date.now();

  try {
    plog("transcribe_start");
    slog("stt", "start", { bytes: audioData.length, ext: audioExt });

    const json = await whisperFetch(audioData, audioExt, whisperUrl);
    const { text, noSpeechProb, filtered } = parseWhisperResult(json);
    const endTs = Date.now();

    plog("transcribe_done", text ? `"${text.slice(0, 100)}"` : "(empty)");
    slog("stt", "done", { text: text.slice(0, 100), durationMs: endTs - sttStartTs });

    logWhisper({
      ts: endTs, inputId, transcriptionStartTs: sttStartTs, transcriptionEndTs: endTs,
      durationMs: endTs - sttStartTs, audioSizeBytes: audioData.length,
      transcribedText: text.slice(0, 80), noSpeechProb, isRetry: false,
      wasFiltered: filtered, status: filtered ? "filtered" : "success",
    });

    return text;
  } catch (err) {
    console.warn("[stt] First attempt failed, retrying:", (err as Error).message);
    const retryStartTs = Date.now();
    try {
      const retryJson = await whisperFetch(audioData, audioExt, whisperUrl);
      const { text, noSpeechProb, filtered } = parseWhisperResult(retryJson);
      const retryEndTs = Date.now();
      console.log(`[stt] Retry succeeded: "${text.slice(0, 60)}"`);

      logWhisper({
        ts: retryEndTs, inputId, transcriptionStartTs: retryStartTs, transcriptionEndTs: retryEndTs,
        durationMs: retryEndTs - retryStartTs, audioSizeBytes: audioData.length,
        transcribedText: text.slice(0, 80), noSpeechProb, isRetry: true,
        wasFiltered: filtered, status: filtered ? "filtered" : "success",
      });

      return text;
    } catch (retryErr) {
      const retryEndTs = Date.now();
      console.error("Whisper transcription failed (after retry):", (retryErr as Error).message);
      plog("transcribe_error", (retryErr as Error).message);
      slog("stt", "error", { error: (retryErr as Error).message });
      serviceStatus.whisper = false;
      broadcast({ type: "voice_status", state: "error", message: "Whisper STT failed" });

      logWhisper({
        ts: retryEndTs, inputId, transcriptionStartTs: retryStartTs, transcriptionEndTs: retryEndTs,
        durationMs: retryEndTs - retryStartTs, audioSizeBytes: audioData.length,
        transcribedText: "", noSpeechProb: 0, isRetry: true,
        wasFiltered: false, status: "failed",
      });

      return "";
    }
  }
}
