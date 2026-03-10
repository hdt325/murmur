/**
 * Persistent settings management.
 * Atomic file writes (tmp -> rename) prevent corruption on crash.
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from "fs";
import { join } from "path";
import type { PanelSettings } from "./types.js";

const SIGNAL_DIR = process.platform === "darwin" ? "/tmp" : join(process.env.TEMP || "/tmp", "murmur");

export function loadSettings(settingsFile: string): PanelSettings {
  try {
    if (existsSync(settingsFile)) {
      return JSON.parse(readFileSync(settingsFile, "utf-8"));
    }
  } catch (err) {
    console.error("Settings file corrupted, backing up and resetting:", (err as Error).message);
    try {
      renameSync(settingsFile, settingsFile + ".backup");
    } catch {}
  }
  return {};
}

export function saveSettings(settingsFile: string, updates: Partial<PanelSettings>) {
  const current = loadSettings(settingsFile);
  const merged = { ...current, ...updates };
  const tmpFile = settingsFile + ".tmp";
  try {
    writeFileSync(tmpFile, JSON.stringify(merged, null, 2));
    renameSync(tmpFile, settingsFile);
  } catch (err) {
    // BUG-110 fix: Log AND re-throw so callers know save failed
    console.error("Failed to save settings:", (err as Error).message);
    throw err;
  }
}

export function initSignalFiles(settingsFile: string, signalDir: string = SIGNAL_DIR) {
  const settings = loadSettings(settingsFile);
  if (settings.voice) {
    writeFileSync(join(signalDir, "claude-tts-voice"), settings.voice);
    console.log(`  Restored voice: ${settings.voice}`);
  }
  if (settings.speed) {
    writeFileSync(join(signalDir, "claude-tts-speed"), settings.speed.toString());
    console.log(`  Restored speed: ${settings.speed}`);
  }
}
