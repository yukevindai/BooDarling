import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LruCache, critiqueCacheKey } from "./cache";
import { createCritique, validateCritiqueRequest, type CreateCritiqueOptions } from "./critique";
import { ANNOUNCEMENT_LINES, PRESET_CRITIQUES, pickPresetCritique } from "./lines";
import { CriticProviderError } from "./providers/errors";
import type { BaronessReadiness, CriticInput, CriticProvider, CritiqueResponse } from "./types";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
const DATA_URL = `data:image/jpeg;base64,${JPEG.toString("base64")}`;
const MODEL_TEXT = "Darling, the spots are timid where the reference roars. Add long red gloves and commit to the contrast.";

function body(over: { sessionId?: string; resultSessionId?: string; aura?: number; image?: string; referenceId?: string } = {}) {
  const sessionId = over.sessionId ?? "sess-1";
  return {
    capture: { sessionId, outfitImage: over.image ?? DATA_URL },
    result: {
      status: "ok",
      sessionId: over.resultSessionId ?? sessionId,
      aura: over.aura ?? 42,
      lookId: "classic-dalmatian",
      referenceId: over.referenceId ?? "classic-dalmatian-01",
      similarity: 0.71,
      referenceScores: [{ referenceId: "classic-dalmatian-01", similarity: 0.71 }],
      modelVersion: "m1",
      referenceVersion: "r1",
      calibrationVersion: "c1",
    },
  };
}

type Behaviour = (input: CriticInput, signal: AbortSignal, call: number) => Promise<string>;

