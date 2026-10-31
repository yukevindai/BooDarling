"use client";

import { useEffect, useRef } from "react";
import { getFaceDetector, readFaceBox, type FaceBox } from "@/lib/expressions/faceDetector";

type Props = {
  videoRef: React.RefObject<HTMLVideoElement>;
  active: boolean;
};

export default function FaceDetectionOverlay({ videoRef, active }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let stopped = false;
    let detector: Awaited<ReturnType<typeof getFaceDetector>> | null = null;
    let lastFrameAt = 0;

    const render = (box: FaceBox | null) => {
      const canvas = canvasRef.current;
      const video = videoRef.current;
      if (!canvas || !video) return;
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (!width || !height) return;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, width, height);
      if (!box) return;
      const x = box.x * width;
      const y = box.y * height;
      const w = box.width * width;
      const h = box.height * height;
      ctx.strokeStyle = "#f4f0e8";
      ctx.lineWidth = Math.max(2, width / 240);
      ctx.shadowColor = "#b51220";
      ctx.shadowBlur = Math.max(8, width / 35);
      ctx.strokeRect(x, y, w, h);
      ctx.shadowBlur = 0;
    };

    const loop = (now: number) => {
      if (stopped) return;
      raf = requestAnimationFrame(loop);
      const video = videoRef.current;
      if (!detector || !video || now - lastFrameAt < 100) return;
      lastFrameAt = now;
      render(readFaceBox(detector, video));
    };

    getFaceDetector()
      .then((loaded) => {
        if (stopped) return;
        detector = loaded;
        raf = requestAnimationFrame(loop);
      })
      .catch(() => {});

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      const canvas = canvasRef.current;
      canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [active, videoRef]);

  if (!active) return null;
  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        objectFit: "cover",
        transform: "scaleX(-1)",
        pointerEvents: "none",
        zIndex: 4,
      }}
    />
  );
}
