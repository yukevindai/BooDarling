/**
 * R4 (Baroness/audio) contracts.
 *
 * `Capture` and `RateResult` are owned by R1 in `lib/types.ts` (frozen in spec §8).
 * Everything below is the R4-owned request/response surface for
 * `POST /api/critique` and `POST /api/speech`, plus the server-side provider
 * interface. R1 may re-export these from `lib/types.ts`; they are structural
 * types, so either import path is compatible.
 */
import type { Capture, RateResult } from "@/lib/types";

export type { Capture, RateResult };

/** Narrowed successful rating. */
export type RateResultOk = Extract<RateResult, { status: "ok" }>;

/** `POST /api/critique` request body. */
export type CritiqueRequest = {
  capture: Capture;
  result: RateResult;
};

export type CritiqueSource = "model" | "preset";

/** One costume piece in the Halloween Aura-max card (resolved server-side from the manifest checklist). */
export type AuraMaxItem = {
  /** Checklist id, e.g. "opera-gloves". */
  id: string;
  label: string;
  /** One short line on why the piece matters to the look. */
  why: string;
  /** Shopping search query (search links only, no specific products). */
  search: string;
};

/**
 * Halloween Aura-max: the next pieces to add to get closer to the matched look.
 * Visual only (never spoken) and never changes the score. No point predictions.
 */
export type AuraMax = {
  lookId: string;
  lookLabel: string;
  /** Up to 3 pieces the camera can see (collar-down crop), most impactful first. */
  steps: AuraMaxItem[];
  /** Pieces the crop cannot show (hair, makeup): always offered, never claimed missing. */
  finishing: AuraMaxItem[];
  /** The critic saw every visible checklist piece (steps is empty). */
  complete: boolean;
  /**
   * "model": steps are what the critic saw missing.
   * "fallback": the critic's opinion is unknown (preset/timeout), so steps are simply the
   * look's top visible pieces — word it as "complete the look", not "you're missing".
   */
  source: "model" | "fallback";
};

/** `POST /api/critique` response body (always 200 for a well-formed request). */
export type CritiqueResponse = {
  sessionId: string;
  text: string;
  source: CritiqueSource;
  /** Additive (R4): present for rated results whose look has a checklist; absent for unavailable results. */
  auraMax?: AuraMax;
};

/** `POST /api/speech` request body. Response is `audio/mpeg` bytes. */
export type SpeechRequest = {
  sessionId: string;
  text: string;
};

/** Hard cap from spec §8. */
export const SPEECH_MAX_CHARS = 500;

/** Decoded outfit JPEG limit from spec §8 (bytes). */
export const OUTFIT_IMAGE_MAX_BYTES = 1_000_000;

/** Readiness payload returned by `GET /api/critique` and `GET /api/speech` (no secrets). */
export type BaronessReadiness = {
  ready: boolean;
  /** e.g. "gemini", "ollama", "mock", "elevenlabs" */
  provider: string;
  /** Model / voice identifiers, safe to show the operator. */
  detail: Record<string, string | boolean | number>;
  /** Human-readable problems for the operator panel. Empty when ready. */
  problems: string[];
};

/** An image handed to a critic provider. */
export type CriticImage = {
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  /** Base64 without the `data:` prefix. */
  base64: string;
};

/** Everything a provider needs to write one critique. */
export type CriticInput = {
  userImage: CriticImage;
  referenceImage: CriticImage;
  aura: number;
  lookId: string;
  lookLabel: string;
  /** Optional curated description of the reference look (from the manifest). */
  lookDescription?: string;
  /** Optional garment-line phrase from the live silhouette (client segmentation). */
  silhouette?: string;
  /**
   * Optional costume checklist pieces the crop can show (visibleInCrop), in priority order.
   * The critic may only report ids from this list as missing.
   */
  checklist?: Array<{ id: string; label: string }>;
};

export interface CriticProvider {
  /** Stable id: "gemini" | "ollama" | "mock". */
  readonly id: string;
  /** Model identifier used in cache keys and logs. */
  readonly model: string;
  /**
   * Returns raw model text (sanitisation happens in the orchestrator). Must honour `signal`.
   * Expected shape: a JSON object `{"critique": "...", "missing": ["<checklist id>", ...]}`;
   * plain text is still accepted (critique only, missing unknown). See lib/critic/aura-max.ts.
   */
  critique(input: CriticInput, signal: AbortSignal): Promise<string>;
  /** Cheap readiness check for the operator panel. Must not throw. */
  readiness(): Promise<BaronessReadiness>;
}
