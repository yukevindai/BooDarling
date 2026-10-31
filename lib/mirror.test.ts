import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { lookLabel, presenceAction, referenceImageUrl } from "./mirror";
import { initialState, reducer } from "./session";
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
  const phases: Phase[] = ["setup", "waiting", "framing", "capturing", "analysing", "results"];
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
  const framing = reducer(reducer(initialState, { type: "start" }), { type: "reveal", sessionId: "s1" });
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
