// FROZEN CONTRACTS. Changes go through R1.

/** Coarse garment-silhouette class derived from the figure's width profile. */
export type SilhouetteShape =
  | "a-line"
  | "column"
  | "hourglass"
  | "inverted-triangle"
  | "boxy"
  | "unknown";

/**
 * A live read of the outfit's outline from the client-side MediaPipe Image
 * Segmenter. Describes the garment's overall LINE only — never the body.
 * Optional: present only when segmentation ran and found a reliable figure.
 */
export type SilhouetteDescriptor = {
  /** Descriptor schema version (bump if fields/semantics change). */
  version: string;
  /** Fraction of the frame the figure occupies, 0..1. */
  coverage: number;
  /** Silhouette bounding-box height / width. */
  aspectRatio: number;
  /** Widths at vertical bands, normalized to the widest point (0..1). */
  bands: { shoulders: number; midline: number; lower: number; hem: number };
  /** Left-right balance of the outline, 0..1 (1 = perfectly even). */
  symmetry: number;
  /** Coarse garment-silhouette class. */
  shape: SilhouetteShape;
  /** One short, garment-focused phrase for the critic/UI (never body talk). */
  phrase: string;
};

export type Capture = {
  sessionId: string;
  outfitImage: string; // JPEG data URL; decoded image <= 1 MB
  /** Optional live silhouette read (MediaPipe Image Segmenter, client-side). */
  silhouette?: SilhouetteDescriptor;
};

export type RateResult =
  | {
      status: "ok"; sessionId: string; aura: number;
      lookId: string; referenceId: string; similarity: number;
      referenceScores: { referenceId: string; similarity: number }[];
      modelVersion: string; referenceVersion: string; calibrationVersion: string;
    }
  | { status: "unavailable"; sessionId: string; message: string };

export type CritiqueRequest = { capture: Capture; result: RateResult };
export type CritiqueResponse = { sessionId: string; text: string; source: "model" | "preset" };
export type SpeechRequest = { sessionId: string; text: string }; // text <= 500 chars -> audio

/** What the visitor asked the mirror to judge: "fairest" → costume (Aura), "scariest" → scare face (BooCamp). */
export type JudgeMode = "costume" | "scare";
