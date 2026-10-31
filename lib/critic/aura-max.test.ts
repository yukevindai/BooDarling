import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import manifestJson from "../../references/manifest.json";
import { BARONESS_SYSTEM_PROMPT, buildBaronessUserPrompt } from "../baroness-prompt";
import {
  AURA_MAX_MAX_STEPS,
  amazonSearchUrl,
  filterMissing,
  parseAuraMax,
  parseChecklist,
  parseCritiqueOutput,
  resolveAuraMax,
  visibleChecklist,
  type ChecklistItem,
} from "./aura-max";
import { LruCache, type CachedCritique } from "./cache";
import { createCritique, type CreateCritiqueOptions } from "./critique";
import { pickPresetCritique } from "./lines";
import { parseManifest } from "./manifest";
import { GeminiCriticProvider, buildGeminiRequest } from "./providers/gemini";
import { MockCriticProvider, mockReply } from "./providers/mock";
import { buildOllamaRequest } from "./providers/ollama";
import type { BaronessReadiness, CriticInput, CriticProvider, CritiqueResponse } from "./types";

const CHECKLIST: ChecklistItem[] = parseChecklist([
  { id: "crimson-gown", label: "Crimson satin gown", why: "The base.", search: "red satin gown", visibleInCrop: true, priority: 1 },
  { id: "opera-gloves", label: "Crimson opera gloves", why: "Drama.", search: "red satin opera gloves", visibleInCrop: true, priority: 2 },
  { id: "cane", label: "Slim black cane", why: "Menace.", search: "black costume cane", visibleInCrop: true, priority: 3 },
  { id: "brooch", label: "Jet brooch", why: "Sparkle.", search: "black brooch", visibleInCrop: true, priority: 4 },
  { id: "two-tone-wig", label: "Two-tone wig", why: "Hair.", search: "cruella wig", visibleInCrop: false, priority: 5 },
  { id: "red-lipstick", label: "Bold red lipstick", why: "Lips.", search: "red lipstick", visibleInCrop: false, priority: 6 },
]);
const VISIBLE = visibleChecklist(CHECKLIST).map(({ id, label }) => ({ id, label }));
const LOOK = { lookId: "red-glamour", lookLabel: "Red Glamour", checklist: CHECKLIST };
const CRIT = "Darling, the red is timid where the reference roars. Pull on long crimson gloves and commit to the drama.";

describe("parseChecklist", () => {
  it("sorts by priority, drops invalid/duplicate entries, defaults visibleInCrop to false", () => {
    const c = parseChecklist([
      { id: "b", label: "B", priority: 2, visibleInCrop: true },
      { id: "a", label: "A", priority: 1 },
      { id: "a", label: "Dup", priority: 0 },
      { id: "Bad Id", label: "X" },
      { id: "c" },
      "nope",
    ]);
    assert.deepEqual(c.map((x) => x.id), ["a", "b"]);
    assert.equal(c[0].visibleInCrop, false);
    assert.equal(c[0].search, "A", "search defaults to the label");
    assert.deepEqual(parseChecklist(undefined), []);
  });

  it("the real red-glamour checklist parses: gown/gloves/cane visible, wig/lips/eyes not", () => {
    const { looks } = parseManifest(manifestJson);
    const checklist = looks.get("red-glamour")?.checklist ?? [];
    assert.deepEqual(
      checklist.filter((c) => c.visibleInCrop).map((c) => c.id),
      ["crimson-gown", "opera-gloves", "cane"],
    );
    assert.deepEqual(
      checklist.filter((c) => !c.visibleInCrop).map((c) => c.id),
      ["two-tone-wig", "red-lipstick", "smoky-eyes"],
    );
    for (const c of checklist) assert.ok(c.why && c.search, `${c.id} has why + search`);
  });
});

