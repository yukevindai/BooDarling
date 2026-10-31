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

/** Weighted scary-face intensity above baseline, ~0..0.6 for a big face. */
export function scareRaw(bs: Blendshapes, base: Blendshapes): number {
  const d = (k: string) => Math.max(0, (bs[k] ?? 0) - (base[k] ?? 0));
  const pair = (k: string) => (d(`${k}Left`) + d(`${k}Right`)) / 2;
  const brows = Math.max(pair("browDown"), d("browInnerUp"));
  const eyes = pair("eyeWide");
  const jaw = d("jawOpen");
  const sneer = pair("noseSneer");
  const mouth = Math.max(pair("mouthStretch"), pair("mouthFrown"), pair("mouthUpperUp"));
  const smile = pair("mouthSmile");
  return Math.max(0, 0.22 * brows + 0.2 * eyes + 0.25 * jaw + 0.15 * sneer + 0.18 * mouth - 0.35 * smile);
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
    const raw = scareRaw(bs, base);
    this.smoothed = this.samples.length ? this.smoothed + this.cfg.smoothing * (raw - this.smoothed) : raw;
    this.samples.push(this.smoothed);
    return rawToScore(this.smoothed, this.cfg);
  }

  get frames() {
    return this.samples.length;
  }

  /** Mean of the top third of smoothed frames, or null if there wasn't enough to judge. */
  final(): number | null {
    if (this.samples.length < this.cfg.minFrames) return null;
    const sorted = [...this.samples].sort((a, b) => b - a);
    const n = Math.max(1, Math.round(sorted.length * this.cfg.topFraction));
    const mean = sorted.slice(0, n).reduce((a, b) => a + b, 0) / n;
    return rawToScore(mean, this.cfg);
  }
}

export function scareVerdict(score: number): string {
  if (score >= 85) return "PETRIFYING, DARLING";
  if (score >= 60) return "GENUINELY GHASTLY";
  if (score >= 35) return "MILDLY UNSETTLING";
  return "ABOUT AS SCARY AS A PUPPY";
}
