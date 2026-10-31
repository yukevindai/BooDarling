"use client";
// R1 OWNS. Hands-free state machine + UI shell. Others plug in via contracts in lib/types.ts.
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useCamera } from "@/lib/camera";
import { INTRO_LINES, SCARE_SKIPPED_LINE, initialState, reducer, verdictWord } from "@/lib/session";
import type { Phase } from "@/lib/session";
import { lookLabel, phraseMode, presenceAction, referenceImageUrl } from "@/lib/mirror";
import type { Capture, JudgeMode, RateResult, SilhouetteDescriptor } from "@/lib/types";
import { getPoseDetector } from "@/lib/capture/detector";
import type { FramingState } from "@/lib/capture/types";
import { ReflectCamera } from "@/components/reflect/ReflectCamera";
import CaptureStub from "@/components/reflect/CaptureStub";
import { isCritiqueDiscarded, requestCritique } from "@/components/baroness";
import BooCamp from "@/components/boocamp/BooCamp";
import NameEntry from "@/components/leaderboard/NameEntry";
import { LeaderboardBoard, LeaderboardRibbon } from "@/components/leaderboard/Leaderboard";
import { getFaceDetector } from "@/lib/expressions/faceDetector";
import { addEntry, clearEntries } from "@/lib/leaderboard/store";
import { scareVerdict } from "@/lib/expressions/scare";
import SilhouetteOverlay from "@/components/silhouette/SilhouetteOverlay";
import FaceDetectionOverlay from "@/components/reflect/FaceDetectionOverlay";

const SILENT = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
/** Safety net if R2 presence never reports departure while results are showing. */
const RESULTS_TIMEOUT_MS = 120000;
/** Without pose detection (fallback capture) nothing reports departure, so return sooner. */
const RESULTS_TIMEOUT_FALLBACK_MS = 45000;
/** A costume session started by voice/link with nobody in frame is abandoned after this long. */
const EMPTY_FRAMING_TIMEOUT_MS = 20000;
/** Scare mode: the Baroness's intro plays before BooCamp starts its own spoken guidance. */
const SCARE_INTRO_MS = 3000;
/** Scare mode with no readable face: hold the skip line this long (after BooCamp's own 2 s) then wait again. */
const SCARE_SKIP_HOLD_MS = 3500;
/** Last-resort net if BooCamp never finishes (e.g. the face model download hangs); it normally skips itself. */
const SCARE_TIMEOUT_MS = 60000;

/** Leaderboard is shown this long before returning to waiting. */
const BOARD_RESET_MS = 15000;

type PoseStatus = "idle" | "loading" | "ready" | "error";
// Results sub-steps. Costume: outfit verdict -> name -> leaderboard. Scare: (BooCamp in phase "scaring") -> name -> leaderboard.
type Step = "verdict" | "name" | "board";
type Guide = { message: string | null; progress: number };

function useTypewriter(text: string | undefined, ms = 32) {
  const [out, setOut] = useState("");
  useEffect(() => {
    setOut(""); if (!text) return;
    let i = 0; const id = setInterval(() => { i++; setOut(text.slice(0, i)); if (i >= text.length) clearInterval(id); }, ms);
    return () => clearInterval(id);
  }, [text, ms]);
  return out;
}

const errText = (e: unknown) =>
  e instanceof Error ? e.message
  : typeof Event !== "undefined" && e instanceof Event ? `${e.type} while loading model files (CDN unreachable?)`
  : String(e);

