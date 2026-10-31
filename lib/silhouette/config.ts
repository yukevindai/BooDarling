/**
 * Silhouette segmentation tuning. Client-side (browser) only.
 *
 * Uses MediaPipe's Image Segmenter with the SelfieSegmenter model, which outputs
 * a per-pixel foreground (person) confidence mask at the input frame resolution.
 * Re-tune thresholds on the demo laptop/backdrop like the rest of capture (spec §3).
 */
export const SILHOUETTE_CONFIG = {
  /** Same pinned @mediapipe/tasks-vision version as package.json. Copy
   *  node_modules/@mediapipe/tasks-vision/wasm to public/mediapipe/wasm for offline demos. */
  wasmUrl: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0/wasm",
  /** SelfieSegmenter (square 256x256), float16. Person-vs-background confidence mask. */
  modelUrl:
    "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite",
  /** Segmentation rate. Throttled so the UI stays smooth. */
  segmentFps: 12,
  /** Confidence above which a pixel counts as foreground (person). */
  foregroundThreshold: 0.5,
  /** How often (ms) to recompute + emit a silhouette descriptor while live. */
  descriptorEveryMs: 500,
  /** Descriptor schema version. */
  descriptorVersion: "sil-v1",
} as const;

export type SilhouetteConfig = typeof SILHOUETTE_CONFIG;
