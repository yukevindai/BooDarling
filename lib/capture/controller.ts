/**
 * Hands-free capture loop (spec §2 steps 1–3, §3).
 *
 *   detect pose → framing check → hold still → sample frames → keep sharpest
 *   → crop → JPEG → onReadyCapture(capture)   (exactly once per arm())
 *
 * R1 owns the camera stream and the session state machine:
 *   - call `arm(sessionId)` when a new visitor session starts,
 *   - listen to `onPresenceChange(false)` to detect departure, then reset and re-arm.
 * The controller never re-arms itself.
 */
import type { PoseLandmarker } from "@mediapipe/tasks-vision";
import { CAPTURE_CONFIG, type CaptureConfig } from "./config";
import { evaluateFraming, GUIDANCE } from "./framing";
import { renderCrop, sharpness, toJpegDataUrl } from "./image";
import { PresenceDebouncer, StabilityTracker, StatusHysteresis } from "./stability";
import type { CaptureDebug, CapturePayload, FramingState, FramingStatus, Pose } from "./types";

export type CaptureCallbacks = {
  /** Fires once per armed session with the sharpest stable outfit crop. */
  onReadyCapture?: (capture: CapturePayload) => void;
  /** Debounced: true once someone has been in frame for enterDebounceMs, false after leaveDebounceMs empty. */
  onPresenceChange?: (present: boolean) => void;
  /** Every detection tick: status, guidance, crop box, progress toward capture. */
  onFraming?: (state: FramingState) => void;
  /** Optional tuning data (only computed cheaply; safe to leave on). */
  onDebug?: (debug: CaptureDebug, poses: Pose[]) => void;
};

/** A couple of bad frames shouldn't wipe out the hold-still progress (spec §2 debounce). */
const MAX_BAD_FRAMES = 2;
/** Statuses that should show up instantly rather than waiting out the guidance hysteresis. */
const INSTANT: FramingStatus[] = ["settling", "capturing", "captured", "idle", "empty"];

export class CaptureController {
  private raf = 0;
  private running = false;
  private lastTick = 0;
  private lastTs = 0;
  private fps = 0;

  private sessionId: string | null = null;
  private captured = false;
  private badFrames = 0;
  private stabilityProgress = 0;
  private collect: { start: number; best: HTMLCanvasElement | null; bestSharp: number; lastSharp: number } | null = null;

  private stability: StabilityTracker;
  private presence: PresenceDebouncer;
  private shown: StatusHysteresis<FramingStatus>;

  constructor(
    private video: HTMLVideoElement,
    private detector: PoseLandmarker,
    private callbacks: CaptureCallbacks = {},
    private cfg: CaptureConfig = CAPTURE_CONFIG,
  ) {
    this.stability = new StabilityTracker(cfg);
    this.presence = new PresenceDebouncer(cfg);
    this.shown = new StatusHysteresis<FramingStatus>("idle", cfg.guidanceHoldMs);
  }

  setCallbacks(cb: CaptureCallbacks) {
    this.callbacks = cb;
  }

