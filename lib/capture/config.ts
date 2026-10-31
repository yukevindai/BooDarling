/**
 * R2 capture tuning. Every threshold here should be re-tuned on the actual
 * demo laptop, camera position and backdrop (spec §3). Use the `debug` prop on
 * <ReflectCamera> to see live values while tuning.
 */
export const CAPTURE_CONFIG = {
  // --- MediaPipe ---
  /** Lite is fast enough on a laptop; switch to "full" if landmarks jitter. */
  modelUrl:
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
  /** Copy node_modules/@mediapipe/tasks-vision/wasm to public/mediapipe/wasm for offline demos. */
  wasmUrl: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0/wasm",
  /** Detect 2 so we can notice a second visitor and pause (spec §2). */
  numPoses: 2,
  minPoseDetectionConfidence: 0.5,
  minPosePresenceConfidence: 0.5,
  minTrackingConfidence: 0.5,

  // --- Loop ---
  /** Pose inference rate. Throttled so the UI stays smooth. */
  detectFps: 12,

  // --- Presence (debounced enter / leave) ---
  enterDebounceMs: 400,
  /** Area must be empty this long before we report departure (spec §2 step 6). */
  leaveDebounceMs: 2500,
  /** Guidance text only changes after a new status persists this long. */
  guidanceHoldMs: 600,

  // --- Framing ---
  minVisibility: 0.5,
  /** A second pose only counts as a person if its shoulders are this visible... */
  secondPersonMinVisibility: 0.6,
  /** ...and its shoulder span is at least this fraction of frame width. */
  secondPersonMinShoulderWidth: 0.06,
  /** Shoulder span as a fraction of frame width. */
  minShoulderWidth: 0.1,
  maxShoulderWidth: 0.42,
  /** Horizontal distance of the body centre from frame centre (fraction of width). */
  centerTolerance: 0.2,
  /** Need at least the knees in frame: Cruella's coat hem matters. */
  requireLowerBody: "knees" as "knees" | "ankles",
  /** Crop box touching a frame edge closer than this means something is clipped. */
  edgeMargin: 0.04,

  // --- Stability ---
  stableHoldMs: 1200,
  /** Max drift of the crop centre (fraction of frame) over the hold window. */
  stableMaxCenterShift: 0.035,
  /** Max relative change in crop height over the hold window. */
  stableMaxScaleShift: 0.08,

  // --- Sharp-frame selection ---
  /** After stability is reached, sample frames for this long and keep the sharpest. */
  collectMs: 700,
  /** Laplacian variance floor. Below this the best frame is too blurry; keep trying. */
  minSharpness: 25,

  // --- Crop policy (shared with reference crops: keep identical!) ---
  /** Extra width each side, as a fraction of shoulder width (sleeves, coat flare). */
  padSides: 0.55,
  /** Space above the shoulders, as a fraction of torso height (collar, not face). */
  padTop: 0.18,
  /** Space below the lowest landmark, as a fraction of torso height (hem, shoes). */
  padBottom: 0.15,
  /** Minimum crop width relative to shoulder width (keeps coats from being clipped). */
  minWidthToShoulders: 2.1,

  // --- Output ---
  outputMaxSide: 768,
  /** Spec §8: decoded JPEG <= 1 MB. */
  maxJpegBytes: 1_000_000,
} as const;

export type CaptureConfig = typeof CAPTURE_CONFIG;