export default function Mirror() {
  const [s, dispatch] = useReducer(reducer, initialState);
  const cam = useCamera();
  const sid = useRef(""); sid.current = s.sessionId;
  // Updated eagerly by reveal/reset so two triggers in the same tick can't double-start.
  const phase = useRef<Phase>(s.phase); phase.current = s.phase;
  const present = useRef(false);
  const ctrl = useRef<AbortController | null>(null);
  const silhouette = useRef<SilhouetteDescriptor | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const [heard, setHeard] = useState("");
  const [listening, setListening] = useState(false);
  const [burst, setBurst] = useState(false);
  const [canSR, setCanSR] = useState(false);
  const [pose, setPose] = useState<PoseStatus>("idle");
  const [poseErr, setPoseErr] = useState<string | null>(null);
  const [guide, setGuide] = useState<Guide>({ message: null, progress: 0 });
  const recRef = useRef<any>(null);
  const [step, setStep] = useState<Step>("verdict");
  const stepRef = useRef<Step>("verdict"); stepRef.current = step;
  const [entryId, setEntryId] = useState<string | undefined>();
  const [scareReady, setScareReady] = useState(false);
  /** Bumped by every new line so a slow TTS fetch can't play over (or after) a newer one. */
  const speechGen = useRef(0);

  // random glitch jolts on the whole frame
  useEffect(() => {
    const id = setInterval(() => { if (Math.random() < 0.5) { setBurst(true); setTimeout(() => setBurst(false), 350); } }, 4500);
    return () => clearInterval(id);
  }, []);
  useEffect(() => { setCanSR(!!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)); }, []);

  const stopAudio = () => { speechGen.current++; audio.current?.pause(); audio.current = null; };

  const speak = useCallback(async (text: string, id: string) => {
    const gen = ++speechGen.current;
    try {
      const r = await fetch("/api/speech", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: id, text: text.slice(0, 500) }), signal: ctrl.current?.signal });
      if (!r.ok || sid.current !== id || gen !== speechGen.current) return;
      const blob = await r.blob();
      if (sid.current !== id || gen !== speechGen.current) return;
      const a = new Audio(URL.createObjectURL(blob)); audio.current = a; await a.play();
    } catch { /* text stays visible */ }
  }, []);

  // Start a session. Triggers: the spoken phrase (always listening while waiting) — "fairest" judges the
  // costume, "scariest" the scare face — or the operator's fallback links. Arrival alone never starts a session.
  const reveal = useCallback((mode: JudgeMode) => {
    if (phase.current !== "waiting") return;
    phase.current = mode === "scare" ? "scaring" : "framing";
    const rec = recRef.current; recRef.current = null; rec?.stop(); setListening(false);
    ctrl.current?.abort(); ctrl.current = new AbortController();
    setGuide({ message: null, progress: 0 });
    setStep("verdict"); setEntryId(undefined); setScareReady(false);
    const id = crypto.randomUUID();
    silhouette.current = null;
    dispatch({ type: "reveal", sessionId: id, mode });
    speak(INTRO_LINES[mode], id);
  }, [speak]);

  const reset = useCallback(() => {
    phase.current = "waiting";
    ctrl.current?.abort(); stopAudio(); setHeard(""); setGuide({ message: null, progress: 0 });
    setStep("verdict"); setEntryId(undefined); setScareReady(false);
    dispatch({ type: "reset" });
  }, []);

  // Results button: back to the mirror, which waits for the phrase again.
  const again = useCallback(() => { reset(); }, [reset]);

  // Speech recognition stays on while waiting so visitors only have to speak the phrase.
  // Chrome ends continuous recognition after silence; restart it while still waiting.
  // A permission error ("not-allowed") stops the loop and leaves the mic button for the operator.
  const micBlocked = useRef(false);
  const listen = useCallback(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR || recRef.current || phase.current !== "waiting") return;
    micBlocked.current = false;
    const r = new SR(); r.lang = "en-US"; r.continuous = true; r.interimResults = true;
    r.onresult = (e: any) => {
      const t = Array.from(e.results).map((x: any) => x[0].transcript).join(" ").toLowerCase();
      setHeard(t); const mode = phraseMode(t); if (mode) reveal(mode);
    };
    let failed = false;
    r.onerror = (e: any) => {
      if (e?.error === "not-allowed" || e?.error === "service-not-allowed") micBlocked.current = true;
      // "no-speech"/"aborted" are routine (silence, our own stop); anything else backs off.
      else if (e?.error !== "no-speech" && e?.error !== "aborted") failed = true;
    };
    r.onend = () => {
      if (recRef.current === r) recRef.current = null;
      setListening(false);
      if (!micBlocked.current && phase.current === "waiting") setTimeout(() => listen(), failed ? 2000 : 300);
    };
    recRef.current = r;
    try { r.start(); setListening(true); } catch { recRef.current = null; setListening(false); }
  }, [reveal]);

  // Listen whenever the mirror is waiting (after setup and after every reset).
  useEffect(() => {
    if (s.phase === "waiting" && canSR) listen();
  }, [s.phase, canSR, listen]);

  const begin = async () => {
    new Audio(SILENT).play().catch(() => {}); // unlock browser audio via user gesture
    // Ask for the microphone now (operator setup) so the always-on phrase listener never prompts a visitor.
    navigator.mediaDevices?.getUserMedia?.({ audio: true })
      .then((st) => st.getTracks().forEach((t) => t.stop()))
      .catch(() => { /* mic denied: the fallback link still works */ });
    // Warm the pose model while the camera prompt is up (spec §3). Not awaited: the mirror opens
    // as soon as the camera runs; ReflectCamera picks up the same cached detector.
    if (pose === "idle" || pose === "error") {
      setPose("loading"); setPoseErr(null);
      getPoseDetector().then(() => setPose("ready"), (e) => { setPose("error"); setPoseErr(errText(e)); });
    }
    getFaceDetector().catch(() => { /* BooCamp retries, then skips itself */ }); // warm for scare mode
    if (await cam.start()) dispatch({ type: "start" });
  };

  // pipeline: capture -> rate -> critique -> speak
  const onReadyCapture = useCallback(async (capture: Capture) => {
    const id = capture.sessionId;
    if (sid.current !== id) return; // late capture from a session that already ended
    const captureWithSilhouette: Capture = {
      ...capture,
      ...(silhouette.current ? { silhouette: silhouette.current } : {}),
    };
    dispatch({ type: "captured", capture: captureWithSilhouette });
    const signal = ctrl.current?.signal;
    const post = async <T,>(url: string, body: unknown): Promise<T> => {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
      return r.json();
    };
    try {
      let result: RateResult;
      try { result = await post<RateResult>("/api/rate", captureWithSilhouette); }
      catch (e) { if (signal?.aborted) return; result = await post<RateResult>("/api/rate", captureWithSilhouette); } // one transient retry
      if (sid.current !== id) return;
      dispatch({ type: "rated", result });
      if (result.status !== "ok") return;
      // Bounded wait; on timeout/failure R4's client falls back to the preset line for this score band.
      let text: string;
      try { text = (await requestCritique(captureWithSilhouette, result, { signal })).text; }
      catch (e) { if (isCritiqueDiscarded(e)) return; throw e; } // visitor left / stale: show nothing
      if (sid.current !== id) return;
      dispatch({ type: "critique", text }); speak(text, id);
    } catch { /* aborted on departure */ }
  }, [speak]);

  // R2 presence (debounced): departure ends a session (spec §2). Arrival does not start one.
  const onPresenceChange = useCallback((p: boolean) => {
    present.current = p;
    // Typing a name / reading the board may take visitors out of frame: those steps time out on their own.
    if (presenceAction(phase.current, p) === "reset" && stepRef.current !== "name" && stepRef.current !== "board") reset();
  }, [reset]);

  const onFramingChange = useCallback((f: FramingState) => {
    if (f.status === "capturing" && phase.current === "framing") dispatch({ type: "countdown" });
    const progress = Math.round(f.progress * 50) / 50; // ~12 updates/s otherwise
    setGuide((g) => (g.message === f.message && g.progress === progress ? g : { message: f.message, progress }));
  }, []);

  const onPoseReady = useCallback(() => setPose("ready"), []);
  const onPoseError = useCallback((e: unknown) => { setPose("error"); setPoseErr(errText(e)); }, []);

  // Safety net: leave results even if departure is never reported.
  const fallback = pose === "error";
  // The timer restarts at each phase-two step so BooCamp + name entry aren't cut short.
  useEffect(() => {
    if (s.phase !== "results") return;
    const ms = step === "board" ? BOARD_RESET_MS : fallback ? RESULTS_TIMEOUT_FALLBACK_MS : RESULTS_TIMEOUT_MS;
    const t = setTimeout(reset, ms);
    return () => clearTimeout(t);
  }, [s.phase, step, reset, fallback]);

  // Costume: once the critique has been said, move on to the guest book.
  const rated = s.phase === "results" && s.result?.status === "ok";
  useEffect(() => {
    if (!rated || step !== "verdict" || !s.critique) return;
    const t = setTimeout(() => setStep("name"), Math.max(7000, s.critique.length * 70));
    return () => clearTimeout(t);
  }, [rated, step, s.critique]);

  // Scare: let the Baroness's intro play, then start BooCamp (its model was warmed at setup).
  useEffect(() => {
    if (s.phase !== "scaring") return;
    getFaceDetector().catch(() => {});
    const intro = setTimeout(() => setScareReady(true), SCARE_INTRO_MS);
    const net = setTimeout(reset, SCARE_TIMEOUT_MS);
    return () => { clearTimeout(intro); clearTimeout(net); };
  }, [s.phase, s.sessionId, reset]);

  const onScareDone = useCallback((score: number | null) => {
    dispatch({ type: "scared", sessionId: sid.current, score });
    if (score !== null) setStep("name");
  }, []);

  // Scare skipped (no face / model failed): BooCamp already said the skip line; no leaderboard entry.
  const scareSkipped = s.phase === "results" && s.mode === "scare" && s.scare === null;
  useEffect(() => {
    if (!scareSkipped) return;
    const t = setTimeout(reset, SCARE_SKIP_HOLD_MS);
    return () => clearTimeout(t);
  }, [scareSkipped, reset]);

  const onName = useCallback((name: string) => {
    const e = s.mode === "scare" && typeof s.scare === "number"
      ? addEntry({ mode: "scare", name, scare: s.scare })
      : s.mode === "costume" && s.result?.status === "ok"
        ? addEntry({ mode: "costume", name, aura: s.result.aura, lookId: s.result.lookId })
        : null;
    if (!e) return reset();
    setEntryId(e.id); setStep("board");
  }, [s.mode, s.scare, s.result, reset]);

  // Costume session started by voice/link but nobody ever stepped into frame: go back to waiting.
  // (Scare mode needs no equivalent: BooCamp skips itself when it can't find a face.)
  useEffect(() => {
    if (s.phase !== "framing" || fallback) return;
    const t = setTimeout(() => { if (!present.current) reset(); }, EMPTY_FRAMING_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [s.phase, s.sessionId, reset, fallback]);

  const typed = useTypewriter(s.critique);
  const ok = s.result?.status === "ok" ? s.result : null;
  const live = s.phase === "framing" || s.phase === "capturing";
  const fogged = s.phase === "setup" || s.phase === "waiting" || s.phase === "analysing";
  const scaring = s.phase === "scaring";
  // Scare mode is all about the face: keep the live mirror visible through BooCamp, name entry and board.
  const faceShown = scaring || (s.phase === "results" && s.mode === "scare");
  const showShot = s.mode === "costume" && (s.phase === "analysing" || s.phase === "results") && s.capture;
  const cameraOn = s.phase !== "setup";
  const myScore = s.mode === "scare" ? (s.scare ?? null) : ok?.aura ?? null;

  return (
    <main className="stage">
      {s.phase === "setup" && (
        <div className="gate">
          <div className="gate-inner">
            <h1 className="title glitch" data-text="Boo, Darling!">Boo, Darling!</h1>
            <p className="gate-note">Operator setup: allow the camera and enable sound. Visitors never touch the controls.</p>
            <div className="gate-actions">
              <button className="btn" onClick={begin}>Open the dressing room</button>
              <button className="link" onClick={() => { if (confirm("Clear the whole leaderboard?")) clearEntries(); }}>Clear leaderboard</button>
            </div>
            {cam.error && <p className="err">{cam.error}</p>}
            {pose === "loading" && <p className="gate-note">Warming the pose model…</p>}
            {pose === "error" && <p className="err">Pose model failed to load ({poseErr}). Timed capture will be used; reload to retry.</p>}
          </div>
        </div>
      )}

      <header className="head">
        <h1 className="title glitch" data-text="Boo, Darling!">Boo, Darling!</h1>
        <p></p>
        <p className="tag">Mirror, mirror on the wall… who’s the fairest — or the scariest — of them all?</p>
        <p className="tag tag2">Let the Baroness judge you.</p>
      </header>
      <LeaderboardRibbon />

      <section className={`frame ${burst ? "burst" : ""}`} aria-label="The haunted mirror">
        <div className={`glass creepy ${fogged ? "" : "clear"} ${s.phase === "analysing" ? "deep" : ""} ${s.phase === "results" ? "dark" : ""}`}>
          {/* visibility:hidden (never display:none) so the stream keeps decoding frames for R2's detector. */}
          <video ref={cam.videoRef} muted playsInline style={{ visibility: live || faceShown || s.phase === "waiting" ? "visible" : "hidden" }} />
          {/* R2 runs whenever the camera is on (presence in waiting/results). Armed from framing until the
              capture lands (framing → capturing keeps the same id, so no re-arm); null disarms.
              mirrored: `.glass video` is scaleX(-1) in globals.css. Guidance is drawn below in R1's style. */}
          {cameraOn && !fallback && (
            <ReflectCamera videoRef={cam.videoRef} sessionId={live ? s.sessionId : null}
              mirrored={true} showGuidance={false}
              onReadyCapture={onReadyCapture} onPresenceChange={onPresenceChange} onFramingChange={onFramingChange}
              onReady={onPoseReady} onError={onPoseError} />
          )}
          {live && <SilhouetteOverlay videoRef={cam.videoRef} active={live}
            onDescriptor={(descriptor) => { silhouette.current = descriptor; }} />}
          {(live || scaring) && <FaceDetectionOverlay videoRef={cam.videoRef} active={live || scaring} />}
          {showShot && <img className="shot" alt="Your captured look" src={s.capture!.outfitImage} />}
          <div className={`fog ${fogged ? "on" : "off"}`} />

          {s.phase === "waiting" && (
            <div className="over">
              <p className="riddle">I reveal your beauty, expose your flaws and never lie. Dare to ask who reigns fairest — or scariest — of them all?</p>
              <p className="phrases"><b>Fairest</b> and I judge your costume. <b>Scariest</b> and I judge your most terrifying face.</p>
              <p className="cue">Speak the words, darling…</p>
              {canSR && <button className={`mic ${listening ? "live" : ""}`} onClick={listen} aria-label="Activate microphone">🎙</button>}
              <p className="heard">{heard && `“${heard}”`}</p>
              <div className="links">
                <button className="link" onClick={() => reveal("costume")}>Judge my costume</button>
                <button className="link" onClick={() => reveal("scare")}>Judge my scare face</button>
              </div>
            </div>
          )}
          {s.phase === "waiting" && fallback && <p className="opnote">Pose model unavailable: timed capture. Reload to retry.</p>}

          {/* One caption: R2's framing guidance when it has something to say, else the Baroness's line. */}
          {live && <div className="line guide">{guide.message ?? s.line}</div>}
          {live && !fallback && guide.progress > 0 && (
            <div className="progress" aria-hidden><span style={{ width: `${guide.progress * 100}%` }} /></div>
          )}
          {/* Degraded mode only: pose model failed to load, so fall back to a timed centre crop. */}
          {fallback && (
            <CaptureStub videoRef={cam.videoRef} active={s.phase === "framing" || s.phase === "capturing"} sessionId={s.sessionId}
              onCountdown={() => dispatch({ type: "countdown" })} onReadyCapture={onReadyCapture} />
          )}

          {s.phase === "analysing" && (<><div className="scan" /><div className="line glitch" data-text={s.line}>{s.line}</div></>)}

          {/* Scare mode: intro line, then BooCamp on the live mirror. */}
          {scaring && !scareReady && <div className="line guide">{s.line}</div>}
          {scaring && scareReady && (
            <BooCamp videoRef={cam.videoRef} runId={s.sessionId} onDone={onScareDone} skipLine={SCARE_SKIPPED_LINE}
              onSay={(t) => { stopAudio(); speak(t, s.sessionId); }} />
          )}
          {scareSkipped && <div className="line guide">{s.line}</div>}

          {s.phase === "results" && s.mode && step !== "verdict" && myScore !== null && (
            <>
              {step === "name" && (
                <NameEntry mode={s.mode} score={myScore} onSubmit={onName}
                  verdict={s.mode === "scare" ? scareVerdict(myScore) : verdictWord(myScore)} />
              )}
              {step === "board" && <div className="over"><LeaderboardBoard mode={s.mode} highlightId={entryId} /></div>}
              {step === "board" && <button className="btn boardAgain" onClick={reset}>FACE THE MIRROR AGAIN</button>}
            </>
          )}

          {s.phase === "results" && s.mode === "costume" && step === "verdict" && (
            <>
              {ok && <>
                <span className="refcap">Closest look: {lookLabel(ok.lookId)}</span>
                <img className="ref" alt="Closest reference" src={referenceImageUrl(ok.referenceId)}
                  onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = "none")} />
              </>}
              <div className="verdict">
                {ok ? (<>
                  <p className="score glitch" data-text={`${ok.aura}/100`}>{ok.aura}<small>/100</small></p>
                  <p className="adj">{verdictWord(ok.aura)}</p>
                  <p className="crit">{typed}</p>
                </>) : <p className="crit">{s.result && s.result.status === "unavailable" ? s.result.message : "Unable to rate this look"}</p>}
                <button className="btn" onClick={again}>FACE THE MIRROR AGAIN</button>
              </div>
            </>
          )}
        </div>
      </section>
    </main>
  );
}
