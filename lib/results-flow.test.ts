import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AURAMAX_STEP_MS, afterBoard, keepsSessionOnDeparture } from "./results-flow";

describe("results flow", () => {
  it("board → Aura-max only when there is something to show, else back to waiting", () => {
    assert.equal(afterBoard(true), "auramax");
    assert.equal(afterBoard(false), "reset");
  });

  it("departure never ends name, board or Aura-max (they time out); it ends the verdict", () => {
    assert.equal(keepsSessionOnDeparture("verdict"), false);
    assert.equal(keepsSessionOnDeparture("name"), true);
    assert.equal(keepsSessionOnDeparture("board"), true);
    assert.equal(keepsSessionOnDeparture("auramax"), true);
  });

  it("Aura-max stays up long enough to scan a QR code", () => {
    assert.ok(AURAMAX_STEP_MS >= 15000 && AURAMAX_STEP_MS <= 30000);
  });
});
