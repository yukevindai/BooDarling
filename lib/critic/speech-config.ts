/**
 * ElevenLabs configuration (server-side only).
 *
 * Every value is read lazily from `process.env` on each call, so tests and the
 * `generate-audio` CLI can set env vars after import. Nothing here ever logs
 * or returns the API key.
 */

export const DEFAULT_MODEL_ID = "eleven_multilingual_v2";
export const DEFAULT_OUTPUT_FORMAT = "mp3_44100_128";
/**
 * Per-attempt time-to-headers. Two attempts + the retry delay must fit inside the
 * browser's speech deadline (components/baroness/timeouts.ts: 2 * this + 3s).
 */
export const DEFAULT_TIMEOUT_MS = 6_000;

/** The route always responds with MP3, so only `mp3_*` output formats are accepted. */
export const SPEECH_CONTENT_TYPE = "audio/mpeg";

export type VoiceSettings = {
  stability: number;
  similarity_boost: number;
  style: number;
  use_speaker_boost: boolean;
};

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  stability: 0.4,
  similarity_boost: 0.8,
  style: 0.5,
  use_speaker_boost: true,
};

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function unitInterval(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

export function getApiKey(): string | undefined {
  return env("ELEVENLABS_API_KEY");
}

export function getVoiceId(): string | undefined {
  return env("ELEVENLABS_VOICE_ID");
}

export function getModelId(): string {
  return env("ELEVENLABS_MODEL_ID") ?? DEFAULT_MODEL_ID;
}

export function getOutputFormat(): string {
  return env("ELEVENLABS_OUTPUT_FORMAT") ?? DEFAULT_OUTPUT_FORMAT;
}

/** Time allowed to reach response headers (connect + first byte), per upstream attempt. */
export function getTimeoutMs(): number {
  const n = Number(env("SPEECH_TIMEOUT_MS"));
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_TIMEOUT_MS;
}

export function getVoiceSettings(): VoiceSettings {
  return {
    stability: unitInterval("ELEVENLABS_STABILITY", DEFAULT_VOICE_SETTINGS.stability),
    similarity_boost: unitInterval("ELEVENLABS_SIMILARITY", DEFAULT_VOICE_SETTINGS.similarity_boost),
    style: unitInterval("ELEVENLABS_STYLE", DEFAULT_VOICE_SETTINGS.style),
    use_speaker_boost: DEFAULT_VOICE_SETTINGS.use_speaker_boost,
  };
}

/** Operator-facing configuration problems (env var names only, never values). */
export function speechConfigProblems(): string[] {
  const problems: string[] = [];
  if (!getApiKey()) problems.push("ELEVENLABS_API_KEY is not set");
  if (!getVoiceId()) problems.push("ELEVENLABS_VOICE_ID is not set");
  if (!getOutputFormat().startsWith("mp3_")) {
    problems.push("ELEVENLABS_OUTPUT_FORMAT must be an mp3_* format (the route serves audio/mpeg)");
  }
  return problems;
}

export function isSpeechConfigured(): boolean {
  return speechConfigProblems().length === 0;
}
