/**
 * Thin ElevenLabs text-to-speech client (built-in fetch only, server-side only).
 *
 * - `openSpeechStream` returns the upstream streaming `Response` (audio/mpeg).
 * - `synthesize` accumulates the whole clip into bytes.
 * - `elevenLabsReadiness` is a cheap, non-throwing check for the operator panel.
 *
 * Upstream failures are mapped to `ElevenLabsError` with a `retryable` flag
 * (429 / 5xx / network / timeout are retryable; 4xx auth/validation are not).
 */
import type { BaronessReadiness } from "./types";
import {
  getApiKey,
  getModelId,
  getOutputFormat,
  getTimeoutMs,
  getVoiceId,
  getVoiceSettings,
  speechConfigProblems,
} from "./speech-config";

const API_BASE = "https://api.elevenlabs.io";

export type ElevenLabsErrorCode =
  | "not_configured"
  | "auth"
  | "voice_not_found"
  | "invalid_request"
  | "rate_limited"
  | "upstream"
  | "network"
  | "timeout"
  | "aborted"
  | "empty_response";

export class ElevenLabsError extends Error {
  readonly code: ElevenLabsErrorCode;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(code: ElevenLabsErrorCode, message: string, opts: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = "ElevenLabsError";
    this.code = code;
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
  }
}

/** Pull a short human-readable reason out of an ElevenLabs error body. */
function extractDetail(text: string): string {
  if (!text) return "";
  try {
    const json = JSON.parse(text) as { detail?: unknown };
    const d = json?.detail;
    if (typeof d === "string") return d.slice(0, 200);
    if (Array.isArray(d)) {
      const msgs = d.map((x) => (x && typeof x === "object" && "msg" in x ? String((x as { msg: unknown }).msg) : ""));
      return msgs.filter(Boolean).join("; ").slice(0, 200);
    }
    if (d && typeof d === "object" && "message" in d) return String((d as { message: unknown }).message).slice(0, 200);
  } catch {
    // not JSON
  }
  return text.slice(0, 120);
}

export function errorFromStatus(status: number, detail = ""): ElevenLabsError {
  const suffix = detail ? `: ${detail}` : "";
  if (status === 401 || status === 403) {
    return new ElevenLabsError("auth", `ElevenLabs rejected the credentials (HTTP ${status})${suffix}`, { status });
  }
  if (status === 404) {
    return new ElevenLabsError("voice_not_found", `ElevenLabs voice not found (HTTP 404)${suffix}`, { status });
  }
  if (status === 429) {
    return new ElevenLabsError("rate_limited", `ElevenLabs rate or concurrency limit (HTTP 429)${suffix}`, {
      status,
      retryable: true,
    });
  }
  if (status >= 500) {
    return new ElevenLabsError("upstream", `ElevenLabs server error (HTTP ${status})${suffix}`, {
      status,
      retryable: true,
    });
  }
  return new ElevenLabsError("invalid_request", `ElevenLabs rejected the request (HTTP ${status})${suffix}`, { status });
}

/** Normalise anything thrown while talking to ElevenLabs into an `ElevenLabsError`. */
export function toElevenLabsError(err: unknown, signal?: AbortSignal): ElevenLabsError {
  if (err instanceof ElevenLabsError) return err;
  if (signal?.aborted) return new ElevenLabsError("aborted", "Speech request aborted");
  const message = err instanceof Error ? err.message : String(err);
  return new ElevenLabsError("network", `Could not reach ElevenLabs: ${message}`, { retryable: true });
}

/**
 * fetch with (a) a time-to-headers timeout and (b) the caller's abort signal
 * linked to the upstream request. The link stays in place after headers arrive,
 * so aborting the caller also cancels an in-flight body stream.
 */
