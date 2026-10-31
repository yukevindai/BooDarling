// R1: pure helpers for the mirror shell (components/mirror/Mirror.tsx). Client-safe, no I/O.
import type { Phase } from "./session";

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
const IN_SESSION: readonly Phase[] = ["framing", "capturing", "analysing", "results"];

/**
 * R2 presence (debounced) → session action (spec §2).
 * Sessions only start when the visitor speaks the phrase ("Mirror, mirror … fairest of them all")
 * or the operator uses the fallback link — never on arrival alone. Departure during a session resets it.
 */
export function presenceAction(phase: Phase, present: boolean): "reset" | null {
  if (present) return null;
  return IN_SESSION.includes(phase) ? "reset" : null;
}
