import type { Capture, RateResult } from "./types";

export type Phase = "setup" | "waiting" | "framing" | "capturing" | "analysing" | "results";
export type State = {
  phase: Phase; sessionId: string; line: string;
  capture?: Capture; result?: RateResult; critique?: string;
};
export type Action =
  | { type: "start" }
  | { type: "reveal"; sessionId: string }
  | { type: "countdown" }
  | { type: "captured"; capture: Capture }
  | { type: "rated"; result: RateResult }
  | { type: "critique"; text: string }
  | { type: "reset" };

export const initialState: State = { phase: "setup", sessionId: "", line: "" };

export function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "start": return { ...initialState, phase: "waiting" };
    case "reveal": return { ...initialState, phase: "framing", sessionId: a.sessionId,
      line: "Well, well. Let's see what we're working with, darling." };
    case "countdown": return s.phase === "framing" ? { ...s, phase: "capturing" } : s;
    case "captured": return s.sessionId === a.capture.sessionId
      ? { ...s, phase: "analysing", capture: a.capture, line: "Oh, this should be interesting..." } : s;
    case "rated": return s.sessionId === a.result.sessionId ? { ...s, result: a.result, phase: "results" } : s;
    case "critique": return { ...s, critique: a.text };
    case "reset": return { ...initialState, phase: "waiting" };
  }
}

export function verdictWord(aura: number) {
  if (aura >= 85) return "MAGNIFICENTLY MENACING";
  if (aura >= 65) return "COUTURE OF CHAOS";
  if (aura >= 40) return "TOLERABLY TRAGIC";
  return "UTTERLY DISASTROUS";
}
