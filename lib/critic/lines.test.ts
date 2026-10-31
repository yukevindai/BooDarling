import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allScriptedLines, PRESET_CRITIQUES } from "./lines";
import { sanitizeCritique, splitSentences } from "./sanitize";

/** Body parts / physical traits a scripted line must never mention (clothing + attitude only). */
const BODY_WORDS =
  /\b(?:chin|neck|shoulders?|chest|hips?|waist|legs?|arms?|hands?|feet|foot|hair|eyes?|lips?|mouth|nose|face\s+(?:is|looks)|body|skin|figure|posture|weight|height|tall|short)\b/i;

describe("scripted lines", () => {
  it("never reference the body (guidance about position like 'step back' is fine)", () => {
    for (const line of allScriptedLines()) {
      assert.doesNotMatch(line.text, BODY_WORDS, `${line.id}: ${line.text}`);
    }
  });

  it("preset critiques: two sentences, no numbers, pass the sanitiser", () => {
    for (const line of Object.values(PRESET_CRITIQUES).flat()) {
      assert.equal(splitSentences(line.text).length, 2, line.id);
      assert.doesNotMatch(line.text, /\d/, line.id);
      assert.equal(sanitizeCritique(line.text), line.text, line.id);
    }
  });

  it("preset-iconic-2 is clothing/attitude only", () => {
    const line = PRESET_CRITIQUES.iconic.find((l) => l.id === "preset-iconic-2");
    assert.ok(line);
    assert.doesNotMatch(line.text, /chin/i);
  });
});