async function request(url: string, init: RequestInit, outer?: AbortSignal): Promise<Response> {
  if (outer?.aborted) throw new ElevenLabsError("aborted", "Speech request aborted");
  const ctrl = new AbortController();
  let timedOut = false;
  outer?.addEventListener("abort", () => ctrl.abort(outer.reason), { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, getTimeoutMs());
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, cache: "no-store" });
  } catch (cause) {
    if (outer?.aborted) throw new ElevenLabsError("aborted", "Speech request aborted");
    if (timedOut) {
      throw new ElevenLabsError("timeout", `ElevenLabs did not respond within ${getTimeoutMs()}ms`, { retryable: true });
    }
    throw toElevenLabsError(cause);
  } finally {
    clearTimeout(timer);
  }
}

async function errorFromResponse(res: Response): Promise<ElevenLabsError> {
  let text = "";
  try {
    text = await res.text();
  } catch {
    // ignore body read failures; status is what matters
  }
  return errorFromStatus(res.status, extractDetail(text));
}

function requireConfig(): { apiKey: string; voiceId: string } {
  const problems = speechConfigProblems();
  const apiKey = getApiKey();
  const voiceId = getVoiceId();
  if (problems.length > 0 || !apiKey || !voiceId) {
    throw new ElevenLabsError("not_configured", problems.join("; ") || "ElevenLabs is not configured");
  }
  return { apiKey, voiceId };
}

/**
 * POST the text to ElevenLabs and return the (streaming) upstream response.
 * Throws `ElevenLabsError` on any failure, including non-2xx statuses.
 */
export async function openSpeechStream(text: string, opts: { signal?: AbortSignal } = {}): Promise<Response> {
  const { apiKey, voiceId } = requireConfig();
  const url = `${API_BASE}/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=${encodeURIComponent(
    getOutputFormat(),
  )}`;
  const res = await request(
    url,
    {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: getModelId(), voice_settings: getVoiceSettings() }),
    },
    opts.signal,
  );
  if (!res.ok) throw await errorFromResponse(res);
  if (!res.body) throw new ElevenLabsError("empty_response", "ElevenLabs returned no audio body", { retryable: true });
  return res;
}

/** Non-streaming convenience: the full MP3 clip as bytes. */
export async function synthesize(text: string, opts: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
  const res = await openSpeechStream(text, opts);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    throw toElevenLabsError(err, opts.signal);
  }
  if (bytes.length === 0) {
    throw new ElevenLabsError("empty_response", "ElevenLabs returned an empty clip", { retryable: true });
  }
  return bytes;
}

/** Cheap readiness probe (voice lookup spends no credits). Never throws; never exposes the key. */
export async function elevenLabsReadiness(): Promise<BaronessReadiness> {
  const voiceId = getVoiceId();
  const detail: BaronessReadiness["detail"] = {
    voiceId: voiceId ?? "",
    modelId: getModelId(),
    outputFormat: getOutputFormat(),
    /** Per-attempt upstream timeout; the browser sizes its own deadline from it. */
    timeoutMs: getTimeoutMs(),
  };
  const problems = speechConfigProblems();
  const apiKey = getApiKey();
  if (!apiKey || !voiceId) return { ready: false, provider: "elevenlabs", detail, problems };

  try {
    const res = await request(`${API_BASE}/v1/voices/${encodeURIComponent(voiceId)}`, {
      method: "GET",
      headers: { "xi-api-key": apiKey },
    });
    if (res.ok) {
      try {
        const json = (await res.json()) as { name?: unknown };
        if (typeof json?.name === "string") detail.voiceName = json.name;
      } catch {
        // voice name is optional
      }
    } else if (res.status === 401 || res.status === 403) {
      // A TTS-only key (no voices_read permission) also gets 401 here, so this
      // does not prove the key is bad.
      problems.push(
        `Could not verify voice (key invalid or missing voices_read permission) — use Test audio to confirm (HTTP ${res.status})`,
      );
    } else {
      problems.push(`Voice not accessible (HTTP ${res.status})`);
    }
  } catch (err) {
    problems.push(toElevenLabsError(err).message);
  }
  return { ready: problems.length === 0, provider: "elevenlabs", detail, problems };
}
