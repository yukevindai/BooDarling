/** MediaPipe Face Landmarker with blendshapes, for BooCamp. Browser-only. */
import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import { CAPTURE_CONFIG } from "@/lib/capture/config";
import type { Blendshapes } from "./scare";

// Same runtime as R2's pose detector (served from /mediapipe/wasm by the postinstall copy).
const WASM = CAPTURE_CONFIG.wasmUrl;
const MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

let shared: Promise<FaceLandmarker> | null = null;

/** Cached; call early (e.g. during the outfit verdict) so the challenge starts instantly. */
export function getFaceDetector(): Promise<FaceLandmarker> {
  if (!shared) {
    shared = (async () => {
      const fileset = await FilesetResolver.forVisionTasks(WASM);
      const opts = (delegate: "GPU" | "CPU") => ({
        baseOptions: { modelAssetPath: MODEL, delegate },
        runningMode: "VIDEO" as const,
        numFaces: 1,
        outputFaceBlendshapes: true,
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      try {
        return await FaceLandmarker.createFromOptions(fileset, opts("GPU"));
      } catch {
        return FaceLandmarker.createFromOptions(fileset, opts("CPU"));
      }
    })();
    shared.catch(() => (shared = null)); // allow retry after a failed load
  }
  return shared;
}

let lastTs = 0;
export type FaceBox = { x: number; y: number; width: number; height: number };
export type FacePoint = { x: number; y: number };
export type FaceMetrics = { box: FaceBox; blendshapes: Blendshapes; landmarks: FacePoint[] };

/** Blendshapes for the first face, or null if no face is tracked this frame. */
export function readBlendshapes(detector: FaceLandmarker, video: HTMLVideoElement): Blendshapes | null {
  if (video.readyState < 2 || !video.videoWidth) return null;
  const ts = Math.max(performance.now(), lastTs + 1);
  lastTs = ts;
  const res = detector.detectForVideo(video, ts);
  const cats = res.faceBlendshapes?.[0]?.categories;
  if (!cats?.length) return null;
  return Object.fromEntries(cats.map((c) => [c.categoryName, c.score]));
}

/** Normalized face bounds for the first tracked face, or null when no face is found. */
export function readFaceBox(detector: FaceLandmarker, video: HTMLVideoElement): FaceBox | null {
  if (video.readyState < 2 || !video.videoWidth) return null;
  const ts = Math.max(performance.now(), lastTs + 1);
  lastTs = ts;
  const landmarks = detector.detectForVideo(video, ts).faceLandmarks?.[0];
  if (!landmarks?.length) return null;

  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  for (const point of landmarks) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Face bounds and blendshapes from one detector pass. */
export function readFaceMetrics(detector: FaceLandmarker, video: HTMLVideoElement): FaceMetrics | null {
  if (video.readyState < 2 || !video.videoWidth) return null;
  const ts = Math.max(performance.now(), lastTs + 1);
  lastTs = ts;
  const result = detector.detectForVideo(video, ts);
  const landmarks = result.faceLandmarks?.[0];
  const categories = result.faceBlendshapes?.[0]?.categories;
  if (!landmarks?.length || !categories?.length) return null;

  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  for (const point of landmarks) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return {
    box: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    blendshapes: Object.fromEntries(categories.map((c) => [c.categoryName, c.score])),
    landmarks: landmarks.map(({ x, y }) => ({ x, y })),
  };
}