describe("parseCritiqueOutput", () => {
  it("parses valid JSON", () => {
    const r = parseCritiqueOutput(JSON.stringify({ critique: CRIT, missing: ["opera-gloves", "cane"] }), VISIBLE);
    assert.equal(r.critique, CRIT);
    assert.deepEqual(r.missing, ["opera-gloves", "cane"]);
  });

  it("parses JSON in code fences and after a <think> block", () => {
    const fenced = "```json\n" + JSON.stringify({ critique: CRIT, missing: ["cane"] }) + "\n```";
    assert.deepEqual(parseCritiqueOutput(fenced, VISIBLE), { critique: CRIT, missing: ["cane"] });
    const think = "<think>hmm {not json}</think>\n" + JSON.stringify({ critique: CRIT, missing: [] });
    assert.deepEqual(parseCritiqueOutput(think, VISIBLE), { critique: CRIT, missing: [] });
  });

  it("plain text → critique only, missing unknown", () => {
    assert.deepEqual(parseCritiqueOutput(CRIT, VISIBLE), { critique: CRIT, missing: null });
    assert.deepEqual(parseCritiqueOutput(undefined, VISIBLE), { critique: "", missing: null });
  });

  it("salvages the critique from truncated JSON (missing unknown)", () => {
    const r = parseCritiqueOutput(`{"critique": "Darling, \\"no\\". Add gloves.", "missing": ["ca`, VISIBLE);
    assert.equal(r.critique, 'Darling, "no". Add gloves.');
    assert.equal(r.missing, null);
  });

  it("JSON without a critique yields empty text (→ preset) and unknown missing", () => {
    assert.deepEqual(parseCritiqueOutput('{"missing": ["cane"]}', VISIBLE), { critique: "", missing: null });
  });

  it("filters unknown and invisible ids, dedupes, keeps order, caps at 3, accepts exact labels", () => {
    const r = parseCritiqueOutput(
      JSON.stringify({
        critique: CRIT,
        missing: ["two-tone-wig", "made-up", "cane", "CANE", 7, "Crimson opera gloves", "brooch", "crimson-gown"],
      }),
      VISIBLE,
    );
    assert.deepEqual(r.missing, ["cane", "opera-gloves", "brooch"]);
    assert.equal(r.missing?.length, AURA_MAX_MAX_STEPS);
    assert.equal(filterMissing("cane", VISIBLE), null, "non-array → unknown");
    assert.deepEqual(filterMissing([], VISIBLE), []);
  });
});

describe("resolveAuraMax", () => {
  it("model missing → those steps in the model's order, finishing = non-visible pieces", () => {
    const a = resolveAuraMax(LOOK, ["cane", "crimson-gown"]);
    assert.ok(a);
    assert.deepEqual(a.steps.map((s) => s.id), ["cane", "crimson-gown"]);
    assert.deepEqual(a.finishing.map((s) => s.id), ["two-tone-wig", "red-lipstick"]);
    assert.equal(a.complete, false);
    assert.equal(a.source, "model");
    assert.deepEqual(Object.keys(a.steps[0]).sort(), ["id", "label", "search", "why"]);
  });

  it("nothing missing → complete", () => {
    const a = resolveAuraMax(LOOK, []);
    assert.equal(a?.complete, true);
    assert.deepEqual(a?.steps, []);
    assert.equal(a?.source, "model");
    assert.equal(a?.finishing.length, 2);
  });

  it("unknown (preset/timeout) → top visible pieces by priority, source fallback", () => {
    const a = resolveAuraMax(LOOK, null);
    assert.deepEqual(a?.steps.map((s) => s.id), ["crimson-gown", "opera-gloves", "cane"]);
    assert.equal(a?.source, "fallback");
    assert.equal(a?.complete, false);
  });

  it("never lists a non-visible piece as a step, and no checklist → no card", () => {
    const a = resolveAuraMax(LOOK, ["two-tone-wig"]);
    assert.deepEqual(a?.steps, []);
    assert.equal(resolveAuraMax({ lookId: "x", lookLabel: "X" }, null), undefined);
  });
});

describe("parseAuraMax (wire validation) and amazonSearchUrl", () => {
  it("round-trips a resolved card and rejects junk", () => {
    const a = resolveAuraMax(LOOK, ["opera-gloves"]);
    assert.deepEqual(parseAuraMax(JSON.parse(JSON.stringify(a))), a);
    assert.equal(parseAuraMax(null), undefined);
    assert.equal(parseAuraMax({ ...a, source: "guess" }), undefined);
    assert.equal(parseAuraMax({ ...a, steps: "x" }), undefined);
    const tooMany = parseAuraMax({ ...a, steps: [...CHECKLIST, ...CHECKLIST] });
    assert.equal(tooMany?.steps.length, 3);
  });

  it("builds an encoded amazon.ca search URL", () => {
    assert.equal(amazonSearchUrl("red satin  opera gloves"), "https://www.amazon.ca/s?k=red%20satin%20opera%20gloves");
    assert.equal(amazonSearchUrl("a&b=c#d"), "https://www.amazon.ca/s?k=a%26b%3Dc%23d");
  });
});

