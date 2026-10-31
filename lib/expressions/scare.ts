/**
 * BooCamp Scare Score (spec §9). Pure logic, no DOM.
 *
 * Measures a PERFORMED scary expression relative to the visitor's own neutral
 * face: frowning/raised brows, wide eyes, open jaw, sneer, stretched mouth.
 * Smiling subtracts. It does not measure actual fear.
 */
export type Blendshapes = Record<string, number>;

export const SCARE_CONFIG = {
  /** Neutral face sampled first; each coefficient is measured above this. */
  baselineMs: 1500,
  /** The challenge itself (spec: five seconds). */
  challengeMs: 5000,
  /** Exponential smoothing for the live meter (0..1, higher = snappier). */
  smoothing: 0.35,
  /** Raw score that maps to 100. Tune on real faces at the venue. */
  fullScaleRaw: 0.45,
  /** Final score = mean of the best fraction of frames, rewarding a held face over a blink. */
  topFraction: 1 / 3,
  /** Total time without a face before we give up and skip (masks, makeup, walked off). */
  maxLostMs: 2500,
  /** Need at least this many challenge frames for a fair score. */
  minFrames: 10,
};
export type ScareConfig = typeof SCARE_CONFIG;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** The scary-face features the score rewards. */
export type ScareFeature = "brows" | "eyes" | "jaw" | "sneer" | "mouth";
export const SCARE_FEATURES: readonly ScareFeature[] = ["brows", "eyes", "jaw", "sneer", "mouth"];
/** Weight of each feature in the raw score (they sum to 1). */
export const SCARE_WEIGHTS: Readonly<Record<ScareFeature, number>> = { brows: 0.22, eyes: 0.2, jaw: 0.25, sneer: 0.15, mouth: 0.18 };
/** Smiling subtracts this much per unit of smile. */
export const SMILE_PENALTY = 0.35;

/** Per-feature intensity above the visitor's own neutral baseline (each 0..1). */
export type ScareFeatures = Record<ScareFeature, number> & { smile: number };

export function scareFeatures(bs: Blendshapes, base: Blendshapes): ScareFeatures {
  const d = (k: string) => Math.max(0, (bs[k] ?? 0) - (base[k] ?? 0));
  const pair = (k: string) => (d(`${k}Left`) + d(`${k}Right`)) / 2;
  return {
    brows: Math.max(pair("browDown"), d("browInnerUp")),
    eyes: pair("eyeWide"),
    jaw: d("jawOpen"),
    sneer: pair("noseSneer"),
    mouth: Math.max(pair("mouthStretch"), pair("mouthFrown"), pair("mouthUpperUp")),
    smile: pair("mouthSmile"),
  };
}

function rawFromFeatures(f: ScareFeatures): number {
  let raw = -SMILE_PENALTY * f.smile;
  for (const k of SCARE_FEATURES) raw += SCARE_WEIGHTS[k] * f[k];
  return Math.max(0, raw);
}

/** Weighted scary-face intensity above baseline, ~0..0.6 for a big face. */
export function scareRaw(bs: Blendshapes, base: Blendshapes): number {
  return rawFromFeatures(scareFeatures(bs, base));
}

export function rawToScore(raw: number, cfg: ScareConfig = SCARE_CONFIG): number {
  return Math.round(100 * clamp01(raw / cfg.fullScaleRaw));
}

/** Accumulates a neutral baseline, then smoothed challenge frames, then a final score. */
export class ScareMeter {
  private baseSum: Blendshapes = {};
  private baseCount = 0;
  private smoothed = 0;
  private samples: number[] = [];
  /** Per-frame feature intensities, parallel to `samples`. */
  private featureFrames: ScareFeatures[] = [];

  constructor(private cfg: ScareConfig = SCARE_CONFIG) {}

  addBaseline(bs: Blendshapes) {
    for (const [k, v] of Object.entries(bs)) this.baseSum[k] = (this.baseSum[k] ?? 0) + v;
    this.baseCount++;
  }

  get hasBaseline() {
    return this.baseCount > 0;
  }

  baseline(): Blendshapes {
    if (!this.baseCount) return {};
    return Object.fromEntries(Object.entries(this.baseSum).map(([k, v]) => [k, v / this.baseCount]));
  }

  /** Add a challenge frame; returns the live 0–100 meter value. */
  push(bs: Blendshapes, base = this.baseline()): number {
    const features = scareFeatures(bs, base);
    const raw = rawFromFeatures(features);
    this.smoothed = this.samples.length ? this.smoothed + this.cfg.smoothing * (raw - this.smoothed) : raw;
    this.samples.push(this.smoothed);
    this.featureFrames.push(features);
    return rawToScore(this.smoothed, this.cfg);
  }

  get frames() {
    return this.samples.length;
  }

