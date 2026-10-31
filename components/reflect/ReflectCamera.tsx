"use client";
/**
 * R2 overlay for the mirror. R1 renders the <video> (one shared camera stream)
 * inside a `position: relative` container and drops this component on top:
 *
 *   <div style={{ position: "relative" }}>
 *     <video ref={videoRef} autoPlay muted playsInline style={{ transform: "scaleX(-1)" }} />
 *     <ReflectCamera
 *       videoRef={videoRef}
 *       sessionId={session?.id ?? null}          // non-null = armed for one capture
 *       onReadyCapture={(c) => rate(c)}          // POST /api/rate
 *       onPresenceChange={(p) => !p && endSession()}
 *     />
 *   </div>
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import { CaptureController } from "@/lib/capture/controller";
import { getPoseDetector } from "@/lib/capture/detector";
import type { CaptureDebug, CapturePayload, FramingState, NormBox, Pose } from "@/lib/capture/types";

export type ReflectCameraProps = {
  videoRef: RefObject<HTMLVideoElement | null>;
  /** Set a fresh id per visitor to arm one capture; null disarms. */
  sessionId: string | null;
  onReadyCapture: (capture: CapturePayload) => void;
  onPresenceChange?: (present: boolean) => void;
  onFramingChange?: (state: FramingState) => void;
  /** Called once the pose model is loaded and running (for operator "Ready" check). */
  onReady?: () => void;
  onError?: (err: unknown) => void;
  /** Match the CSS mirroring on the <video>. Default true. */
  mirrored?: boolean;
  /** Show the guidance caption + progress bar. Default true (R1 can render its own instead). */
  showGuidance?: boolean;
  /** Draw landmarks and live numbers for threshold tuning. */
  debug?: boolean;
};

const IVORY = "#F4EFE6";
const RED = "#C8102E";

export function ReflectCamera({
  videoRef,
  sessionId,
  onReadyCapture,
  onPresenceChange,
  onFramingChange,
  onReady,
  onError,
  mirrored = true,
  showGuidance = true,
  debug = false,
}: ReflectCameraProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<CaptureController | null>(null);
  const [framing, setFraming] = useState<FramingState | null>(null);
  const [dbg, setDbg] = useState<CaptureDebug | null>(null);

  // Keep latest callbacks without restarting the loop.
  const cb = useRef({ onReadyCapture, onPresenceChange, onFramingChange, onReady, onError });
  cb.current = { onReadyCapture, onPresenceChange, onFramingChange, onReady, onError };
  const debugRef = useRef(debug);
  debugRef.current = debug;
  const mirroredRef = useRef(mirrored);
  mirroredRef.current = mirrored;
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  // Create the controller once the video element and model are available.
  useEffect(() => {
    let cancelled = false;
    let controller: CaptureController | null = null;
    (async () => {
      try {
        const detector = await getPoseDetector("VIDEO");
        const video = videoRef.current;
        if (cancelled || !video) return;
        controller = new CaptureController(video, detector, {
          onReadyCapture: (c) => cb.current.onReadyCapture(c),
          onPresenceChange: (p) => cb.current.onPresenceChange?.(p),
          onFraming: (s) => {
            setFraming(s);
            cb.current.onFramingChange?.(s);
            draw(canvasRef.current, video, s, null, mirroredRef.current);
          },
          onDebug: (d, poses) => {
            if (!debugRef.current) return;
            setDbg(d);
            draw(canvasRef.current, video, null, poses, mirroredRef.current);
          },
        });
        controllerRef.current = controller;
        if (sessionRef.current) controller.arm(sessionRef.current);
        controller.start();
        cb.current.onReady?.();
      } catch (err) {
        console.error("[capture] failed to start pose detection", err);
        cb.current.onError?.(err);
      }
    })();
    return () => {
      cancelled = true;
      controller?.stop();
      controllerRef.current = null;
    };
  }, [videoRef]);

  // Arm once per session id; disarm on null.
  useEffect(() => {
    const c = controllerRef.current;
    if (!c) return;
    if (sessionId) c.arm(sessionId);
    else c.disarm();
  }, [sessionId]);

  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />
      {showGuidance && framing?.message && (
        <div
          style={{
            position: "absolute",
            left: "50%",
            bottom: "8%",
            transform: "translateX(-50%)",
            padding: "0.6em 1.4em",
            background: "rgba(0,0,0,0.72)",
            color: IVORY,
            fontFamily: "'Playfair Display', Didot, 'Bodoni 72', Georgia, serif",
            fontStyle: "italic",
            fontSize: "clamp(18px, 2.6vw, 34px)",
            letterSpacing: "0.02em",
            whiteSpace: "nowrap",
            borderBottom: `2px solid ${RED}`,
          }}
        >
          {framing.message}
        </div>
      )}
      {showGuidance && framing && framing.progress > 0 && framing.status !== "captured" && (
        <div style={{ position: "absolute", left: "15%", right: "15%", bottom: "4%", height: 3, background: "rgba(244,239,230,0.25)" }}>
          <div style={{ height: "100%", width: `${framing.progress * 100}%`, background: RED, transition: "width 80ms linear" }} />
        </div>
      )}
      {debug && dbg && (
        <pre
          style={{
            position: "absolute",
            top: 8,
            left: 8,
            margin: 0,
            padding: 8,
            background: "rgba(0,0,0,0.7)",
            color: "#9f9",
            font: "12px/1.4 ui-monospace, monospace",
          }}
        >
          {[
            `fps        ${dbg.fps}`,
            `raw        ${dbg.rawStatus}`,
            `shown      ${framing?.status ?? "-"}`,
            `people     ${framing?.people ?? 0}`,
            `shoulderW  ${fmt(dbg.shoulderWidth)}`,
            `centerOff  ${fmt(dbg.centerOffset)}`,
            `sharp      ${fmt(dbg.lastSharpness, 0)} / best ${fmt(dbg.bestSharpness, 0)}`,
            `progress   ${fmt(framing?.progress ?? 0)}`,
            `session    ${sessionId ?? "(disarmed)"}`,
          ].join("\n")}
        </pre>
      )}
    </div>
  );
}

