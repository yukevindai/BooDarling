/** Browser-only image helpers: crop rendering, sharpness scoring, JPEG encoding. */
import { CAPTURE_CONFIG, type CaptureConfig } from "./config";
import type { NormBox } from "./types";

type Source = HTMLVideoElement | HTMLImageElement | HTMLCanvasElement | ImageBitmap;

function sourceSize(src: Source): { w: number; h: number } {
  if (src instanceof HTMLVideoElement) return { w: src.videoWidth, h: src.videoHeight };
  if (src instanceof HTMLImageElement) return { w: src.naturalWidth, h: src.naturalHeight };
  return { w: src.width, h: src.height };
}

/**
 * Draw the normalized crop box from the source into a new canvas, preserving
 * aspect ratio (no stretching) and scaling so the long side <= outputMaxSide.
 * Always reads the raw (unmirrored) frame, so the crop matches the landmarks.
 */
export function renderCrop(src: Source, box: NormBox, cfg: CaptureConfig = CAPTURE_CONFIG): HTMLCanvasElement {
  const { w: sw, h: sh } = sourceSize(src);
  const sx = Math.round(box.x * sw), sy = Math.round(box.y * sh);
  const cw = Math.max(1, Math.round(box.w * sw)), ch = Math.max(1, Math.round(box.h * sh));
  const scale = Math.min(1, cfg.outputMaxSide / Math.max(cw, ch));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(cw * scale));
  canvas.height = Math.max(1, Math.round(ch * scale));
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, sx, sy, cw, ch, 0, 0, canvas.width, canvas.height);
  return canvas;
}

const SHARP_W = 160;
let scratch: HTMLCanvasElement | null = null;

/**
 * Variance of the Laplacian on a small grayscale copy. Higher = sharper.
 * Cheap enough to run on every sampled frame during the collect window.
 */
export function sharpness(canvas: HTMLCanvasElement): number {
  scratch ??= document.createElement("canvas");
  const w = SHARP_W;
  const h = Math.max(3, Math.round((canvas.height / canvas.width) * w));
  scratch.width = w;
  scratch.height = h;
  const ctx = scratch.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(canvas, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];

  let sum = 0, sumSq = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = g[i - w] + g[i + w] + g[i - 1] + g[i + 1] - 4 * g[i];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/** Decoded byte size of a base64 data URL. */
export function dataUrlBytes(dataUrl: string): number {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

/** Encode as JPEG, stepping quality (then size) down until it fits maxJpegBytes. */
export function toJpegDataUrl(canvas: HTMLCanvasElement, cfg: CaptureConfig = CAPTURE_CONFIG): string {
  let current = canvas;
  for (let attempt = 0; attempt < 4; attempt++) {
    for (const q of [0.9, 0.82, 0.72, 0.6]) {
      const url = current.toDataURL("image/jpeg", q);
      if (dataUrlBytes(url) <= cfg.maxJpegBytes) return url;
    }
    // Still too big: halve the canvas and try again.
    const smaller = document.createElement("canvas");
    smaller.width = Math.max(1, Math.round(current.width / 2));
    smaller.height = Math.max(1, Math.round(current.height / 2));
    smaller.getContext("2d")!.drawImage(current, 0, 0, smaller.width, smaller.height);
    current = smaller;
  }
  return current.toDataURL("image/jpeg", 0.5);
}
