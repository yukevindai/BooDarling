"use client";

/**
 * useBaroness: the one hook R1 wires into the session state machine.
 *
 *   const baroness = useBaroness();
 *   baroness.startSession(sessionId);          // on person-detected (recommended)
 *   baroness.guide("step-back");               // Framing
 *   const out = await baroness.run({ capture, result });   // Analysing -> Speaking
 *   baroness.cancel();                         // departure / reset
 *
 * Guarantees:
 *  - Critique text is published to state BEFORE audio starts and stays even if audio fails.
 *  - One run per session: a second run() for the same session returns the same promise.
 *    A run() for a new session cancels the previous run and its audio.
 *  - cancel() aborts the critique request, stops audio, discards late responses.
 *  - run() never rejects. If cancelled, it resolves with `cancelled: true`.
 *  - Stale runs are refused (resolve `cancelled: true` immediately; no fetch, no audio,
 *    no state change): a run for a session that was cancelled or superseded, or for
 *    any session other than the one passed to startSession(). See `session-gate.ts`.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AnnouncementKey, GuidanceKey } from "@/lib/critic/lines";
import type { Capture, CritiqueSource, RateResult } from "@/lib/critic/types";
import { getBaronessVoice, type SpeakOutcome, type VoiceState } from "./audio";
import { fallbackCritique, isCritiqueDiscarded, requestCritique } from "./critique-client";
import { SessionGate } from "./session-gate";

export type BaronessStatus = "idle" | "thinking" | "speaking" | "done";

export type BaronessRunInput = { capture: Capture; result: RateResult };

export type BaronessRunOutcome = {
  sessionId: string;
  text: string;
  source: CritiqueSource;
  /** True if audible playback of the critique started. */
  spoken: boolean;
  /** True if the run was cancelled/superseded; text is then empty and must not be shown. */
  cancelled: boolean;
};

export type BaronessState = {
  status: BaronessStatus;
  text: string | null;
  source: CritiqueSource | undefined;
  sessionId: string | null;
  /** True while audio is audibly playing. */
  speaking: boolean;
};

export type UseBaroness = BaronessState & {
  run(input: BaronessRunInput): Promise<BaronessRunOutcome>;
  startSession(sessionId: string): void;
  guide(key: GuidanceKey, sessionId?: string): Promise<SpeakOutcome>;
  announce(key: AnnouncementKey, sessionId?: string): Promise<SpeakOutcome>;
  cancel(): void;
};

type Core = Omit<BaronessState, "speaking">;
const IDLE: Core = { status: "idle", text: null, source: undefined, sessionId: null };
const SERVER_VOICE_STATE: VoiceState = { speaking: false, sessionId: null, unlocked: false };

export function useBaroness(): UseBaroness {
  const voice = getBaronessVoice();
  const [core, setCore] = useState<Core>(IDLE);
  const voiceState = useSyncExternalStore(voice.subscribe, voice.getState, () => SERVER_VOICE_STATE);

  const mounted = useRef(true);
  const runSeq = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const inflight = useRef<{ sessionId: string; promise: Promise<BaronessRunOutcome> } | null>(null);
  const [gate] = useState(() => new SessionGate());

  const set = useCallback((next: Core) => {
    if (mounted.current) setCore(next);
  }, []);

  const cancelInternal = useCallback(
    (publish: boolean) => {
      runSeq.current++;
      abortRef.current?.abort();
      abortRef.current = null;
      inflight.current = null;
      gate.cancel(); // retire the departed session: late run()s for it are refused
      voice.setActiveSession(null); // stops audio + in-flight speech fetches
      if (publish) set(IDLE);
    },
    [voice, set, gate],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancelInternal(false);
    };
  }, [cancelInternal]);

  const cancel = useCallback(() => cancelInternal(true), [cancelInternal]);

  const startSession = useCallback(
    (sessionId: string) => {
      const change = gate.start(sessionId);
      if (change === "ignored") return; // retired (departed/superseded) session
      if (change === "switched") {
        // New visitor: drop any previous run and its audio.
        runSeq.current++;
        abortRef.current?.abort();
        abortRef.current = null;
        inflight.current = null;
        set({ ...IDLE, sessionId });
      }
      voice.setActiveSession(sessionId); // no-op if already active
    },
    [voice, set, gate],
  );

  const run = useCallback(
    ({ capture, result }: BaronessRunInput): Promise<BaronessRunOutcome> => {
      const sessionId = capture.sessionId;
      const cancelled: BaronessRunOutcome = { sessionId, text: "", source: "preset", spoken: false, cancelled: true };
      const decision = gate.decide(sessionId, inflight.current?.sessionId ?? null);
      // Stale run (departed/superseded session, or not the started session):
      // no fetch, no audio, no state change.
      if (decision.action === "refuse") return Promise.resolve(cancelled);
      if (decision.action === "join" && inflight.current) return inflight.current.promise;

      // New session: cancel the old run (retiring its session), activate the new session.
      gate.runStarted(sessionId);
      runSeq.current++;
      abortRef.current?.abort();
      const myRun = runSeq.current;
      const ac = new AbortController();
      abortRef.current = ac;
      voice.setActiveSession(sessionId);
      const alive = () => runSeq.current === myRun && !ac.signal.aborted;

      set({ status: "thinking", text: null, source: undefined, sessionId });

      const promise = (async (): Promise<BaronessRunOutcome> => {
        let critique;
        try {
          critique = await requestCritique(capture, result, { signal: ac.signal });
        } catch (e) {
          if (!isCritiqueDiscarded(e) && alive()) critique = fallbackCritique(capture, result);
          else return cancelled;
        }
        if (!alive()) return cancelled;

        // Text first: visible even if audio never plays.
        set({ status: "speaking", text: critique.text, source: critique.source, sessionId });

        const outcome = await voice.speak(sessionId, critique.text, { kind: "critique" });
        if (!alive()) return cancelled;

        set({ status: "done", text: critique.text, source: critique.source, sessionId });
        return {
          sessionId,
          text: critique.text,
          source: critique.source,
          spoken: outcome.played,
          cancelled: false,
        };
      })();

      inflight.current = { sessionId, promise };
      return promise;
    },
    [voice, set, gate],
  );

  const guide = useCallback(
    (key: GuidanceKey, sessionId?: string): Promise<SpeakOutcome> => {
      const active = voice.getActiveSession();
      if (!active) return Promise.resolve({ played: false, via: "none", reason: "no-session" });
      return voice.playGuidance(key, sessionId ?? active);
    },
    [voice],
  );

  const announce = useCallback(
    (key: AnnouncementKey, sessionId?: string): Promise<SpeakOutcome> => {
      const active = voice.getActiveSession();
      if (!active) return Promise.resolve({ played: false, via: "none", reason: "no-session" });
      return voice.announce(key, sessionId ?? active);
    },
    [voice],
  );

  return useMemo(
    () => ({ ...core, speaking: voiceState.speaking, run, startSession, guide, announce, cancel }),
    [core, voiceState.speaking, run, startSession, guide, announce, cancel],
  );
}
