/**
 * BaronessVoice: framework-agnostic audio controller for the Baroness.
 *
 * - One shared, reusable HTMLAudioElement (unlocked once from an operator gesture).
 * - One utterance at a time; a new speak() supersedes the previous one.
 * - Session gating: audio only plays for the active session; late responses for
 *   stale sessions are discarded; leaving a session stops everything.
 * - speak() NEVER rejects and ALWAYS settles (end, error, stop, or safety timeout),
 *   so the visitor flow can never be trapped behind audio.
 * - Priority: critique > announcement > guidance. Guidance is throttled.
 * - SSR-safe: nothing here touches `window`/`Audio` until a method is called.
 */
import {
  ANNOUNCEMENT_LINES,
  GUIDANCE_LINES,
  scriptedLineIdForText,
  type AnnouncementKey,
  type GuidanceKey,
} from "@/lib/critic/lines";
import { SPEECH_MAX_CHARS, type SpeechRequest } from "@/lib/critic/types";

/* ------------------------------------------------------------------ types */

export type SpeakKind = "critique" | "announcement" | "guidance";
export type SpeakVia = "clip" | "tts" | "none";

/**
 * `played` = audible playback actually started (it may have been cut short later;
 * `reason` then says why: "stopped", "superseded", "session-changed", "timeout", ...).
 */
export type SpeakOutcome = { played: boolean; via: SpeakVia; reason?: string };

export type SpeakOptions = {
  /** Default "critique". Guidance never interrupts a critique. */
  kind?: SpeakKind;
  /** Skip the pre-generated clip lookup and go straight to /api/speech. */
  skipClip?: boolean;
  /** Cache the TTS blob for identical text. Default: true except for unscripted critiques. */
  cache?: boolean;
  /** Per-request timeout for /api/speech. Default 8000 (5000 for guidance). */
  fetchTimeoutMs?: number;
  /** Override the playback safety timeout (ms). */
  maxPlayMs?: number;
};

export type VoiceState = {
  speaking: boolean;
  sessionId: string | null;
  unlocked: boolean;
  lastError?: string;
};

/** The slice of HTMLAudioElement we rely on (lets tests inject a fake). */
export type AudioLike = {
  src: string;
  volume: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onended: ((ev: any) => void) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onerror: ((ev: any) => void) | null;
  play(): Promise<void> | void;
  pause(): void;
  removeAttribute?(name: string): void;
  load?(): void;
};

export type VoiceEnv = {
  /** Returns null when audio is unsupported (SSR, no Audio). */
  createAudio(): AudioLike | null;
  fetch(input: string, init?: RequestInit): Promise<Response>;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

/* ------------------------------------------------------------ pure helpers */

/** True only when `requested` is the currently active session. */
export function isSessionActive(active: string | null, requested: string | null | undefined): boolean {
  return active !== null && requested !== null && requested !== undefined && active === requested;
}

/** Rough speech duration used to size the playback safety timeout. */
export function estimateSpeechMs(text: string): number {
  return Math.max(1500, Math.round(text.trim().length * 70));
}

/** Safety timeout for playback: estimated duration + 4s, clamped to [6s, 25s]. */
export function playbackSafetyMs(text: string): number {
  return Math.min(25_000, Math.max(6_000, estimateSpeechMs(text) + 4_000));
}

/** Clamp to the server's text cap, preferring a sentence boundary. */
export function clampSpeechText(text: string, max = SPEECH_MAX_CHARS): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return lastStop > max * 0.5 ? cut.slice(0, lastStop + 1) : cut.trimEnd();
}

export type ThrottleDecision = { ok: true } | { ok: false; reason: "same-key" | "too-soon" };

/** Guidance throttle: same key not within `sameKeyMs`, any guidance not within `anyMs`. */
export class GuidanceThrottle {
  private lastAny = -Infinity;
  private lastByKey = new Map<string, number>();
  constructor(
    private readonly sameKeyMs = 6000,
    private readonly anyMs = 3000,
  ) {}

  check(key: string, now: number): ThrottleDecision {
    const lastKey = this.lastByKey.get(key);
    if (lastKey !== undefined && now - lastKey < this.sameKeyMs) return { ok: false, reason: "same-key" };
    if (now - this.lastAny < this.anyMs) return { ok: false, reason: "too-soon" };
    return { ok: true };
  }

  record(key: string, now: number): void {
    this.lastAny = now;
    this.lastByKey.set(key, now);
  }

  reset(): void {
    this.lastAny = -Infinity;
    this.lastByKey.clear();
  }
}

