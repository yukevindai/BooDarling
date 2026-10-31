/**
 * MediaPipe Image Segmenter loading (browser-only).
 *
 * Mirrors lib/capture/detector.ts: one shared segmenter per running mode, loaded
 * once and warm. The `@mediapipe/tasks-vision` runtime is pulled in via dynamic
 * import so this module never evaluates browser-only code during SSR; only the
 * (erased) type import is static.
 */
import type { ImageSegmenter } from "@mediapipe/tasks-vision";
import { SILHOUETTE_CONFIG } from "./config";

type Mode = "VIDEO" | "IMAGE";
const cache = new Map<Mode, Promise<ImageSegmenter>>();

async function create(mode: Mode): Promise<ImageSegmenter> {
  const { FilesetResolver, ImageSegmenter } = await import("@mediapipe/tasks-vision");
  const fileset = await FilesetResolver.forVisionTasks(SILHOUETTE_CONFIG.wasmUrl);
  const options = (delegate: "GPU" | "CPU") => ({
    baseOptions: { modelAssetPath: SILHOUETTE_CONFIG.modelUrl, delegate },
    runningMode: mode,
    outputCategoryMask: false,
    outputConfidenceMasks: true,
  });
  try {
    return await ImageSegmenter.createFromOptions(fileset, options("GPU"));
  } catch (err) {
    console.warn("[silhouette] GPU delegate failed, falling back to CPU", err);
    return ImageSegmenter.createFromOptions(fileset, options("CPU"));
  }
}

/**
 * Shared segmenter per mode. Call during operator setup so the model is
 * downloaded and warm before the mirror goes live. A failed load is not cached,
 * so a retry can succeed.
 */
export function getImageSegmenter(mode: Mode = "VIDEO"): Promise<ImageSegmenter> {
  let p = cache.get(mode);
  if (!p) {
    p = create(mode);
    p.catch(() => cache.delete(mode));
    cache.set(mode, p);
  }
  return p;
}

export async function closeImageSegmenters(): Promise<void> {
  for (const p of cache.values()) (await p.catch(() => null))?.close();
  cache.clear();
}
