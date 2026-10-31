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
      if (!metrics) {
        ctx.fillStyle = "rgba(9, 9, 9, 0.78)";
        ctx.font = `600 ${Math.max(14, width / 48)}px sans-serif`;
        ctx.fillText("FACE SCAN SEARCHING", 16, 32);
        return;
      }
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

      const point = (index: number) => {
        const p = metrics.landmarks[index];
        if (!p) return null;
        return { x: (1 - p.x) * width, y: p.y * height };
      };
      const drawPath = (indices: number[], close = false) => {
        const points = indices.map(point).filter((p): p is { x: number; y: number } => p !== null);
        if (points.length < 2) return;
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (const p of points.slice(1)) ctx.lineTo(p.x, p.y);
        if (close) ctx.closePath();
        ctx.stroke();
      };
      ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
      ctx.lineWidth = Math.max(1.5, width / 400);
      ctx.shadowColor = "#b51220";
      ctx.shadowBlur = Math.max(4, width / 90);
      // MediaPipe Face Landmarker regions: face oval, eyes, nose bridge, and mouth.
      drawPath([10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109, 10], true);
      drawPath([33, 133, 160, 159, 158, 157, 173]);
      drawPath([263, 362, 387, 386, 385, 384, 398]);
      drawPath([168, 6, 197, 195, 5, 4, 1, 19, 94]);
      drawPath([61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 308, 324, 318, 61], true);
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
