"use client";
/**
 * Real-time silhouette overlay.
 *
 * Runs MediaPipe's Image Segmenter on the shared camera <video> and paints the
 * person's silhouette over it: the figure is tinted crimson, the background is
 * darkened, so the outline reads clearly in the mirror. While live it also emits
 * a garment-focused SilhouetteDescriptor (throttled) via `onDescriptor`, which
 * the mirror attaches to the capture so the Baroness can critique the silhouette.
 *
 * The canvas matches the video's CSS exactly (object-fit: cover + scaleX(-1)
 * mirror), and the segmentation mask is returned at the video's frame resolution,
 * so the overlay lines up with what the visitor sees.
 */
import { useEffect, useRef } from "react";
import type { ImageSegmenterResult } from "@mediapipe/tasks-vision";
import type { SilhouetteDescriptor } from "@/lib/types";
import { describeSilhouette, getImageSegmenter, SILHOUETTE_CONFIG } from "@/lib/silhouette";

type Props = {
  videoRef: React.RefObject<HTMLVideoElement>;
  active: boolean;
  onDescriptor?: (d: SilhouetteDescriptor) => void;
};

export default function SilhouetteOverlay({ videoRef, active, onDescriptor }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cb = useRef(onDescriptor);
  cb.current = onDescriptor;

  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let stopped = false;
    let lastFrameAt = 0;
    let lastTs = -1;
    let lastDescAt = 0;
    let imgData: ImageData | null = null;
    let segmenter: Awaited<ReturnType<typeof getImageSegmenter>> | null = null;
    const minFrameMs = 1000 / SILHOUETTE_CONFIG.segmentFps;
    const thr = SILHOUETTE_CONFIG.foregroundThreshold;

    const render = (result: ImageSegmenterResult, now: number) => {
      const masks = result.confidenceMasks;
      const canvas = canvasRef.current;
      if (!masks || masks.length === 0 || !canvas) {
        masks?.forEach((m) => m.close());
        return;
      }
      const mask = masks[0];
      const w = mask.width;
      const h = mask.height;
      const conf = mask.getAsFloat32Array();

      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        imgData = null;
      }
      const ctx = canvas.getContext("2d");
      if (ctx) {
        if (!imgData) imgData = ctx.createImageData(w, h);
        const d = imgData.data;
        for (let i = 0, p = 0; i < conf.length; i++, p += 4) {
          if (conf[i] >= thr) {
            d[p] = 201; d[p + 1] = 24; d[p + 2] = 37; d[p + 3] = 120; // crimson figure
          } else {
            d[p] = 9; d[p + 1] = 9; d[p + 2] = 9; d[p + 3] = 140; // darkened ground
          }
        }
        ctx.putImageData(imgData, 0, 0);
      }

      if (cb.current && now - lastDescAt >= SILHOUETTE_CONFIG.descriptorEveryMs) {
        const desc = describeSilhouette(conf, w, h, {
          threshold: thr,
          version: SILHOUETTE_CONFIG.descriptorVersion,
        });
        if (desc && desc.phrase) {
          lastDescAt = now;
          cb.current(desc);
        }
      }
      masks.forEach((m) => m.close());
    };

    const loop = (now: number) => {
      if (stopped) return;
      raf = requestAnimationFrame(loop);
      const v = videoRef.current;
      if (!segmenter || !v || v.readyState < 2 || !v.videoWidth) return;
      if (now - lastFrameAt < minFrameMs) return;
      lastFrameAt = now;
      // Timestamps must strictly increase for VIDEO running mode.
      const ts = Math.max(lastTs + 1, Math.round(now));
      lastTs = ts;
      segmenter.segmentForVideo(v, ts, (result) => render(result, now));
    };

    getImageSegmenter("VIDEO")
      .then((s) => {
        if (stopped) return;
        segmenter = s;
        raf = requestAnimationFrame(loop);
      })
      .catch((err) => console.warn("[silhouette] segmenter unavailable", err));

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
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
        transform: "scaleX(-1)", // match `.glass video` mirroring
        pointerEvents: "none",
        zIndex: 2,
      }}
    />
  );
}
