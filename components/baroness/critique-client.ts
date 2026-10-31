/**
 * Browser client for `POST /api/critique`.
 *
 * `requestCritique` never rejects because of network errors, timeouts, bad
 * responses or 4xx/5xx: it falls back to a client-side preset (the score is never
 * touched). The ONLY rejection is `CritiqueDiscardedError` (name "AbortError"),
 * thrown when the caller's signal aborted or the response belongs to another
 * session; callers should silently discard those.
 */
import { ANNOUNCEMENT_LINES, pickPresetCritique } from "@/lib/critic/lines";
import type { Capture, CritiqueResponse, CritiqueRequest, RateResult } from "@/lib/critic/types";
import { critiqueClientTimeoutMs, DEFAULT_CRITIQUE_CLIENT_TIMEOUT_MS } from "./timeouts";

/** Floor for the client deadline; the effective default follows the server (see timeouts.ts). */
export const DEFAULT_CRITIQUE_TIMEOUT_MS = DEFAULT_CRITIQUE_CLIENT_TIMEOUT_MS;

export type RequestCritiqueOptions = {
  /** Caller cancellation (e.g. visitor departed). Aborting rejects with CritiqueDiscardedError. */
  signal?: AbortSignal;
  /**
   * Client-side deadline before falling back to a preset.
   * Default: max(12000, server CRITIC_TIMEOUT_MS + 3000) once configured (see timeouts.ts).
   */
  timeoutMs?: number;
};

export class CritiqueDiscardedError extends Error {
  readonly reason: "aborted" | "stale";
  constructor(reason: "aborted" | "stale") {
    super(reason === "aborted" ? "Critique request aborted" : "Critique response belongs to another session");
    this.name = "AbortError";
    this.reason = reason;
  }
}

export function isCritiqueDiscarded(e: unknown): e is CritiqueDiscardedError {
  return e instanceof CritiqueDiscardedError;
}

/** Client-side preset critique: no image-specific claims, score untouched. */
export function fallbackCritique(capture: Capture, result: RateResult): CritiqueResponse {
  const text =
    result.status === "ok"
      ? pickPresetCritique(result.aura, capture.sessionId).text
      : ANNOUNCEMENT_LINES.unavailable.text;
  return { sessionId: capture.sessionId, text, source: "preset" };
}

function parseResponse(value: unknown): CritiqueResponse | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.sessionId !== "string" || v.sessionId.length === 0) return null;
  if (typeof v.text !== "string" || v.text.trim().length === 0) return null;
  if (v.source !== "model" && v.source !== "preset") return null;
  return { sessionId: v.sessionId, text: v.text.trim(), source: v.source };
}

export async function requestCritique(
  capture: Capture,
  result: RateResult,
  { signal, timeoutMs = critiqueClientTimeoutMs() }: RequestCritiqueOptions = {},
): Promise<CritiqueResponse> {
  if (signal?.aborted) throw new CritiqueDiscardedError("aborted");

  const ctrl = new AbortController();
  const onCallerAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onCallerAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const body: CritiqueRequest = { capture, result };
    let parsed: CritiqueResponse | null = null;
    try {
      const res = await globalThis.fetch("/api/critique", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (res.ok) parsed = parseResponse(await res.json());
    } catch {
      // network error, timeout abort, or malformed JSON: handled below
    }

    // A caller abort always wins over any fallback.
    if (signal?.aborted) throw new CritiqueDiscardedError("aborted");

    if (parsed) {
      if (parsed.sessionId !== capture.sessionId) throw new CritiqueDiscardedError("stale");
      return parsed;
    }
    return fallbackCritique(capture, result);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCallerAbort);
  }
}
