// R1: pure helpers for the mirror shell (components/mirror/Mirror.tsx). Client-safe, no I/O.
import type { Phase } from "./session";
import type { JudgeMode } from "./types";

/** "red-glamour" → "Red Glamour". Client-side twin of humaniseLookId in lib/critic/manifest.ts. */
export function lookLabel(lookId: string): string {
  return lookId
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Reference image URL; /api/reference resolves the id via R3's manifest and redirects to the file. */
export function referenceImageUrl(referenceId: string): string {
  return `/api/reference/${encodeURIComponent(referenceId)}`;
}

/** Phases in which a visitor is being assessed (or shown results) and departure should end the session. */
const IN_SESSION: readonly Phase[] = ["framing", "capturing", "analysing", "scaring", "results"];

/**
 * R2 presence (debounced) → session action (spec §2).
 * Sessions only start when the visitor speaks a phrase (see phraseMode)
 * or the operator uses the fallback link — never on arrival alone. Departure during a session resets it.
 */
export function presenceAction(phase: Phase, present: boolean): "reset" | null {
  if (present) return null;
  return IN_SESSION.includes(phase) ? "reset" : null;
}

const lastIndex = (re: RegExp, t: string) => {
  let last = -1;
  for (const m of t.matchAll(re)) last = m.index ?? last;
  return last;
};

/**
 * Which judgement the visitor asked for, from a (lowercase) speech transcript:
 *   "Mirror, mirror on the wall, who's the fairest of them all?"   → "costume"
 *   "Mirror, mirror on the wall, who's the scariest of them all?"  → "scare"
 * Lenient: needs "mirror" plus fair/fairer/fairest or scary/scarier/scariest. Continuous recognition
 * accumulates the whole transcript, so if both words were heard the one spoken last wins.
 */
export function phraseMode(transcript: string): JudgeMode | null {
  const t = transcript.toLowerCase();
  if (!/mirror/.test(t)) return null;
  const fair = lastIndex(/\bfair/g, t);
  const scare = lastIndex(/\bscar(?:i|y|ie)/g, t);
  if (fair < 0 && scare < 0) return null;
  return scare > fair ? "scare" : "costume";
}
