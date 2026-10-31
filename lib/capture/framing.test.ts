import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CAPTURE_CONFIG } from "./config";
import { LM, computeClothingBox, coveredKneeInFrame, evaluateFraming } from "./framing";
import type { Landmark, Pose } from "./types";

/** A centred, front-facing person; override individual landmarks per test. */
function person(over: Partial<Record<number, Landmark>> = {}): Pose {
  const p: Pose = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0 }));
  const set = (i: number, x: number, y: number, visibility: number) => (p[i] = { x, y, visibility });
  set(LM.lShoulder, 0.6, 0.2, 0.95);
  set(LM.rShoulder, 0.4, 0.2, 0.95);
  set(LM.lElbow, 0.64, 0.33, 0.9);
  set(LM.rElbow, 0.36, 0.33, 0.9);
  set(LM.lWrist, 0.63, 0.45, 0.9);
  set(LM.rWrist, 0.37, 0.45, 0.9);
  set(LM.lHip, 0.56, 0.5, 0.9);
  set(LM.rHip, 0.44, 0.5, 0.9);
  set(LM.lKnee, 0.56, 0.72, 0.9);
  set(LM.rKnee, 0.44, 0.72, 0.9);
  for (const [i, l] of Object.entries(over)) p[Number(i)] = l!;
  return p;
}

const gownKnees = {
  [LM.lKnee]: { x: 0.56, y: 0.72, visibility: 0.15 },
  [LM.rKnee]: { x: 0.44, y: 0.72, visibility: 0.12 },
  // Feet estimated at the floor under the hem, barely "visible".
  [LM.lAnkle]: { x: 0.55, y: 0.97, visibility: 0.1 },
  [LM.rAnkle]: { x: 0.45, y: 0.97, visibility: 0.1 },
};

describe("framing: floor-length gowns", () => {
  it("visible knees capture as before", () => {
    assert.equal(evaluateFraming([person()]).status, "settling");
  });

  it("knees hidden by a gown but located in frame are accepted", () => {
    const p = person(gownKnees);
    assert.ok(coveredKneeInFrame(p, LM.lKnee, CAPTURE_CONFIG));
    assert.equal(evaluateFraming([p]).status, "settling");
  });

  it("the gown crop runs collar to just below the knees, not to the floor", () => {
    const box = computeClothingBox(person(gownKnees))!;
    const bottom = box.y + box.h;
    assert.ok(bottom > 0.72 && bottom < 0.8, `bottom=${bottom}`);
    assert.ok(box.y > 0.1 && box.y < 0.2, `top=${box.y}`);
  });

  it("knees below the frame still ask the visitor to step back", () => {
    const p = person({
      [LM.lKnee]: { x: 0.56, y: 1.08, visibility: 0.12 },
      [LM.rKnee]: { x: 0.44, y: 1.08, visibility: 0.12 },
    });
    assert.equal(evaluateFraming([p]).status, "tooClose");
  });

  it("knees with essentially no signal are not trusted", () => {
    const p = person({
      [LM.lKnee]: { x: 0.56, y: 0.72, visibility: 0.02 },
      [LM.rKnee]: { x: 0.44, y: 0.72, visibility: 0.03 },
    });
    assert.equal(evaluateFraming([p]).status, "tooClose");
  });

  it("covered knees never count without visible hips", () => {
    const p = person({
      ...gownKnees,
      [LM.lHip]: { x: 0.56, y: 0.5, visibility: 0.1 },
      [LM.rHip]: { x: 0.44, y: 0.5, visibility: 0.1 },
    });
    assert.equal(evaluateFraming([p]).status, "partial");
  });
});
