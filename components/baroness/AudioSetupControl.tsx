"use client";

/**
 * Operator-only audio setup control (spec section 2: "enable/test audio through a
 * user gesture" and "verify model/reference readiness").
 *
 * - "Enable & test audio": unlocks the shared audio element inside the click
 *   handler, then speaks the audio-test line under a temporary session.
 *   While a visitor session is active the test line is never played (it would
 *   cut the visitor's audio): the button only unlocks, or is disabled once unlocked.
 * - Fetches GET /api/critique and GET /api/speech and lists provider/model/voice
 *   and problems. Speech not ready is a warning (text-only still works); audio
 *   unlocked is what the hands-free audio flow requires. The reported server
 *   timeouts configure the client deadlines (configureBaronessTimeouts).
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { BaronessReadiness } from "@/lib/critic/types";
import { getBaronessVoice, type SpeakOutcome, type VoiceState } from "./audio";
import { isVisitorSessionActive, speakAudioTest } from "./audio-test";
import { configureBaronessTimeouts } from "./timeouts";
import styles from "./Baroness.module.css";

export type AudioSetupState = {
  audioUnlocked: boolean;
  critic: BaronessReadiness | null;
  speech: BaronessReadiness | null;
};

export type AudioSetupControlProps = {
  onReadyChange?(state: AudioSetupState): void;
  className?: string;
};

const SERVER_STATE: VoiceState = { speaking: false, sessionId: null, unlocked: false };

async function fetchReadiness(url: string): Promise<BaronessReadiness | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(url, { cache: "no-store", signal: ctrl.signal });
    if (!res.ok) return null;
    const json = (await res.json()) as Partial<BaronessReadiness> | null;
    if (!json || typeof json.ready !== "boolean") return null;
    return {
      ready: json.ready,
      provider: String(json.provider ?? "unknown"),
      detail: json.detail && typeof json.detail === "object" ? json.detail : {},
      problems: Array.isArray(json.problems) ? json.problems.map(String) : [],
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const DETAIL_KEYS = ["model", "modelId", "voice", "voiceId"];

function describe(r: BaronessReadiness): string {
  const shown = DETAIL_KEYS.filter((k) => r.detail[k] !== undefined && r.detail[k] !== "");
  const keys = shown.length > 0 ? shown : Object.keys(r.detail).slice(0, 3);
  return [r.provider, ...keys.map((k) => `${k}: ${String(r.detail[k])}`)].join(" · ");
}

type Tone = "ok" | "warn" | "bad";

function Row({ label, tone, children }: { label: string; tone: Tone; children: React.ReactNode }) {
  return (
    <li className={styles.setupRow} data-tone={tone}>
      <span className={styles.setupDot} aria-hidden="true" />
      <span className={styles.setupLabel}>{label}</span>
      <span className={styles.setupValue}>{children}</span>
    </li>
  );
}

export function AudioSetupControl({ onReadyChange, className }: AudioSetupControlProps) {
  const voice = getBaronessVoice();
  const voiceState = useSyncExternalStore(voice.subscribe, voice.getState, () => SERVER_STATE);
  const unlocked = voiceState.unlocked;

  const [critic, setCritic] = useState<BaronessReadiness | null>(null);
  const [speech, setSpeech] = useState<BaronessReadiness | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<SpeakOutcome | null>(null);
  const [unlockFailed, setUnlockFailed] = useState(false);

  const refresh = useCallback(async () => {
    setChecking(true);
    const [c, s] = await Promise.all([fetchReadiness("/api/critique"), fetchReadiness("/api/speech")]);
    configureBaronessTimeouts({ critiqueServerMs: c?.detail.timeoutMs, speechServerMs: s?.detail.timeoutMs });
    setCritic(c);
    setSpeech(s);
    setChecking(false);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const cb = useRef(onReadyChange);
  useEffect(() => {
    cb.current = onReadyChange;
  });
  useEffect(() => {
    if (checking) return;
    cb.current?.({ audioUnlocked: unlocked, critic, speech });
  }, [unlocked, critic, speech, checking]);

  const visitorActive = isVisitorSessionActive(voiceState.sessionId);

  const enableAndTest = useCallback(async () => {
    // Unlock FIRST and synchronously inside the click handler (user gesture).
    const unlocking = voice.unlock();
    setBusy(true);
    setTestResult(null);
    setUnlockFailed(false);
    try {
      const ok = await unlocking;
      if (!ok) {
        setUnlockFailed(true);
        return;
      }
      // Never speak over a live visitor (speakAudioTest also guards this).
      if (isVisitorSessionActive(voice.getActiveSession())) return;
      const outcome = await speakAudioTest(voice);
      setTestResult(outcome);
      void refresh();
    } finally {
      setBusy(false);
    }
  }, [voice, refresh]);

  const criticTone: Tone = critic === null ? "bad" : critic.ready ? "ok" : "warn";
  const speechTone: Tone = speech === null ? "warn" : speech.ready ? "ok" : "warn";

  return (
    <section className={[styles.setup, className ?? ""].filter(Boolean).join(" ")} aria-label="Audio setup">
      <h2 className={styles.setupTitle}>Baroness audio</h2>

      <div className={styles.setupActions}>
        <button
          type="button"
          className={styles.setupButton}
          onClick={enableAndTest}
          disabled={busy || (unlocked && visitorActive)}
          aria-describedby={unlocked && visitorActive ? "baroness-test-hint" : undefined}
        >
          {busy
            ? "Testing…"
            : unlocked
              ? "Test audio again"
              : visitorActive
                ? "Enable audio"
                : "Enable & test audio"}
        </button>
        <button type="button" className={styles.setupGhost} onClick={() => void refresh()} disabled={checking}>
          {checking ? "Checking…" : "Re-check"}
        </button>
      </div>

      {unlocked && visitorActive && (
        <p id="baroness-test-hint" className={styles.setupNote} data-tone="warn">
          Test disabled while a visitor session is active.
        </p>
      )}

      <ul className={styles.setupList}>
        <Row label="Audio" tone={unlocked ? "ok" : "bad"}>
          {unlocked ? "Unlocked: hands-free audio enabled" : "Locked: press the button (required for spoken critiques)"}
        </Row>
        <Row label="Critic" tone={checking && !critic ? "warn" : criticTone}>
          {critic ? describe(critic) : checking ? "Checking…" : "Unreachable: presets will be used"}
        </Row>
        <Row label="Voice" tone={checking && !speech ? "warn" : speechTone}>
          {speech
            ? describe(speech)
            : checking
              ? "Checking…"
              : "Unreachable: critiques will be text only"}
        </Row>
      </ul>

      {(critic?.problems.length ?? 0) + (speech?.problems.length ?? 0) > 0 && (
        <ul className={styles.setupProblems}>
          {critic?.problems.map((p, i) => (
            <li key={`c${i}`}>Critic: {p}</li>
          ))}
          {speech?.problems.map((p, i) => (
            <li key={`s${i}`}>Voice: {p}</li>
          ))}
        </ul>
      )}

      {unlockFailed && (
        <p className={styles.setupNote} role="alert" data-tone="bad">
          The browser blocked audio ({voiceState.lastError ?? "unknown"}). Click the button again.
        </p>
      )}
      {testResult && (
        <p className={styles.setupNote} role="status" data-tone={testResult.played ? "ok" : "warn"}>
          {testResult.played
            ? `Test played (${testResult.via === "clip" ? "pre-generated clip" : "live voice"}).`
            : `Unlocked, but the test line did not play${testResult.reason ? ` (${testResult.reason})` : ""}. Critiques will be text only.`}
        </p>
      )}
      {speech && !speech.ready && (
        <p className={styles.setupNote} data-tone="warn">
          Warning: voice is not ready. The mirror still works with on-screen text only.
        </p>
      )}
    </section>
  );
}
