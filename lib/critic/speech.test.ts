import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allScriptedLines } from "./lines";
import {
  AudioCache,
  normalizeSpeechText,
  safeJsonResponse,
  speechAudioResponse,
  speechCacheKey,
  validateSpeechRequest,
} from "./speech";
import { SPEECH_MAX_CHARS } from "./types";

describe("normalizeSpeechText", () => {
  it("trims and collapses whitespace", () => {
    assert.equal(normalizeSpeechText("  Hello \n\t  darling  .  "), "Hello darling.");
  });

  it("strips markdown and emoji", () => {
    assert.equal(
      normalizeSpeechText("## **Bold** _move_ with [style](http://x.y) \u{1F480}✨ `now`"),
      "Bold move with style now",
    );
  });

  it("leaves scripted lines unchanged", () => {
    for (const l of allScriptedLines()) assert.equal(normalizeSpeechText(l.text), l.text, l.id);
  });

  it("returns empty for whitespace / symbols only", () => {
    assert.equal(normalizeSpeechText(" \n \u{1F480} ** "), "");
  });

  it("caps at 500 chars on a sentence boundary", () => {
    const sentence = "This is a perfectly ordinary sentence about tailoring. ";
    const text = sentence.repeat(20);
    const out = normalizeSpeechText(text);
    assert.ok(out.length <= SPEECH_MAX_CHARS);
    assert.ok(out.endsWith("tailoring."));
    assert.equal(out, sentence.repeat(9).trim());
  });

  it("falls back to a word boundary when there is no sentence end", () => {
    const out = normalizeSpeechText("word ".repeat(200));
    assert.ok(out.length <= SPEECH_MAX_CHARS);
    assert.ok(out.endsWith("word"));
  });

  it("hard-cuts a single giant token", () => {
    assert.equal(normalizeSpeechText("x".repeat(900)).length, SPEECH_MAX_CHARS);
  });

  it("keeps exactly 500 chars untouched", () => {
    const t = "a".repeat(500);
    assert.equal(normalizeSpeechText(t), t);
  });
});

describe("validateSpeechRequest", () => {
  it("accepts a valid body and returns normalised text", () => {
    assert.deepEqual(validateSpeechRequest({ sessionId: " s1 ", text: "  Hi   there " }), {
      ok: true,
      sessionId: "s1",
      text: "Hi there",
    });
  });

  it("rejects non-objects", () => {
    for (const body of [null, undefined, "x", 3, []]) {
      const r = validateSpeechRequest(body);
      assert.ok(!r.ok && r.status === 400);
    }
  });

  it("rejects bad sessionId", () => {
    for (const sessionId of [undefined, "", "   ", 5, "s".repeat(129)]) {
      const r = validateSpeechRequest({ sessionId, text: "hi" });
      assert.ok(!r.ok && r.status === 400, String(sessionId));
    }
    assert.ok(validateSpeechRequest({ sessionId: "s".repeat(128), text: "hi" }).ok);
  });

  it("rejects header-unsafe sessionIds (CR/LF, control, non-ASCII)", () => {
    for (const sessionId of ["a\nb", "a\r\nX-Evil: 1", "a\u0000b", "セッション"]) {
      const r = validateSpeechRequest({ sessionId, text: "hi" });
      assert.ok(!r.ok && r.status === 400, JSON.stringify(sessionId));
    }
  });

  it("rejects missing, non-string and empty text", () => {
    for (const text of [undefined, 1, "", "   ", "\u{1F480}"]) {
      const r = validateSpeechRequest({ sessionId: "s", text });
      assert.ok(!r.ok && r.status === 400, String(text));
    }
  });

  it("caps long text instead of rejecting, but rejects absurd payloads", () => {
    const r = validateSpeechRequest({ sessionId: "s", text: "Hello there. ".repeat(100) });
    assert.ok(r.ok && r.text.length <= SPEECH_MAX_CHARS);
    const big = validateSpeechRequest({ sessionId: "s", text: "a".repeat(20_001) });
    assert.ok(!big.ok && big.status === 413);
  });
});

describe("speechCacheKey", () => {
  const base = { voiceId: "v", modelId: "m", outputFormat: "mp3_44100_128", text: "Hello" };

  it("is stable and sensitive to every part", () => {
    const k = speechCacheKey(base);
    assert.match(k, /^[0-9a-f]{64}$/);
    assert.equal(speechCacheKey({ ...base }), k);
    for (const patch of [{ voiceId: "v2" }, { modelId: "m2" }, { outputFormat: "mp3_22050_32" }, { text: "Hello." }]) {
      assert.notEqual(speechCacheKey({ ...base, ...patch }), k);
    }
  });
});

describe("AudioCache", () => {
  const bytes = (n: number) => new Uint8Array(n).fill(1);

  it("evicts least-recently-used entries past the entry limit", () => {
    const c = new AudioCache(3, 1000);
    c.set("a", bytes(1));
    c.set("b", bytes(1));
    c.set("c", bytes(1));
    assert.ok(c.get("a")); // a is now most recent
    c.set("d", bytes(1)); // evicts b
    assert.equal(c.size, 3);
    assert.ok(!c.has("b"));
    assert.ok(c.has("a") && c.has("c") && c.has("d"));
  });

  it("evicts to stay within the byte budget", () => {
    const c = new AudioCache(10, 100);
    c.set("a", bytes(60));
    c.set("b", bytes(30));
    c.set("c", bytes(30)); // 120 > 100 -> evict a
    assert.ok(!c.has("a"));
    assert.equal(c.bytes, 60);
  });

  it("refuses empty or oversize entries and tracks replacement bytes", () => {
    const c = new AudioCache(10, 100);
    assert.equal(c.set("big", bytes(101)), false);
    assert.equal(c.set("empty", bytes(0)), false);
    c.set("a", bytes(40));
    c.set("a", bytes(10));
    assert.equal(c.bytes, 10);
    assert.equal(c.size, 1);
  });
});

describe("speechAudioResponse / safeJsonResponse (defence in depth)", () => {
  it("builds the audio response with session + cache headers", async () => {
    const res = await speechAudioResponse({ cache: "hit", body: new Uint8Array([1, 2, 3]) }, "s1");
    assert.ok(res);
    assert.equal(res.headers.get("x-session-id"), "s1");
    assert.equal(res.headers.get("content-length"), "3");
    assert.equal(res.headers.get("content-type"), "audio/mpeg");
  });

  it("returns null and cancels the upstream stream when headers are invalid", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {},
      cancel() {
        cancelled = true;
      },
    });
    const res = await speechAudioResponse({ cache: "miss", body }, "bad\nid");
    assert.equal(res, null);
    assert.equal(cancelled, true);
  });

  it("safeJsonResponse drops invalid extra headers instead of throwing", async () => {
    const res = safeJsonResponse({ error: "x" }, 502, { "X-Session-Id": "セ" });
    assert.equal(res.status, 502);
    assert.equal(res.headers.get("x-session-id"), null);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), { error: "x" });
  });
});
