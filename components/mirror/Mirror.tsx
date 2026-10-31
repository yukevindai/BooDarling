"use client";
// R1 OWNS. Hands-free state machine + UI shell. Others plug in via contracts in lib/types.ts.
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useCamera } from "@/lib/camera";
import { initialState, reducer, verdictWord } from "@/lib/session";
import type { Capture, CritiqueResponse, RateResult, SilhouetteDescriptor } from "@/lib/types";
import CaptureStub from "@/components/reflect/CaptureStub";
import SilhouetteOverlay from "@/components/silhouette/SilhouetteOverlay";

const PHRASE_OK = (t: string) => /mirror/.test(t) && /fairest/.test(t);
const SILENT = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
const AUTO_RESET_MS = 45000;

function useTypewriter(text: string | undefined, ms = 32) {
  const [out, setOut] = useState("");
  useEffect(() => {
    setOut(""); if (!text) return;
    let i = 0; const id = setInterval(() => { i++; setOut(text.slice(0, i)); if (i >= text.length) clearInterval(id); }, ms);
    return () => clearInterval(id);
  }, [text, ms]);
  return out;
}

export default function Mirror() {
  const [s, dispatch] = useReducer(reducer, initialState);
  const cam = useCamera();
  const sid = useRef(""); sid.current = s.sessionId;
  const ctrl = useRef<AbortController | null>(null);
  const sil = useRef<SilhouetteDescriptor | null>(null); // latest live silhouette read
  const audio = useRef<HTMLAudioElement | null>(null);
  const [heard, setHeard] = useState("");
  const [listening, setListening] = useState(false);
  const [burst, setBurst] = useState(false);
  const [canSR, setCanSR] = useState(false);
  const recRef = useRef<any>(null);

  // random glitch jolts on the whole frame
  useEffect(() => {
    const id = setInterval(() => { if (Math.random() < 0.5) { setBurst(true); setTimeout(() => setBurst(false), 350); } }, 4500);
    return () => clearInterval(id);
  }, []);
  useEffect(() => { setCanSR(!!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)); }, []);

  const stopAudio = () => { audio.current?.pause(); audio.current = null; };

  const speak = useCallback(async (text: string, id: string) => {
    try {
      const r = await fetch("/api/speech", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: id, text: text.slice(0, 500) }), signal: ctrl.current?.signal });
      if (!r.ok || sid.current !== id) return;
      const a = new Audio(URL.createObjectURL(await r.blob())); audio.current = a; await a.play();
    } catch { /* text stays visible */ }
  }, []);

  const reveal = useCallback(() => {
    recRef.current?.stop(); setListening(false);
    ctrl.current?.abort(); ctrl.current = new AbortController();
    const id = crypto.randomUUID();
    sil.current = null; // fresh silhouette per visitor
    dispatch({ type: "reveal", sessionId: id });
    speak("Well, well. Let's see what we're working with, darling.", id);
  }, [speak]);

  const reset = useCallback(() => {
    ctrl.current?.abort(); stopAudio(); setHeard(""); dispatch({ type: "reset" });
  }, []);

  const listen = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    const r = new SR(); r.lang = "en-US"; r.continuous = true; r.interimResults = true;
    r.onresult = (e: any) => {
      const t = Array.from(e.results).map((x: any) => x[0].transcript).join(" ").toLowerCase();
      setHeard(t); if (PHRASE_OK(t)) reveal();
    };
    r.onend = () => setListening(false); r.onerror = () => setListening(false);
    recRef.current = r; r.start(); setListening(true);
  };

  const begin = async () => {
    new Audio(SILENT).play().catch(() => {}); // unlock browser audio via user gesture
    await cam.start(); dispatch({ type: "start" });
  };

  // pipeline: capture -> rate -> critique -> speak
  const onReadyCapture = useCallback(async (raw: Capture) => {
    // Attach the latest live silhouette read so the critique can comment on it.
    const capture: Capture = sil.current ? { ...raw, silhouette: sil.current } : raw;
    const id = capture.sessionId; dispatch({ type: "captured", capture });
    const signal = ctrl.current?.signal;
    const post = async <T,>(url: string, body: unknown): Promise<T> => {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
      return r.json();
    };
    try {
      let result: RateResult;
      try { result = await post<RateResult>("/api/rate", capture); }
      catch (e) { if (signal?.aborted) return; result = await post<RateResult>("/api/rate", capture); } // one transient retry
      if (sid.current !== id) return;
      dispatch({ type: "rated", result });
      if (result.status !== "ok") return;
      const c = await post<CritiqueResponse>("/api/critique", { capture, result }).catch(() => null);
      if (sid.current !== id) return;
      const text = c?.text ?? "Hm. I have nothing kind to say, and I never lie.";
      dispatch({ type: "critique", text }); speak(text, id);
    } catch { /* aborted on departure */ }
  }, [speak]);

  // auto-return after a while (stands in for R2 departure detection)
  useEffect(() => {
    if (s.phase !== "results") return;
    const t = setTimeout(reset, AUTO_RESET_MS); return () => clearTimeout(t);
  }, [s.phase, reset]);

  const typed = useTypewriter(s.critique);
  const ok = s.result?.status === "ok" ? s.result : null;
  const live = s.phase === "framing" || s.phase === "capturing";
  const fogged = s.phase === "setup" || s.phase === "waiting" || s.phase === "analysing";
  const showShot = (s.phase === "analysing" || s.phase === "results") && s.capture;

  return (
    <main className="stage">
      {s.phase === "setup" && (
        <div className="gate"><div>
          <h1 className="title glitch" data-text="Boo, Darling!">Boo, Darling!</h1>
          <p>Operator setup: allow the camera and enable sound. Visitors never touch the controls.</p>
          <button className="btn" onClick={begin}>Open the dressing room</button>
          {cam.error && <p className="err">{cam.error}</p>}
        </div></div>
      )}

      <header className="head">
        <h1 className="title glitch" data-text="Boo, Darling!">Boo, Darling!</h1>
        <p className="tag">Mirror, mirror on the wall… who’s the fairest of them all?<br /><b>Let the Baroness judge you.</b></p>
      </header>

      <section className={`frame ${burst ? "burst" : ""}`} aria-label="The haunted mirror">
        <div className={`glass creepy ${fogged ? "" : "clear"} ${s.phase === "analysing" ? "deep" : ""} ${s.phase === "results" ? "dark" : ""}`}>
          <video ref={cam.videoRef} muted playsInline style={{ visibility: live || s.phase === "waiting" ? "visible" : "hidden" }} />
          {live && <SilhouetteOverlay videoRef={cam.videoRef} active={live} onDescriptor={(d) => { sil.current = d; }} />}
          {showShot && <img className="shot" alt="Your captured look" src={s.capture!.outfitImage} />}
          <div className={`fog ${fogged ? "on" : "off"}`} />

          {s.phase === "waiting" && (
            <div className="over">
              <p className="riddle">I reveal your beauty, expose your flaws and never lie. Dare to ask who reigns fairest of them all?</p>
              <p className="cue">Speak the words, darling…</p>
              {canSR && <button className={`mic ${listening ? "live" : ""}`} onClick={listen} aria-label="Activate microphone">🎙</button>}
              <p className="heard">{heard && `“${heard}”`}</p>
              <button className="link" onClick={reveal}>Or reveal the mirror</button>
            </div>
          )}

          {live && <div className="line">{s.line}</div>}
          <CaptureStub videoRef={cam.videoRef} active={live} sessionId={s.sessionId}
            onCountdown={() => dispatch({ type: "countdown" })} onReadyCapture={onReadyCapture} />

          {s.phase === "analysing" && (<><div className="scan" /><div className="line glitch" data-text={s.line}>{s.line}</div></>)}

          {s.phase === "results" && (
            <>
              {ok && <>
                <span className="refcap">Closest look: {ok.lookId}</span>
                <img className="ref" alt="Closest reference" src={`/references/cruella/${ok.lookId}/${ok.referenceId}.jpg`}
                  onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = "none")} />
              </>}
              <div className="verdict">
                {ok ? (<>
                  <p className="score glitch" data-text={`${ok.aura}/100`}>{ok.aura}<small>/100</small></p>
                  <p className="adj">{verdictWord(ok.aura)}</p>
                  <p className="crit">{typed}</p>
                </>) : <p className="crit">{s.result && s.result.status === "unavailable" ? s.result.message : "Unable to rate this look"}</p>}
                <button className="btn" onClick={reset}>FACE THE MIRROR AGAIN</button>
              </div>
            </>
          )}
        </div>
      </section>
    </main>
  );
}
