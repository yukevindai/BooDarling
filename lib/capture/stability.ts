import { CAPTURE_CONFIG, type CaptureConfig } from "./config";
import type { NormBox } from "./types";

/** Tracks the crop box over time and reports how long it has stayed still. */
export class StabilityTracker {
  private samples: { t: number; cx: number; cy: number; h: number }[] = [];
  constructor(private cfg: CaptureConfig = CAPTURE_CONFIG) {}

  reset() {
    this.samples = [];
  }

  /** Add a sample; returns 0..1 progress toward `stableHoldMs` of continuous stillness. */
  push(box: NormBox, t: number): number {
    const s = { t, cx: box.x + box.w / 2, cy: box.y + box.h / 2, h: box.h };
    // Compare against the first sample of the still period, so slow drift also resets it.
    const anchor = this.samples[0];
    if (anchor && !this.near(anchor, s)) this.samples = [];
    if (this.samples.length === 0) this.samples.push(s);
    const held = t - this.samples[0].t;
    return Math.min(1, held / this.cfg.stableHoldMs);
  }

  private near(a: { cx: number; cy: number; h: number }, b: { cx: number; cy: number; h: number }) {
    const d = Math.hypot(a.cx - b.cx, a.cy - b.cy);
    const scale = Math.abs(a.h - b.h) / Math.max(a.h, 1e-3);
    return d <= this.cfg.stableMaxCenterShift && scale <= this.cfg.stableMaxScaleShift;
  }
}

/** Debounces raw per-frame presence into enter/leave events. */
export class PresenceDebouncer {
  private present = false;
  private since: number | null = null;
  constructor(private cfg: CaptureConfig = CAPTURE_CONFIG) {}

  get isPresent() {
    return this.present;
  }

  /** Returns the new state when it flips, otherwise null. */
  update(raw: boolean, t: number): boolean | null {
    if (raw === this.present) {
      this.since = null;
      return null;
    }
    if (this.since === null) this.since = t;
    const wait = raw ? this.cfg.enterDebounceMs : this.cfg.leaveDebounceMs;
    if (t - this.since >= wait) {
      this.present = raw;
      this.since = null;
      return raw;
    }
    return null;
  }

  reset() {
    this.present = false;
    this.since = null;
  }
}

/** Only lets a new status through after it has persisted for `holdMs`, so guidance doesn't flicker. */
export class StatusHysteresis<T> {
  private shown: T;
  private pending: T | null = null;
  private pendingSince = 0;
  constructor(initial: T, private holdMs: number) {
    this.shown = initial;
  }
  update(raw: T, t: number, immediate = false): T {
    if (raw === this.shown || immediate) {
      this.shown = raw;
      this.pending = null;
      return this.shown;
    }
    if (raw !== this.pending) {
      this.pending = raw;
      this.pendingSince = t;
    } else if (t - this.pendingSince >= this.holdMs) {
      this.shown = raw;
      this.pending = null;
    }
    return this.shown;
  }
}
