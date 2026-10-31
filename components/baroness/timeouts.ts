/**
 * Client-side request deadlines, derived from the server's own timeouts so the
 * browser never gives up before the server has had its full budget.
 *
 * AudioSetupControl calls `configureBaronessTimeouts` with `detail.timeoutMs`
 * from GET /api/critique and GET /api/speech. Until then the defaults apply.
 *
 *  - critique: max(12s, critiqueServerMs + 3s)       (server budget includes its retry)
 *  - speech:   max(15s, 2 * speechServerMs + 3s)     (two upstream attempts + retry delay)
 */

export const DEFAULT_CRITIQUE_CLIENT_TIMEOUT_MS = 12_000;
export const DEFAULT_SPEECH_CLIENT_TIMEOUT_MS = 15_000;
/** Guidance clips are short and pre-generated/cached; fail fast. */
export const GUIDANCE_SPEECH_TIMEOUT_MS = 5_000;
const MARGIN_MS = 3_000;
/** Ignore absurd server values (beyond any configured server cap). */
const MAX_SERVER_MS = 300_000;

let critiqueServerMs: number | undefined;
let speechServerMs: number | undefined;

function valid(n: unknown): number | undefined {
  return typeof n === "number" && Number.isFinite(n) && n > 0 && n <= MAX_SERVER_MS ? n : undefined;
}

export type BaronessTimeoutConfig = {
  /** CRITIC_TIMEOUT_MS as reported by GET /api/critique `detail.timeoutMs`. */
  critiqueServerMs?: unknown;
  /** SPEECH_TIMEOUT_MS as reported by GET /api/speech `detail.timeoutMs`. */
  speechServerMs?: unknown;
};

/** Record server timeouts. Missing/invalid values leave the previous setting unchanged. */
export function configureBaronessTimeouts(cfg: BaronessTimeoutConfig): void {
  const c = valid(cfg.critiqueServerMs);
  const s = valid(cfg.speechServerMs);
  if (c !== undefined) critiqueServerMs = c;
  if (s !== undefined) speechServerMs = s;
}

/** Test hook. */
export function resetBaronessTimeouts(): void {
  critiqueServerMs = undefined;
  speechServerMs = undefined;
}

export function critiqueClientTimeoutMs(): number {
  return critiqueServerMs === undefined
    ? DEFAULT_CRITIQUE_CLIENT_TIMEOUT_MS
    : Math.max(DEFAULT_CRITIQUE_CLIENT_TIMEOUT_MS, Math.round(critiqueServerMs + MARGIN_MS));
}

export function speechClientTimeoutMs(): number {
  return speechServerMs === undefined
    ? DEFAULT_SPEECH_CLIENT_TIMEOUT_MS
    : Math.max(DEFAULT_SPEECH_CLIENT_TIMEOUT_MS, Math.round(2 * speechServerMs + MARGIN_MS));
}
