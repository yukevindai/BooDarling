import type { Capture, JudgeMode, RateResult } from "./types";

/**
 * Costume mode: waiting → framing → capturing → analysing → results.
 * Scare mode:   waiting → scaring (BooCamp) → results (name → board), or straight back to waiting if skipped.
 */
export type Phase = "setup" | "waiting" | "framing" | "capturing" | "analysing" | "scaring" | "results";
export type State = {
  phase: Phase; sessionId: string; line: string;
  /** Set by reveal; null outside a session. */
  mode: JudgeMode | null;
  capture?: Capture; result?: RateResult; critique?: string;
  /** Scare mode: BooCamp's Scare Score (null = skipped: no face / model failed). */
  scare?: number | null;
};
export type Action =
  | { type: "start" }
  | { type: "reveal"; sessionId: string; mode: JudgeMode }
  | { type: "countdown" }
  | { type: "captured"; capture: Capture }
  | { type: "rated"; result: RateResult }
  | { type: "critique"; text: string }
  | { type: "scared"; sessionId: string; score: number | null }
  | { type: "reset" };

export const initialState: State = { phase: "setup", sessionId: "", line: "", mode: null };

export const INTRO_LINES: Record<JudgeMode, string> = {
  costume: "Well, well. Let's see what we're working with, darling.",
  scare: "Show me your most terrifying face, darling.",
};
/** Scare mode with no readable face: said once, then the mirror returns to waiting (no leaderboard entry). */
export const SCARE_SKIPPED_LINE = "No face, no fright, darling. Come back when you can terrify me.";

export function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "start": return { ...initialState, phase: "waiting" };
    case "reveal": return { ...initialState, phase: a.mode === "scare" ? "scaring" : "framing",
      sessionId: a.sessionId, mode: a.mode, line: INTRO_LINES[a.mode] };
    case "countdown": return s.phase === "framing" ? { ...s, phase: "capturing" } : s;
    case "captured": return s.mode === "costume" && s.sessionId === a.capture.sessionId
      ? { ...s, phase: "analysing", capture: a.capture, line: "Oh, this should be interesting..." } : s;
    case "rated": return s.mode === "costume" && s.sessionId === a.result.sessionId ? { ...s, result: a.result, phase: "results" } : s;
    case "critique": return { ...s, critique: a.text };
    case "scared": return s.phase === "scaring" && s.sessionId === a.sessionId
      ? { ...s, phase: "results", scare: a.score, line: a.score === null ? SCARE_SKIPPED_LINE : s.line } : s;
    case "reset": return { ...initialState, phase: "waiting" };
  }
}

export function verdictWord(aura: number) {
  if (aura >= 85) return "MAGNIFICENTLY MENACING";
  if (aura >= 65) return "COUTURE OF CHAOS";
  if (aura >= 40) return "TOLERABLY TRAGIC";
  return "UTTERLY DISASTROUS";
}
