"use client";
/**
 * Runs one BooCamp challenge on the shared camera:
 *   loading → baseline (neutral face) → challenge (5 s, scary face) → done | skipped
 * The clock pauses while no face is tracked; after maxLostMs without a face,
 * or if the model fails to load, the challenge is skipped (spec §9: never block).
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import { getFaceDetector, readBlendshapes } from "./faceDetector";
import { SCARE_CONFIG, ScareMeter } from "./scare";

export type BooPhase = "loading" | "baseline" | "challenge" | "done" | "skipped";
export type BooState = {
  phase: BooPhase;
  /** Whole seconds left in the current timed phase. */
  secondsLeft: number;
  /** Live 0–100 meter during the challenge. */
  live: number;
  /** Final Scare Score once done (null when skipped). */
  score: number | null;
  faceVisible: boolean;
};

const FPS = 15;

export function useBooCamp(videoRef: RefObject<HTMLVideoElement | null>, runId: string | null, cfg = SCARE_CONFIG): BooState {
  const [state, setState] = useState<BooState>({ phase: "loading", secondsLeft: 0, live: 0, score: null, faceVisible: false });
  const cfgRef = useRef(cfg);

  useEffect(() => {
    if (!runId) return;
    const cfg = cfgRef.current;
    let cancelled = false;
    let raf = 0;
    const meter = new ScareMeter(cfg);
    let phase: BooPhase = "loading";
    let elapsed = 0; // time spent in the current phase WITH a face visible
    let lost = 0;
    let last = 0;
    let lastFrame = 0;
    setState({ phase, secondsLeft: 0, live: 0, score: null, faceVisible: false });

    const finish = (p: "done" | "skipped", score: number | null) => {
      phase = p;
      cancelAnimationFrame(raf);
      setState((s) => ({ ...s, phase: p, score, secondsLeft: 0 }));
    };

    getFaceDetector()
      .then((detector) => {
        if (cancelled) return;
        phase = "baseline";
        last = performance.now();
        const loop = (now: number) => {
          if (cancelled || phase === "done" || phase === "skipped") return;
          raf = requestAnimationFrame(loop);
          if (now - lastFrame < 1000 / FPS) return;
          lastFrame = now;
          const dt = now - last;
          last = now;

          const video = videoRef.current;
          let bs = null;
          try {
            bs = video ? readBlendshapes(detector, video) : null;
          } catch {
            bs = null;
          }

          if (!bs) {
            lost += dt; // clock paused while the face is missing
            if (lost > cfg.maxLostMs) return finish("skipped", null);
            setState((s) => ({ ...s, phase, faceVisible: false }));
            return;
          }
          lost = 0;
          elapsed += dt;

          if (phase === "baseline") {
            meter.addBaseline(bs);
            if (elapsed >= cfg.baselineMs) {
              phase = "challenge";
              elapsed = 0;
            }
            setState({ phase, secondsLeft: Math.ceil((cfg.baselineMs - elapsed) / 1000), live: 0, score: null, faceVisible: true });
            return;
          }

          const live = meter.push(bs);
          if (elapsed >= cfg.challengeMs) {
            const score = meter.final();
            return finish(score === null ? "skipped" : "done", score);
          }
          setState({ phase, secondsLeft: Math.ceil((cfg.challengeMs - elapsed) / 1000), live, score: null, faceVisible: true });
        };
        raf = requestAnimationFrame(loop);
      })
      .catch((err) => {
        console.warn("[boocamp] face model failed to load; skipping", err);
        if (!cancelled) finish("skipped", null);
      });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [runId, videoRef]);

  return state;
}
