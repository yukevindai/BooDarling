import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { clearSpeechCache } from "../../../lib/critic/speech";
import { GET, POST } from "./route";

const realFetch = globalThis.fetch;
const ENV_KEYS = ["ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID", "ELEVENLABS_MODEL_ID", "ELEVENLABS_OUTPUT_FORMAT", "SPEECH_TIMEOUT_MS"];
const saved: Record<string, string | undefined> = {};

let calls: Array<{ url: string; init: RequestInit }> = [];
function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  calls = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return handler(String(input), init ?? {});
  }) as typeof fetch;
}

function post(body: unknown, signal?: AbortSignal): Request {
  return new Request("http://localhost/api/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal,
  });
}

async function bytesOf(res: Response): Promise<number[]> {
  return [...new Uint8Array(await res.arrayBuffer())];
}

/** Two-chunk streaming MP3 body. */
function audioResponse(): Response {
  const parts = [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])];
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "audio/mpeg" } });
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.ELEVENLABS_API_KEY = "sk_test_secret";
  process.env.ELEVENLABS_VOICE_ID = "voice123";
  clearSpeechCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  clearSpeechCache();
});

describe("POST /api/speech", () => {
  it("streams audio with the right headers, then serves an identical request from cache", async () => {
    stubFetch(audioResponse);
    const res = await POST(post({ sessionId: "sess-1", text: "Step back, darling." }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "audio/mpeg");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("x-session-id"), "sess-1");
    assert.equal(res.headers.get("x-speech-cache"), "miss");
    assert.deepEqual(await bytesOf(res), [1, 2, 3, 4, 5]);
    assert.equal(calls.length, 1);

    const again = await POST(post({ sessionId: "sess-2", text: "  Step back,   darling. " }));
    assert.equal(again.status, 200);
    assert.equal(again.headers.get("x-speech-cache"), "hit");
    assert.equal(again.headers.get("x-session-id"), "sess-2");
    assert.equal(again.headers.get("content-type"), "audio/mpeg");
    assert.deepEqual(await bytesOf(again), [1, 2, 3, 4, 5]);
    assert.equal(calls.length, 1, "cache hit must not call ElevenLabs");
  });

  it("returns 503 JSON without a key and never calls fetch", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    stubFetch(audioResponse);
    const res = await POST(post({ sessionId: "s", text: "hello" }));
    assert.equal(res.status, 503);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const json = (await res.json()) as { error: string; problems: string[] };
    assert.ok(json.error);
    assert.deepEqual(json.problems, ["ELEVENLABS_API_KEY is not set"]);
    assert.equal(calls.length, 0);
  });

  it("returns 400 on invalid JSON and invalid bodies", async () => {
    stubFetch(audioResponse);
    assert.equal((await POST(post("{nope"))).status, 400);
    assert.equal((await POST(post({ text: "hi" }))).status, 400);
    assert.equal((await POST(post({ sessionId: "s", text: "   " }))).status, 400);
    assert.equal((await POST(post({ sessionId: "s".repeat(129), text: "hi" }))).status, 400);
    assert.equal(calls.length, 0);
  });

  it("caps text over 500 characters before sending upstream", async () => {
    stubFetch(audioResponse);
    const text = "A fairly long sentence about silhouettes and drama. ".repeat(30);
    const res = await POST(post({ sessionId: "s", text }));
    assert.equal(res.status, 200);
    await res.arrayBuffer();
    const sent = JSON.parse(String(calls[0].init.body)) as { text: string };
    assert.ok(sent.text.length <= 500);
    assert.ok(sent.text.endsWith("drama."));
  });

  it("maps upstream failure to 502 JSON, retrying once on a retryable error", async () => {
    let n = 0;
    stubFetch(() => {
      n++;
      return Response.json({ detail: "busy" }, { status: 429 });
    });
    const res = await POST(post({ sessionId: "s", text: "hello" }));
    assert.equal(res.status, 502);
    const json = (await res.json()) as { error: string; code: string; retryable: boolean };
    assert.equal(json.code, "rate_limited");
    assert.equal(json.retryable, true);
    assert.equal(n, 2, "one automatic retry");
    assert.ok(!JSON.stringify(json).includes("sk_test_secret"));
  });

  it("does not retry non-retryable errors", async () => {
    stubFetch(() => Response.json({ detail: "bad key" }, { status: 401 }));
    const res = await POST(post({ sessionId: "s", text: "hello" }));
    assert.equal(res.status, 502);
    assert.equal(calls.length, 1);
  });

  it("recovers when the retry succeeds", async () => {
    let n = 0;
    stubFetch(() => (++n === 1 ? new Response("x", { status: 500 }) : audioResponse()));
    const res = await POST(post({ sessionId: "s", text: "hello" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await bytesOf(res), [1, 2, 3, 4, 5]);
    assert.equal(n, 2);
  });

  it("passes a client abort through to the upstream request", async () => {
    let upstreamSignal: AbortSignal | undefined;
    stubFetch(
      (_u, init) =>
        new Promise<Response>((_res, rej) => {
          upstreamSignal = init.signal ?? undefined;
          init.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
        }),
    );
    const ac = new AbortController();
    const pending = POST(post({ sessionId: "s", text: "hello" }, ac.signal));
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(upstreamSignal, "fetch was called");
    assert.equal(upstreamSignal!.aborted, false);
    ac.abort();
    const res = await pending;
    assert.equal(upstreamSignal!.aborted, true);
    assert.equal(res.status, 499);
    assert.equal(calls.length, 1, "no retry after abort");
  });

  it("does not cache a clip whose stream was cancelled mid-way", async () => {
    stubFetch(() => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([1, 2]));
        },
        pull() {
          return new Promise(() => {}); // never finishes
        },
      });
      return new Response(stream);
    });
    const res = await POST(post({ sessionId: "s", text: "hello" }));
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();

    stubFetch(audioResponse);
    const again = await POST(post({ sessionId: "s", text: "hello" }));
    assert.equal(again.headers.get("x-speech-cache"), "miss");
    assert.equal(calls.length, 1);
  });
});

describe("GET /api/speech", () => {
  it("returns readiness JSON with problems when unconfigured", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_VOICE_ID;
    const res = await GET();
    assert.equal(res.status, 200);
    const json = (await res.json()) as { ready: boolean; provider: string; problems: string[] };
    assert.equal(json.ready, false);
    assert.equal(json.provider, "elevenlabs");
    assert.equal(json.problems.length, 2);
  });
});
