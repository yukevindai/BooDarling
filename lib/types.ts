// Shared request/result contracts for Reflect.
//
// OWNER: R1 (Integration/UI). These are the frozen interfaces from the MVP spec
// §8. R2 depends on `Capture` only. This file is provided here as a faithful
// placeholder of the frozen contract so the capture/vision work compiles and
// integrates; R1 coordinates any real changes.

export type Capture = {
  sessionId: string;
  outfitImage: string; // JPEG data URL; decoded image <= 1 MB
};

export type RateResult =
  | {
      status: "ok";
      sessionId: string;
      aura: number;
      lookId: string;
      referenceId: string;
      similarity: number;
      referenceScores: { referenceId: string; similarity: number }[];
      modelVersion: string;
      referenceVersion: string;
      calibrationVersion: string;
    }
  | { status: "unavailable"; sessionId: string; message: string };
