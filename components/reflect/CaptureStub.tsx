"use client";
// R2 REPLACES THIS with real detection/framing/auto-crop (components/reflect/, lib/capture/).
// Contract: call onCountdown(n) when stable framing begins, onReadyCapture(capture) ONCE per session.
import { useEffect, useRef, useState } from "react";
import type { Capture } from "@/lib/types";

type Props = {
  videoRef: React.RefObject<HTMLVideoElement>; active: boolean; sessionId: string;
  onCountdown: () => void; onReadyCapture: (c: Capture) => void;
};

export default function CaptureStub({ videoRef, active, sessionId, onCountdown, onReadyCapture }: Props) {
  const [n, setN] = useState<number | null>(null);
  const fired = useRef("");
  useEffect(() => {
    if (!active || !sessionId || fired.current === sessionId) return;
    let c = 3; let t: ReturnType<typeof setTimeout>;
    const begin = setTimeout(() => {
      onCountdown(); setN(c);
      const tick = () => {
        c -= 1;
        if (c > 0) { setN(c); t = setTimeout(tick, 1000); return; }
        setN(null); fired.current = sessionId;
        const v = videoRef.current; if (!v || !v.videoWidth) return;
        const h = v.videoHeight, w = Math.round(h * 0.75), sx = (v.videoWidth - w) / 2;
        const cv = document.createElement("canvas"); cv.width = 540; cv.height = 720;
        cv.getContext("2d")!.drawImage(v, sx, 0, w, h, 0, 0, 540, 720);
        onReadyCapture({ sessionId, outfitImage: cv.toDataURL("image/jpeg", 0.85) });
      };
      t = setTimeout(tick, 1000);
    }, 1200);
    return () => { clearTimeout(begin); clearTimeout(t); setN(null); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, sessionId]);
  return n ? <div className="count glitch" data-text={n}>{n}</div> : null;
}
