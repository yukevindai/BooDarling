"use client";
/**
 * Standalone test bench for R2: opens its own camera, runs the full capture
 * loop with debug overlay, and shows each captured crop. Use it to tune
 * lib/capture/config.ts on the demo laptop before R1's mirror is wired up.
 *
 * Mount temporarily at e.g. app/dev/capture/page.tsx (ask R1):
 *   export default function Page() { return <CaptureSandbox />; }
 * Not part of the visitor flow: the real app uses R1's single camera stream.
 */
import { useEffect, useRef, useState } from "react";
import { dataUrlBytes } from "@/lib/capture/image";
import type { CapturePayload, FramingState } from "@/lib/capture/types";
import { ReflectCamera } from "./ReflectCamera";

export function CaptureSandbox() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [present, setPresent] = useState(false);
  const [status, setStatus] = useState<FramingState["status"]>("idle");
  const [captures, setCaptures] = useState<(CapturePayload & { at: string; kb: number })[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    navigator.mediaDevices
      .getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      .then((s) => {
        stream = s;
        if (videoRef.current) videoRef.current.srcObject = s;
      })
      .catch((e) => setError(String(e)));
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, []);

  // Mimic R1: new session on arrival, clear on departure.
  const onPresenceChange = (p: boolean) => {
    setPresent(p);
    setSessionId(p ? crypto.randomUUID() : null);
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16, padding: 16, background: "#000", color: "#F4EFE6", minHeight: "100vh" }}>
      <div style={{ position: "relative", background: "#111" }}>
        <video ref={videoRef} autoPlay muted playsInline style={{ width: "100%", display: "block", transform: "scaleX(-1)" }} />
        <ReflectCamera
          videoRef={videoRef}
          sessionId={sessionId}
          debug
          onPresenceChange={onPresenceChange}
          onFramingChange={(s) => setStatus(s.status)}
          onReadyCapture={(c) =>
            setCaptures((xs) => [{ ...c, at: new Date().toLocaleTimeString(), kb: Math.round(dataUrlBytes(c.outfitImage) / 1024) }, ...xs].slice(0, 6))
          }
          onError={(e) => setError(String(e))}
        />
      </div>
      <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 13 }}>
        {error && <p style={{ color: "#C8102E" }}>Error: {error}</p>}
        <p>present: {String(present)} · status: {status}</p>
        <p>session: {sessionId ?? "-"}</p>
        <button style={{ pointerEvents: "auto" }} onClick={() => setSessionId(crypto.randomUUID())}>
          Re-arm (testing only)
        </button>
        {captures.map((c) => (
          <figure key={c.at + c.sessionId} style={{ margin: "12px 0" }}>
            <img src={c.outfitImage} alt="captured outfit crop" style={{ maxWidth: "100%", maxHeight: 360 }} />
            <figcaption>
              {c.at} · {c.kb} KB · {c.sessionId.slice(0, 8)}
            </figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}
