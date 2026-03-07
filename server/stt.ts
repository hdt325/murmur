/**
 * Speech-to-text module — Whisper integration.
 * Handles audio format detection, transcription with retry, and hallucination filtering.
 */

import { writeFileSync, unlinkSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
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

export async function transcribeAudio(
  audioData: Buffer,
  whisperUrl: string,
  tempDir: string,
  serviceStatus: ServiceStatus,
  broadcast: BroadcastFn,
  checkService: (name: string, url: string) => Promise<boolean>,
): Promise<string> {
  if (!serviceStatus.whisper) {
    serviceStatus.whisper = await checkService("Whisper STT", whisperUrl);
    if (!serviceStatus.whisper) {
      console.error("Whisper is not running -- cannot transcribe");
      broadcast({ type: "voice_status", state: "error", message: "Whisper STT not running" });
      return "";
    }
  }

  const uid = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  const audioExt = detectAudioExt(audioData);
  const tmpFile = join(tempDir, `murmur-audio-${uid}.${audioExt}`);
  writeFileSync(tmpFile, audioData);

  try {
    plog("transcribe_start");
    const sttStart = Date.now();
    slog("stt", "start", { bytes: audioData.length, ext: audioExt });

    const result = execFileSync("curl", [
      "-s", "-X", "POST", `${whisperUrl}/v1/audio/transcriptions`,
      "-F", `file=@${tmpFile}`, "-F", "model=whisper-1", "-F", "language=en",
      "-F", "response_format=verbose_json", "-F", `prompt=${STT_PROMPT}`,
    ], { encoding: "utf-8", timeout: 10000 });

    const json = JSON.parse(result);
    const noSpeechProb = json.segments?.[0]?.no_speech_prob ?? 0;
    if (noSpeechProb >= 0.6) {
      console.log(`[stt] Discarded -- no_speech_prob=${noSpeechProb.toFixed(2)} (likely hallucination)`);
      return "";
    }
    const text = json.text?.trim() || "";
    plog("transcribe_done", text ? `"${text.slice(0, 100)}"` : "(empty)");
    slog("stt", "done", { text: text.slice(0, 100), durationMs: Date.now() - sttStart });
    return text;
  } catch (err) {
    console.warn("[stt] First attempt failed, retrying:", (err as Error).message);
    try {
      const retryResult = execFileSync("curl", [
        "-s", "-X", "POST", `${whisperUrl}/v1/audio/transcriptions`,
        "-F", `file=@${tmpFile}`, "-F", "model=whisper-1", "-F", "language=en",
        "-F", "response_format=verbose_json", "-F", `prompt=${STT_PROMPT}`,
      ], { encoding: "utf-8", timeout: 10000 });
      const retryJson = JSON.parse(retryResult);
      const text = retryJson.text?.trim() || "";
      console.log(`[stt] Retry succeeded: "${text.slice(0, 60)}"`);
      return text;
    } catch (retryErr) {
      console.error("Whisper transcription failed (after retry):", (retryErr as Error).message);
      plog("transcribe_error", (retryErr as Error).message);
      slog("stt", "error", { error: (retryErr as Error).message });
      serviceStatus.whisper = false;
      broadcast({ type: "voice_status", state: "error", message: "Whisper STT failed" });
      return "";
    }
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}
