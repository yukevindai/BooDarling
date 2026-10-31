import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ElevenLabsError, elevenLabsReadiness, synthesize } from "./elevenlabs";

const realFetch = globalThis.fetch;
const ENV_KEYS = [
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_VOICE_ID",
  "ELEVENLABS_MODEL_ID",
  "ELEVENLABS_OUTPUT_FORMAT",
  "SPEECH_TIMEOUT_MS",
  "ELEVENLABS_STABILITY",
];
const savedEnv: Record<string, string | undefined> = {};

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  calls = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch;
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.ELEVENLABS_API_KEY = "sk_test_secret";
  process.env.ELEVENLABS_VOICE_ID = "voice123";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("synthesize", () => {
  it("sends the expected request and returns bytes", async () => {
    stubFetch(() => new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "audio/mpeg" } }));
    process.env.ELEVENLABS_STABILITY = "0.7";
    const out = await synthesize("Hello darling");
    assert.deepEqual([...out], [1, 2, 3]);

    assert.equal(calls.length, 1);
    const { url, init } = calls[0];
    assert.equal(url, "https://api.elevenlabs.io/v1/text-to-speech/voice123/stream?output_format=mp3_44100_128");
    assert.equal(init.method, "POST");
    const headers = init.headers as Record<string, string>;
    assert.equal(headers["xi-api-key"], "sk_test_secret");
    assert.equal(headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(String(init.body)), {
      text: "Hello darling",
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.7, similarity_boost: 0.8, style: 0.5, use_speaker_boost: true },
    });
  });

  it("honours model and format overrides", async () => {
    stubFetch(() => new Response(new Uint8Array([9])));
    process.env.ELEVENLABS_MODEL_ID = "eleven_flash_v2_5";
    process.env.ELEVENLABS_OUTPUT_FORMAT = "mp3_22050_32";
    await synthesize("x");
    assert.ok(calls[0].url.endsWith("?output_format=mp3_22050_32"));
    assert.equal(JSON.parse(String(calls[0].init.body)).model_id, "eleven_flash_v2_5");
  });

  it("maps upstream statuses to typed errors with retryable flags", async () => {
    const cases: Array<[number, string, boolean]> = [
      [401, "auth", false],
      [404, "voice_not_found", false],
      [422, "invalid_request", false],
      [429, "rate_limited", true],
      [500, "upstream", true],
      [503, "upstream", true],
    ];
    for (const [status, code, retryable] of cases) {
      stubFetch(() => Response.json({ detail: { message: "nope" } }, { status }));
      await assert.rejects(synthesize("x"), (err: unknown) => {
        assert.ok(err instanceof ElevenLabsError);
        assert.equal(err.code, code, String(status));
        assert.equal(err.status, status);
        assert.equal(err.retryable, retryable);
        assert.ok(!err.message.includes("sk_test_secret"));
        return true;
      });
    }
  });

  it("maps network failure to a retryable error", async () => {
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    await assert.rejects(synthesize("x"), (err: unknown) => err instanceof ElevenLabsError && err.code === "network" && err.retryable);
  });

  it("times out waiting for headers", async () => {
    process.env.SPEECH_TIMEOUT_MS = "30";
    stubFetch(
      (_u, init) =>
        new Promise<Response>((_res, rej) => {
          init.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
        }),
    );
    await assert.rejects(synthesize("x"), (err: unknown) => err instanceof ElevenLabsError && err.code === "timeout" && err.retryable);
  });

  it("throws not_configured without a key, without calling fetch", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    stubFetch(() => new Response("x"));
    await assert.rejects(synthesize("x"), (err: unknown) => err instanceof ElevenLabsError && err.code === "not_configured");
    assert.equal(calls.length, 0);
  });

  it("throws aborted for an already-aborted signal", async () => {
    stubFetch(() => new Response("x"));
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(synthesize("x", { signal: ac.signal }), (err: unknown) => err instanceof ElevenLabsError && err.code === "aborted");
    assert.equal(calls.length, 0);
  });
});

describe("elevenLabsReadiness", () => {
  it("reports both missing env vars without calling fetch", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_VOICE_ID;
    stubFetch(() => new Response("x"));
    const r = await elevenLabsReadiness();
    assert.equal(r.ready, false);
    assert.equal(r.provider, "elevenlabs");
    assert.deepEqual(r.problems, ["ELEVENLABS_API_KEY is not set", "ELEVENLABS_VOICE_ID is not set"]);
    assert.equal(calls.length, 0);
  });

  it("reports a missing voice id only", async () => {
    delete process.env.ELEVENLABS_VOICE_ID;
    const r = await elevenLabsReadiness();
    assert.deepEqual(r.problems, ["ELEVENLABS_VOICE_ID is not set"]);
  });

  it("is ready when the voice is accessible, and never leaks the key", async () => {
    stubFetch(() => Response.json({ voice_id: "voice123", name: "Baroness" }));
    const r = await elevenLabsReadiness();
    assert.equal(r.ready, true);
    assert.deepEqual(r.problems, []);
    assert.equal(r.detail.voiceId, "voice123");
    assert.equal(r.detail.modelId, "eleven_multilingual_v2");
    assert.equal(r.detail.voiceName, "Baroness");
    assert.ok(!JSON.stringify(r).includes("sk_test_secret"));
    assert.equal(calls[0].url, "https://api.elevenlabs.io/v1/voices/voice123");
    assert.equal((calls[0].init.headers as Record<string, string>)["xi-api-key"], "sk_test_secret");
  });

  it("reports an inaccessible voice and a rejected key", async () => {
    stubFetch(() => new Response("{}", { status: 404 }));
    assert.deepEqual((await elevenLabsReadiness()).problems, ["Voice not accessible (HTTP 404)"]);
    stubFetch(() => new Response("{}", { status: 401 }));
    const r = await elevenLabsReadiness();
    assert.equal(r.ready, false);
    assert.match(r.problems[0], /401/);
  });

  it("a 401 on the voice lookup does not claim the key is rejected (may lack voices_read)", async () => {
    stubFetch(() => new Response('{"detail":{"status":"missing_permissions"}}', { status: 401 }));
    const r = await elevenLabsReadiness();
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0], /Could not verify voice \(key invalid or missing voices_read permission\)/);
    assert.match(r.problems[0], /use Test audio to confirm/);
    assert.doesNotMatch(r.problems[0], /rejected/);
  });

  it("reports the per-attempt server timeout so the browser can size its deadline", async () => {
    stubFetch(() => Response.json({ name: "Baroness" }));
    assert.equal((await elevenLabsReadiness()).detail.timeoutMs, 6000);
    process.env.SPEECH_TIMEOUT_MS = "4500";
    assert.equal((await elevenLabsReadiness()).detail.timeoutMs, 4500);
  });

  it("does not throw on network failure", async () => {
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    const r = await elevenLabsReadiness();
    assert.equal(r.ready, false);
    assert.match(r.problems[0], /Could not reach ElevenLabs/);
  });
});