describe("prompt + providers ask for {critique, missing} in the same call", () => {
  const INPUT: CriticInput = {
    userImage: { mimeType: "image/jpeg", base64: "VVNFUg==" },
    referenceImage: { mimeType: "image/png", base64: "UkVG" },
    aura: 30,
    lookId: "red-glamour",
    lookLabel: "Red Glamour",
    checklist: VISIBLE,
  };
  const realFetch = globalThis.fetch;
  const savedKey = process.env.GEMINI_API_KEY;
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedKey;
  });

  it("system prompt describes the JSON shape; user prompt lists only visible checklist ids", () => {
    assert.match(BARONESS_SYSTEM_PROMPT, /"critique"/);
    assert.match(BARONESS_SYSTEM_PROMPT, /"missing"/);
    assert.match(BARONESS_SYSTEM_PROMPT, /CLEARLY ABSENT/);
    const u = buildBaronessUserPrompt(INPUT);
    assert.match(u, /- opera-gloves: Crimson opera gloves/);
    assert.ok(!u.includes("two-tone-wig"));
    assert.match(buildBaronessUserPrompt({ ...INPUT, checklist: undefined }), /"missing" must be \[\]/);
  });

  it("gemini: JSON mode + schema whose missing items are an enum of visible ids", () => {
    const req = buildGeminiRequest(INPUT, "gemini-2.5-flash") as { generationConfig: Record<string, any> };
    assert.equal(req.generationConfig.responseMimeType, "application/json");
    const schema = req.generationConfig.responseSchema;
    assert.deepEqual(schema.required, ["critique", "missing"]);
    assert.deepEqual(schema.properties.missing.items.enum, ["crimson-gown", "opera-gloves", "cane", "brooch"]);
    const noList = buildGeminiRequest({ ...INPUT, checklist: undefined }, "gemini-2.5-flash") as { generationConfig: Record<string, any> };
    assert.equal(noList.generationConfig.responseSchema.properties.missing.items.enum, undefined);
  });

  it("gemini: a 400 blaming the schema retries once without responseSchema (JSON mode kept)", async () => {
    process.env.GEMINI_API_KEY = "k";
    const bodies: any[] = [];
    globalThis.fetch = (async (_url: unknown, init: RequestInit = {}) => {
      bodies.push(JSON.parse(String(init.body)));
      const body =
        bodies.length === 1
          ? { error: { message: "Invalid JSON payload: unknown field responseSchema.propertyOrdering" } }
          : { candidates: [{ content: { parts: [{ text: '{"critique":"A. B.","missing":[]}' }] } }] };
      return new Response(JSON.stringify(body), { status: bodies.length === 1 ? 400 : 200 });
    }) as typeof fetch;
    const p = new GeminiCriticProvider("gemini-schema-test", []);
    assert.equal(await p.critique(INPUT, new AbortController().signal), '{"critique":"A. B.","missing":[]}');
    assert.equal(bodies.length, 2);
    assert.ok(bodies[0].generationConfig.responseSchema);
    assert.equal(bodies[1].generationConfig.responseSchema, undefined);
    assert.equal(bodies[1].generationConfig.responseMimeType, "application/json");
  });

  it("ollama: format json", () => {
    assert.equal((buildOllamaRequest(INPUT, "qwen3-vl:4b") as { format?: string }).format, "json");
  });

  it("mock: deterministic JSON, missing by aura band", async () => {
    const parsed = (aura: number) => JSON.parse(mockReply({ ...INPUT, aura })) as { critique: string; missing: string[] };
    assert.deepEqual(parsed(5).missing, ["crimson-gown", "opera-gloves", "cane"]);
    assert.deepEqual(parsed(30).missing.length, 2);
    assert.deepEqual(parsed(97).missing, []);
    assert.match(parsed(5).critique, /Red Glamour/);
    const p = new MockCriticProvider(0);
    assert.equal(await p.critique(INPUT, new AbortController().signal), mockReply(INPUT));
  });
});

