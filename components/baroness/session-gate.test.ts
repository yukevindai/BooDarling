import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideRun, RetiredSessions, SessionGate } from "./session-gate";

describe("decideRun (pure)", () => {
  const base = { sessionId: "A", inflightSessionId: null, startedSessionId: null, retired: false };

  it("starts a run when nothing was started (run() without startSession keeps working)", () => {
    assert.deepEqual(decideRun(base), { action: "start" });
  });

  it("joins the in-flight run for the same session", () => {
    assert.deepEqual(decideRun({ ...base, inflightSessionId: "A" }), { action: "join" });
  });

  it("refuses a retired session even if it is the in-flight one", () => {
    assert.deepEqual(decideRun({ ...base, retired: true, inflightSessionId: "A" }), {
      action: "refuse",
      reason: "retired",
    });
  });

  it("refuses a run for a session other than the explicitly started one", () => {
    assert.deepEqual(decideRun({ ...base, startedSessionId: "B" }), {
      action: "refuse",
      reason: "other-session-started",
    });
    assert.deepEqual(decideRun({ ...base, startedSessionId: "A" }), { action: "start" });
  });
});

describe("SessionGate: late run() cannot resurrect a departed session", () => {
  it("late run(A) after cancel() and startSession(B) is refused; B is untouched", () => {
    const g = new SessionGate();
    assert.equal(g.start("A"), "switched");
    assert.equal(g.decide("A", null).action, "start");
    g.runStarted("A");
    g.cancel(); // A departs
    assert.equal(g.start("B"), "switched");
    assert.deepEqual(g.decide("A", "A"), { action: "refuse", reason: "retired" });
    assert.equal(g.current, "B");
    assert.equal(g.decide("B", null).action, "start");
  });

  it("late run(A) after cancel() with an empty room is refused", () => {
    const g = new SessionGate();
    g.runStarted("A"); // R1 only calls run()
    g.cancel();
    assert.deepEqual(g.decide("A", null), { action: "refuse", reason: "retired" });
    // The next visitor still works with run() alone.
    assert.equal(g.decide("B", null).action, "start");
  });

  it("run()-only flow: a run for B supersedes and retires A", () => {
    const g = new SessionGate();
    g.runStarted("A");
    assert.equal(g.decide("B", "A").action, "start");
    g.runStarted("B");
    assert.deepEqual(g.decide("A", "B"), { action: "refuse", reason: "retired" });
    assert.equal(g.decide("B", "B").action, "join");
  });

  it("startSession(B) retires A without a cancel(); a run for a never-started id is refused", () => {
    const g = new SessionGate();
    g.start("A");
    g.runStarted("A");
    assert.equal(g.start("B"), "switched");
    assert.deepEqual(g.decide("A", "A"), { action: "refuse", reason: "retired" });
    assert.deepEqual(g.decide("C", null), { action: "refuse", reason: "other-session-started" });
  });

  it("startSession on the current or a retired id does not reset", () => {
    const g = new SessionGate();
    g.runStarted("A");
    assert.equal(g.start("A"), "same");
    g.cancel();
    assert.equal(g.start("A"), "ignored");
    assert.equal(g.current, null);
    assert.equal(g.started, null);
  });
});

describe("RetiredSessions", () => {
  it("is bounded (FIFO) and ignores empty ids", () => {
    const r = new RetiredSessions(3);
    r.add(null);
    r.add("");
    assert.equal(r.size, 0);
    for (const id of ["a", "b", "c", "d"]) r.add(id);
    assert.equal(r.size, 3);
    assert.equal(r.has("a"), false);
    assert.equal(r.has("d"), true);
  });
});
