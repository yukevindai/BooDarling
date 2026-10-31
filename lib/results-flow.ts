// Results sub-step sequencing for the mirror (components/mirror/Mirror.tsx). Pure, client-safe.
//
//   costume: verdict (score + roast) → name → board → auramax → waiting
//   scare:   (BooCamp) → name → board → auramax → waiting
//
// Aura-max comes last and only when there is something to show (a costume `auraMax` card from
// /api/critique, or Scare tips from BooCamp). Skipped BooCamp never reaches results steps.

export type ResultsStep = "verdict" | "name" | "board" | "auramax";

/** How long the Aura-max stage stays up (time to scan a QR code) before returning to waiting. */
export const AURAMAX_STEP_MS = 20000;

/** When the board's timer ends: show Aura-max if there is one, else end the session as before. */
export function afterBoard(hasAuraMax: boolean): "auramax" | "reset" {
  return hasAuraMax ? "auramax" : "reset";
}

/**
 * Steps where a departed visitor does NOT end the session: typing a name, reading the board and
 * scanning an Aura-max QR code can all take people out of frame. These steps time out on their own.
 */
export function keepsSessionOnDeparture(step: ResultsStep): boolean {
  return step === "name" || step === "board" || step === "auramax";
}
