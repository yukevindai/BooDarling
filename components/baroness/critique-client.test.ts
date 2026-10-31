import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ANNOUNCEMENT_LINES, pickPresetCritique } from "../../lib/critic/lines";
import type { Capture, RateResult } from "../../lib/critic/types";
import { CritiqueDiscardedError, isCritiqueDiscarded, requestCritique } from "./critique-client";
import { configureBaronessTimeouts, resetBaronessTimeouts } from "./timeouts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const capture: Capture = { sessionId: "s-1", outfitImage: "data:image/jpeg;base64,AAAA" };
const ok: RateResult = {
  status: "ok",
  sessionId: "s-1",
  aura: 62,
  lookId: "classic-dalmatian",
  referenceId: "classic-dalmatian-01",
  similarity: 0.7,
  referenceScores: [],
  modelVersion: "m",
  referenceVersion: "r",
  calibrationVersion: "c",
};
const unavailable: RateResult = { status: "unavailable", sessionId: "s-1", message: "down" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A fetch that never answers but rejects with AbortError when its signal aborts. */
function hangingFetch(): typeof fetch {
  return ((_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as typeof fetch;
}

describe("requestCritique", () => {
  it("returns the server critique on success and posts {capture, result}", async () => {
    let seen: { url: string; body: unknown } | undefined;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seen = { url, body: JSON.parse(String(init?.body)) };
      return json({ sessionId: "s-1", text: "One. Two.", source: "model" });
    }) as typeof fetch;
    const r = await requestCritique(capture, ok);
    assert.deepEqual(r, { sessionId: "s-1", text: "One. Two.", source: "model" });
    assert.equal(seen?.url, "/api/critique");
    assert.deepEqual(seen?.body, { capture, result: ok });
  });

  it("falls back to a client preset on HTTP 500 (ok result)", async () => {
    globalThis.fetch = (async () => json({ error: "boom" }, 500)) as typeof fetch;
    const r = await requestCritique(capture, ok);
    assert.equal(r.source, "preset");
    assert.equal(r.sessionId, "s-1");
    assert.equal(r.text, pickPresetCritique(62, "s-1").text);
  });

  it("falls back on network error and malformed bodies", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    assert.equal((await requestCritique(capture, ok)).source, "preset");

    globalThis.fetch = (async () => json({ sessionId: "s-1", text: "", source: "model" })) as typeof fetch;
    assert.equal((await requestCritique(capture, ok)).source, "preset");

    globalThis.fetch = (async () => new Response("<html>", { status: 200 })) as typeof fetch;
    assert.equal((await requestCritique(capture, ok)).source, "preset");

    globalThis.fetch = (async () => json({ sessionId: "s-1", text: "x", source: "weird" })) as typeof fetch;
    assert.equal((await requestCritique(capture, ok)).source, "preset");
  });

  it("falls back to the unavailable announcement when the rating is unavailable", async () => {
    globalThis.fetch = (async () => json({ error: "boom" }, 500)) as typeof fetch;
    const r = await requestCritique(capture, unavailable);
    assert.equal(r.source, "preset");
    assert.equal(r.text, ANNOUNCEMENT_LINES.unavailable.text);
  });

  it("falls back to a preset on client timeout", async () => {
    globalThis.fetch = hangingFetch();
    const started = Date.now();
    const r = await requestCritique(capture, ok, { timeoutMs: 40 });
    assert.equal(r.source, "preset");
    assert.ok(Date.now() - started < 1000);
  });

  it("default client deadline follows the server's CRITIC_TIMEOUT_MS (max(12s, server + 3s))", async () => {
    const realSetTimeout = globalThis.setTimeout;
    const delays: number[] = [];
    globalThis.fetch = (async () => json({ sessionId: "s-1", text: "Fine. Very fine.", source: "model" })) as typeof fetch;
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return realSetTimeout(fn, ms);
    }) as typeof setTimeout;
    try {
      await requestCritique(capture, ok);
      configureBaronessTimeouts({ critiqueServerMs: 60_000 });
      await requestCritique(capture, ok);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      resetBaronessTimeouts();
    }
    assert.deepEqual(delays, [12_000, 63_000]);
  });

  it("discards a response for a different session", async () => {
    globalThis.fetch = (async () => json({ sessionId: "other", text: "Hi. There.", source: "model" })) as typeof fetch;
    await assert.rejects(requestCritique(capture, ok), (e: unknown) => {
      assert.ok(isCritiqueDiscarded(e));
      assert.equal((e as CritiqueDiscardedError).reason, "stale");
      return true;
    });
  });

  it("propagates a caller abort (mid-flight and pre-aborted) instead of returning a preset", async () => {
    globalThis.fetch = hangingFetch();
    const ac = new AbortController();
    const p = requestCritique(capture, ok, { signal: ac.signal, timeoutMs: 5000 });
    setTimeout(() => ac.abort(), 20);
    await assert.rejects(p, (e: unknown) => {
      assert.ok(isCritiqueDiscarded(e));
      assert.equal((e as Error).name, "AbortError");
      assert.equal((e as CritiqueDiscardedError).reason, "aborted");
      return true;
    });

    const done = new AbortController();
    done.abort();
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return json({});
    }) as typeof fetch;
    await assert.rejects(requestCritique(capture, ok, { signal: done.signal }), isCritiqueDiscarded);
    assert.equal(called, false);
  });

  it("discards a successful response if the caller aborted meanwhile", async () => {
    const ac = new AbortController();
    globalThis.fetch = (async () => {
      ac.abort();
      return json({ sessionId: "s-1", text: "A. B.", source: "model" });
    }) as typeof fetch;
    await assert.rejects(requestCritique(capture, ok, { signal: ac.signal }), isCritiqueDiscarded);
  });
});
