import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BARONESS_SYSTEM_PROMPT } from "../baroness-prompt";
import { criticProviderId, criticTimeoutMs, geminiModel, ollamaBaseUrl } from "./config";
import { getCriticProvider } from "./providers";
import { isTransientError } from "./providers/errors";
import { GeminiCriticProvider, buildGeminiRequest, geminiThinkingConfig, parseGeminiResponse } from "./providers/gemini";
import { MockCriticProvider } from "./providers/mock";
import { OllamaCriticProvider, ollamaModelMatches, parseOllamaResponse } from "./providers/ollama";
import type { CriticInput } from "./types";

const INPUT: CriticInput = {
  userImage: { mimeType: "image/jpeg", base64: "VVNFUg==" },
  referenceImage: { mimeType: "image/png", base64: "UkVG" },
  aura: 63,
  lookId: "classic-dalmatian",
  lookLabel: "Classic Dalmatian Coat",
};

type Call = { url: string; init: RequestInit };
const realFetch = globalThis.fetch;
const ENV_KEYS = ["CRITIC_PROVIDER", "GEMINI_API_KEY", "GEMINI_MODEL", "OLLAMA_BASE_URL", "OLLAMA_MODEL", "CRITIC_TIMEOUT_MS"];
let savedEnv: Record<string, string | undefined> = {};
let calls: Call[] = [];

function stubFetch(responder: (call: Call, n: number) => Response | Promise<Response>) {
  calls = [];
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    if (init.signal?.aborted) throw init.signal.reason;
    return responder(call, calls.length);
  }) as typeof fetch;
}
const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("config", () => {
  it("reads env lazily with defaults", () => {
    assert.equal(criticProviderId(), "gemini");
    assert.equal(geminiModel(), "gemini-flash-latest");
    assert.equal(ollamaBaseUrl(), "http://127.0.0.1:11434");
    assert.equal(criticTimeoutMs(), 8000);
    process.env.CRITIC_PROVIDER = "MOCK";
    process.env.CRITIC_TIMEOUT_MS = "5000";
    process.env.OLLAMA_BASE_URL = "http://box:11434/";
    assert.equal(criticProviderId(), "mock");
    assert.equal(criticTimeoutMs(), 5000);
    assert.equal(ollamaBaseUrl(), "http://box:11434");
    process.env.CRITIC_TIMEOUT_MS = "banana";
    assert.equal(criticTimeoutMs(), 8000);
  });

  it("selects the provider from CRITIC_PROVIDER", () => {
    assert.equal(getCriticProvider().id, "gemini");
    process.env.CRITIC_PROVIDER = "ollama";
    assert.equal(getCriticProvider().id, "ollama");
    process.env.CRITIC_PROVIDER = "mock";
    assert.equal(getCriticProvider().id, "mock");
    process.env.CRITIC_PROVIDER = "nonsense";
    assert.equal(getCriticProvider().id, "gemini");
  });
});

