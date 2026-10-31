// FROZEN CONTRACTS. Changes go through R1.
export type Capture = {
  sessionId: string;
  outfitImage: string; // JPEG data URL; decoded image <= 1 MB
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
