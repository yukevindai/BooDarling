/**
 * Critique orchestrator for `POST /api/critique` (server-side only).
 *
 * Contract (spec §5, §8): `{ capture, result }` → `{ sessionId, text, source }`.
 *  - The score is never computed, changed or echoed here.
 *  - The reference image is resolved server-side from the manifest.
 *  - Any critic failure, timeout, unknown reference or unsafe text → a preset
 *    line with no image-specific claims (`source: "preset"`), still HTTP 200.
 *  - One automatic retry for transient errors while the request is alive and
 *    enough of the time budget remains.
 */
import type { Capture, RateResult } from "@/lib/types";
import { PROMPT_VERSION } from "../baroness-prompt";
import { critiqueCache, critiqueCacheKey, type LruCache } from "./cache";
import { criticTimeoutMs, projectRoot } from "./config";
import { loadReferenceImage as defaultLoadReferenceImage, parseImageDataUrl } from "./images";
import { ANNOUNCEMENT_LINES, pickPresetCritique } from "./lines";
import { resolveReference as defaultResolveReference, type ResolvedReference } from "./manifest";
import { getCriticProvider } from "./providers";
import { isAbortError, isTransientError } from "./providers/errors";
import { sanitizeCritiqueDetailed } from "./sanitize";
import { isValidSessionId, SESSION_ID_MAX_CHARS, sessionIdErrorMessage } from "./session-id";
import type { CriticImage, CriticInput, CriticProvider, CritiqueResponse } from "./types";

/** Raw request body limit for the route (1 MB JPEG as base64 ≈ 1.34 MB + JSON). */
export const CRITIQUE_MAX_BODY_BYTES = 1_600_000;
export { SESSION_ID_MAX_CHARS };
/** Only retry if at least this much of the time budget is left. */
export const RETRY_MIN_BUDGET_MS = 2500;

export type CritiqueOutcome =
  | { status: 200; body: CritiqueResponse }
  | { status: 400; body: { error: string } };

export type CreateCritiqueOptions = {
  /** Request signal: when aborted (visitor left), return quickly; the route discards the response. */
  signal?: AbortSignal;
  /** Override the provider (tests); defaults to `getCriticProvider()`. */
  provider?: CriticProvider;
  /** Total model budget including the one retry; defaults to CRITIC_TIMEOUT_MS. */
  timeoutMs?: number;
  retryMinBudgetMs?: number;
  now?: () => number;
  /** `null` disables caching; defaults to the process-wide cache. */
  cache?: LruCache<string> | null;
  resolveReference?: (referenceId: string, lookId?: string) => Promise<ResolvedReference | null>;
  loadReferenceImage?: (absPath: string, root: string) => Promise<CriticImage>;
  /** Log sink (one line per request); defaults to console.info. */
  log?: (line: string) => void;
};

type ValidOk = {
  kind: "ok";
  sessionId: string;
  outfitImage: string;
  userImage: CriticImage;
  aura: number;
  lookId: string;
  referenceId: string;
  modelVersion: string;
  referenceVersion: string;
  calibrationVersion: string;
};
type ValidUnavailable = { kind: "unavailable"; sessionId: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function nonEmptyString(v: unknown, max: number): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= max && !CONTROL_CHARS.test(v);
}

/** Validate a `CritiqueRequest` body. Exported for tests and the route. */
export function validateCritiqueRequest(body: unknown): { ok: true; value: ValidOk | ValidUnavailable } | { ok: false; error: string } {
  if (!isObj(body)) return { ok: false, error: "Body must be a JSON object with capture and result" };
  const capture = body.capture as Partial<Capture> | undefined;
  const result = body.result as Partial<RateResult> | undefined;
  if (!isObj(capture)) return { ok: false, error: "capture is required" };
  if (!isObj(result)) return { ok: false, error: "result is required" };

  const sessionId = capture.sessionId;
  // Same rule as /api/speech (header-safe), so every accepted session can be spoken.
  if (!isValidSessionId(sessionId)) return { ok: false, error: sessionIdErrorMessage("capture.sessionId") };
  if (result.sessionId !== sessionId) return { ok: false, error: "result.sessionId does not match capture.sessionId" };
  if (typeof capture.outfitImage !== "string") return { ok: false, error: "capture.outfitImage must be a data URL string" };

  if (result.status === "unavailable") return { ok: true, value: { kind: "unavailable", sessionId } };
  if (result.status !== "ok") return { ok: false, error: 'result.status must be "ok" or "unavailable"' };

  const r = result as Partial<Extract<RateResult, { status: "ok" }>>;
  if (typeof r.aura !== "number" || !Number.isFinite(r.aura) || r.aura < 0 || r.aura > 100) {
    return { ok: false, error: "result.aura must be a number from 0 to 100" };
  }
  if (!nonEmptyString(r.referenceId, 128)) return { ok: false, error: "result.referenceId is required" };
  if (!nonEmptyString(r.lookId, 128)) return { ok: false, error: "result.lookId is required" };
  for (const k of ["modelVersion", "referenceVersion", "calibrationVersion"] as const) {
    if (r[k] !== undefined && (typeof r[k] !== "string" || r[k].length > 128)) {
      return { ok: false, error: `result.${k} must be a string` };
    }
  }

  const img = parseImageDataUrl(capture.outfitImage);
  if (!img.ok) return { ok: false, error: `capture.${img.error}` };

  return {
    ok: true,
    value: {
      kind: "ok",
      sessionId,
      outfitImage: capture.outfitImage,
      userImage: img.image,
      aura: r.aura,
      lookId: r.lookId,
      referenceId: r.referenceId,
      modelVersion: r.modelVersion ?? "",
      referenceVersion: r.referenceVersion ?? "",
      calibrationVersion: r.calibrationVersion ?? "",
    },
  };
}