describe("gemini provider", () => {
  it("builds a generateContent request with system prompt, text and two inline images in order", () => {
    const req = buildGeminiRequest(INPUT, "gemini-flash-latest") as {
      systemInstruction: { parts: { text: string }[] };
      contents: { role: string; parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }> }[];
      generationConfig: Record<string, unknown>;
    };
    assert.equal(req.systemInstruction.parts[0].text, BARONESS_SYSTEM_PROMPT);
    const images = req.contents[0].parts.filter((p) => p.inline_data).map((p) => p.inline_data);
    assert.deepEqual(images, [
      { mime_type: "image/jpeg", data: "VVNFUg==" },
      { mime_type: "image/png", data: "UkVG" },
    ]);
    assert.match(req.contents[0].parts[0].text ?? "", /63 out of 100/);
    assert.deepEqual(req.generationConfig.thinkingConfig, { thinkingLevel: "low" });
    assert.equal(req.generationConfig.temperature, 0.9);
  });

  it("chooses a safe thinkingConfig per model", () => {
    assert.deepEqual(geminiThinkingConfig("gemini-2.5-flash"), { thinkingBudget: 0 });
    assert.deepEqual(geminiThinkingConfig("models/gemini-2.5-flash-lite"), { thinkingBudget: 0 });
    assert.deepEqual(geminiThinkingConfig("gemini-3-flash-preview"), { thinkingLevel: "low" });
    assert.deepEqual(geminiThinkingConfig("gemini-flash-latest"), { thinkingLevel: "low" });
    assert.equal(geminiThinkingConfig("gemini-2.5-pro"), undefined);
  });

  it("parses text, skipping thought parts, and rejects blocks", () => {
    assert.equal(
      parseGeminiResponse({
        candidates: [{ finishReason: "STOP", content: { parts: [{ text: "thinking...", thought: true }, { text: "One. " }, { text: "Two." }] } }],
      }),
      "One. Two.",
    );
    assert.throws(() => parseGeminiResponse({ promptFeedback: { blockReason: "SAFETY" } }), /blocked/);
    assert.throws(() => parseGeminiResponse({ candidates: [{ finishReason: "SAFETY", content: { parts: [] } }] }), /SAFETY/);
    assert.throws(() => parseGeminiResponse({ candidates: [] }), /no candidates/);
    assert.throws(() => parseGeminiResponse({ candidates: [{ finishReason: "MAX_TOKENS", content: {} }] }), /empty/);
  });

  it("calls the REST endpoint with the key header and honours the signal", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    stubFetch(() => jsonRes({ candidates: [{ content: { parts: [{ text: "Fine. Add gloves." }] } }] }));
    const p = new GeminiCriticProvider("gemini-2.5-flash");
    assert.equal(await p.critique(INPUT, new AbortController().signal), "Fine. Add gloves.");
    assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    assert.equal((calls[0].init.headers as Record<string, string>)["x-goog-api-key"], "test-key");
    const sent = JSON.parse(String(calls[0].init.body));
    assert.deepEqual(sent.generationConfig.thinkingConfig, { thinkingBudget: 0 });

    const ac = new AbortController();
    ac.abort();
    await assert.rejects(p.critique(INPUT, ac.signal), (e: Error) => e.name === "AbortError");
  });

  it("maps HTTP errors to transient/non-transient and never leaks the key", async () => {
    process.env.GEMINI_API_KEY = "super-secret-key";
    const p = new GeminiCriticProvider("gemini-flash-latest");
    stubFetch(() => jsonRes({ error: { message: "Resource exhausted" } }, 429));
    await assert.rejects(p.critique(INPUT, new AbortController().signal), (e: Error) => {
      assert.ok(isTransientError(e));
      assert.ok(!e.message.includes("super-secret-key"));
      return true;
    });
    stubFetch(() => jsonRes({ error: { message: "API key not valid" } }, 400));
    await assert.rejects(p.critique(INPUT, new AbortController().signal), (e: Error) => !isTransientError(e));
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    await assert.rejects(p.critique(INPUT, new AbortController().signal), (e: Error) => isTransientError(e));
  });

  it("retries once without thinkingConfig when the model rejects it", async () => {
    process.env.GEMINI_API_KEY = "k";
    stubFetch((_c, n) =>
      n === 1
        ? jsonRes({ error: { message: "Thinking budget is not supported for this model." } }, 400)
        : jsonRes({ candidates: [{ content: { parts: [{ text: "Ok then. Add gloves." }] } }] }),
    );
    const p = new GeminiCriticProvider("gemini-3-pro-test");
    assert.equal(await p.critique(INPUT, new AbortController().signal), "Ok then. Add gloves.");
    assert.equal(calls.length, 2);
    assert.equal(JSON.parse(String(calls[1].init.body)).generationConfig.thinkingConfig, undefined);
  });

  it("throws without a key and reports not-ready without calling the network", async () => {
    stubFetch(() => {
      throw new Error("should not be called");
    });
    const p = new GeminiCriticProvider();
    await assert.rejects(p.critique(INPUT, new AbortController().signal), /GEMINI_API_KEY/);
    const r = await p.readiness();
    assert.equal(r.ready, false);
    assert.equal(r.detail.apiKeyConfigured, false);
    assert.match(r.problems[0], /GEMINI_API_KEY/);
    assert.equal(calls.length, 0);
  });

  it("readiness checks the model with the key", async () => {
    process.env.GEMINI_API_KEY = "k";
    stubFetch(() => jsonRes({ name: "models/gemini-readiness-ok" }));
    const r = await new GeminiCriticProvider("gemini-readiness-ok").readiness();
    assert.equal(r.ready, true);
    assert.equal(JSON.stringify(r).includes('"k"'), false);
    stubFetch(() => jsonRes({ error: { message: "not found" } }, 404));
    const r2 = await new GeminiCriticProvider("gemini-readiness-missing").readiness();
    assert.equal(r2.ready, false);
    assert.match(r2.problems[0], /not found/);
  });
});

