/**
 * Operator "Test audio" logic (used by AudioSetupControl), kept React-free so it
 * is unit-testable.
 *
 * The test speaks under a temporary `audio-test-*` session. It must never
 * disturb a live visitor:
 *  - it refuses to run while a non-test (visitor) session is active, and
 *  - afterwards it only clears the voice session if the temp test session is
 *    STILL the active one (a visitor may have started meanwhile).
 */
import { ANNOUNCEMENT_LINES } from "@/lib/critic/lines";
import type { BaronessVoice, SpeakOutcome } from "./audio";

export const AUDIO_TEST_SESSION_PREFIX = "audio-test-";

export function isAudioTestSession(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(AUDIO_TEST_SESSION_PREFIX);
}

/** True when a visitor (non-test) session is active, i.e. the test must not run. */
export function isVisitorSessionActive(activeSession: string | null | undefined): boolean {
  return typeof activeSession === "string" && !isAudioTestSession(activeSession);
}

type VoiceLike = Pick<BaronessVoice, "getActiveSession" | "setActiveSession" | "speak">;

/**
 * Speak the audio-test line under a temporary session. Call `voice.unlock()`
 * synchronously in the click handler BEFORE this. Never rejects.
 */
export async function speakAudioTest(
  voice: VoiceLike,
  makeId: () => string = () => `${AUDIO_TEST_SESSION_PREFIX}${Date.now().toString(36)}`,
): Promise<SpeakOutcome> {
  if (isVisitorSessionActive(voice.getActiveSession())) {
    return { played: false, via: "none", reason: "visitor-session-active" };
  }
  const tempId = makeId();
  voice.setActiveSession(tempId);
  const outcome = await voice.speak(tempId, ANNOUNCEMENT_LINES["audio-test"].text, { kind: "announcement" });
  // Only release the voice if nobody took it over while the test was playing.
  // (Before the test no visitor session was active, so "previous" is always null.)
  if (voice.getActiveSession() === tempId) voice.setActiveSession(null);
  return outcome;
}
