import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  configureBaronessTimeouts,
  critiqueClientTimeoutMs,
  resetBaronessTimeouts,
  speechClientTimeoutMs,
} from "./timeouts";

afterEach(() => resetBaronessTimeouts());

describe("Baroness client timeouts", () => {
  it("defaults: critique 12s, speech 15s", () => {
    assert.equal(critiqueClientTimeoutMs(), 12_000);
    assert.equal(speechClientTimeoutMs(), 15_000);
  });

  it("critique = max(12s, server + 3s)", () => {
    configureBaronessTimeouts({ critiqueServerMs: 8_000 });
    assert.equal(critiqueClientTimeoutMs(), 12_000);
    configureBaronessTimeouts({ critiqueServerMs: 120_000 });
    assert.equal(critiqueClientTimeoutMs(), 123_000);
  });

  it("speech = max(15s, 2 * server + 3s)", () => {
    configureBaronessTimeouts({ speechServerMs: 6_000 });
    assert.equal(speechClientTimeoutMs(), 15_000);
    configureBaronessTimeouts({ speechServerMs: 10_000 });
    assert.equal(speechClientTimeoutMs(), 23_000);
  });

  it("ignores missing or invalid values and keeps the previous setting", () => {
    configureBaronessTimeouts({ critiqueServerMs: 30_000, speechServerMs: 9_000 });
    configureBaronessTimeouts({ critiqueServerMs: undefined, speechServerMs: "x" });
    configureBaronessTimeouts({ critiqueServerMs: -1, speechServerMs: Infinity });
    assert.equal(critiqueClientTimeoutMs(), 33_000);
    assert.equal(speechClientTimeoutMs(), 21_000);
  });
});
