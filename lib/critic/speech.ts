/**
 * Speech helpers for `POST /api/speech`: text normalisation, request
 * validation, an in-memory audio cache and the cache-or-stream orchestrator.
 */
import { createHash } from "node:crypto";
import { openSpeechStream, ElevenLabsError, toElevenLabsError } from "./elevenlabs";
import { getModelId, getOutputFormat, getVoiceId, SPEECH_CONTENT_TYPE, speechConfigProblems } from "./speech-config";
import { isValidSessionId, SESSION_ID_MAX_CHARS, sessionIdErrorMessage } from "./session-id";
import { SPEECH_MAX_CHARS } from "./types";

/* ------------------------------------------------------------------ */
/* Text normalisation + request validation                             */
/* ------------------------------------------------------------------ */

/** Raw input above this is rejected outright (413) instead of being normalised. */
export const SPEECH_RAW_MAX_CHARS = 20_000;
export { SESSION_ID_MAX_CHARS };

const SENTENCE_END = /[.!?…]+["'”’)\]]*(?=\s)/g;

/**
 * Trim, collapse whitespace, strip markdown / emoji-ish symbols, and cap at
 * `maxChars` (default 500) — preferring the last sentence end, then the last
 * word boundary. Returns "" when nothing speakable remains.
 */
export function normalizeSpeechText(input: string, maxChars: number = SPEECH_MAX_CHARS): string {
  let s = String(input ?? "");
  s = s
    .replace(/```[\s\S]*?```/g, " ") // fenced code
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links -> label
    .replace(/<[^>\n]+>/g, " ") // html tags
    .replace(/^[ \t]*(?:#{1,6}|>|[-*+])[ \t]+/gm, "") // heading / quote / bullet markers
    .replace(/[*_~`|^\\]+/g, "") // emphasis & code markers
    .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}‍︎️⃣]/gu, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ") // control / format chars (incl. zero-width)
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();

  if (s.length <= maxChars) return s;

  const window = s.slice(0, maxChars + 1);
  let cut = -1;
  for (const m of window.matchAll(SENTENCE_END)) {
    const end = (m.index ?? 0) + m[0].length;
    if (end <= maxChars) cut = end;
  }
  if (cut <= 0) {
    const space = window.lastIndexOf(" ");
    cut = space > 0 ? space : maxChars;
  }
  let out = s.slice(0, cut);
  // never split a surrogate pair on a hard cut
  if (/[\ud800-\udbff]$/.test(out)) out = out.slice(0, -1);
  return out.replace(/[\s,;:—-]+$/, "").trim();
}

export type SpeechValidation =
  | { ok: true; sessionId: string; text: string }
  | { ok: false; status: number; error: string };

export function validateSpeechRequest(body: unknown): SpeechValidation {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, error: "Request body must be a JSON object { sessionId, text }" };
  }
  const { sessionId, text } = body as Record<string, unknown>;
  // Same rule as /api/critique; also guarantees a valid X-Session-Id header value.
  if (!isValidSessionId(sessionId)) return { ok: false, status: 400, error: sessionIdErrorMessage() };
  if (typeof text !== "string") {
    return { ok: false, status: 400, error: "text must be a string" };
  }
  if (text.length > SPEECH_RAW_MAX_CHARS) {
    return { ok: false, status: 413, error: `text must be at most ${SPEECH_RAW_MAX_CHARS} characters` };
  }
  const normalized = normalizeSpeechText(text);
  if (!normalized) return { ok: false, status: 400, error: "text is empty after normalisation" };
  return { ok: true, sessionId: sessionId.trim(), text: normalized };
}

/* ------------------------------------------------------------------ */
/* In-memory audio cache (LRU, entry + byte budget)                    */
/* ------------------------------------------------------------------ */

export const AUDIO_CACHE_MAX_ENTRIES = 50;
export const AUDIO_CACHE_MAX_BYTES = 20 * 1024 * 1024;

export class AudioCache {
  private readonly map = new Map<string, Uint8Array>();
  private totalBytes = 0;

  constructor(
    readonly maxEntries: number = AUDIO_CACHE_MAX_ENTRIES,
    readonly maxBytes: number = AUDIO_CACHE_MAX_BYTES,
  ) {}

  get size(): number {
    return this.map.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  get(key: string): Uint8Array | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // refresh recency
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  set(key: string, value: Uint8Array): boolean {
    if (value.length === 0 || value.length > this.maxBytes) return false;
    const existing = this.map.get(key);
    if (existing) {
      this.totalBytes -= existing.length;
      this.map.delete(key);
    }
    this.map.set(key, value);
    this.totalBytes += value.length;
    while (this.map.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.totalBytes -= this.map.get(oldest.value)!.length;
      this.map.delete(oldest.value);
    }
    return true;
  }

  clear(): void {
    this.map.clear();
    this.totalBytes = 0;
  }
}

/** Stable key: sha256(voiceId|modelId|outputFormat|text). */
export function speechCacheKey(parts: { voiceId: string; modelId: string; outputFormat: string; text: string }): string {
  return createHash("sha256")
    .update([parts.voiceId, parts.modelId, parts.outputFormat, parts.text].join("|"))
    .digest("hex");
}

// Pinned on globalThis so dev-server module reloads don't drop the cache.
const CACHE_SLOT = Symbol.for("reflect.baroness.speechCache");
type GlobalWithCache = typeof globalThis & { [CACHE_SLOT]?: AudioCache };

export function speechAudioCache(): AudioCache {
  const g = globalThis as GlobalWithCache;
  return (g[CACHE_SLOT] ??= new AudioCache());
}

export function clearSpeechCache(): void {
  speechAudioCache().clear();
}

/* ------------------------------------------------------------------ */
/* Cache-or-stream orchestrator                                        */
/* ------------------------------------------------------------------ */

export type SpeechResult =
  | { cache: "hit"; body: Uint8Array }
  | { cache: "miss"; body: ReadableStream<Uint8Array> };

const RETRY_DELAY_MS = 400;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Return cached audio, or open the upstream stream and tee it into the cache.
 *
 * - Throws `ElevenLabsError` (not_configured, aborted, upstream failures).
 * - One automatic retry for retryable errors, only before any byte is sent and
 *   only while the caller has not aborted. The first upstream chunk is read
 *   eagerly so a dead stream can still be retried / reported as an error.
 * - The cache is only filled when the upstream body is read to completion;
 *   a client abort (`signal`) cancels the upstream request and stores nothing.
 */
export async function getSpeechAudio(
  text: string,
  opts: { signal?: AbortSignal; cache?: AudioCache; retryDelayMs?: number } = {},
): Promise<SpeechResult> {
  const { signal } = opts;
  const cache = opts.cache ?? speechAudioCache();

  const problems = speechConfigProblems();
  const voiceId = getVoiceId();
  if (problems.length > 0 || !voiceId) {
    throw new ElevenLabsError("not_configured", problems.join("; ") || "ElevenLabs is not configured");
  }

  const key = speechCacheKey({ voiceId, modelId: getModelId(), outputFormat: getOutputFormat(), text });
  const hit = cache.get(key);
  if (hit) return { cache: "hit", body: hit };

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let first: Uint8Array | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await openSpeechStream(text, { signal });
      reader = res.body!.getReader();
      const chunk = await reader.read();
      if (chunk.done || !chunk.value || chunk.value.length === 0) {
        reader.cancel().catch(() => {});
        throw new ElevenLabsError("empty_response", "ElevenLabs returned an empty audio stream", { retryable: true });
      }
      first = chunk.value;
      break;
    } catch (err) {
      reader?.cancel().catch(() => {});
      reader = undefined;
      const e = toElevenLabsError(err, signal);
      if (attempt === 0 && e.retryable && !signal?.aborted) {
        await sleep(opts.retryDelayMs ?? RETRY_DELAY_MS, signal);
        if (!signal?.aborted) continue;
      }
      throw signal?.aborted ? new ElevenLabsError("aborted", "Speech request aborted") : e;
    }
  }

  const upstream = reader!;
  const chunks: Uint8Array[] = [first!];
  let total = first!.length;
  let sentFirst = false;
  let overBudget = false;

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentFirst) {
        sentFirst = true;
        controller.enqueue(first!);
        return;
      }
      try {
        const { done, value } = await upstream.read();
        if (done) {
          controller.close();
          if (!overBudget) cache.set(key, concat(chunks, total));
          return;
        }
        if (!overBudget) {
          total += value.length;
          if (total > cache.maxBytes) overBudget = true;
          else chunks.push(value);
        }
        controller.enqueue(value);
      } catch (err) {
        chunks.length = 0; // aborted / failed mid-stream: never cache a partial clip
        overBudget = true;
        controller.error(err);
      }
    },
    cancel(reason) {
      chunks.length = 0;
      overBudget = true;
      return upstream.cancel(reason).catch(() => {});
    },
  });

  return { cache: "miss", body };
}

/* ------------------------------------------------------------------ */
/* Response construction (defence in depth for header-unsafe values)   */
/* ------------------------------------------------------------------ */

/**
 * Build the 200 audio response. If construction throws (e.g. a header-unsafe
 * session id slipped past validation) the upstream stream is cancelled so the
 * ElevenLabs request does not keep running, and null is returned.
 */
export async function speechAudioResponse(result: SpeechResult, sessionId: string): Promise<Response | null> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": SPEECH_CONTENT_TYPE,
      "Cache-Control": "no-store",
      "X-Session-Id": sessionId,
      "X-Speech-Cache": result.cache,
    };
    if (result.cache === "hit") headers["Content-Length"] = String(result.body.length);
    return new Response(result.body as BodyInit, { status: 200, headers });
  } catch {
    if (result.cache === "miss") await result.body.cancel().catch(() => {});
    return null;
  }
}

/** JSON response that falls back to no extra headers if any of them is invalid. */
export function safeJsonResponse(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  const base = { "Cache-Control": "no-store" };
  try {
    return Response.json(body, { status, headers: { ...base, ...extra } });
  } catch {
    return Response.json(body, { status, headers: base });
  }
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
