import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { lookLabel, phraseMode, presenceAction, referenceImageUrl } from "./mirror";
import { INTRO_LINES, SCARE_SKIPPED_LINE, initialState, reducer } from "./session";
import type { Phase } from "./session";

describe("lookLabel", () => {
  it("humanises look ids", () => {
    assert.equal(lookLabel("red-glamour"), "Red Glamour");
    assert.equal(lookLabel("classic_dalmatian coat"), "Classic Dalmatian Coat");
    assert.equal(lookLabel("--x--"), "X");
    assert.equal(lookLabel(""), "");
  });
});

describe("referenceImageUrl", () => {
  it("encodes the id into the API path", () => {
    assert.equal(referenceImageUrl("red-glamour-01"), "/api/reference/red-glamour-01");
    assert.equal(referenceImageUrl("a/b c"), "/api/reference/a%2Fb%20c");
  });
});

describe("presenceAction", () => {
  const phases: Phase[] = ["setup", "waiting", "framing", "capturing", "analysing", "scaring", "results"];
  it("starts a session only on arrival while waiting", () => {
    for (const p of phases) assert.equal(presenceAction(p, true), null, p); // arrival never skips the spoken phrase
  });
  it("resets on departure during a session, never from setup/waiting", () => {
    for (const p of phases) {
      const want = p === "setup" || p === "waiting" ? null : "reset";
      assert.equal(presenceAction(p, false), want, p);
    }
  });
});

describe("session reducer with R2 capture", () => {
  const framing = reducer(reducer(initialState, { type: "start" }), { type: "reveal", sessionId: "s1", mode: "costume" });
  const capture = { sessionId: "s1", outfitImage: "data:image/jpeg;base64,AA==" };

  it("accepts a capture straight from framing (no prior capturing status)", () => {
    const s = reducer(framing, { type: "captured", capture });
    assert.equal(s.phase, "analysing");
    assert.equal(s.capture, capture);
  });
  it("countdown only moves framing → capturing", () => {
    assert.equal(reducer(framing, { type: "countdown" }).phase, "capturing");
    const waiting = reducer(initialState, { type: "start" });
    assert.equal(reducer(waiting, { type: "countdown" }).phase, "waiting");
  });
  it("ignores a stale capture after departure", () => {
    const reset = reducer(framing, { type: "reset" });
    assert.equal(reducer(reset, { type: "captured", capture }).phase, "waiting");
  });
});

describe("phraseMode", () => {
  it("fairest → costume, scariest → scare", () => {
    assert.equal(phraseMode("mirror mirror on the wall who's the fairest of them all"), "costume");
    assert.equal(phraseMode("Mirror, mirror on the wall, who's the SCARIEST of them all?"), "scare");
  });
  it("is lenient about the exact word", () => {
    assert.equal(phraseMode("mirror mirror who is fairer"), "costume");
    assert.equal(phraseMode("mirror who's the fair one"), "costume");
    assert.equal(phraseMode("mirror mirror who's scarier"), "scare");
    assert.equal(phraseMode("mirror who's the scary one"), "scare");
    assert.equal(phraseMode("mirrors who's the scariest"), "scare");
  });
  it("needs both the mirror and a judging word", () => {
    assert.equal(phraseMode(""), null);
    assert.equal(phraseMode("who's the fairest of them all"), null);
    assert.equal(phraseMode("who's the scariest of them all"), null);
    assert.equal(phraseMode("mirror mirror on the wall"), null);
    assert.equal(phraseMode("mirror mirror who's the"), null); // interim result, word not heard yet
  });
  it("ignores look-alike words", () => {
    assert.equal(phraseMode("mirror, what an affair"), null);
    assert.equal(phraseMode("mirror, nice scarf"), null);
    assert.equal(phraseMode("mirror, what a scar"), null);
  });
  it("prefers whichever word was spoken last", () => {
    assert.equal(phraseMode("that was not fair mirror mirror who's the scariest of them all"), "scare");
    assert.equal(phraseMode("scary costume huh mirror mirror who's the fairest of them all"), "costume");
    assert.equal(phraseMode("mirror who's the scariest no wait the fairest"), "costume");
  });
});

