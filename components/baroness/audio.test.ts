import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ANNOUNCEMENT_LINES, GUIDANCE_LINES, PRESET_CRITIQUES } from "../../lib/critic/lines";
import {
  clampSpeechText,
  createBaronessVoice,
  GuidanceThrottle,
  isSessionActive,
  playbackSafetyMs,
  silentWavDataUri,
  type AudioLike,
  type VoiceEnv,
  type VoiceState,
} from "./audio";

/* ----------------------------------------------------------------- fakes */

class FakeAudio implements AudioLike {
  src = "";
  volume = 1;
  onended: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  plays: string[] = [];
  paused = 0;
  playImpl: () => Promise<void> = () => Promise.resolve();
  play() {
    this.plays.push(this.src);
    return this.playImpl();
  }
  pause() {
    this.paused++;
  }
  removeAttribute() {
    this.src = "";
  }
  load() {}
  end() {
    this.onended?.({});
  }
}

type Handler = (init: RequestInit | undefined) => Promise<Response> | Response;

function audioResponse(): Response {
  return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-type": "audio/mpeg" } });
}

function makeEnv(handlers: Record<string, Handler>) {
  const audio = new FakeAudio();
  const calls: { url: string; body?: string }[] = [];
  const created: string[] = [];
  const revoked: string[] = [];
  let clock = 0;
  let nextTimer = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let n = 0;
  const env: VoiceEnv = {
    createAudio: () => audio,
    fetch: (url, init) => {
      calls.push({ url, body: init?.body as string | undefined });
      const h = handlers[url];
      if (!h) return Promise.resolve(new Response("nope", { status: 404 }));
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        Promise.resolve(h(init)).then(resolve, reject);
      });
    },
    createObjectURL: () => {
      const u = `blob:fake-${++n}`;
      created.push(u);
      return u;
    },
    revokeObjectURL: (u) => revoked.push(u),
    now: () => clock,
    setTimeout: (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { at: clock + ms, fn });
      return id;
    },
    clearTimeout: (h) => {
      timers.delete(h as number);
    },
  };
  const advance = (ms: number) => {
    clock += ms;
    for (const [id, t] of [...timers]) {
      if (t.at <= clock) {
        timers.delete(id);
        t.fn();
      }
    }
  };
  return { env, audio, calls, created, revoked, advance };
}

const tick = () => new Promise<void>((r) => setImmediate(r));
async function flush(n = 6) {
  for (let i = 0; i < n; i++) await tick();
}

const PRESET = PRESET_CRITIQUES.promising[0].text;
const CLIP_URL = "/audio/baroness/preset-promising-1.mp3";

/* ------------------------------------------------------------ pure logic */

describe("pure helpers", () => {
  it("isSessionActive only matches the exact active session", () => {
    assert.equal(isSessionActive("a", "a"), true);
    assert.equal(isSessionActive("a", "b"), false);
    assert.equal(isSessionActive(null, "a"), false);
    assert.equal(isSessionActive("a", null), false);
    assert.equal(isSessionActive(null, null), false);
  });

  it("GuidanceThrottle: same key 6s, any guidance 3s", () => {
    const t = new GuidanceThrottle();
    assert.deepEqual(t.check("step-back", 0), { ok: true });
    t.record("step-back", 0);
    assert.deepEqual(t.check("step-back", 5000), { ok: false, reason: "same-key" });
    assert.deepEqual(t.check("center", 2999), { ok: false, reason: "too-soon" });
    assert.deepEqual(t.check("center", 3000), { ok: true });
    t.record("center", 3000);
    assert.deepEqual(t.check("step-back", 5999), { ok: false, reason: "same-key" });
    assert.deepEqual(t.check("step-back", 6000), { ok: true });
    t.reset();
    assert.deepEqual(t.check("center", 3001), { ok: true });
  });

  it("clampSpeechText respects the 500 char cap, preferring sentence ends", () => {
    const sentence = "This is a sentence. ";
    const long = sentence.repeat(40);
    const out = clampSpeechText(long);
    assert.ok(out.length <= 500);
    assert.ok(out.endsWith("."));
    assert.equal(clampSpeechText("  short  "), "short");
    assert.equal(clampSpeechText("x".repeat(900)).length, 500);
  });

  it("playbackSafetyMs is clamped to [6s, 25s]", () => {
    assert.equal(playbackSafetyMs("hi"), 6000);
    assert.equal(playbackSafetyMs("x".repeat(5000)), 25000);
    const mid = playbackSafetyMs("x".repeat(100));
    assert.ok(mid > 6000 && mid < 25000);
  });

  it("silentWavDataUri is a valid RIFF/WAVE data URI", () => {
    const uri = silentWavDataUri();
    assert.ok(uri.startsWith("data:audio/wav;base64,"));
    const bytes = Buffer.from(uri.split(",")[1], "base64");
    assert.equal(bytes.subarray(0, 4).toString(), "RIFF");
    assert.equal(bytes.subarray(8, 12).toString(), "WAVE");
  });
});