  /** Indices of the frames that make up the final score (top third by smoothed value). */
  private topFrames(): number[] {
    const order = this.samples.map((_, i) => i).sort((a, b) => this.samples[b] - this.samples[a]);
    const n = Math.max(1, Math.round(order.length * this.cfg.topFraction));
    return order.slice(0, n);
  }

  /** Mean of the top third of smoothed frames, or null if there wasn't enough to judge. */
  final(): number | null {
    if (this.samples.length < this.cfg.minFrames) return null;
    const top = this.topFrames();
    const mean = top.reduce((a, i) => a + this.samples[i], 0) / top.length;
    return rawToScore(mean, this.cfg);
  }

  /**
   * Mean per-feature intensities over the same frames as final() (null when final() is null).
   * Feeds the Scare Aura-max tips; it never changes the score.
   */
  breakdown(): ScareFeatures | null {
    if (this.samples.length < this.cfg.minFrames) return null;
    const top = this.topFrames();
    const out: ScareFeatures = { brows: 0, eyes: 0, jaw: 0, sneer: 0, mouth: 0, smile: 0 };
    for (const i of top) for (const k of Object.keys(out) as Array<keyof ScareFeatures>) out[k] += this.featureFrames[i][k];
    for (const k of Object.keys(out) as Array<keyof ScareFeatures>) out[k] /= top.length;
    return out;
  }
}

/** One Scare Aura-max tip (facial expression only — no shopping, no model call). */
export type ScareTip = { id: ScareFeature | "smile" | "flawless"; title: string; detail: string };

export const SCARE_TIP_LINES: Readonly<Record<ScareTip["id"], { title: string; detail: string }>> = {
  jaw: { title: "Drop your jaw", detail: "A silent scream: let it hang open." },
  eyes: { title: "Widen your eyes", detail: "Open them until they ache." },
  brows: { title: "Furrow those brows", detail: "Crush them down, or hoist them in horror." },
  sneer: { title: "Curl your lip into a sneer", detail: "Wrinkle that nose as if something died." },
  mouth: { title: "Stretch your mouth wide", detail: "Drag the corners down and out." },
  smile: { title: "Stop smiling, darling", detail: "Terror never grins." },
  flawless: { title: "Flawless fright, darling", detail: "Not a muscle wasted. Go haunt someone." },
};

export const SCARE_TIPS_CONFIG = {
  /** At most this many tips. */
  maxTips: 3,
  /** A feature at or above this fraction of its full-scale intensity needs no tip. */
  strongRatio: 0.75,
  /** Smile tip when smiling cost at least this many score points. */
  smilePoints: 3,
  /** At or above this score the face is "flawless" unless smiling cost points. */
  flawlessScore: 95,
};

/**
 * 1–3 expression tips from a breakdown, deterministic:
 *  - a smile tip first if smiling cost points;
 *  - then the features with the biggest shortfall in score points vs. their weight. A feature's
 *    full-scale intensity is the level at which every feature together would reach 100
 *    (fullScaleRaw / sum of weights); features at >= strongRatio of it are left alone;
 *  - if nothing is short, one "flawless fright" line.
 */
export function scareTips(
  breakdown: ScareFeatures | null,
  score: number | null,
  cfg: ScareConfig = SCARE_CONFIG,
  tipsCfg = SCARE_TIPS_CONFIG,
): ScareTip[] {
  if (!breakdown || score === null) return [];
  const tip = (id: ScareTip["id"]): ScareTip => ({ id, ...SCARE_TIP_LINES[id] });
  const toPoints = (raw: number) => (100 * raw) / cfg.fullScaleRaw;
  const smileCost = toPoints(SMILE_PENALTY * breakdown.smile);
  const smiled = smileCost >= tipsCfg.smilePoints;
  if (score >= tipsCfg.flawlessScore && !smiled) return [tip("flawless")];

  const totalWeight = SCARE_FEATURES.reduce((a, k) => a + SCARE_WEIGHTS[k], 0);
  const full = cfg.fullScaleRaw / totalWeight;
  const short = SCARE_FEATURES.map((k) => ({ k, intensity: breakdown[k], shortfall: toPoints(SCARE_WEIGHTS[k] * Math.max(0, full - breakdown[k])) }))
    .filter((x) => x.intensity < tipsCfg.strongRatio * full)
    .sort((a, b) => b.shortfall - a.shortfall || SCARE_FEATURES.indexOf(a.k) - SCARE_FEATURES.indexOf(b.k));

  const tips: ScareTip[] = smiled ? [tip("smile")] : [];
  for (const x of short) {
    if (tips.length >= tipsCfg.maxTips) break;
    tips.push(tip(x.k));
  }
  return tips.length ? tips : [tip("flawless")];
}

export function scareVerdict(score: number): string {
  if (score >= 85) return "PETRIFYING, DARLING";
  if (score >= 60) return "GENUINELY GHASTLY";
  if (score >= 35) return "MILDLY UNSETTLING";
  return "ABOUT AS SCARY AS A PUPPY";
}
