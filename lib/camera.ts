"use client";
import { useCallback, useEffect, useRef, useState } from "react";

// R1 owns the ONE camera stream. Others receive videoRef.
export function useCamera() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play().catch(() => {}); }
      setReady(true); setError(null);
    } catch { setError("Camera blocked. Allow camera access in the browser and reload."); }
  }, []);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null; setReady(false);
  }, []);

  useEffect(() => () => stop(), [stop]);
  return { videoRef, start, stop, ready, error };
}
