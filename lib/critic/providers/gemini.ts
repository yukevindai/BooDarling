/**
 * Gemini critic provider (hosted fallback). REST, no SDK.
 * https://ai.google.dev/gemini-api/docs/image-understanding
 */
import { BARONESS_SYSTEM_PROMPT, buildBaronessUserPrompt } from "../../baroness-prompt";
import { geminiApiKey, geminiFallbackModels, geminiModel } from "../config";
import type { BaronessReadiness, CriticInput, CriticProvider } from "../types";
import { CriticProviderError, fetchJson, isAbortError } from "./errors";

export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

type ThinkingConfig = { thinkingBudget: number } | { thinkingLevel: string };

/** Models we know reject a thinkingConfig (learned at runtime after a 400). */
const thinkingUnsupported = new Set<string>();

function normaliseModel(model: string): string {
  return model.replace(/^models\//, "");
}

/**
 * Keep thinking short so latency stays low and output tokens are not eaten by
 * thoughts. Only set it where the value is known to be accepted:
 *  - 2.5 Flash / Flash-Lite: thinkingBudget 0 disables thinking.
 *  - Gemini 3.x: thinkingLevel "low" (accepted by Flash and Pro).
 *  - "-latest" aliases currently resolve to Gemini 3.x Flash, so they get
 *    thinkingLevel "low" too; if the alias ever moves to a model that rejects
 *    it, the 400-retry in critique() drops the setting for that model.
 */
export function geminiThinkingConfig(model: string): ThinkingConfig | undefined {
  const m = normaliseModel(model).toLowerCase();
  if (thinkingUnsupported.has(m)) return undefined;
  if (/gemini-2\.5-flash/.test(m)) return { thinkingBudget: 0 };
  if (/gemini-3/.test(m) || /-latest$/.test(m)) return { thinkingLevel: "low" };
  return undefined;
}

export function buildGeminiRequest(input: CriticInput, model: string, withThinking = true): Record<string, unknown> {
  const thinkingConfig = withThinking ? geminiThinkingConfig(model) : undefined;
  const noThoughts = thinkingConfig !== undefined && "thinkingBudget" in thinkingConfig && thinkingConfig.thinkingBudget === 0;
  return {
    systemInstruction: { parts: [{ text: BARONESS_SYSTEM_PROMPT }] },
    contents: [
      {
        role: "user",
        parts: [
          { text: buildBaronessUserPrompt(input) },
          { text: "Image 1 (visitor's outfit):" },
          { inline_data: { mime_type: input.userImage.mimeType, data: input.userImage.base64 } },
          { text: "Image 2 (reference look):" },
          { inline_data: { mime_type: input.referenceImage.mimeType, data: input.referenceImage.base64 } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.9,
      candidateCount: 1,
      // Leave room for thoughts when thinking cannot be switched off.
      maxOutputTokens: noThoughts ? 256 : 1024,
      ...(thinkingConfig ? { thinkingConfig } : {}),
    },
  };
}

const BLOCK_FINISH = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "IMAGE_SAFETY"]);

type GeminiPart = { text?: string; thought?: boolean };
type GeminiResponse = {
  promptFeedback?: { blockReason?: string };
  candidates?: Array<{ finishReason?: string; content?: { parts?: GeminiPart[] } }>;
};

/** Extract the answer text (non-thought parts) or throw. */
export function parseGeminiResponse(json: unknown): string {
  const data = (json ?? {}) as GeminiResponse;
  if (data.promptFeedback?.blockReason) {
    throw new CriticProviderError(`Gemini blocked the prompt (${data.promptFeedback.blockReason})`);
  }
  const cand = data.candidates?.[0];
  if (!cand) throw new CriticProviderError("Gemini returned no candidates");
  if (cand.finishReason && BLOCK_FINISH.has(cand.finishReason)) {
    throw new CriticProviderError(`Gemini stopped: ${cand.finishReason}`);
  }
  const text = (cand.content?.parts ?? [])
    .filter((p) => !p.thought && typeof p.text === "string")
    .map((p) => p.text)
    .join("")
    .trim();
  if (!text) throw new CriticProviderError(`Gemini returned empty text${cand.finishReason ? ` (${cand.finishReason})` : ""}`);
  return text;
}

let readinessCache: { at: number; key: string; value: BaronessReadiness } | null = null;
/** Cache successful checks longer than failures so the operator sees fixes quickly. */
const READINESS_TTL_MS = { ok: 30_000, fail: 5_000 };

/** Overloaded / unavailable / unknown model: worth trying the next model in the chain. */
function shouldFailOver(err: unknown): boolean {
  if (isAbortError(err) || !(err instanceof CriticProviderError) || err.status === undefined) return false;
  return err.status === 404 || err.status === 429 || err.status >= 500;
}

export class GeminiCriticProvider implements CriticProvider {
  readonly id = "gemini";
  readonly model: string;
  /** Primary first, then fallbacks (deduplicated). */
  readonly models: string[];

  constructor(model: string = geminiModel(), fallbacks: string[] = geminiFallbackModels()) {
    this.model = normaliseModel(model);
    this.models = [...new Set([this.model, ...fallbacks.map(normaliseModel)])];
  }

  async critique(input: CriticInput, signal: AbortSignal): Promise<string> {
    const key = geminiApiKey();
    if (!key) throw new CriticProviderError("GEMINI_API_KEY is not set");
    let lastError: unknown;
    for (const model of this.models) {
      try {
        return await this.critiqueWith(model, key, input, signal);
      } catch (err) {
        lastError = err;
        if (!shouldFailOver(err) || signal.aborted) throw err;
        console.warn(
          `[critique] gemini model=${model} unavailable (${(err as CriticProviderError).status}); trying next model`,
        );
      }
    }
    throw lastError;
  }

  private async critiqueWith(model: string, key: string, input: CriticInput, signal: AbortSignal): Promise<string> {
    const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent`;
    const send = (withThinking: boolean) =>
      fetchJson(
        url,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify(buildGeminiRequest(input, model, withThinking)),
          signal,
        },
        "Gemini",
      );
    let json: unknown;
    try {
      json = await send(true);
    } catch (err) {
      // A 400 that mentions thinking means this model rejects our thinkingConfig: retry once without it.
      if (
        !isAbortError(err) &&
        err instanceof CriticProviderError &&
        err.status === 400 &&
        /think/i.test(err.message) &&
        geminiThinkingConfig(model)
      ) {
        thinkingUnsupported.add(model.toLowerCase());
        json = await send(false);
      } else {
        throw err;
      }
    }
    return parseGeminiResponse(json);
  }

  async readiness(): Promise<BaronessReadiness> {
    const key = geminiApiKey();
    const base: BaronessReadiness = {
      ready: false,
      provider: this.id,
      detail: { model: this.model, fallbackModels: this.models.slice(1).join(",") || "none", apiKeyConfigured: Boolean(key) },
      problems: [],
    };
    if (!key) {
      base.problems.push("GEMINI_API_KEY is not set; critiques will use preset lines.");
      return base;
    }
    const cacheKey = this.model;
    const ttl = readinessCache?.value.ready ? READINESS_TTL_MS.ok : READINESS_TTL_MS.fail;
    if (readinessCache && readinessCache.key === cacheKey && Date.now() - readinessCache.at < ttl) {
      return readinessCache.value;
    }
    try {
      await fetchJson(
        `${GEMINI_API_BASE}/models/${encodeURIComponent(this.model)}`,
        { method: "GET", headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(3000) },
        "Gemini",
      );
      base.ready = true;
    } catch (err) {
      if (isAbortError(err)) base.problems.push("Gemini did not answer within 3 s; check the network.");
      else if (err instanceof CriticProviderError && err.status === 404)
        base.problems.push(`Gemini model "${this.model}" was not found; check GEMINI_MODEL.`);
      else if (err instanceof CriticProviderError && (err.status === 400 || err.status === 401 || err.status === 403))
        base.problems.push("Gemini rejected the API key; check GEMINI_API_KEY.");
      else base.problems.push(`Gemini is unreachable (${err instanceof Error ? err.message : "unknown error"}).`);
    }
    readinessCache = { at: Date.now(), key: cacheKey, value: base };
    return base;
  }
}