/* ------------------------------------------------------------ controller */

describe("BaronessVoice", () => {
  it("unlock plays a silent clip and flips state", async () => {
    const { env, audio } = makeEnv({});
    const v = createBaronessVoice(env);
    const states: VoiceState[] = [];
    v.subscribe((s) => states.push(s));
    assert.equal(v.isUnlocked(), false);
    assert.equal(await v.unlock(), true);
    assert.equal(v.isUnlocked(), true);
    assert.ok(audio.plays[0].startsWith("data:audio/wav"));
    assert.equal(states.at(-1)?.unlocked, true);
  });

  it("unlock reports failure when the browser blocks play()", async () => {
    const { env, audio } = makeEnv({});
    audio.playImpl = () => Promise.reject(new DOMException("blocked", "NotAllowedError"));
    const v = createBaronessVoice(env);
    assert.equal(await v.unlock(), false);
    assert.equal(v.isUnlocked(), false);
    assert.match(v.getState().lastError ?? "", /unlock-failed/);
  });

  it("refuses to speak for an inactive session", async () => {
    const { env, calls } = makeEnv({});
    const v = createBaronessVoice(env);
    assert.deepEqual(await v.speak("s1", "Hello there."), { played: false, via: "none", reason: "inactive-session" });
    v.setActiveSession("s2");
    assert.equal((await v.speak("s1", "Hello there.")).played, false);
    assert.equal(calls.length, 0);
  });

  it("plays a scripted line from its pre-generated clip and resolves on end", async () => {
    const { env, audio, calls, created, revoked } = makeEnv({ [CLIP_URL]: () => audioResponse() });
    const v = createBaronessVoice(env);
    v.setActiveSession("s1");
    const p = v.speak("s1", PRESET);
    await flush();
    assert.equal(audio.plays.length, 1);
    assert.equal(v.getState().speaking, true);
    audio.end();
    const out = await p;
    assert.deepEqual(out, { played: true, via: "clip", reason: undefined });
    assert.equal(v.getState().speaking, false);
    assert.deepEqual(calls.map((c) => c.url), [CLIP_URL]);
    assert.deepEqual(revoked, created);
  });

  it("falls back to /api/speech on clip 404 and remembers the miss", async () => {
    const { env, audio, calls } = makeEnv({ "/api/speech": () => audioResponse() });
    const v = createBaronessVoice(env);
    v.setActiveSession("s1");
    const p1 = v.speak("s1", PRESET);
    await flush();
    audio.end();
    assert.equal((await p1).via, "tts");
    assert.deepEqual(calls.map((c) => c.url), [CLIP_URL, "/api/speech"]);
    assert.deepEqual(JSON.parse(calls[1].body ?? "{}"), { sessionId: "s1", text: PRESET });

    // Second time: no clip request (known miss) and TTS blob served from cache.
    const p2 = v.speak("s1", PRESET);
    await flush();
    audio.end();
    assert.equal((await p2).via, "tts");
    assert.equal(calls.length, 2);

    v.clearCache();
    const p3 = v.speak("s1", PRESET);
    await flush();
    audio.end();
    await p3;
    assert.equal(calls.length, 4); // clip + speech again
  });

  it("unscripted critique text goes straight to TTS and is not cached", async () => {
    const { env, audio, calls } = makeEnv({ "/api/speech": () => audioResponse() });
    const v = createBaronessVoice(env);
    v.setActiveSession("s1");
    const text = "A bespoke observation. A bespoke suggestion.";
    for (let i = 0; i < 2; i++) {
      const p = v.speak("s1", text);
      await flush();
      audio.end();
      assert.equal((await p).via, "tts");
    }
    assert.deepEqual(calls.map((c) => c.url), ["/api/speech", "/api/speech"]);
  });

  it("never rejects when speech fails (503, network error)", async () => {
    const { env } = makeEnv({
      "/api/speech": () => new Response(JSON.stringify({ error: "off" }), { status: 503 }),
    });
    const v = createBaronessVoice(env);
    v.setActiveSession("s1");
    const out = await v.speak("s1", "Some words. More words.");
    assert.deepEqual(out, { played: false, via: "none", reason: "speech-503" });
    assert.equal(v.getState().lastError, "speech-503");

    const e2 = makeEnv({
      "/api/speech": () => {
        throw new TypeError("network down");
      },
    });
    const v2 = createBaronessVoice(e2.env);
    v2.setActiveSession("s1");
    const out2 = await v2.speak("s1", "Some words. More words.");
    assert.equal(out2.played, false);
    assert.match(out2.reason ?? "", /network down/);
  });

  it("reports play-blocked when the browser refuses playback", async () => {
    const { env, audio, revoked, created } = makeEnv({ "/api/speech": () => audioResponse() });
    audio.playImpl = () => Promise.reject(new DOMException("no gesture", "NotAllowedError"));
    const v = createBaronessVoice(env);
    v.setActiveSession("s1");
    const out = await v.speak("s1", "Some words. More words.");
    assert.equal(out.played, false);
    assert.match(out.reason ?? "", /play-blocked/);
    assert.deepEqual(revoked, created);
  });

  it("discards a late response when the session changes mid-fetch", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { env, audio, created } = makeEnv({
      "/api/speech": async () => {
        await gate;
        return audioResponse();
      },
    });
    const v = createBaronessVoice(env);
    v.setActiveSession("s1");
    const p = v.speak("s1", "Some words. More words.");
    await flush();
    v.setActiveSession("s2");
    release();
    const out = await p;
    assert.equal(out.played, false);
    assert.equal(out.reason, "session-changed");
    await flush();
    assert.equal(audio.plays.length, 0);
    assert.equal(created.length, 0);
  });

  it("setActiveSession(null) and stop() silence playback and resolve the pending promise", async () => {
    const { env, audio, revoked, created } = makeEnv({ "/api/speech": () => audioResponse() });
    const v = createBaronessVoice(env);
    v.setActiveSession("s1");
    const p = v.speak("s1", "Some words. More words.");
    await flush();
    assert.equal(v.getState().speaking, true);
    v.setActiveSession(null);
    const out = await p;
    assert.equal(out.played, true); // it had started
    assert.equal(out.reason, "session-changed");
    assert.equal(v.getState().speaking, false);
    assert.ok(audio.paused > 0);
    assert.deepEqual(revoked, created);

    v.setActiveSession("s3");
    const p2 = v.speak("s3", "Other words. More words.");
    v.stop();
    assert.equal((await p2).reason, "stopped");
  });

  it("stop() aborts an in-flight fetch", async () => {
    const { env } = makeEnv({ "/api/speech": () => new Promise<Response>(() => {}) });
    const v = createBaronessVoice(env);
    v.setActiveSession("s1");
    const p = v.speak("s1", "Some words. More words.");
    await flush();
    v.stop();
    assert.equal((await p).played, false);
  });

  it("a new speak() supersedes the previous utterance", async () => {
    const { env, audio } = makeEnv({ "/api/speech": () => audioResponse() });
    const v = createBaronessVoice(env);
    v.setActiveSession("s1");
    const p1 = v.speak("s1", "First words. More words.");
    await flush();
    const p2 = v.speak("s1", "Second words. More words.");
    assert.equal((await p1).reason, "superseded");
    await flush();
    assert.equal(audio.plays.length, 2);
    audio.end();
    assert.equal((await p2).played, true);
  });

  it("resolves via the safety timeout if the audio never ends", async () => {
    const { env, advance } = makeEnv({ "/api/speech": () => audioResponse() });
    const v = createBaronessVoice(env);
    v.setActiveSession("s1");
    const p = v.speak("s1", "Some words. More words.");
    await flush();
    advance(5000);
    await flush();
    assert.equal(v.getState().speaking, true);
    advance(25_000);
    const out = await p;
    assert.equal(out.reason, "timeout");
    assert.equal(v.getState().speaking, false);
  });

  it("times out a hanging speech fetch instead of trapping the flow", async () => {
    const { env, advance } = makeEnv({ "/api/speech": () => new Promise<Response>(() => {}) });
    const v = createBaronessVoice(env);
    v.setActiveSession("s1");
    const p = v.speak("s1", "Some words. More words.");
    await flush();
    advance(8001);
    const out = await p;
    assert.equal(out.played, false);
    assert.match(out.reason ?? "", /AbortError/);
  });

  describe("guidance", () => {
    const key = "step-back" as const;
    const guidanceText = GUIDANCE_LINES[key].text;

    async function unlocked(handlers: Record<string, Handler>) {
      const h = makeEnv({ "/api/speech": () => audioResponse(), ...handlers });
      const v = createBaronessVoice(h.env);
      await v.unlock();
      v.setActiveSession("s1");
      return { ...h, v };
    }

    it("is silent until audio is unlocked", async () => {
      const h = makeEnv({ "/api/speech": () => audioResponse() });
      const v = createBaronessVoice(h.env);
      v.setActiveSession("s1");
      assert.equal((await v.playGuidance(key, "s1")).reason, "locked");
    });

    it("throttles repeats: same key 6s, any guidance 3s", async () => {
      const { v, audio, advance } = await unlocked({});
      const p1 = v.playGuidance(key, "s1");
      await flush();
      audio.end();
      assert.equal((await p1).played, true);

      advance(2000);
      assert.equal((await v.playGuidance("center", "s1")).reason, "throttled:too-soon");
      advance(2000); // t=4s
      assert.equal((await v.playGuidance(key, "s1")).reason, "throttled:same-key");
      const p2 = v.playGuidance("center", "s1");
      await flush();
      audio.end();
      assert.equal((await p2).played, true);
      advance(2500); // t=6.5s since first, 2.5s since center
      assert.equal((await v.playGuidance(key, "s1")).reason, "throttled:too-soon");
      advance(600);
      const p3 = v.playGuidance(key, "s1");
      await flush();
      audio.end();
      assert.equal((await p3).played, true);
    });

    it("does not interrupt a critique in progress, and is silent after it started", async () => {
      const { v, audio, advance } = await unlocked({});
      const critique = v.speak("s1", "Some words. More words.");
      await flush();
      advance(10_000);
      assert.equal((await v.playGuidance(key, "s1")).reason, "after-critique");
      assert.equal(audio.plays.length, 2); // unlock + critique only
      audio.end();
      await critique;
      assert.equal((await v.playGuidance(key, "s1")).reason, "after-critique");
    });

    it("does not interrupt other guidance that is speaking", async () => {
      const { v, audio, advance } = await unlocked({});
      const p1 = v.playGuidance(key, "s1");
      await flush();
      advance(4000);
      assert.equal((await v.playGuidance("center", "s1")).reason, "busy");
      audio.end();
      assert.equal((await p1).played, true);
    });

    it("rejects guidance for a stale session; a new session resets throttling", async () => {
      const { v, audio } = await unlocked({});
      assert.equal((await v.playGuidance(key, "other")).reason, "inactive-session");
      const p1 = v.playGuidance(key, "s1");
      await flush();
      audio.end();
      await p1;
      v.setActiveSession("s2");
      const p2 = v.playGuidance(key, "s2");
      await flush();
      audio.end();
      assert.equal((await p2).played, true);
    });

    it("guidance uses the scripted clip when present, text matches the catalogue", async () => {
      const { v, audio, calls } = await unlocked({
        [`/audio/baroness/${GUIDANCE_LINES[key].id}.mp3`]: () => audioResponse(),
      });
      const p = v.playGuidance(key, "s1");
      await flush();
      audio.end();
      assert.equal((await p).via, "clip");
      assert.ok(guidanceText.length > 0);
      assert.equal(calls.some((c) => c.url === "/api/speech"), false);
    });

    it("a critique supersedes guidance already speaking", async () => {
      const { v, audio } = await unlocked({});
      const g = v.playGuidance(key, "s1");
      await flush();
      const c = v.speak("s1", "Some words. More words.");
      assert.equal((await g).reason, "superseded");
      await flush();
      audio.end();
      assert.equal((await c).played, true);
    });
  });

  it("announce() speaks the scripted announcement", async () => {
    const h = makeEnv({ "/api/speech": () => audioResponse() });
    const v = createBaronessVoice(h.env);
    v.setActiveSession("s1");
    const p = v.announce("audio-test", "s1");
    await flush();
    h.audio.end();
    assert.equal((await p).played, true);
    assert.equal(JSON.parse(h.calls.at(-1)?.body ?? "{}").text, ANNOUNCEMENT_LINES["audio-test"].text);
  });
});
