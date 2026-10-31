/**
 * Pure framing logic: person counting, clothing-crop policy and readiness.
 * No DOM or MediaPipe imports, so it's easy to unit-test and the same crop
 * policy can be reused for reference images (spec §3: consistent framing).
 */
import { CAPTURE_CONFIG, type CaptureConfig } from "./config";
import type { FramingStatus, NormBox, Pose } from "./types";

// MediaPipe Pose landmark indices.
export const LM = {
  nose: 0,
  lShoulder: 11, rShoulder: 12,
  lElbow: 13, rElbow: 14,
  lWrist: 15, rWrist: 16,
  lHip: 23, rHip: 24,
  lKnee: 25, rKnee: 26,
  lAnkle: 27, rAnkle: 28,
  lHeel: 29, rHeel: 30,
  lFoot: 31, rFoot: 32,
} as const;

const ARM_POINTS = [LM.lElbow, LM.rElbow, LM.lWrist, LM.rWrist];
const LOWER_POINTS = [LM.lKnee, LM.rKnee, LM.lAnkle, LM.rAnkle, LM.lHeel, LM.rHeel, LM.lFoot, LM.rFoot];

export const GUIDANCE: Record<FramingStatus, string | null> = {
  empty: null,
  idle: null,
  multiple: "One at a time, darlings.",
  partial: "Let me see the whole look, darling.",
  tooClose: "Step back a little, darling.",
  tooFar: "Closer, darling. I can't see the fabric.",
  offCenter: "To the centre, darling.",
  settling: "Hold still. Let me look at you.",
  capturing: "Perfect. Don't move.",
  captured: null,
};

const vis = (p: Pose, i: number) => p[i]?.visibility ?? 0;
const seen = (p: Pose, i: number, cfg: CaptureConfig) => !!p[i] && vis(p, i) >= cfg.minVisibility;

export function shoulderWidth(p: Pose): number {
  return Math.abs((p[LM.lShoulder]?.x ?? 0) - (p[LM.rShoulder]?.x ?? 0));
}

/** True if this pose is a real person rather than a low-confidence ghost. */
export function isPerson(p: Pose, cfg: CaptureConfig = CAPTURE_CONFIG, strict = false): boolean {
  const minVis = strict ? cfg.secondPersonMinVisibility : cfg.minVisibility;
  if (vis(p, LM.lShoulder) < minVis || vis(p, LM.rShoulder) < minVis) return false;
  return !strict || shoulderWidth(p) >= cfg.secondPersonMinShoulderWidth;
}

/** Main person = widest shoulders (closest to the mirror); others must pass a stricter check. */
export function countPeople(poses: Pose[], cfg: CaptureConfig = CAPTURE_CONFIG): { main: Pose | null; people: number } {
  const candidates = poses.filter((p) => isPerson(p, cfg));
  if (candidates.length === 0) return { main: null, people: 0 };
  candidates.sort((a, b) => shoulderWidth(b) - shoulderWidth(a));
  const [main, ...rest] = candidates;
  return { main, people: 1 + rest.filter((p) => isPerson(p, cfg, true)).length };
}

/**
 * Padded clothing box from shoulders, arms, hips and lower body.
 * Returned UNCLAMPED so callers can tell when the outfit runs off-frame.
 * Top sits just above the shoulders to keep the focus on clothing, not faces.
 */
