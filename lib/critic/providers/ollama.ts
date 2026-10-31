/**
 * Local Qwen3-VL critic via Ollama (`POST /api/chat`, non-streaming).
 * https://github.com/ollama/ollama/blob/main/docs/api.md#generate-a-chat-completion
 */
import { BARONESS_SYSTEM_PROMPT, buildBaronessUserPrompt } from "../../baroness-prompt";
import { ollamaBaseUrl, ollamaModel } from "../config";
import type { BaronessReadiness, CriticInput, CriticProvider } from "../types";
import { CriticProviderError, fetchJson, isAbortError } from "./errors";

/** Models that rejected `think: false` (learned after a 400). */
const thinkUnsupported = new Set<string>();

export function buildOllamaRequest(input: CriticInput, model: string, withThinkFlag = true): Record<string, unknown> {
  return {
    model,
    stream: false,
    ...(withThinkFlag && !thinkUnsupported.has(model) ? { think: false } : {}),
    keep_alive: "30m",
    messages: [
      { role: "system", content: BARONESS_SYSTEM_PROMPT },
      {
        role: "user",
        // Ollama passes images in order: image 1 = visitor, image 2 = reference.
        content: buildBaronessUserPrompt(input),
        images: [input.userImage.base64, input.referenceImage.base64],
      },
    ],
    options: { temperature: 0.9, num_predict: 240 },
  };
}

/** Remove any Qwen3 `<think>…</think>` block (including an unterminated one). */
export function stripThink(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/i, "")
    .trim();
}

export function parseOllamaResponse(json: unknown): string {
  const data = (json ?? {}) as { message?: { content?: unknown }; error?: unknown };
  if (typeof data.error === "string") throw new CriticProviderError(`Ollama error: ${data.error.slice(0, 160)}`);
  const content = typeof data.message?.content === "string" ? stripThink(data.message.content) : "";
  if (!content) throw new CriticProviderError("Ollama returned empty text");
  return content;
}

/** Does an `ollama list` name match the configured model (treating a missing tag as ":latest")? */
export function ollamaModelMatches(available: string, wanted: string): boolean {
  const norm = (m: string) => (m.includes(":") ? m : `${m}:latest`).toLowerCase();
  return norm(available) === norm(wanted);
}

export class OllamaCriticProvider implements CriticProvider {
  readonly id = "ollama";
  readonly model: string;
  private readonly baseUrl: string;

  constructor(model: string = ollamaModel(), baseUrl: string = ollamaBaseUrl()) {
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async critique(input: CriticInput, signal: AbortSignal): Promise<string> {
    const send = (withThinkFlag: boolean) =>
      fetchJson(
        `${this.baseUrl}/api/chat`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(buildOllamaRequest(input, this.model, withThinkFlag)),
          signal,
        },
        "Ollama",
      );
    let json: unknown;
    try {
      json = await send(true);
    } catch (err) {
      if (
        !isAbortError(err) &&
        err instanceof CriticProviderError &&
        err.status === 400 &&
        /think/i.test(err.message) &&
        !thinkUnsupported.has(this.model)
      ) {
        thinkUnsupported.add(this.model);
        json = await send(false);
      } else {
        if (err instanceof CriticProviderError && err.status === 404) {
          throw new CriticProviderError(`Ollama model "${this.model}" is not pulled`, { status: 404 });
        }
        throw err;
      }
    }
    return parseOllamaResponse(json);
  }

  async readiness(): Promise<BaronessReadiness> {
    const out: BaronessReadiness = {
      ready: false,
      provider: this.id,
      detail: { model: this.model, baseUrl: this.baseUrl },
      problems: [],
    };
    try {
      const json = (await fetchJson(
        `${this.baseUrl}/api/tags`,
        { method: "GET", signal: AbortSignal.timeout(1500) },
        "Ollama",
      )) as { models?: Array<{ name?: string; model?: string }> };
      const names = (json.models ?? []).flatMap((m) => [m.name, m.model]).filter((n): n is string => typeof n === "string");
      if (names.some((n) => ollamaModelMatches(n, this.model))) {
        out.ready = true;
      } else {
        out.problems.push(`Ollama model "${this.model}" is not pulled. Run: ollama pull ${this.model}`);
      }
    } catch (err) {
      out.problems.push(
        isAbortError(err)
          ? `Ollama did not answer at ${this.baseUrl} within 1.5 s. Is "ollama serve" running?`
          : `Ollama is unreachable at ${this.baseUrl}. Start it with: ollama serve`,
      );
    }
    return out;
  }
}
