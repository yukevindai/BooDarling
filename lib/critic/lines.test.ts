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

import { FRAMING_TO_GUIDANCE, GUIDANCE_LINES as GL, toGuidanceKey } from "./lines";
import { describe as d2, it as it2 } from "node:test";
import assertStrict from "node:assert/strict";

d2("R2 framing → R4 guidance mapping", () => {
  it2("maps every R2 status with a caption to a voiced line matching R2's caption", () => {
    // Captions copied from lib/capture/framing.ts GUIDANCE (R2); caption and voice must agree.
    const r2Captions: Record<string, string> = {
      multiple: "One at a time, darlings.",
      partial: "Let me see the whole look, darling.",
      tooClose: "Step back a little, darling.",
      tooFar: "Closer, darling. I can't see the fabric.",
      offCenter: "To the centre, darling.",
      settling: "Hold still. Let me look at you.",
      capturing: "Perfect. Don't move.",
    };
    for (const [status, caption] of Object.entries(r2Captions)) {
      const key = toGuidanceKey(status);
      assertStrict.ok(key, `no mapping for ${status}`);
      assertStrict.equal(GL[key].text, caption);
    }
    assertStrict.equal(Object.keys(FRAMING_TO_GUIDANCE).length, Object.keys(r2Captions).length);
  });

  it2("passes R4 keys through and silences empty/idle/captured/unknown", () => {
    assertStrict.equal(toGuidanceKey("step-back"), "step-back");
    for (const k of ["empty", "idle", "captured", "nope", "", null, undefined, "toString", "__proto__"]) {
      assertStrict.equal(toGuidanceKey(k as string | null | undefined), null);
    }
  });
});
