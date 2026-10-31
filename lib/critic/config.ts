/**
 * Server-only critic configuration. Every value is read lazily from
 * `process.env` so tests (and a dev server restart-free `.env.local` edit)
 * see the current value. Never import this from client components.
 */
import path from "node:path";

export type CriticProviderId = "gemini" | "ollama" | "mock";

const PROVIDER_IDS: ReadonlyArray<CriticProviderId> = ["gemini", "ollama", "mock"];

function env(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

/** `CRITIC_PROVIDER`: "gemini" (default) | "ollama" | "mock". Unknown values fall back to "gemini". */
export function criticProviderId(): CriticProviderId {
  const raw = env("CRITIC_PROVIDER")?.toLowerCase();
  return PROVIDER_IDS.find((p) => p === raw) ?? "gemini";
}

/** Raw `CRITIC_PROVIDER` when it is set but unrecognised (for readiness problems). */
export function unknownCriticProvider(): string | undefined {
  const raw = env("CRITIC_PROVIDER");
  if (!raw) return undefined;
  return PROVIDER_IDS.includes(raw.toLowerCase() as CriticProviderId) ? undefined : raw;
}

export function geminiApiKey(): string | undefined {
  return env("GEMINI_API_KEY");
}

export function geminiModel(): string {
  return env("GEMINI_MODEL") ?? "gemini-flash-latest";
}

/**
 * Models tried in order when the primary model is overloaded (429/5xx) or no longer
 * exists (404). Comma-separated GEMINI_FALLBACK_MODELS overrides; "none" disables.
 */
export function geminiFallbackModels(): string[] {
  const raw = env("GEMINI_FALLBACK_MODELS") ?? "gemini-flash-lite-latest,gemini-2.5-flash";
  if (raw.trim().toLowerCase() === "none") return [];
  return raw.split(",").map((m) => m.trim()).filter(Boolean);
}

export function ollamaBaseUrl(): string {
  return (env("OLLAMA_BASE_URL") ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
}

export function ollamaModel(): string {
  return env("OLLAMA_MODEL") ?? "qwen3-vl:4b";
}

/** Total time budget for one critique (including the single retry). */
export function criticTimeoutMs(): number {
  const n = Number(env("CRITIC_TIMEOUT_MS"));
  return Number.isFinite(n) && n >= 500 && n <= 120_000 ? Math.round(n) : 8000;
}

/** Absolute project root used to resolve manifest and reference paths. */
export function projectRoot(): string {
  return path.resolve(env("REFLECT_PROJECT_ROOT") ?? process.cwd());
}

export function referencesManifestPath(): string {
  const p = env("REFERENCES_MANIFEST_PATH");
  if (!p) return path.join(projectRoot(), "references", "manifest.json");
  return path.isAbsolute(p) ? p : path.resolve(projectRoot(), p);
}