  get isPresent() {
    return this.presence.isPresent;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      const now = performance.now();
      if (now - this.lastTick < 1000 / this.cfg.detectFps) return;
      const dt = now - this.lastTick;
      this.lastTick = now;
      this.fps = this.fps ? this.fps * 0.9 + (1000 / dt) * 0.1 : 1000 / dt;
      this.tick(now);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  /** Begin looking for one capture for this session. Safe to call again for a new session. */
  arm(sessionId: string) {
    this.sessionId = sessionId;
    this.captured = false;
    this.resetProgress();
  }

  /** Stop capturing (e.g. multiple-people pause handled by R1, or operator stop). */
  disarm() {
    this.sessionId = null;
    this.captured = false;
    this.resetProgress();
  }

  private resetProgress() {
    this.stability.reset();
    this.collect = null;
    this.badFrames = 0;
    this.stabilityProgress = 0;
  }

  private tick(now: number) {
    const v = this.video;
    if (v.readyState < 2 || !v.videoWidth) return;

    // detectForVideo needs strictly increasing timestamps.
    const ts = Math.max(now, this.lastTs + 1);
    this.lastTs = ts;
    let poses: Pose[] = [];
    try {
      poses = this.detector.detectForVideo(v, ts).landmarks as Pose[];
    } catch (err) {
      console.warn("[capture] detection failed this frame", err);
      return;
    }

    const ev = evaluateFraming(poses, this.cfg);

    // --- Presence (enter / leave), independent of arming ---
    const flip = this.presence.update(ev.status !== "empty", now);
    if (flip !== null) {
      if (!flip) this.resetProgress();
      this.callbacks.onPresenceChange?.(flip);
    }

    // --- Capture state machine ---
    let raw: FramingStatus;
    let progress = 0;
    if (!this.sessionId) raw = ev.status === "empty" ? "empty" : "idle";
    else if (this.captured) raw = "captured";
    else raw = this.advance(ev.status, ev.box, now);

    if (this.sessionId && !this.captured) {
      const collectFrac = this.collect ? Math.min(1, (now - this.collect.start) / this.cfg.collectMs) : 0;
      progress = this.stabilityProgress * 0.8 + collectFrac * 0.2;
    } else if (this.captured) progress = 1;

    const status = this.shown.update(raw, now, INSTANT.includes(raw));
    this.callbacks.onFraming?.({
      status,
      message: GUIDANCE[status],
      guidanceKey: GUIDANCE[status] ? status : null,
      box: ev.box,
      people: ev.people,
      progress,
    });
    this.callbacks.onDebug?.(
      {
        fps: Math.round(this.fps),
        rawStatus: ev.status,
        shoulderWidth: ev.shoulderWidth,
        centerOffset: ev.centerOffset,
        lastSharpness: this.collect?.lastSharp ?? null,
        bestSharpness: this.collect?.bestSharp ?? null,
      },
      poses,
    );
  }

  /** One step of framing → stable → collecting → captured. Returns the raw status to show. */
  private advance(status: FramingStatus, box: ReturnType<typeof evaluateFraming>["box"], now: number): FramingStatus {
    if (status !== "settling" || !box) {
      // Tolerate a brief tracking blip without losing progress.
      const inProgress = this.collect !== null || this.stabilityProgress > 0;
      this.badFrames++;
      if (!inProgress || this.badFrames > MAX_BAD_FRAMES) {
        this.stability.reset();
        this.collect = null;
        this.stabilityProgress = 0;
        return status;
      }
      return this.collect ? "capturing" : "settling";
    }
    this.badFrames = 0;

    if (!this.collect) {
      this.stabilityProgress = this.stability.push(box, now);
      if (this.stabilityProgress < 1) return "settling";
      this.collect = { start: now, best: null, bestSharp: -1, lastSharp: 0 };
    }

    // Collecting: crop this frame and keep the sharpest one in the window.
    const crop = renderCrop(this.video, box, this.cfg);
    const s = sharpness(crop);
    this.collect.lastSharp = s;
    if (s > this.collect.bestSharp) {
      this.collect.best = crop;
      this.collect.bestSharp = s;
    }

    if (now - this.collect.start < this.cfg.collectMs) return "capturing";

    const { best, bestSharp } = this.collect;
    if (!best || bestSharp < this.cfg.minSharpness) {
      // Every frame was blurry (moving, low light). Start another collect window.
      this.collect = { start: now, best: null, bestSharp: -1, lastSharp: s };
      return "settling";
    }

    this.captured = true;
    this.collect = null;
    const sessionId = this.sessionId!;
    this.callbacks.onReadyCapture?.({ sessionId, outfitImage: toJpegDataUrl(best, this.cfg) });
    return "captured";
  }
}
