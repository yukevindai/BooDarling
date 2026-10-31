import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BARONESS_SYSTEM_PROMPT, CRITIQUE_TARGET_CHARS, PROMPT_VERSION, buildBaronessUserPrompt } from "./baroness-prompt";
import type { CriticInput } from "./critic/types";

const input = (over: Partial<CriticInput> = {}): CriticInput => ({
  userImage: { mimeType: "image/jpeg", base64: "AAAA" },
  referenceImage: { mimeType: "image/jpeg", base64: "BBBB" },
  aura: 37,
  lookId: "classic-dalmatian",
  lookLabel: "Classic Dalmatian Coat",
  lookDescription: "Spotted fur coat over a black dress,\nred gloves.",
  ...over,
});

describe("baroness prompt", () => {
  it("exports a version", () => {
    assert.match(PROMPT_VERSION, /\S/);
  });

  it("system prompt sets the persona, image order, two-sentence format and safety rules", () => {
    const s = BARONESS_SYSTEM_PROMPT;
    assert.match(s, /Baroness von Hellman/);
    assert.match(s, /Image 1 is the visitor/);
    assert.match(s, /Image 2 is the reference/);
    assert.match(s, /EXACTLY two sentences/);
    assert.match(s, /actionable styling suggestion/);
    for (const forbidden of ["bodies", "weight", "faces", "skin", "age", "gender", "race", "identity", "attractiveness"]) {
      assert.ok(s.includes(forbidden), `system prompt should forbid ${forbidden}`);
    }
    assert.match(s, /Never invent details/);
    assert.match(s, /score is final/i);
    assert.match(s, /never claim to know why/i);
    assert.match(s, /no markdown/i);
    assert.ok(s.includes(String(CRITIQUE_TARGET_CHARS)));
    // A character voice, not an actor impersonation.
    assert.ok(!/Emma Thompson/i.test(s));
  });

  it("user prompt carries the score, label, description and band tone", () => {
    const u = buildBaronessUserPrompt(input());
    assert.match(u, /Image 1: the visitor's outfit/);
    assert.match(u, /Image 2: the reference look/);
    assert.match(u, /Matched look: Classic Dalmatian Coat\./);
    assert.match(u, /37 out of 100/);
    assert.match(u, /do not mention or change it/);
    assert.match(u, /weak/);
    assert.match(u, /Spotted fur coat over a black dress, red gloves\./);
    assert.ok(!u.includes("AAAA"), "no image data in the text prompt");
  });

  it("scales tone with the score band and clamps/rounds the score", () => {
    assert.match(buildBaronessUserPrompt(input({ aura: 3 })), /dismal/);
    assert.match(buildBaronessUserPrompt(input({ aura: 92.6 })), /93 out of 100[\s\S]*iconic/);
    assert.match(buildBaronessUserPrompt(input({ aura: 150 })), /100 out of 100/);
  });

  it("falls back to the lookId and omits a missing description", () => {
    const u = buildBaronessUserPrompt(input({ lookLabel: "", lookDescription: undefined }));
    assert.match(u, /Matched look: classic-dalmatian\./);
    assert.ok(!u.includes("Reference look notes"));
  });
});