describe("ollama provider", () => {
  it("posts a non-streaming chat with system + user images in order", async () => {
    stubFetch(() => jsonRes({ message: { role: "assistant", content: "<think>hmm</think>\nNice spots. Add red gloves." } }));
    const p = new OllamaCriticProvider("qwen3-vl:4b", "http://ollama:11434/");
    assert.equal(await p.critique(INPUT, new AbortController().signal), "Nice spots. Add red gloves.");
    assert.equal(calls[0].url, "http://ollama:11434/api/chat");
    const sent = JSON.parse(String(calls[0].init.body));
    assert.equal(sent.model, "qwen3-vl:4b");
    assert.equal(sent.stream, false);
    assert.equal(sent.think, false);
    assert.equal(sent.messages[0].role, "system");
    assert.deepEqual(sent.messages[1].images, ["VVNFUg==", "UkVG"]);
    assert.equal(typeof sent.options.temperature, "number");
    assert.equal(typeof sent.options.num_predict, "number");
  });

  it("retries without the think flag when the model rejects it", async () => {
    stubFetch((_c, n) =>
      n === 1 ? jsonRes({ error: '"qwen-x" does not support thinking' }, 400) : jsonRes({ message: { content: "Fine. Add gloves." } }),
    );
    const p = new OllamaCriticProvider("qwen-x", "http://o");
    assert.equal(await p.critique(INPUT, new AbortController().signal), "Fine. Add gloves.");
    assert.equal(JSON.parse(String(calls[1].init.body)).think, undefined);
  });

  it("parses responses defensively", () => {
    assert.throws(() => parseOllamaResponse({ message: { content: "<think>only thoughts" } }), /empty/);
    assert.throws(() => parseOllamaResponse({ error: "model not found" }), /model not found/);
    assert.ok(ollamaModelMatches("qwen3-vl:4b", "qwen3-vl:4b"));
    assert.ok(ollamaModelMatches("llava:latest", "llava"));
    assert.ok(!ollamaModelMatches("qwen3-vl:8b", "qwen3-vl:4b"));
  });

  it("readiness reports pulled / missing / unreachable", async () => {
    stubFetch(() => jsonRes({ models: [{ name: "qwen3-vl:4b", model: "qwen3-vl:4b" }] }));
    assert.equal((await new OllamaCriticProvider("qwen3-vl:4b", "http://o").readiness()).ready, true);
    stubFetch(() => jsonRes({ models: [{ name: "llama3:latest" }] }));
    const missing = await new OllamaCriticProvider("qwen3-vl:4b", "http://o").readiness();
    assert.equal(missing.ready, false);
    assert.match(missing.problems[0], /ollama pull qwen3-vl:4b/);
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    const down = await new OllamaCriticProvider("qwen3-vl:4b", "http://o").readiness();
    assert.equal(down.ready, false);
    assert.match(down.problems[0], /ollama serve/);
  });
});

describe("mock provider", () => {
  it("is deterministic, ready, and aborts", async () => {
    const p = new MockCriticProvider(0);
    const a = await p.critique(INPUT, new AbortController().signal);
    const b = await p.critique(INPUT, new AbortController().signal);
    assert.equal(a, b);
    assert.match(a, /Classic Dalmatian Coat/);
    assert.equal((await p.readiness()).ready, true);
    const slow = new MockCriticProvider(1000);
    const ac = new AbortController();
    const pending = slow.critique(INPUT, ac.signal);
    ac.abort();
    await assert.rejects(pending);
  });
});
