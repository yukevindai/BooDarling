/**
 * Turn a foreground-confidence mask into a garment-focused silhouette descriptor.
 *
 * Pure and framework-free so the shape logic can be reasoned about and tested on
 * its own. All outputs describe the outfit's OUTLINE (its line/shape), never the
 * wearer's body — the phrases use garment vocabulary (A-line, column, boxy, ...).
 */
import type { SilhouetteDescriptor, SilhouetteShape } from "@/lib/types";

const PHRASES: Record<SilhouetteShape, string> = {
  "a-line": "an A-line that flares out toward a wide hem",
  column: "a long, straight column line",
  hourglass: "a sharply cinched, nipped-in line",
  "inverted-triangle": "a bold, strong-shouldered line that tapers downward",
  boxy: "a boxy, oversized line",
  unknown: "",
};

export type DescribeOptions = {
  /** Confidence above which a pixel counts as foreground. Default 0.5. */
  threshold?: number;
  /** Descriptor schema version stamped into the result. Default "sil-v1". */
  version?: string;
  /** Minimum fraction of the frame the figure must cover to be reliable. Default 0.02. */
  minCoverage?: number;
};

/**
 * @param conf   per-pixel foreground confidence, row-major, length >= width*height
 * @param width  mask width (equals the input video frame width)
 * @param height mask height
 * @returns a descriptor, or null when no reliable figure is present
 */
export function describeSilhouette(
  conf: Float32Array,
  width: number,
  height: number,
  opts: DescribeOptions = {},
): SilhouetteDescriptor | null {
  const threshold = opts.threshold ?? 0.5;
  const version = opts.version ?? "sil-v1";
  const minCoverage = opts.minCoverage ?? 0.02;
  if (width <= 0 || height <= 0 || conf.length < width * height) return null;

  const rowMin = new Int32Array(height).fill(width);
  const rowMax = new Int32Array(height).fill(-1);
  let total = 0;
  let minY = -1;
  let maxY = -1;
  let minX = width;
  let maxX = -1;

  for (let y = 0; y < height; y++) {
    const base = y * width;
    let lo = width;
    let hi = -1;
    let c = 0;
    for (let x = 0; x < width; x++) {
      if (conf[base + x] >= threshold) {
        c++;
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
    }
    rowMin[y] = lo;
    rowMax[y] = hi;
    total += c;
    if (c > 0) {
      if (minY < 0) minY = y;
      maxY = y;
      if (lo < minX) minX = lo;
      if (hi > maxX) maxX = hi;
    }
  }

  const coverage = total / (width * height);
  if (minY < 0 || coverage < minCoverage) return null;

  const bboxH = maxY - minY + 1;
  const bboxW = Math.max(1, maxX - minX + 1);
  const aspectRatio = bboxH / bboxW;

  // Average outline width (px) in a small window around a fraction of bbox height.
  const spanAt = (frac: number): number => {
    const center = minY + frac * (bboxH - 1);
    const half = Math.max(1, Math.round(bboxH * 0.03));
    let sum = 0;
    let n = 0;
    for (let y = Math.round(center - half); y <= Math.round(center + half); y++) {
      if (y < minY || y > maxY) continue;
      if (rowMax[y] >= rowMin[y]) {
        sum += rowMax[y] - rowMin[y] + 1;
        n++;
      }
    }
    return n ? sum / n : 0;
  };

  const shouldersPx = spanAt(0.18);
  const midPx = spanAt(0.45);
  const lowerPx = spanAt(0.62);
  const hemPx = spanAt(0.9);
  const widest = Math.max(shouldersPx, midPx, lowerPx, hemPx, 1);
  const bands = {
    shoulders: shouldersPx / widest,
    midline: midPx / widest,
    lower: lowerPx / widest,
    hem: hemPx / widest,
  };

  // Left-right balance around the bbox center.
  const cx = (minX + maxX) / 2;
  const step = Math.max(1, Math.round(bboxH / 40));
  let asym = 0;
  let rows = 0;
  for (let y = minY; y <= maxY; y += step) {
    const base = y * width;
    let left = 0;
    let right = 0;
    for (let x = minX; x <= maxX; x++) {
      if (conf[base + x] >= threshold) {
        if (x < cx) left++;
        else right++;
      }
    }
    const t = left + right;
    if (t > 0) {
      asym += Math.abs(left - right) / t;
      rows++;
    }
  }
  const symmetry = rows ? Math.max(0, 1 - asym / rows) : 0;

  const shape = classify(bands, aspectRatio);
  return { version, coverage, aspectRatio, bands, symmetry, shape, phrase: PHRASES[shape] };
}

function classify(
  b: { shoulders: number; midline: number; lower: number; hem: number },
  aspectRatio: number,
): SilhouetteShape {
  const { shoulders, midline, lower, hem } = b;
  // Flares toward the hem (skirt/coat sweep).
  if (hem >= 0.92 && hem > shoulders + 0.12 && hem > midline + 0.1) return "a-line";
  // Cinched middle, fuller above and below.
  if (midline <= shoulders - 0.14 && midline <= lower - 0.1) return "hourglass";
  // Strong shoulders tapering down.
  if (shoulders >= 0.92 && shoulders > lower + 0.12 && shoulders > hem + 0.12) return "inverted-triangle";
  // Wide and square all the way down.
  if (shoulders >= 0.8 && midline >= 0.8 && lower >= 0.8 && aspectRatio < 1.7) return "boxy";
  // Otherwise roughly even: a column line.
  return "column";
}