class FakeProvider implements CriticProvider {
  readonly id = "fake";
  readonly model = "fake-1";
  calls = 0;
  inputs: CriticInput[] = [];
  constructor(private readonly behaviour: Behaviour) {}
  critique(input: CriticInput, signal: AbortSignal): Promise<string> {
    this.calls++;
    this.inputs.push(input);
    return this.behaviour(input, signal, this.calls);
  }
  async readiness(): Promise<BaronessReadiness> {
    return { ready: true, provider: this.id, detail: {}, problems: [] };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const REF_IMAGE = { mimeType: "image/jpeg" as const, base64: "cmVm" };

function opts(provider: CriticProvider, extra: Partial<CreateCritiqueOptions> = {}): CreateCritiqueOptions {
  return {
    provider,
    timeoutMs: 2000,
    retryMinBudgetMs: 500,
    cache: null,
    log: () => {},
    resolveReference: async (referenceId) =>
      referenceId === "classic-dalmatian-01"
        ? {
            referenceId,
            lookId: "classic-dalmatian",
            lookLabel: "Classic Dalmatian Coat",
            lookDescription: "Spotted coat.",
            imagePath: "/virtual/01.jpg",
          }
        : null,
    loadReferenceImage: async () => REF_IMAGE,
    ...extra,
  };
}

function ok(outcome: Awaited<ReturnType<typeof createCritique>>): CritiqueResponse {
  assert.equal(outcome.status, 200, JSON.stringify(outcome.body));
  return outcome.body as CritiqueResponse;
}

const presetFor = (aura: number, sessionId = "sess-1") => pickPresetCritique(aura, sessionId).text;

describe("createCritique", () => {
  it("returns sanitized model text on success and passes both images + look metadata", async () => {
    const p = new FakeProvider(async () => `**${MODEL_TEXT}**`);
    const res = ok(await createCritique(body(), opts(p)));
    assert.deepEqual(res, { sessionId: "sess-1", text: MODEL_TEXT, source: "model" });
    assert.equal(p.calls, 1);
    const input = p.inputs[0];
    assert.equal(input.userImage.mimeType, "image/jpeg");
    assert.equal(input.userImage.base64, JPEG.toString("base64"));
    assert.deepEqual(input.referenceImage, REF_IMAGE);
    assert.equal(input.aura, 42);
    assert.equal(input.lookLabel, "Classic Dalmatian Coat");
    assert.equal(input.lookDescription, "Spotted coat.");
  });

  it("falls back to a preset on timeout (even if the provider ignores the signal)", async () => {
    const p = new FakeProvider(() => new Promise<string>(() => {}));
    const t0 = Date.now();
    const res = ok(await createCritique(body({ aura: 80 }), opts(p, { timeoutMs: 150 })));
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(res.source, "preset");
    assert.equal(res.text, presetFor(80));
    assert.ok(PRESET_CRITIQUES.strong.some((l) => l.text === res.text));
    assert.equal(p.calls, 1);
  });

  it("falls back to a preset when the provider throws (non-transient, no retry)", async () => {
    const p = new FakeProvider(async () => {
      throw new CriticProviderError("bad request", { status: 400 });
    });
    const res = ok(await createCritique(body({ aura: 10 }), opts(p)));
    assert.equal(res.source, "preset");
    assert.equal(res.text, presetFor(10));
    assert.equal(p.calls, 1);
  });

  it("falls back to a preset when the text is unsafe", async () => {
    for (const unsafe of ["Your body is wrong for this coat. Add gloves.", "I would score this 90 out of 100. Add gloves.", "", "<think>hmm"]) {
      const p = new FakeProvider(async () => unsafe);
      const res = ok(await createCritique(body(), opts(p)));
      assert.equal(res.source, "preset", unsafe);
    }
  });

  it("answers an unavailable result with the fixed line without calling the provider", async () => {
    const p = new FakeProvider(async () => MODEL_TEXT);
    const res = ok(
      await createCritique(
        { capture: { sessionId: "s2", outfitImage: DATA_URL }, result: { status: "unavailable", sessionId: "s2", message: "down" } },
        opts(p),
      ),
    );
    assert.deepEqual(res, { sessionId: "s2", text: ANNOUNCEMENT_LINES.unavailable.text, source: "preset" });
    assert.equal(p.calls, 0);
  });

  it("rejects a sessionId mismatch with 400", async () => {
    const p = new FakeProvider(async () => MODEL_TEXT);
    const out = await createCritique(body({ resultSessionId: "other" }), opts(p));
    assert.equal(out.status, 400);
    assert.match((out.body as { error: string }).error, /sessionId/);
    assert.equal(p.calls, 0);
  });

  it("rejects bad images and malformed bodies with 400", async () => {
    const p = new FakeProvider(async () => MODEL_TEXT);
    const bad: unknown[] = [
      body({ image: "data:image/jpeg;base64,aGVsbG8=" }),
      body({ image: "https://example.com/x.jpg" }),
      body({ aura: 101 }),
      body({ aura: Number.NaN }),
      body({ sessionId: "" }),
      body({ sessionId: "x".repeat(129) }),
      { capture: { sessionId: "a", outfitImage: DATA_URL } },
      null,
      "nope",
      { capture: { sessionId: "a", outfitImage: DATA_URL }, result: { status: "weird", sessionId: "a" } },
    ];
    for (const b of bad) {
      const out = await createCritique(b, opts(p));
      assert.equal(out.status, 400, JSON.stringify(b)?.slice(0, 120));
    }
    assert.equal(p.calls, 0);
  });

  it("uses a preset for an unknown reference without calling the provider", async () => {
    const p = new FakeProvider(async () => MODEL_TEXT);
    const res = ok(await createCritique(body({ referenceId: "nope" }), opts(p)));
    assert.equal(res.source, "preset");
    assert.equal(p.calls, 0);
  });

  it("uses a preset when the reference image cannot be loaded", async () => {
    const p = new FakeProvider(async () => MODEL_TEXT);
    const res = ok(
      await createCritique(body(), opts(p, { loadReferenceImage: async () => Promise.reject(new Error("ENOENT")) })),
    );
    assert.equal(res.source, "preset");
    assert.equal(p.calls, 0);
  });

  it("serves exact repeats from the cache (model results only)", async () => {
    const cache = new LruCache<string>(10, 60_000);
    const p = new FakeProvider(async () => MODEL_TEXT);
    const a = ok(await createCritique(body(), opts(p, { cache })));
    const b = ok(await createCritique(body(), opts(p, { cache })));
    assert.deepEqual(a, b);
    assert.equal(b.source, "model");
    assert.equal(p.calls, 1);
    // Different aura → different key.
    ok(await createCritique(body({ aura: 43 }), opts(p, { cache })));
    assert.equal(p.calls, 2);

    const failing = new FakeProvider(async () => {
      throw new Error("boom");
    });
    ok(await createCritique(body({ aura: 7 }), opts(failing, { cache })));
    ok(await createCritique(body({ aura: 7 }), opts(failing, { cache })));
    assert.equal(failing.calls, 2, "presets are not cached");
  });

  it("does not serve a stale cached critique after the reference image or look metadata changes", async () => {
    const cache = new LruCache<string>(10, 60_000);
    const p = new FakeProvider(async () => MODEL_TEXT);
    let image = REF_IMAGE;
    let label = "Classic Dalmatian Coat";
    let description = "Spotted coat.";
    const extra: Partial<CreateCritiqueOptions> = {
      cache,
      loadReferenceImage: async () => image,
      resolveReference: async (referenceId) => ({
        referenceId,
        lookId: "classic-dalmatian",
        lookLabel: label,
        lookDescription: description,
        imagePath: "/virtual/01.jpg",
      }),
    };
    ok(await createCritique(body(), opts(p, extra)));
    ok(await createCritique(body(), opts(p, extra)));
    assert.equal(p.calls, 1, "identical inputs hit the cache");

    image = { mimeType: "image/jpeg", base64: "c3dhcHBlZA==" }; // file swapped, same referenceVersion
    ok(await createCritique(body(), opts(p, extra)));
    assert.equal(p.calls, 2, "a swapped reference image misses the cache");

    label = "Punk Tour Jacket";
    ok(await createCritique(body(), opts(p, extra)));
    assert.equal(p.calls, 3, "a changed look label misses the cache");

    description = "Studded leather.";
    ok(await createCritique(body(), opts(p, extra)));
    assert.equal(p.calls, 4, "a changed look description misses the cache");
  });

  it("retries exactly once on a transient error", async () => {
    const p = new FakeProvider(async (_i, _s, call) => {
      if (call === 1) throw new CriticProviderError("HTTP 503", { transient: true, status: 503 });
      return MODEL_TEXT;
    });
    const res = ok(await createCritique(body(), opts(p)));
    assert.equal(res.source, "model");
    assert.equal(p.calls, 2);

    const always = new FakeProvider(async () => {
      throw new TypeError("fetch failed");
    });
    const res2 = ok(await createCritique(body(), opts(always)));
    assert.equal(res2.source, "preset");
    assert.equal(always.calls, 2);
  });

  it("does not retry when too little budget remains", async () => {
    const p = new FakeProvider(async () => {
      await sleep(120);
      throw new CriticProviderError("HTTP 429", { transient: true, status: 429 });
    });
    const res = ok(await createCritique(body(), opts(p, { timeoutMs: 600, retryMinBudgetMs: 500 })));
    assert.equal(res.source, "preset");
    assert.equal(p.calls, 1);
  });

  it("returns quickly when the client aborts, and never retries after an abort", async () => {
    const pre = new AbortController();
    pre.abort();
    const p = new FakeProvider(async () => MODEL_TEXT);
    const res = ok(await createCritique(body(), opts(p, { signal: pre.signal })));
    assert.equal(res.source, "preset");
    assert.equal(p.calls, 0);

    const mid = new AbortController();
    const slow = new FakeProvider(() => new Promise<string>(() => {}));
    setTimeout(() => mid.abort(), 50);
    const t0 = Date.now();
    const res2 = ok(await createCritique(body(), opts(slow, { signal: mid.signal, timeoutMs: 5000 })));
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(res2.source, "preset");
    assert.equal(slow.calls, 1);
  });

  it("never changes the score-dependent preset band", async () => {
    const p = new FakeProvider(async () => {
      throw new Error("x");
    });
    for (const [aura, band] of [[0, "dismal"], [30, "weak"], [60, "promising"], [80, "strong"], [95, "iconic"]] as const) {
      const res = ok(await createCritique(body({ aura }), opts(p)));
      assert.ok(PRESET_CRITIQUES[band].some((l) => l.text === res.text), `${aura}`);
    }
  });

  it("logs one line without image data", async () => {
    const lines: string[] = [];
    const p = new FakeProvider(async () => MODEL_TEXT);
    await createCritique(body(), opts(p, { log: (l) => lines.push(l) }));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /provider=fake .*source=model/);
    assert.ok(!lines[0].includes(JPEG.toString("base64")));
  });
});

describe("validateCritiqueRequest / cache key", () => {
  it("accepts a well-formed request", () => {
    const v = validateCritiqueRequest(body());
    assert.ok(v.ok && v.value.kind === "ok");
  });

  it("cache keys change with every component", () => {
    const base = {
      outfitImage: DATA_URL,
      referenceId: "r",
      referenceImage: "image/jpeg;cmVm",
      lookId: "l",
      lookLabel: "Label",
      lookDescription: "Desc",
      aura: 1,
      modelVersion: "m",
      referenceVersion: "rv",
      calibrationVersion: "c",
      providerId: "p",
      providerModel: "pm",
      promptVersion: "v",
    };
    const k = critiqueCacheKey(base);
    assert.match(k, /^[0-9a-f]{64}$/);
    for (const key of Object.keys(base) as Array<keyof typeof base>) {
      const changed = { ...base, [key]: typeof base[key] === "number" ? 2 : `${base[key]}x` };
      assert.notEqual(critiqueCacheKey(changed), k, key);
    }
  });

  it("LRU evicts the oldest entry and honours TTL", () => {
    let t = 0;
    const c = new LruCache<string>(2, 100, () => t);
    c.set("a", "1");
    c.set("b", "2");
    c.get("a");
    c.set("c", "3");
    assert.equal(c.get("b"), undefined);
    assert.equal(c.get("a"), "1");
    t = 200;
    assert.equal(c.get("a"), undefined);
  });
});
