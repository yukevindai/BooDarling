/** MediaPipe Pose Landmarker loading. Browser-only. */
import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";
import { CAPTURE_CONFIG, type CaptureConfig } from "./config";

type Mode = "VIDEO" | "IMAGE";
const cache = new Map<Mode, Promise<PoseLandmarker>>();

async function create(mode: Mode, cfg: CaptureConfig): Promise<PoseLandmarker> {
  const fileset = await FilesetResolver.forVisionTasks(cfg.wasmUrl);
  const options = (delegate: "GPU" | "CPU") => ({
    baseOptions: { modelAssetPath: cfg.modelUrl, delegate },
    runningMode: mode,
    numPoses: cfg.numPoses,
    minPoseDetectionConfidence: cfg.minPoseDetectionConfidence,
    minPosePresenceConfidence: cfg.minPosePresenceConfidence,
    minTrackingConfidence: cfg.minTrackingConfidence,
  });
  try {
    return await PoseLandmarker.createFromOptions(fileset, options("GPU"));
  } catch (err) {
    console.warn("[capture] GPU delegate failed, falling back to CPU", err);
    return PoseLandmarker.createFromOptions(fileset, options("CPU"));
  }
}

/**
 * Shared detector per mode. Call `getPoseDetector()` during operator setup so
 * the model is downloaded and warm before the app shows Ready (spec §3).
 * A failed load is not cached, so the operator can retry.
 */
export function getPoseDetector(mode: Mode = "VIDEO", cfg: CaptureConfig = CAPTURE_CONFIG): Promise<PoseLandmarker> {
  let p = cache.get(mode);
  if (!p) {
    p = create(mode, cfg);
    p.catch(() => cache.delete(mode));
    cache.set(mode, p);
  }
  return p;
}

export async function closePoseDetectors() {
  for (const p of cache.values()) (await p.catch(() => null))?.close();
  cache.clear();
}
