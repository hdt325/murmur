/**
 * Generate test audio files using Kokoro TTS for pipeline integration tests.
 *
 * Produces WAV files in tests/test-audio/ that simulate real user speech.
 * ⚠️  MUST be run in the `test-runner` tmux session — NOT inside the claude-voice session.
 * Run once before test-tts-pipeline.ts (in test-runner):
 *   node --import tsx/esm tests/generate-test-audio.ts
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
  {
    name: "short",
    // ~5 seconds of natural speech
    text: "Hey Claude, can you help me understand how async await works in JavaScript? I keep getting confused about error handling.",
  },
  {
    name: "medium",
    // ~15 seconds of natural speech
    text: "I'm working on a project that uses WebSockets for real-time communication between a Node.js server and a browser client. The problem I'm running into is that when the connection drops and reconnects, some messages get lost during the gap. I've tried adding a message queue but I'm not sure if that's the right approach. What would you recommend for reliable message delivery over WebSockets?",
  },
  {
    name: "long",
    // ~30 seconds of natural speech
    text: "Let me explain what I'm trying to build. It's a voice interface for a coding assistant. The user speaks into their microphone, the audio gets sent to a speech-to-text service, the transcribed text goes to an AI model, the response comes back, and then text-to-speech converts it to audio that plays back to the user. The tricky part is handling all the state transitions. You've got idle, recording, transcribing, thinking, responding, and speaking states, and they need to flow smoothly without any gaps or overlaps. Sometimes the user wants to interrupt while the AI is still speaking, and sometimes the AI's response triggers a follow-up TTS chunk while the first one is still playing. How would you architect the state machine for this kind of real-time voice pipeline?",
  },
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

  // Generate silence (10 seconds — simulates user holding mic open without speaking)
  try {
    const silencePath = join(AUDIO_DIR, "silence.wav");
    await generateSilence(silencePath, 10);
    const stat = statSync(silencePath);
    console.log(`  ✓ silence.wav (${Math.round(stat.size / 1024)}KB, 10s) — [silence]`);
  } catch (err) {
    console.error(`  ✗ silence.wav — ${(err as Error).message}`);
  }

  // Generate noise (10 seconds of pink noise — simulates noisy environment)
  try {
    const noisePath = join(AUDIO_DIR, "noise.wav");
    execSync(
      `ffmpeg -y -f lavfi -i "anoisesrc=d=10:c=pink:r=16000:a=0.3" -ac 1 "${noisePath}"`,
      { stdio: "ignore", timeout: 10000 }
    );
    const stat = statSync(noisePath);
    console.log(`  ✓ noise.wav (${Math.round(stat.size / 1024)}KB, 10s) — [pink noise]`);
  } catch (err) {
    console.error(`  ✗ noise.wav — ${(err as Error).message}`);
  }

  // Generate speech-with-pauses — speech, 3s silence, more speech (tests silence detection mid-utterance)
  try {
    const pausedPath = join(AUDIO_DIR, "speech-with-pauses.wav");
    const part1 = join(AUDIO_DIR, "_pause_part1.mp3");
    const part2 = join(AUDIO_DIR, "_pause_part2.mp3");
    const silGap = join(AUDIO_DIR, "_pause_gap.wav");

    // Generate two speech segments
    for (const [outFile, text] of [
      [part1, "Hey Claude, I have a question."],
      [part2, "Actually wait, let me think about how to phrase this. Okay, can you explain recursion?"],
    ] as const) {
      const res = await fetch(`${KOKORO_URL}/v1/audio/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "kokoro", input: text, voice: "af_sky", speed: 1 }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`Kokoro ${res.status}`);
      writeFileSync(outFile, Buffer.from(await res.arrayBuffer()));
    }
    // 3-second silence gap
    execSync(`ffmpeg -y -f lavfi -i anullsrc=r=16000:cl=mono -t 3 "${silGap}"`, { stdio: "ignore", timeout: 5000 });

    // Concatenate: part1 + silence + part2
    execSync(
      `ffmpeg -y -i "${part1}" -i "${silGap}" -i "${part2}" ` +
      `-filter_complex "[0:a]aresample=16000,aformat=sample_fmts=fltp:channel_layouts=mono[a0];` +
      `[1:a][a0]concat=n=2:v=0:a=1[gap];` +
      `[2:a]aresample=16000,aformat=sample_fmts=fltp:channel_layouts=mono[a2];` +
      `[gap][a2]concat=n=2:v=0:a=1[out]" -map "[out]" "${pausedPath}"`,
      { stdio: "ignore", timeout: 15000 }
    );
    // Cleanup temp files
    for (const f of [part1, part2, silGap]) try { execSync(`rm "${f}"`, { stdio: "ignore" }); } catch {}

    const stat = statSync(pausedPath);
    const dur = Math.round((stat.size / 32000) * 10) / 10;
    console.log(`  ✓ speech-with-pauses.wav (${Math.round(stat.size / 1024)}KB, ${dur}s) — [speech + 3s gap + speech]`);
  } catch (err) {
    console.error(`  ✗ speech-with-pauses.wav — ${(err as Error).message}`);
  }

  // Generate quiet speech (low volume — tests loudnorm normalization)
  try {
    const quietPath = join(AUDIO_DIR, "quiet.wav");
    const tmpMp3 = join(AUDIO_DIR, "_quiet_tmp.mp3");
    const res = await fetch(`${KOKORO_URL}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "kokoro",
        input: "This is a quiet message spoken at a low volume, testing whether the audio normalization can boost it enough for transcription.",
        voice: "af_sky", speed: 1,
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`Kokoro ${res.status}`);
    writeFileSync(tmpMp3, Buffer.from(await res.arrayBuffer()));
    // Reduce volume by 20dB to simulate quiet speech
    execSync(
      `ffmpeg -y -i "${tmpMp3}" -af "volume=-20dB" -ar 16000 -ac 1 "${quietPath}"`,
      { stdio: "ignore", timeout: 10000 }
    );
    try { execSync(`rm "${tmpMp3}"`, { stdio: "ignore" }); } catch {}
    const stat = statSync(quietPath);
    const dur = Math.round((stat.size / 32000) * 10) / 10;
    console.log(`  ✓ quiet.wav (${Math.round(stat.size / 1024)}KB, ${dur}s) — [speech at -20dB]`);
  } catch (err) {
    console.error(`  ✗ quiet.wav — ${(err as Error).message}`);
  }

  console.log();
  console.log("Done. Audio files saved to tests/test-audio/");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
