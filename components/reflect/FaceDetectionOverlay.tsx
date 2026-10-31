"use client";

import { useEffect, useRef } from "react";
import { getFaceDetector, readFaceMetrics, type FaceBox, type FaceMetrics } from "@/lib/expressions/faceDetector";
import { ScareMeter } from "@/lib/expressions/scare";

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
    let baselineStartedAt = 0;
    const meter = new ScareMeter();

    const render = (metrics: FaceMetrics | null, now: number) => {
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
      if (!metrics) return;
      const box: FaceBox = metrics.box;
      // The video is mirrored in CSS, so mirror the detected bounds in canvas
      // coordinates while keeping the score label readable.
      const x = (1 - box.x - box.width) * width;
      const y = box.y * height;
      const w = box.width * width;
      const h = box.height * height;
      if (!baselineStartedAt) baselineStartedAt = now;
      const calibrating = now - baselineStartedAt < 1500;
      if (calibrating) meter.addBaseline(metrics.blendshapes);
      const score = calibrating ? null : meter.push(metrics.blendshapes);
      const label = score === null ? "CALIBRATING SCARY SCORE" : `LIVE SCARY SCORE ${score}`;
      ctx.strokeStyle = "#f4f0e8";
      ctx.lineWidth = Math.max(2, width / 240);
      ctx.shadowColor = "#b51220";
      ctx.shadowBlur = Math.max(8, width / 35);
      ctx.strokeRect(x, y, w, h);
      ctx.shadowBlur = 0;
      ctx.font = `600 ${Math.max(14, width / 48)}px sans-serif`;
      const labelWidth = ctx.measureText(label).width + 20;
      const labelX = Math.max(8, Math.min(width - labelWidth - 8, x));
      const labelY = Math.max(28, y - 10);
      ctx.fillStyle = "rgba(9, 9, 9, 0.82)";
      ctx.fillRect(labelX, labelY - 24, labelWidth, 28);
      ctx.fillStyle = "#f4f0e8";
      ctx.fillText(label, labelX + 10, labelY - 4);
    };

    const loop = (now: number) => {
      if (stopped) return;
      raf = requestAnimationFrame(loop);
      const video = videoRef.current;
      if (!detector || !video || now - lastFrameAt < 100) return;
      lastFrameAt = now;
      render(readFaceMetrics(detector, video), now);
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
        pointerEvents: "none",
        zIndex: 4,
      }}
    />
  );
}
