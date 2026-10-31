"use client";
/**
 * BooCamp (spec §9): one five-second scary-face challenge after the outfit
 * verdict. Shows guidance, a countdown and a live meter, reveals a separate
 * Scare Score, then calls onDone. Skips itself if the face can't be tracked.
 */
import { useEffect, useRef, type RefObject } from "react";
import { useBooCamp } from "@/lib/expressions/useBooCamp";
import { scareVerdict } from "@/lib/expressions/scare";
import s from "./BooCamp.module.css";

type Props = {
  videoRef: RefObject<HTMLVideoElement | null>;
  /** Unique per run (use the session id). */
  runId: string;
  /** Speak a line in the Baroness's voice (optional). */
  onSay?: (text: string) => void;
  /** Called once with the Scare Score, or null if skipped. */
  onDone: (score: number | null) => void;
};

const LINES = {
  baseline: "Now, relax your face, darling. Show me nothing at all.",
  challenge: "Now terrify me! Your most frightening face. Five seconds!",
  skipped: "I can't read that face, darling. We'll skip the scare.",
};
const REVEAL_MS = 3500;

export default function BooCamp({ videoRef, runId, onSay, onDone }: Props) {
  const st = useBooCamp(videoRef, runId);
  const said = useRef<string>("");
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const sayRef = useRef(onSay);
  sayRef.current = onSay;

  // Speak each phase's line once.
  useEffect(() => {
    const key = `${runId}:${st.phase}`;
    if (said.current === key) return;
    said.current = key;
    if (st.phase === "baseline") sayRef.current?.(LINES.baseline);
    if (st.phase === "challenge") sayRef.current?.(LINES.challenge);
    if (st.phase === "skipped") sayRef.current?.(LINES.skipped);
    if (st.phase === "done" && st.score !== null) sayRef.current?.(`Scare score: ${st.score}. ${cap(scareVerdict(st.score))}.`);
  }, [st.phase, st.score, runId]);

  // Hand back after the reveal.
  useEffect(() => {
    if (st.phase !== "done" && st.phase !== "skipped") return;
    const t = setTimeout(() => doneRef.current(st.score), st.phase === "done" ? REVEAL_MS : 2000);
    return () => clearTimeout(t);
  }, [st.phase, st.score]);

  return (
    <div className={s.wrap} aria-live="polite">
      <p className={s.kicker}>BooCamp</p>
      <FaceBadge phase={st.phase} visible={st.faceVisible} />

      {st.phase === "loading" && <p className={s.line}>Summoning the scare-o-meter…</p>}

      {st.phase === "baseline" && (
        <>
          <p className={s.line}>{st.faceVisible ? "Relax your face, darling…" : "Face the mirror, darling."}</p>
          <p className={s.count}>{st.faceVisible ? st.secondsLeft : "…"}</p>
        </>
      )}

      {st.phase === "challenge" && (
        <>
          <p className={s.line}>{st.faceVisible ? "TERRIFY ME!" : "Where did your face go? Back to the mirror!"}</p>
          <p className={`${s.count} glitch`} data-text={String(st.secondsLeft)}>
            {st.secondsLeft}
          </p>
          <div className={s.meter} role="meter" aria-valuenow={st.live} aria-valuemin={0} aria-valuemax={100} aria-label="Scare meter">
            <div className={s.fill} style={{ width: `${st.live}%` }} />
          </div>
        </>
      )}

      {st.phase === "done" && st.score !== null && (
        <>
          <p className={`${s.score} glitch`} data-text={`${st.score}/100`}>
            {st.score}
            <small>/100</small>
          </p>
          <p className={s.verdict}>{scareVerdict(st.score)}</p>
          <p className={s.note}>Scare Score</p>
        </>
      )}

      {st.phase === "skipped" && <p className={s.line}>{LINES.skipped}</p>}
    </div>
  );
}

/** Live tracking indicator, so operators can see whether the face model is actually finding a face. */
function FaceBadge({ phase, visible }: { phase: string; visible: boolean }) {
  if (phase === "done") return null;
  const [cls, text] =
    phase === "loading" ? [s.badgeLoading, "Loading face model…"]
    : phase === "skipped" ? [s.badgeOff, "No face detected"]
    : visible ? [s.badgeOn, "Face detected"]
    : [s.badgeOff, "No face detected"];
  return (
    <p className={`${s.badge} ${cls}`} role="status">
      <span className={s.dot} aria-hidden />
      {text}
    </p>
  );
}

function cap(x: string) {
  return x.charAt(0) + x.slice(1).toLowerCase();
}
