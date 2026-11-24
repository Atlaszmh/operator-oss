import fs from "node:fs";
import path from "node:path";
import { DB_DIR } from "./config";

/**
 * "I have an API key instead" path for the Gemini agent — the Gemini mirror of
 * lib/anthropic-key.ts and lib/openai-key.ts. Most instances connect Gemini via
 * the user's own Google account subscription (lib/agents/gemini/auth.ts, with
 * billing.overageStrategy="always" so Google One AI Credits apply automatically),
 * but a user can choose to bill per-token with a Gemini API key instead.
 * Persisted to a 0600 file on the volume — NOT the settings table — and mirrored
 * into process.env so `gemini` children inherit it. loadPersistedGeminiKey()
 * re-applies it on boot after entrypoints strip GEMINI_API_KEY / GOOGLE_API_KEY
 * from the launch environment.
 */
const KEY_PATH = path.join(DB_DIR, "gemini-api-key");

export function hasGeminiKey(): boolean {
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return true;
  try {
    return fs.statSync(KEY_PATH).size > 0;
  } catch {
    return false;
  }
}

/** Loose shape check — Google AI Studio / Gemini API keys start with AIza, or >=20 chars. */
export function looksLikeGeminiKey(key: string): boolean {
  return /^(AIza[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{24,})$/.test(key.trim());
}

export function setGeminiKey(key: string): void {
  const k = key.trim();
  fs.mkdirSync(DB_DIR, { recursive: true });
  fs.writeFileSync(KEY_PATH, k, { mode: 0o600 });
  try {
    fs.chmodSync(KEY_PATH, 0o600);
  } catch {}
  process.env.GEMINI_API_KEY = k;
}

export function clearGeminiKey(): void {
  try {
    fs.rmSync(KEY_PATH, { force: true });
  } catch {}
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
}

/** Called once at DB init: re-apply a persisted key to this process's env. */
export function loadPersistedGeminiKey(): void {
  try {
    const k = fs.readFileSync(KEY_PATH, "utf8").trim();
    if (k) process.env.GEMINI_API_KEY = k;
  } catch {
    /* no persisted key — Google subscription login (or nothing yet) */
  }
}