/** 0.1s of 8-bit mono silence, used to unlock the shared audio element. */
export function silentWavDataUri(): string {
  const samples = 800;
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) bytes[off + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  ascii(36, "data");
  view.setUint32(40, samples, true);
  bytes.fill(0x80, 44);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return `data:audio/wav;base64,${btoa(bin)}`;
}

/* ------------------------------------------------------------------- env */

function defaultEnv(): VoiceEnv {
  return {
    createAudio: () => {
      if (typeof Audio === "undefined") return null;
      const a = new Audio();
      a.preload = "auto";
      return a as unknown as AudioLike;
    },
    fetch: (input, init) => globalThis.fetch(input, init),
    createObjectURL: (b) => URL.createObjectURL(b),
    revokeObjectURL: (u) => URL.revokeObjectURL(u),
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
}

/* ------------------------------------------------------------ controller */

const PRIORITY: Record<SpeakKind, number> = { guidance: 1, announcement: 2, critique: 3 };
const CLIP_TIMEOUT_MS = 2500;
const CACHE_LIMIT = 32;

type Utterance = {
  id: number;
  sessionId: string;
  kind: SpeakKind;
  controller: AbortController;
  settled: boolean;
  started: boolean;
  via: SpeakVia;
  objectUrl: string | null;
  timers: unknown[];
  resolve: (o: SpeakOutcome) => void;
};

type FetchResult = { blob?: Blob; status?: number; error?: string };

function none(reason: string): SpeakOutcome {
  return { played: false, via: "none", reason };
}

function errName(e: unknown): string {
  return e instanceof Error ? `${e.name}${e.message ? `: ${e.message}` : ""}` : String(e);
}

export class BaronessVoice {
  private audio: AudioLike | null = null;
  private unlocked = false;
  private unlockPromise: Promise<boolean> | null = null;
  private activeSession: string | null = null;
  private critiqueSession: string | null = null;
  private current: Utterance | null = null;
  private seq = 0;
  private throttle = new GuidanceThrottle();
  private cache = new Map<string, Blob>();
  private clipMissing = new Set<string>();
  private listeners = new Set<(s: VoiceState) => void>();
  private state: VoiceState = { speaking: false, sessionId: null, unlocked: false };

  constructor(private readonly env: VoiceEnv = defaultEnv()) {}

  /* ---- subscription (stable references: usable with useSyncExternalStore) */

  subscribe = (listener: (s: VoiceState) => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): VoiceState => this.state;

  isUnlocked = (): boolean => this.unlocked;

  private setState(patch: Partial<VoiceState>): void {
    const next = { ...this.state, ...patch };
    const changed = (Object.keys(next) as (keyof VoiceState)[]).some((k) => next[k] !== this.state[k]);
    if (!changed) return;
    this.state = next;
    for (const l of [...this.listeners]) {
      try {
        l(next);
      } catch {
        /* listener errors must never break audio */
      }
    }
  }

  /* ---- session ---------------------------------------------------------- */

  getActiveSession(): string | null {
    return this.activeSession;
  }

  /** Changing or clearing the session stops any audio and in-flight fetches. */
  setActiveSession(id: string | null): void {
    if (id === this.activeSession) return;
    this.interrupt("session-changed");
    this.activeSession = id;
    this.critiqueSession = null;
    this.throttle.reset();
    this.setState({ sessionId: id });
  }

  /* ---- unlock ----------------------------------------------------------- */

  /**
   * Call from a user gesture. Plays a tiny silent clip on the shared element so
   * later programmatic playback is allowed. The play() call happens synchronously
   * inside the caller's gesture.
   */
  unlock(): Promise<boolean> {
    if (this.unlocked) return Promise.resolve(true);
    if (!this.unlockPromise) {
      this.unlockPromise = this.doUnlock().finally(() => {
        this.unlockPromise = null;
      });
    }
    return this.unlockPromise;
  }

  private async doUnlock(): Promise<boolean> {
    const audio = this.getAudio();
    if (!audio) {
      this.setState({ lastError: "audio-unsupported" });
      return false;
    }
    if (this.current?.started) {
      // Real audio is already playing on the element, so it is evidently unlocked.
      this.unlocked = true;
      this.setState({ unlocked: true });
      return true;
    }
    try {
      audio.src = silentWavDataUri();
      await Promise.resolve(audio.play());
      audio.pause();
      this.resetElement(audio);
      this.unlocked = true;
      this.setState({ unlocked: true, lastError: undefined });
      return true;
    } catch (e) {
      this.setState({ lastError: `unlock-failed: ${errName(e)}` });
      return false;
    }
  }

  private getAudio(): AudioLike | null {
    if (!this.audio) {
      try {
        this.audio = this.env.createAudio();
      } catch {
        this.audio = null;
      }
    }
    return this.audio;
  }

  private resetElement(audio: AudioLike): void {
    audio.onended = null;
    audio.onerror = null;
    try {
      audio.pause();
    } catch {
      /* ignore */
    }
    try {
      audio.removeAttribute?.("src");
      audio.load?.();
    } catch {
      /* ignore */
    }
  }

  /* ---- speaking --------------------------------------------------------- */

  /** Never rejects. Resolves when playback ends / fails / is stopped / times out. */
  speak(sessionId: string, text: string, opts: SpeakOptions = {}): Promise<SpeakOutcome> {
    try {
      const kind = opts.kind ?? "critique";
      const clean = (text ?? "").trim();
      if (!clean) return Promise.resolve(none("empty-text"));
      if (!isSessionActive(this.activeSession, sessionId)) return Promise.resolve(none("inactive-session"));
      if (!this.getAudio()) return Promise.resolve(none("audio-unsupported"));
      if (this.current && PRIORITY[kind] < PRIORITY[this.current.kind]) return Promise.resolve(none("busy"));

      this.interrupt("superseded");
      if (kind === "critique") this.critiqueSession = sessionId;

      let resolve!: (o: SpeakOutcome) => void;
      const promise = new Promise<SpeakOutcome>((r) => {
        resolve = r;
      });
      const utt: Utterance = {
        id: ++this.seq,
        sessionId,
        kind,
        controller: new AbortController(),
        settled: false,
        started: false,
        via: "none",
        objectUrl: null,
        timers: [],
        resolve,
      };
      this.current = utt;
      this.run(utt, clean, opts).catch((e) => {
        this.setState({ lastError: errName(e) });
        this.settle(utt, errName(e));
      });
      return promise;
    } catch (e) {
      return Promise.resolve(none(errName(e)));
    }
  }

  /** Convenience: speak a scripted announcement line. */
  announce(key: AnnouncementKey, sessionId: string, opts: SpeakOptions = {}): Promise<SpeakOutcome> {
    return this.speak(sessionId, ANNOUNCEMENT_LINES[key].text, { kind: "announcement", ...opts });
  }

  /**
   * Speak framing guidance with throttling. Never interrupts a critique, an
   * announcement, or other guidance already speaking; silent after the critique
   * for this session has started.
   */
  playGuidance(key: GuidanceKey, sessionId: string): Promise<SpeakOutcome> {
    if (!isSessionActive(this.activeSession, sessionId)) return Promise.resolve(none("inactive-session"));
    if (!this.unlocked) return Promise.resolve(none("locked"));
    if (this.critiqueSession === sessionId) return Promise.resolve(none("after-critique"));
    if (this.current) return Promise.resolve(none("busy"));
    const now = this.env.now();
    const decision = this.throttle.check(key, now);
    if (!decision.ok) return Promise.resolve(none(`throttled:${decision.reason}`));
    this.throttle.record(key, now);
    return this.speak(sessionId, GUIDANCE_LINES[key].text, { kind: "guidance" });
  }

  /** Abort in-flight fetches and silence playback. Pending speak() promises resolve. */
  stop(): void {
    this.interrupt("stopped");
  }

  clearCache(): void {
    this.cache.clear();
    this.clipMissing.clear();
  }

  /* ---- internals -------------------------------------------------------- */

  private interrupt(reason: string): void {
    if (this.current) this.settle(this.current, reason);
  }

  private settle(utt: Utterance, reason?: string): void {
    if (utt.settled) return;
    utt.settled = true;
    for (const t of utt.timers) this.env.clearTimeout(t);
    utt.timers = [];
    try {
      utt.controller.abort();
    } catch {
      /* ignore */
    }
    if (this.current === utt) {
      this.current = null;
      if (this.audio) this.resetElement(this.audio);
    }
    if (utt.objectUrl) {
      try {
        this.env.revokeObjectURL(utt.objectUrl);
      } catch {
        /* ignore */
      }
      utt.objectUrl = null;
    }
    if (!this.current) this.setState({ speaking: false });
    utt.resolve({ played: utt.started, via: utt.started ? utt.via : "none", reason });
  }

  private remember(key: string, blob: Blob): void {
    this.cache.delete(key);
    this.cache.set(key, blob);
    while (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private async fetchBlob(
    utt: Utterance,
    url: string,
    init: RequestInit,
    timeoutMs: number,
    requireAudioType: boolean,
  ): Promise<FetchResult> {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    utt.controller.signal.addEventListener("abort", onAbort);
    const timer = this.env.setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.env.fetch(url, { ...init, signal: ctrl.signal });
      if (!res.ok) return { status: res.status };
      const type = res.headers.get("content-type") ?? "";
      if (requireAudioType && /text\/html|json/i.test(type)) return { status: 404 };
      const blob = await res.blob();
      if (blob.size === 0) return { error: "empty-audio" };
      return { blob };
    } catch (e) {
      return { error: errName(e) };
    } finally {
      this.env.clearTimeout(timer);
      utt.controller.signal.removeEventListener("abort", onAbort);
    }
  }

  private async run(utt: Utterance, text: string, opts: SpeakOptions): Promise<void> {
    const lineId = scriptedLineIdForText(text);
    let blob: Blob | undefined;
    let via: SpeakVia = "none";

    // 1. Pre-generated clip (scripted lines only). Misses are silent and remembered.
    if (lineId && !opts.skipClip && !this.clipMissing.has(lineId)) {
      const key = `clip:${lineId}`;
      blob = this.cache.get(key);
      if (!blob) {
        const r = await this.fetchBlob(utt, `/audio/baroness/${lineId}.mp3`, {}, CLIP_TIMEOUT_MS, true);
        if (utt.settled) return;
        if (r.blob) {
          blob = r.blob;
          this.remember(key, blob);
        } else if (r.status !== undefined) {
          this.clipMissing.add(lineId);
        }
      }
      if (blob) via = "clip";
    }

    // 2. Live TTS.
    if (!blob) {
      const ttsText = clampSpeechText(text);
      const key = `tts:${ttsText}`;
      blob = this.cache.get(key);
      if (!blob) {
        const body: SpeechRequest = { sessionId: utt.sessionId, text: ttsText };
        const timeout = opts.fetchTimeoutMs ?? (utt.kind === "guidance" ? 5000 : 8000);
        const r = await this.fetchBlob(
          utt,
          "/api/speech",
          { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
          timeout,
          false,
        );
        if (utt.settled) return;
        if (!r.blob) {
          const reason = r.status !== undefined ? `speech-${r.status}` : (r.error ?? "speech-failed");
          this.setState({ lastError: reason });
          this.settle(utt, reason);
          return;
        }
        blob = r.blob;
        if (opts.cache ?? (utt.kind !== "critique" || !!lineId)) this.remember(key, blob);
      }
      via = "tts";
    }

    // 3. Late-response guard, then play on the shared element.
    if (utt.settled) return;
    if (this.current !== utt || !isSessionActive(this.activeSession, utt.sessionId)) {
      this.settle(utt, "stale-session");
      return;
    }
    const audio = this.getAudio();
    if (!audio) {
      this.settle(utt, "audio-unsupported");
      return;
    }

    const url = this.env.createObjectURL(blob);
    utt.objectUrl = url;
    audio.onended = () => {
      utt.started = true;
      utt.via = via;
      this.settle(utt);
    };
    audio.onerror = () => {
      this.setState({ lastError: "playback-error" });
      this.settle(utt, "playback-error");
    };
    audio.src = url;
    audio.volume = 1;
    utt.timers.push(
      this.env.setTimeout(() => this.settle(utt, "timeout"), opts.maxPlayMs ?? playbackSafetyMs(text)),
    );
    try {
      await Promise.resolve(audio.play());
    } catch (e) {
      if (utt.settled) return;
      const reason = `play-blocked: ${errName(e)}`;
      this.setState({ lastError: reason });
      this.settle(utt, reason);
      return;
    }
    if (utt.settled) return;
    utt.started = true;
    utt.via = via;
    this.setState({ speaking: true, lastError: undefined });
  }
}

/* ------------------------------------------------------------- singleton */

export function createBaronessVoice(env?: VoiceEnv): BaronessVoice {
  return new BaronessVoice(env);
}

const SINGLETON_KEY = "__baronessVoice";

/** Singleton (survives dev hot-reload so there is only ever one audio element). */
export function getBaronessVoice(): BaronessVoice {
  const g = globalThis as unknown as Record<string, BaronessVoice | undefined>;
  const existing = g[SINGLETON_KEY];
  if (existing) return existing;
  const voice = new BaronessVoice();
  g[SINGLETON_KEY] = voice;
  return voice;
}