function fmt(n: number | null | undefined, digits = 3) {
  return n === null || n === undefined ? "-" : n.toFixed(digits);
}

// ---------- drawing ----------

/** Map normalized video coords to the overlay's CSS pixels, honouring object-fit and mirroring. */
function mapper(canvas: HTMLCanvasElement, video: HTMLVideoElement, mirrored: boolean) {
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  const vw = video.videoWidth || 1, vh = video.videoHeight || 1;
  const fit = getComputedStyle(video).objectFit;
  const scale = fit === "cover" ? Math.max(cw / vw, ch / vh) : fit === "fill" ? NaN : Math.min(cw / vw, ch / vh);
  const sx = Number.isNaN(scale) ? cw / vw : scale;
  const sy = Number.isNaN(scale) ? ch / vh : scale;
  const ox = (cw - vw * sx) / 2, oy = (ch - vh * sy) / 2;
  return (x: number, y: number) => {
    const nx = mirrored ? 1 - x : x;
    return [ox + nx * vw * sx, oy + y * vh * sy] as const;
  };
}

let lastFraming: FramingState | null = null;
let lastPoses: Pose[] | null = null;

function draw(
  canvas: HTMLCanvasElement | null,
  video: HTMLVideoElement,
  framing: FramingState | null,
  poses: Pose[] | null,
  mirrored: boolean,
) {
  if (!canvas) return;
  if (framing) lastFraming = framing;
  if (poses) lastPoses = poses;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const map = mapper(canvas, video, mirrored);

  const f = lastFraming;
  if (f?.box && f.status !== "empty" && f.status !== "idle" && f.status !== "captured") {
    const active = f.status === "settling" || f.status === "capturing";
    drawBrackets(ctx, map, f.box, active ? RED : "rgba(244,239,230,0.7)", f.status === "capturing" ? 3 : 2);
  }

  // Landmarks only reach here in debug mode (onDebug is gated).
  if (poses && lastPoses) {
    ctx.fillStyle = "#9f9";
    for (const p of lastPoses) {
      for (const lm of p) {
        if ((lm.visibility ?? 0) < 0.5) continue;
        const [x, y] = map(lm.x, lm.y);
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

function drawBrackets(
  ctx: CanvasRenderingContext2D,
  map: (x: number, y: number) => readonly [number, number],
  box: NormBox,
  color: string,
  width: number,
) {
  const [x1a, y1] = map(box.x, box.y);
  const [x2a, y2] = map(box.x + box.w, box.y + box.h);
  const x1 = Math.min(x1a, x2a), x2 = Math.max(x1a, x2a);
  const len = Math.min(x2 - x1, y2 - y1) * 0.12;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  for (const [cx, cy, dx, dy] of [
    [x1, y1, 1, 1], [x2, y1, -1, 1], [x1, y2, 1, -1], [x2, y2, -1, -1],
  ] as const) {
    ctx.moveTo(cx + dx * len, cy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx, cy + dy * len);
  }
  ctx.stroke();
}
