import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createBaronessVoice, type AudioLike, type VoiceEnv } from "./audio";
import { isAudioTestSession, isVisitorSessionActive, speakAudioTest } from "./audio-test";

class FakeAudio implements AudioLike {
  src = "";
  volume = 1;
  onended: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  plays: string[] = [];
  play() {
    this.plays.push(this.src);
    return Promise.resolve();
  }
  pause() {}
  removeAttribute() {
    this.src = "";
  }
  load() {}
}

const tick = () => new Promise<void>((r) => setImmediate(r));
async function flush(n = 8) {
  for (let i = 0; i < n; i++) await tick();
}

function voiceEnv(): { env: VoiceEnv; audio: FakeAudio } {
  const audio = new FakeAudio();
  let n = 0;
  return {
    audio,
    env: {
      createAudio: () => audio,
      fetch: async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" } }),
      createObjectURL: () => `blob:${++n}`,
      revokeObjectURL: () => {},
      now: () => 0,
      setTimeout: () => 0,
      clearTimeout: () => {},
    },
  };
}

describe("speakAudioTest", () => {
  it("classifies test vs visitor sessions", () => {
    assert.equal(isAudioTestSession("audio-test-abc"), true);
    assert.equal(isAudioTestSession("visitor-1"), false);
    assert.equal(isVisitorSessionActive(null), false);
    assert.equal(isVisitorSessionActive("audio-test-abc"), false);
    assert.equal(isVisitorSessionActive("visitor-1"), true);
  });

  it("does not kill a visitor session that started while the test was playing", async () => {
    const { env } = voiceEnv();
    const voice = createBaronessVoice(env);
    const testP = speakAudioTest(voice, () => "audio-test-x");
    await flush();
    assert.equal(voice.getActiveSession(), "audio-test-x");
    // Visitor flow (useBaroness.run) starts meanwhile.
    voice.setActiveSession("B");
    const critP = voice.speak("B", "Darling, that coat is a cry for help. Add a fur collar and commit.", { kind: "critique" });
    const out = await testP;
    assert.equal(out.reason, "session-changed");
    assert.equal(voice.getActiveSession(), "B", "the visitor keeps the voice");
    await flush();
    assert.equal(voice.getState().speaking, true, "the visitor's critique is still playing");
    voice.stop();
    assert.equal((await critP).played, true);
  });

  it("refuses to run while a visitor session is active (no session change, no audio)", async () => {
    const { env, audio } = voiceEnv();
    const voice = createBaronessVoice(env);
    voice.setActiveSession("visitor-1");
    const out = await speakAudioTest(voice, () => "audio-test-y");
    assert.deepEqual(out, { played: false, via: "none", reason: "visitor-session-active" });
    assert.equal(voice.getActiveSession(), "visitor-1");
    assert.equal(audio.plays.length, 0);
  });

  it("releases its temporary session when nothing else took over", async () => {
    const { env, audio } = voiceEnv();
    const voice = createBaronessVoice(env);
    const p = speakAudioTest(voice, () => "audio-test-z");
    await flush();
    audio.onended?.({});
    assert.equal((await p).played, true);
    assert.equal(voice.getActiveSession(), null);
  });
});
