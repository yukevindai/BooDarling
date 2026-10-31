import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SCARE_CONFIG,
  SCARE_TIP_LINES,
  SCARE_WEIGHTS,
  ScareMeter,
  rawToScore,
  scareFeatures,
  scareRaw,
  scareTips,
  type Blendshapes,
  type ScareFeatures,
} from "./scare";

const NONE: ScareFeatures = { brows: 0, eyes: 0, jaw: 0, sneer: 0, mouth: 0, smile: 0 };
const f = (over: Partial<ScareFeatures>): ScareFeatures => ({ ...NONE, ...over });

/** Blendshapes that produce the given feature intensities over a zero baseline. */
function bs(x: Partial<ScareFeatures>): Blendshapes {
  const pair = (k: string, v = 0) => ({ [`${k}Left`]: v, [`${k}Right`]: v });
  return {
    ...pair("browDown", x.brows),
    ...pair("eyeWide", x.eyes),
    jawOpen: x.jaw ?? 0,
    ...pair("noseSneer", x.sneer),
    ...pair("mouthStretch", x.mouth),
    ...pair("mouthSmile", x.smile),
  };
}

describe("scare features", () => {
  it("measure each feature above the visitor's own baseline", () => {
    const base = { jawOpen: 0.2, browInnerUp: 0.1 };
    const got = scareFeatures({ jawOpen: 0.5, browInnerUp: 0.05, eyeWideLeft: 0.4, eyeWideRight: 0.2, mouthFrownLeft: 0.3, mouthFrownRight: 0.3 }, base);
    assert.ok(Math.abs(got.jaw - 0.3) < 1e-9);
    assert.equal(got.brows, 0, "below baseline counts as zero");
    assert.ok(Math.abs(got.eyes - 0.3) < 1e-9);
    assert.ok(Math.abs(got.mouth - 0.3) < 1e-9);
  });

  it("scareRaw is the weighted sum minus the smile penalty (unchanged scoring)", () => {
    const x = { brows: 0.5, eyes: 0.4, jaw: 0.6, sneer: 0.2, mouth: 0.3, smile: 0.1 };
    const expected = 0.22 * 0.5 + 0.2 * 0.4 + 0.25 * 0.6 + 0.15 * 0.2 + 0.18 * 0.3 - 0.35 * 0.1;
    assert.ok(Math.abs(scareRaw(bs(x), {}) - expected) < 1e-9);
    assert.equal(scareRaw(bs({ smile: 1 }), {}), 0, "never negative");
    const w = Object.values(SCARE_WEIGHTS).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(w - 1) < 1e-9);
  });
});

describe("ScareMeter breakdown", () => {
  it("averages per-feature intensities over exactly the top-third frames behind final()", () => {
    const m = new ScareMeter({ ...SCARE_CONFIG, smoothing: 1, minFrames: 3 }); // no smoothing: frames are raw
    m.addBaseline({});
    // 6 frames → top third = 2 frames (the two jaw-drop frames).
    for (let i = 0; i < 4; i++) m.push(bs({ eyes: 0.1 }));
    m.push(bs({ jaw: 0.8, eyes: 0.2 }));
    m.push(bs({ jaw: 0.6, eyes: 0.4 }));
    const b = m.breakdown();
    assert.ok(b);
    assert.ok(Math.abs(b.jaw - 0.7) < 1e-9);
    assert.ok(Math.abs(b.eyes - 0.3) < 1e-9);
    // final() uses the same frames.
    const rawMean = (0.25 * 0.8 + 0.2 * 0.2 + 0.25 * 0.6 + 0.2 * 0.4) / 2;
    assert.equal(m.final(), rawToScore(rawMean));
  });

  it("is null when there were too few frames to score", () => {
    const m = new ScareMeter();
    m.push(bs({ jaw: 1 }));
    assert.equal(m.final(), null);
    assert.equal(m.breakdown(), null);
  });
});

describe("scareTips", () => {
  it("ranks the biggest weighted shortfalls first (max 3) and skips strong features", () => {
    // jaw (0.25) and brows (0.22) absent, eyes strong, sneer + mouth partial.
    const tips = scareTips(f({ eyes: 0.6, sneer: 0.1, mouth: 0.1 }), 40);
    assert.deepEqual(tips.map((t) => t.id), ["jaw", "brows", "mouth"]);
    assert.equal(tips[0].title, "Drop your jaw");
    assert.ok(!tips.some((t) => t.id === "eyes"));
  });

  it("returns fewer tips when only one feature is short", () => {
    const strong = 0.45;
    const tips = scareTips(f({ brows: strong, eyes: strong, jaw: strong, mouth: strong, sneer: 0 }), 85);
    assert.deepEqual(tips.map((t) => t.id), ["sneer"]);
  });

  it("puts a smile tip first when smiling cost points", () => {
    const tips = scareTips(f({ smile: 0.2, eyes: 0.6, brows: 0.6, mouth: 0.6, sneer: 0.6 }), 60);
    assert.deepEqual(tips.map((t) => t.id), ["smile", "jaw"]);
    assert.equal(tips[0].detail, SCARE_TIP_LINES.smile.detail);
    // A trace of smile (under 3 points) is ignored.
    assert.ok(!scareTips(f({ smile: 0.01 }), 10).some((t) => t.id === "smile"));
  });

  it("flawless when nothing is short or the score is near the top", () => {
    const all = f({ brows: 0.5, eyes: 0.5, jaw: 0.5, sneer: 0.5, mouth: 0.5 });
    assert.deepEqual(scareTips(all, 100).map((t) => t.id), ["flawless"]);
    assert.deepEqual(scareTips(f({ jaw: 1, eyes: 1 }), 97).map((t) => t.id), ["flawless"]);
    assert.deepEqual(scareTips(all, 80).map((t) => t.id), ["flawless"]);
  });

  it("no breakdown or no score → no tips (skipped BooCamp has no Aura-max)", () => {
    assert.deepEqual(scareTips(null, 50), []);
    assert.deepEqual(scareTips(f({}), null), []);
  });

  it("always 1–3 tips for a scored face", () => {
    for (const x of [f({}), f({ smile: 1 }), f({ jaw: 1 }), f({ brows: 0.3, smile: 0.5 })]) {
      const n = scareTips(x, 20).length;
      assert.ok(n >= 1 && n <= 3, `got ${n}`);
    }
  });

  it("end to end: a meter's breakdown feeds the tips", () => {
    const m = new ScareMeter();
    m.addBaseline({});
    for (let i = 0; i < 30; i++) m.push(bs({ eyes: 0.7, brows: 0.6, smile: 0.3 }));
    const tips = scareTips(m.breakdown(), m.final());
    assert.equal(tips[0].id, "smile");
    assert.equal(tips[1].id, "jaw");
  });
});