describe("createCritique → auraMax", () => {
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
  const body = (status: "ok" | "unavailable" = "ok", aura = 42) => ({
    capture: { sessionId: "sess-am", outfitImage: `data:image/jpeg;base64,${JPEG.toString("base64")}` },
    result:
      status === "ok"
        ? { status, sessionId: "sess-am", aura, lookId: "red-glamour", referenceId: "red-glamour-01", similarity: 0.5, referenceScores: [], modelVersion: "m", referenceVersion: "r", calibrationVersion: "c" }
        : { status, sessionId: "sess-am", message: "down" },
  });
  class Fake implements CriticProvider {
    readonly id = "fake";
    readonly model = "fake-1";
    calls = 0;
    inputs: CriticInput[] = [];
    constructor(private readonly reply: (input: CriticInput) => Promise<string>) {}
    critique(input: CriticInput): Promise<string> {
      this.calls++;
      this.inputs.push(input);
      return this.reply(input);
    }
    async readiness(): Promise<BaronessReadiness> {
      return { ready: true, provider: this.id, detail: {}, problems: [] };
    }
  }
  const opts = (provider: CriticProvider, extra: Partial<CreateCritiqueOptions> = {}): CreateCritiqueOptions => ({
    provider,
    timeoutMs: 2000,
    retryMinBudgetMs: 500,
    cache: null,
    log: () => {},
    resolveReference: async (referenceId) => ({ referenceId, ...LOOK, imagePath: "/virtual/01.jpg" }),
    loadReferenceImage: async () => ({ mimeType: "image/jpeg", base64: "cmVm" }),
    ...extra,
  });
  const run = async (provider: CriticProvider, extra?: Partial<CreateCritiqueOptions>, b = body()) => {
    const out = await createCritique(b, opts(provider, extra));
    assert.equal(out.status, 200);
    return out.body as CritiqueResponse;
  };

  it("sends only visible checklist pieces to the critic and returns model steps", async () => {
    const p = new Fake(async () => JSON.stringify({ critique: CRIT, missing: ["opera-gloves", "two-tone-wig", "cane"] }));
    const r = await run(p);
    assert.equal(r.text, CRIT);
    assert.equal(r.source, "model");
    assert.deepEqual(p.inputs[0].checklist?.map((c) => c.id), ["crimson-gown", "opera-gloves", "cane", "brooch"]);
    assert.deepEqual(r.auraMax?.steps.map((s) => s.id), ["opera-gloves", "cane"]);
    assert.equal(r.auraMax?.source, "model");
    assert.equal(r.auraMax?.lookId, "red-glamour");
  });

  it("nothing visible missing → complete", async () => {
    const r = await run(new Fake(async () => JSON.stringify({ critique: CRIT, missing: [] })));
    assert.equal(r.auraMax?.complete, true);
    assert.deepEqual(r.auraMax?.steps, []);
  });

  it("plain-text reply keeps the model critique; card falls back", async () => {
    const r = await run(new Fake(async () => CRIT));
    assert.equal(r.source, "model");
    assert.equal(r.text, CRIT);
    assert.equal(r.auraMax?.source, "fallback");
  });

  it("preset (error, timeout, unsafe text) → preset critique + fallback card", async () => {
    const preset = pickPresetCritique(42, "sess-am").text;
    const failing = await run(new Fake(async () => Promise.reject(new Error("boom"))));
    assert.equal(failing.source, "preset");
    assert.equal(failing.text, preset);
    assert.equal(failing.auraMax?.source, "fallback");
    assert.deepEqual(failing.auraMax?.steps.map((s) => s.id), ["crimson-gown", "opera-gloves", "cane"]);

    const hang = new Fake(() => new Promise<string>(() => {}));
    const timedOut = await run(hang, { timeoutMs: 60 });
    assert.equal(timedOut.source, "preset");
    assert.equal(timedOut.auraMax?.source, "fallback");

    const unsafe = await run(new Fake(async () => JSON.stringify({ critique: "Your weight is the problem here, darling, truly.", missing: ["cane"] })));
    assert.equal(unsafe.source, "preset");
    assert.equal(unsafe.auraMax?.source, "fallback", "a rejected reply's missing list is not trusted");
  });

  it("unavailable result → no auraMax; look without checklist → no auraMax", async () => {
    const r = await run(new Fake(async () => CRIT), {}, body("unavailable"));
    assert.equal(r.auraMax, undefined);
    assert.equal("auraMax" in r, false);
    const bare = await run(new Fake(async () => JSON.stringify({ critique: CRIT, missing: ["cane"] })), {
      resolveReference: async (referenceId) => ({ referenceId, lookId: "x", lookLabel: "X", imagePath: "/v.jpg" }),
    });
    assert.equal("auraMax" in bare, false);
  });

  it("cache hits keep the model's missing list", async () => {
    const cache = new LruCache<CachedCritique>(10, 60_000);
    const p = new Fake(async () => JSON.stringify({ critique: CRIT, missing: ["cane"] }));
    const a = await run(p, { cache });
    const b = await run(p, { cache });
    assert.equal(p.calls, 1);
    assert.deepEqual(b, a);
    assert.deepEqual(b.auraMax?.steps.map((s) => s.id), ["cane"]);
  });

  it("works end to end with the mock provider", async () => {
    const r = await run(new MockCriticProvider(0), {}, body("ok", 10));
    assert.equal(r.source, "model");
    assert.equal(r.auraMax?.source, "model");
    assert.deepEqual(r.auraMax?.steps.map((s) => s.id), ["crimson-gown", "opera-gloves", "cane"]);
  });
});
