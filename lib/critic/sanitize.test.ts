import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CRITIQUE_MAX_CHARS, sanitizeCritique, sanitizeCritiqueDetailed, splitSentences } from "./sanitize";
import { mockCritique } from "./providers/mock";
import { PRESET_CRITIQUES } from "./lines";

const GOOD =
  "Darling, your coat has spots, but they whisper where the reference roars. Swap the grey scarf for long red gloves and let the black and white do the shouting.";

describe("sanitizeCritique", () => {
  it("passes a clean two-sentence critique through unchanged", () => {
    assert.equal(sanitizeCritique(GOOD, { aura: 40 }), GOOD);
  });

  it("strips markdown, labels, quotes, emoji and newlines", () => {
    const raw =
      '**Observation:** "Darling, your coat has spots, but they whisper where the reference roars." 💅\n\n- *Suggestion:* Swap the grey scarf for long red gloves. ✨';
    assert.equal(
      sanitizeCritique(raw),
      "Darling, your coat has spots, but they whisper where the reference roars. Swap the grey scarf for long red gloves.",
    );
  });

  it("strips surrounding curly quotes, speaker labels and stage directions", () => {
    const raw = "Baroness: “(sniffs) The collar is timid. Give it a dramatic black fur trim.”";
    assert.equal(sanitizeCritique(raw), "The collar is timid. Give it a dramatic black fur trim.");
  });

  it("removes Qwen <think> blocks, including unterminated ones", () => {
    assert.equal(
      sanitizeCritique("<think>The user wants...</think>\nThe coat is charming. Add red gloves."),
      "The coat is charming. Add red gloves.",
    );
    assert.equal(sanitizeCritique("<think>never finished reasoning"), null);
  });

  it("keeps at most two sentences", () => {
    const out = sanitizeCritique("The coat is close. The gloves are missing. Also the shoes are wrong. Add red gloves.");
    assert.equal(out, "The coat is close. The gloves are missing.");
  });

  it("adds terminal punctuation when missing", () => {
    assert.equal(sanitizeCritique("The coat is close but timid. Add long red gloves"), "The coat is close but timid. Add long red gloves.");
  });

  it("caps length at a sentence or word boundary", () => {
    const long = `${"Darling the coat is an extravagant monument to hesitation ".repeat(8)}end. Add gloves.`;
    const out = sanitizeCritique(long);
    assert.ok(out);
    assert.ok(out.length <= CRITIQUE_MAX_CHARS, `length ${out.length}`);
    assert.match(out, /[.!?]$/);
    const twoLong = `${"A".repeat(10)} ${"word ".repeat(40)}done. ${"Another ".repeat(30)}sentence.`;
    const out2 = sanitizeCritique(twoLong);
    assert.ok(out2 && out2.length <= CRITIQUE_MAX_CHARS);
  });

  it("returns null for empty, non-string or too-short output", () => {
    assert.equal(sanitizeCritique(""), null);
    assert.equal(sanitizeCritique("   \n  "), null);
    assert.equal(sanitizeCritique(undefined), null);
    assert.equal(sanitizeCritique(42), null);
    assert.equal(sanitizeCritique("No."), null);
    assert.equal(sanitizeCritique("💅✨"), null);
  });

  it("rejects score claims and score talk", () => {
    assert.equal(sanitizeCritiqueDetailed("This is barely 40/100 of the look. Add red gloves.", { aura: 72 }).reason, "score-claim");
    assert.equal(sanitizeCritique("I'd call it 90% Cruella. Add red gloves.", { aura: 72 }), null);
    assert.equal(sanitizeCritique("Honestly this deserves a higher score. Add red gloves.", { aura: 72 }), null);
    assert.equal(sanitizeCritique("The embedding clearly hated your coat. Add red gloves.", { aura: 72 }), null);
    assert.equal(sanitizeCritique("Eight out of ten for nerve. Add red gloves now.", { aura: 72 }), null);
  });

  it("allows a number that equals the computed aura", () => {
    assert.equal(
      sanitizeCritique("Seventy-two percent of a villain is still a villain. Add red gloves.", { aura: 72 }),
      null, // "percent" is score talk
    );
    assert.equal(sanitizeCritique("A 72 out of 100 villain in training. Add red gloves.", { aura: 72 }), "A 72 out of 100 villain in training. Add red gloves.");
  });

  it("rejects body and identity terms", () => {
    for (const bad of [
      "You look too skinny for that coat. Add red gloves.",
      "That dress hides your body. Add red gloves.",
      "Your face is doing all the work. Add red gloves.",
      "Very brave for someone your age. Add red gloves.",
      "A fine effort, young man. Add red gloves.",
      "The coat makes you look fat. Add red gloves.",
      "Ugly, darling, simply ugly. Add red gloves.",
      "Your skin clashes with the coat. Add red gloves.",
      "This old thing again. Add red gloves.",
    ]) {
      assert.equal(sanitizeCritiqueDetailed(bad).reason, "blocked-term", bad);
    }
  });

  it("allows clothing phrases that contain borderline words", () => {
    for (const ok of [
      "The thin belt is timid. Swap it for a bold black sash.",
      "Skinny jeans are not a coat. Add a spotted fur coat over them.",
      "The skin-tight dress is right. Add the spotted coat on top.",
      "Your look is charmingly old-fashioned. Add sharper red gloves.",
    ]) {
      assert.equal(sanitizeCritique(ok), ok);
    }
  });

  it("allows costume makeup, idioms and persona words (eyes, lady, man-tailored, young, face it)", () => {
    for (const ok of [
      "Face it, darling, the coat is timid. Add red gloves and commit to the contrast.",
      "The smoky eyes are the only villainous thing here. Match that eyeliner with a sharper collar.",
      "A lady of leisure would never settle for beige. Swap it for black and white and stride.",
      "That man-tailored blazer is a promising start. Now add a fur stole and some menace.",
      "The night is young and so is this idea. Push the spots harder and commit.",
      "The face paint is doing the heavy lifting. Let the coat carry some of the menace.",
      "Time to face the music, darling. That cardigan has to go.",
      "Dramatic makeup and red lipstick sell it. Now give the coat the same conviction.",
      "An about-face from last season, darling. Keep the gloves and lose the beige.",
    ]) {
      assert.equal(sanitizeCritique(ok), ok, ok);
    }
  });

  it("still blocks genuine body / identity references", () => {
    for (const bad of [
      "Your face looks tired tonight. Add a brighter scarf, darling.",
      "Your face, it seems, has given up. Add red gloves.",
      "That coat makes you look fat, darling. Try a longer line.",
      "You look younger in black, darling. Wear more of it.",
      "The man in this coat looks lost. Commit to the spots.",
      "Your skin colour clashes with the coat. Try black instead.",
      "Your weight is not the problem here. The coat is.",
      "So skinny the coat swallows you. Add a belt, darling.",
      "Your race has nothing to do with this coat. Add red gloves.",
      "Such a pretty woman in such a dull coat. Add red gloves.",
    ]) {
      assert.equal(sanitizeCritiqueDetailed(bad).reason, "blocked-term", bad);
    }
  });

  it("accepts every mock and preset line", () => {
    for (const aura of [0, 10, 30, 55, 80, 95, 100]) {
      for (const lookId of ["classic-dalmatian", "red-gown", "punk-tour"]) {
        const text = mockCritique({ aura, lookId, lookLabel: "Classic Dalmatian Coat" });
        assert.equal(sanitizeCritique(text, { aura }), text, text);
        assert.ok(text.length <= 260, `mock too long: ${text.length}`);
        assert.equal(splitSentences(text).length, 2);
      }
    }
    for (const line of Object.values(PRESET_CRITIQUES).flat()) {
      assert.equal(sanitizeCritique(line.text), line.text, line.id);
    }
  });
});