/** Resolve when `promise` settles or reject as soon as `signal` aborts (guards providers that ignore it). */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

function shortErr(err: unknown): string {
  if (isAbortError(err)) return (err as Error).name === "TimeoutError" ? "timeout" : "aborted";
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\s+/g, " ").slice(0, 120);
}

/**
 * Produce the Baroness critique for one assessment. Never throws for runtime
 * failures: bad input → 400, everything else → 200 with model or preset text.
 */
export async function createCritique(body: unknown, opts: CreateCritiqueOptions = {}): Promise<CritiqueOutcome> {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((line: string) => console.info(line));
  const started = now();

  const v = validateCritiqueRequest(body);
  if (!v.ok) return { status: 400, body: { error: v.error } };
  const req = v.value;

  if (req.kind === "unavailable") {
    log(`[critique] session=${req.sessionId.slice(0, 12)} result=unavailable source=preset ms=${now() - started}`);
    return { status: 200, body: { sessionId: req.sessionId, text: ANNOUNCEMENT_LINES.unavailable.text, source: "preset" } };
  }

  const requestSignal = opts.signal ?? new AbortController().signal;
  const provider = opts.provider ?? getCriticProvider();
  const budgetMs = opts.timeoutMs ?? criticTimeoutMs();
  const retryMinBudgetMs = opts.retryMinBudgetMs ?? RETRY_MIN_BUDGET_MS;
  const cache = opts.cache === undefined ? critiqueCache : opts.cache;
  const deadline = started + budgetMs;
  let attempts = 0;

  const finish = (text: string, source: "model" | "preset", reason?: string): CritiqueOutcome => {
    log(
      `[critique] session=${req.sessionId.slice(0, 12)} provider=${provider.id} model=${provider.model} ` +
        `source=${source}${reason ? ` reason=${reason}` : ""} attempts=${attempts} ms=${now() - started}`,
    );
    return { status: 200, body: { sessionId: req.sessionId, text, source } };
  };
  const preset = (reason: string) => finish(pickPresetCritique(req.aura, req.sessionId).text, "preset", reason);

  if (requestSignal.aborted) return preset("client-aborted");

  // Reference image is resolved server-side only.
  const ref = await (opts.resolveReference ?? defaultResolveReference)(req.referenceId, req.lookId);
  if (!ref) return preset("unknown-reference");
  let referenceImage: CriticImage;
  try {
    referenceImage = await (opts.loadReferenceImage ?? defaultLoadReferenceImage)(ref.imagePath, projectRoot());
  } catch (err) {
    return preset(`reference-image: ${shortErr(err)}`);
  }

  const cacheKey = critiqueCacheKey({
    outfitImage: req.outfitImage,
    referenceId: req.referenceId,
    referenceImage: `${referenceImage.mimeType};${referenceImage.base64}`,
    lookId: req.lookId,
    lookLabel: ref.lookLabel,
    lookDescription: ref.lookDescription ?? "",
    aura: req.aura,
    modelVersion: req.modelVersion,
    referenceVersion: req.referenceVersion,
    calibrationVersion: req.calibrationVersion,
    providerId: provider.id,
    providerModel: provider.model,
    promptVersion: PROMPT_VERSION,
  });
  const cached = cache?.get(cacheKey);
  if (cached) return finish(cached, "model", "cache-hit");

  const input: CriticInput = {
    userImage: req.userImage,
    referenceImage,
    aura: req.aura,
    lookId: ref.lookId,
    lookLabel: ref.lookLabel,
    lookDescription: ref.lookDescription,
  };

  while (attempts < 2) {
    const remaining = deadline - now();
    if (remaining <= 0) return preset("timeout");
    if (requestSignal.aborted) return preset("client-aborted");
    attempts++;
    // Explicit (ref'd, always cleared) timer rather than AbortSignal.timeout, whose
    // unref'd timer cannot by itself keep a hung provider call from stalling.
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new DOMException("Critic timed out", "TimeoutError")),
      remaining,
    );
    const signal = AbortSignal.any([requestSignal, timeout.signal]);
    try {
      const raw = await raceAbort(provider.critique(input, signal), signal);
      const clean = sanitizeCritiqueDetailed(raw, { aura: req.aura });
      if (clean.text === null) return preset(`sanitize:${clean.reason}`);
      cache?.set(cacheKey, clean.text);
      return finish(clean.text, "model");
    } catch (err) {
      if (requestSignal.aborted) return preset("client-aborted");
      const left = deadline - now();
      if (attempts < 2 && isTransientError(err) && left > retryMinBudgetMs) continue;
      return preset(`error: ${shortErr(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return preset("exhausted");
}
