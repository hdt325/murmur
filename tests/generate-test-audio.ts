/**
 * Generate test audio files using Kokoro TTS for pipeline integration tests.
 *
 * Produces WAV files in tests/test-audio/ that simulate real user speech.
 * Run once before test-tts-pipeline.ts:
 *   npx tsx tests/generate-test-audio.ts
 */

import { writeFileSync, mkdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = join(__dirname, "test-audio");
const KOKORO_URL = "http://127.0.0.1:8880";

mkdirSync(AUDIO_DIR, { recursive: true });

interface TestPhrase {
  name: string;
  text: string;
}

const PHRASES: TestPhrase[] = [
  { name: "short", text: "What is two plus two?" },
  { name: "medium", text: "Explain in two sentences why the sky is blue." },
  { name: "long", text: "Tell me a short story about a cat. Make it three paragraphs long." },
];

async function generateSilence(outPath: string, durationSec = 2) {
  // Generate silence WAV using ffmpeg
  execSync(
    `ffmpeg -y -f lavfi -i anullsrc=r=16000:cl=mono -t ${durationSec} "${outPath}"`,
    { stdio: "ignore", timeout: 10000 }
  );
}

async function generateAudio(phrase: TestPhrase): Promise<{ path: string; sizeKB: number; durationS: number }> {
  const mp3Path = join(AUDIO_DIR, `${phrase.name}.mp3`);
  const wavPath = join(AUDIO_DIR, `${phrase.name}.wav`);

  // Generate speech via Kokoro TTS
  const payload = JSON.stringify({
    model: "kokoro",
    input: phrase.text,
    voice: "af_sky",
    speed: 1,
  });

  const res = await fetch(`${KOKORO_URL}/v1/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    throw new Error(`Kokoro returned ${res.status}: ${await res.text()}`);
  }

  const audioBuffer = Buffer.from(await res.arrayBuffer());
  writeFileSync(mp3Path, audioBuffer);

  // Convert to WAV (16kHz mono) — matches what the server expects after normalization
  execSync(
    `ffmpeg -y -i "${mp3Path}" -ar 16000 -ac 1 "${wavPath}"`,
    { stdio: "ignore", timeout: 10000 }
  );

  const stat = statSync(wavPath);
  // Estimate duration from WAV size: 16kHz * 16bit * mono = 32000 bytes/sec
  const durationS = Math.round((stat.size / 32000) * 10) / 10;

  return { path: wavPath, sizeKB: Math.round(stat.size / 1024), durationS };
}

async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  Murmur — Generate Test Audio                ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log();

  // Check Kokoro is running
  try {
    await fetch(KOKORO_URL, { signal: AbortSignal.timeout(3000) });
  } catch {
    console.error("  ✗ Kokoro TTS is not running at", KOKORO_URL);
    console.error("    Start it first, then re-run this script.");
    process.exit(1);
  }
  console.log("  ✓ Kokoro TTS is running");
  console.log();

  console.log("── Generating test audio ──");

  for (const phrase of PHRASES) {
    try {
      const result = await generateAudio(phrase);
      console.log(`  ✓ ${phrase.name}.wav (${result.sizeKB}KB, ${result.durationS}s) — "${phrase.text}"`);
    } catch (err) {
      console.error(`  ✗ ${phrase.name}.wav — ${(err as Error).message}`);
    }
  }

  // Generate silence
  try {
    const silencePath = join(AUDIO_DIR, "silence.wav");
    await generateSilence(silencePath);
    const stat = statSync(silencePath);
    console.log(`  ✓ silence.wav (${Math.round(stat.size / 1024)}KB, 2.0s) — [silence]`);
  } catch (err) {
    console.error(`  ✗ silence.wav — ${(err as Error).message}`);
  }

  // Generate noise
  try {
    const noisePath = join(AUDIO_DIR, "noise.wav");
    execSync(
      `ffmpeg -y -f lavfi -i "anoisesrc=d=2:c=pink:r=16000:a=0.3" -ac 1 "${noisePath}"`,
      { stdio: "ignore", timeout: 10000 }
    );
    const stat = statSync(noisePath);
    console.log(`  ✓ noise.wav (${Math.round(stat.size / 1024)}KB, 2.0s) — [pink noise]`);
  } catch (err) {
    console.error(`  ✗ noise.wav — ${(err as Error).message}`);
  }

  console.log();
  console.log("Done. Audio files saved to tests/test-audio/");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