describe("session reducer: judging modes", () => {
  const waiting = reducer(initialState, { type: "start" });
  const capture = { sessionId: "s1", outfitImage: "data:image/jpeg;base64,AA==" };
  const ok = {
    status: "ok" as const, sessionId: "s1", aura: 70, lookId: "red-glamour", referenceId: "r1", similarity: 0.5,
    referenceScores: [], modelVersion: "m", referenceVersion: "r", calibrationVersion: "c",
  };

  it("waiting has no mode", () => {
    assert.equal(waiting.mode, null);
  });
  it("costume reveal goes to framing with the costume intro", () => {
    const s = reducer(waiting, { type: "reveal", sessionId: "s1", mode: "costume" });
    assert.equal(s.phase, "framing");
    assert.equal(s.mode, "costume");
    assert.equal(s.line, INTRO_LINES.costume);
  });
  it("costume flows framing → capturing → analysing → results", () => {
    let s = reducer(waiting, { type: "reveal", sessionId: "s1", mode: "costume" });
    s = reducer(s, { type: "countdown" });
    assert.equal(s.phase, "capturing");
    s = reducer(s, { type: "captured", capture });
    assert.equal(s.phase, "analysing");
    s = reducer(s, { type: "rated", result: ok });
    assert.equal(s.phase, "results");
    assert.equal(s.mode, "costume");
    assert.equal(reducer(s, { type: "scared", sessionId: "s1", score: 90 }), s); // no BooCamp in costume mode
  });
  it("scare reveal skips framing and goes straight to BooCamp", () => {
    const s = reducer(waiting, { type: "reveal", sessionId: "s2", mode: "scare" });
    assert.equal(s.phase, "scaring");
    assert.equal(s.mode, "scare");
    assert.equal(s.line, INTRO_LINES.scare);
    assert.equal(reducer(s, { type: "countdown" }).phase, "scaring");
  });
  it("scare mode never captures or rates an outfit", () => {
    const s = reducer(waiting, { type: "reveal", sessionId: "s1", mode: "scare" });
    assert.equal(reducer(s, { type: "captured", capture }), s);
    assert.equal(reducer(s, { type: "rated", result: ok }), s);
  });
  it("a Scare Score moves scaring → results", () => {
    const s = reducer(reducer(waiting, { type: "reveal", sessionId: "s2", mode: "scare" }), { type: "scared", sessionId: "s2", score: 77 });
    assert.equal(s.phase, "results");
    assert.equal(s.scare, 77);
    assert.equal(s.mode, "scare");
    assert.equal(s.result, undefined);
  });
  it("a skipped BooCamp lands in results with the skip line and no score", () => {
    const s = reducer(reducer(waiting, { type: "reveal", sessionId: "s2", mode: "scare" }), { type: "scared", sessionId: "s2", score: null });
    assert.equal(s.phase, "results");
    assert.equal(s.scare, null);
    assert.equal(s.line, SCARE_SKIPPED_LINE);
  });
  it("ignores a stale Scare Score from another session or after reset", () => {
    const s = reducer(waiting, { type: "reveal", sessionId: "s2", mode: "scare" });
    assert.equal(reducer(s, { type: "scared", sessionId: "old", score: 50 }), s);
    const reset = reducer(s, { type: "reset" });
    assert.equal(reducer(reset, { type: "scared", sessionId: "s2", score: 50 }).phase, "waiting");
    assert.equal(reset.mode, null);
  });
  it("departure ends a scare session like a costume one", () => {
    assert.equal(presenceAction("scaring", false), "reset");
    assert.equal(presenceAction("scaring", true), null);
  });
});
