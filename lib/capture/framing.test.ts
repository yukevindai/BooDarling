import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CAPTURE_CONFIG } from "./config";
import { LM, computeClothingBox, coveredKneeInFrame, evaluateFraming } from "./framing";
import type { Landmark, Pose } from "./types";

/** Full-length standing setup (the gown tests). */
const KNEES = { ...CAPTURE_CONFIG, requireLowerBody: "knees" as const };

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

describe("framing (knees mode): floor-length gowns", () => {
  it("visible knees capture as before", () => {
    assert.equal(evaluateFraming([person()], KNEES).status, "settling");
  });

  it("knees hidden by a gown but located in frame are accepted", () => {
    const p = person(gownKnees);
    assert.ok(coveredKneeInFrame(p, LM.lKnee, KNEES));
    assert.equal(evaluateFraming([p], KNEES).status, "settling");
  });

  it("the gown crop runs collar to just below the knees, not to the floor", () => {
    const box = computeClothingBox(person(gownKnees), KNEES)!;
    const bottom = box.y + box.h;
    assert.ok(bottom > 0.72 && bottom < 0.8, `bottom=${bottom}`);
    assert.ok(box.y > 0.1 && box.y < 0.2, `top=${box.y}`);
  });

  it("knees below the frame still ask the visitor to step back", () => {
    const p = person({
      [LM.lKnee]: { x: 0.56, y: 1.08, visibility: 0.12 },
      [LM.rKnee]: { x: 0.44, y: 1.08, visibility: 0.12 },
    });
    assert.equal(evaluateFraming([p], KNEES).status, "tooClose");
  });

  it("knees with essentially no signal are not trusted", () => {
    const p = person({
      [LM.lKnee]: { x: 0.56, y: 0.72, visibility: 0.02 },
      [LM.rKnee]: { x: 0.44, y: 0.72, visibility: 0.03 },
    });
    assert.equal(evaluateFraming([p], KNEES).status, "tooClose");
  });

  it("covered knees never count without visible hips", () => {
    const p = person({
      ...gownKnees,
      [LM.lHip]: { x: 0.56, y: 0.5, visibility: 0.1 },
      [LM.rHip]: { x: 0.44, y: 0.5, visibility: 0.1 },
    });
    assert.equal(evaluateFraming([p], KNEES).status, "partial");
  });
});

/** Upper body only, as at a laptop webcam: shoulders and chest visible, nothing below the waist. */
function upperBody(over: Partial<Record<number, Landmark>> = {}): Pose {
  const p: Pose = Array.from({ length: 33 }, () => ({ x: 0.5, y: 1.4, visibility: 0.02 }));
  const set = (i: number, x: number, y: number, visibility: number) => (p[i] = { x, y, visibility });
  set(LM.lShoulder, 0.74, 0.62, 0.98);
  set(LM.rShoulder, 0.26, 0.62, 0.98);
  set(LM.lElbow, 0.82, 0.98, 0.6);
  set(LM.rElbow, 0.18, 0.98, 0.6);
  for (const [i, l] of Object.entries(over)) p[Number(i)] = l!;
  return p;
}

describe("framing (default upper-body mode): no full body needed", () => {
  it("defaults to upper-body framing", () => {
    assert.equal(CAPTURE_CONFIG.requireLowerBody, "none");
  });

  it("shoulders-and-chest framing at a webcam is ready to capture", () => {
    assert.equal(evaluateFraming([upperBody()]).status, "settling");
  });

  it("the crop runs from just above the shoulders to the bottom of the frame", () => {
    const ev = evaluateFraming([upperBody()]);
    assert.ok(ev.box);
    assert.ok(ev.box!.y < 0.62 && ev.box!.y > 0.4, `top=${ev.box!.y}`);
    assert.ok(Math.abs(ev.box!.y + ev.box!.h - 1) < 1e-9, "bottom clamped to the frame edge");
  });

  it("a full-length visitor still captures, cropped collar to knees", () => {
    const ev = evaluateFraming([person()]);
    assert.equal(ev.status, "settling");
    assert.ok(ev.box!.y + ev.box!.h < 0.85, `bottom=${ev.box!.y + ev.box!.h}`);
  });

  it("asks to step back when a shoulder leaves the frame or the collar is cut off", () => {
    const wide = upperBody({
      [LM.lShoulder]: { x: 1.02, y: 0.62, visibility: 0.9 },
      [LM.rShoulder]: { x: 0.4, y: 0.62, visibility: 0.9 },
    });
    assert.equal(evaluateFraming([wide]).status, "tooClose");
    const high = upperBody({
      [LM.lShoulder]: { x: 0.7, y: 0.03, visibility: 0.9 },
      [LM.rShoulder]: { x: 0.3, y: 0.03, visibility: 0.9 },
    });
    assert.notEqual(evaluateFraming([high]).status, "settling");
  });

  it("still asks visitors far from the camera to come closer", () => {
    const far = upperBody({
      [LM.lShoulder]: { x: 0.53, y: 0.5, visibility: 0.9 },
      [LM.rShoulder]: { x: 0.47, y: 0.5, visibility: 0.9 },
    });
    assert.equal(evaluateFraming([far]).status, "tooFar");
  });
});