export function computeClothingBox(p: Pose, cfg: CaptureConfig = CAPTURE_CONFIG): NormBox | null {
  const ls = p[LM.lShoulder], rs = p[LM.rShoulder];
  if (!ls || !rs) return null;
  const sw = Math.max(shoulderWidth(p), 1e-3);
  const shoulderY = (ls.y + rs.y) / 2;

  const hipsSeen = seen(p, LM.lHip, cfg) || seen(p, LM.rHip, cfg);
  const hipY = hipsSeen
    ? avg([LM.lHip, LM.rHip].filter((i) => seen(p, i, cfg)).map((i) => p[i].y))
    : shoulderY + sw * 1.6; // rough torso estimate when hips are hidden
  const torsoH = Math.max(hipY - shoulderY, sw * 0.8);

  const xPoints = [LM.lShoulder, LM.rShoulder, LM.lHip, LM.rHip, ...ARM_POINTS, ...LOWER_POINTS]
    .filter((i) => i === LM.lShoulder || i === LM.rShoulder || seen(p, i, cfg))
    .map((i) => p[i].x);
  const lowerYs = LOWER_POINTS.filter((i) => seen(p, i, cfg)).map((i) => p[i].y);

  const centerX = hipsSeen
    ? (ls.x + rs.x + (p[LM.lHip]?.x ?? ls.x) + (p[LM.rHip]?.x ?? rs.x)) / 4
    : (ls.x + rs.x) / 2;
  const padX = cfg.padSides * sw;
  const minHalfW = (cfg.minWidthToShoulders * sw) / 2;
  const left = Math.min(Math.min(...xPoints) - padX, centerX - minHalfW);
  const right = Math.max(Math.max(...xPoints) + padX, centerX + minHalfW);

  const top = shoulderY - cfg.padTop * torsoH;
  const lowest = lowerYs.length ? Math.max(...lowerYs) : hipY;
  const bottom = lowest + cfg.padBottom * torsoH;

  return { x: left, y: top, w: right - left, h: bottom - top };
}

export function clampBox(b: NormBox): NormBox {
  const x = Math.max(0, b.x), y = Math.max(0, b.y);
  const r = Math.min(1, b.x + b.w), btm = Math.min(1, b.y + b.h);
  return { x, y, w: Math.max(0, r - x), h: Math.max(0, btm - y) };
}

export type FramingEval = {
  status: FramingStatus;
  people: number;
  main: Pose | null;
  /** Clamped crop box for the main person (present whenever a person is found). */
  box: NormBox | null;
  shoulderWidth: number | null;
  centerOffset: number | null;
};

/** Classify one frame's poses into a framing status. "settling" means ready to capture. */
export function evaluateFraming(poses: Pose[], cfg: CaptureConfig = CAPTURE_CONFIG): FramingEval {
  const { main, people } = countPeople(poses, cfg);
  if (!main) {
    // Something was detected but not even shoulders are clear: likely half out of frame.
    const status: FramingStatus = poses.length ? "partial" : "empty";
    return { status, people: 0, main: null, box: null, shoulderWidth: null, centerOffset: null };
  }

  const raw = computeClothingBox(main, cfg);
  const sw = shoulderWidth(main);
  const box = raw ? clampBox(raw) : null;
  const centerOffset = raw ? raw.x + raw.w / 2 - 0.5 : null;
  const out = (status: FramingStatus): FramingEval => ({ status, people, main, box, shoulderWidth: sw, centerOffset });

  if (people > 1) return out("multiple");
  if (sw > cfg.maxShoulderWidth) return out("tooClose");
  if (sw < cfg.minShoulderWidth) return out("tooFar");

  const hipsSeen = seen(main, LM.lHip, cfg) || seen(main, LM.rHip, cfg);
  const lowerIdx = cfg.requireLowerBody === "ankles" ? [LM.lAnkle, LM.rAnkle] : [LM.lKnee, LM.rKnee];
  const lowerSeen = lowerIdx.some((i) => seen(main, i, cfg));
  // Lower body missing almost always means the camera can't fit them: step back.
  if (!hipsSeen || !lowerSeen) return out(hipsSeen ? "tooClose" : "partial");

  if (!raw) return out("partial");
  if (centerOffset !== null && Math.abs(centerOffset) > cfg.centerTolerance) return out("offCenter");

  const m = cfg.edgeMargin;
  const clipsVertically = raw.y < -m || raw.y + raw.h > 1 + m;
  const clipsSides = raw.x < -m || raw.x + raw.w > 1 + m;
  if (clipsVertically) return out("tooClose");
  if (clipsSides) return out(raw.w > 0.95 ? "tooClose" : "offCenter");

  return out("settling");
}

function avg(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
