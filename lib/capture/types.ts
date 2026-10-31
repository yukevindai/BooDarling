/**
 * R2-local types. `CapturePayload` is structurally identical to `Capture` in
 * the shared lib/types.ts (spec §8), so it can be passed straight to
 * POST /api/rate without importing R1's file. If R1 changes `Capture`,
 * update this to match (or swap to `import type { Capture } from "../types"`).
 */
import type { SilhouetteDescriptor } from "../types";

export type CapturePayload = {
  sessionId: string;
  /** JPEG data URL; decoded image <= 1 MB. */
  outfitImage: string;
  /** Optional live silhouette read (MediaPipe Image Segmenter, client-side). */
  silhouette?: SilhouetteDescriptor;
};

export type Landmark = { x: number; y: number; z?: number; visibility?: number };
export type Pose = Landmark[];

/** Box in normalized [0,1] video coordinates (unmirrored). */
export type NormBox = { x: number; y: number; w: number; h: number };

export type FramingStatus =
  | "empty" // nobody in frame
  | "multiple" // more than one person
  | "partial" // key body parts not visible
  | "tooClose"
  | "tooFar"
  | "offCenter"
  | "settling" // framing OK, waiting for the person to hold still
  | "capturing" // stable; sampling frames for the sharpest one
  | "captured" // capture emitted for this session
  | "idle"; // controller not armed (e.g. results showing)

export type FramingState = {
  status: FramingStatus;
  /** Short Cruella-voiced guidance, or null when nothing needs saying. */
  message: string | null;
  /** Stable key so R4 can map guidance to pre-generated audio clips. */
  guidanceKey: FramingStatus | null;
  /** Clothing crop of the main person, if one is found. */
  box: NormBox | null;
  /** Number of people counted (after filtering ghost poses). */
  people: number;
  /** 0..1 progress toward automatic capture (for a ring/bar in the UI). */
  progress: number;
};

export type CaptureDebug = {
  fps: number;
  rawStatus: FramingStatus;
  shoulderWidth: number | null;
  centerOffset: number | null;
  lastSharpness: number | null;
  bestSharpness: number | null;
};
