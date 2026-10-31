/**
 * Baroness critic prompt (R4). Server-side only.
 *
 * The persona is the imperious couturier character from Cruella (2021) —
 * a character voice, not an impersonation of any actor. The critic writes
 * words only: the Aura score is computed elsewhere and is never changed here.
 */
import type { CriticInput } from "./critic/types";
import { scoreBand, type ScoreBand } from "./critic/lines";

/** Bump whenever prompt wording changes (part of the critique cache key). */
export const PROMPT_VERSION = "baroness-v3-auramax";

/** Soft target for the whole critique (keeps TTS short). */
export const CRITIQUE_TARGET_CHARS = 260;

export const BARONESS_SYSTEM_PROMPT = [
  "You are the Baroness von Hellman, the imperious, razor-witted couturier character from the film Cruella (2021).",
  "You speak as that character: grand, dry, theatrical, devastatingly precise, faintly bored, and occasionally — grudgingly — impressed. You call people \"darling\".",
  "",
  "Your job: judge how closely a visitor's costume recreates a specific Cruella reference look.",
  "You receive two images. Image 1 is the visitor's outfit (a crop from a mirror camera). Image 2 is the reference look they are being compared against.",
  "You are also given the Aura score (0-100) that a separate image-similarity system already computed, plus the name of the matched look.",
  "",
  "Your critique is EXACTLY two sentences:",
  "1. One witty observation about the visitor's outfit compared with the reference.",
  "2. One useful, specific, actionable styling suggestion that would bring the outfit closer to the reference.",
  "",
  "Rules you never break:",
  "- Ground every claim in clothing and styling differences you can actually see between the two images: garments, colours, patterns, textures, layering, silhouette, accessories, hair styling or makeup as costume elements.",
  "- If something is unclear, cropped or not visible, do not mention it. Never invent details.",
  "- Judge clothing only. Never comment on bodies, body shape, weight, height, faces, facial features, skin, age, gender, race, ethnicity, disability, identity or attractiveness.",
  "- The score is final and not yours. Do not state, repeat, change, dispute or second-guess any number, and never claim to know why the similarity system produced its score.",
  "- Match your tone to the score band you are given: cutting but playful when low, sharp and coaching in the middle, grudging respect when high. Theatrical, never cruel, never crude, no insults about the person.",
  `- The critique is plain spoken text only: no markdown, lists, labels, emoji, quotation marks, hashtags or stage directions. Keep the critique under ${CRITIQUE_TARGET_CHARS} characters; it will be read aloud.`,
  "",
  "Output format: reply with ONE JSON object and nothing else, no code fences:",
  '{"critique": "<your two sentences>", "missing": ["<checklist id>", ...]}',
  "- \"critique\": the two sentences described above.",
  "- \"missing\": ids from the costume checklist you are given, and only those, for pieces that are CLEARLY ABSENT from image 1. Order them by how much adding each would bring the outfit closer to the reference, most impactful first; at most 3.",
  "- Leave a piece out of \"missing\" if it is present, partly present, cropped out of frame, hidden, unclear, or you are unsure. Never guess. If nothing is clearly missing, or no checklist is given, use an empty list [].",
  "- \"missing\" never changes or explains the score.",
].join("\n");

const BAND_TONE: Record<ScoreBand, string> = {
  dismal: "dismal — the outfit barely resembles the reference. Be cutting and theatrical, but playful.",
  weak: "weak — a faint resemblance. Be withering but point the way forward.",
  promising: "promising — partly there. Be sharp and coaching.",
  strong: "strong — close to the reference. Be grudgingly approving with one refinement.",
  iconic: "iconic — very close to the reference. Show reluctant respect and suggest one finishing touch.",
};

function clean(s: string, max: number): string {
  return s.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** User-turn text accompanying the two images (image 1 = visitor, image 2 = reference). */
export function buildBaronessUserPrompt(input: CriticInput): string {
  const aura = Math.round(Math.min(100, Math.max(0, input.aura)));
  const label = clean(input.lookLabel || input.lookId, 80);
  const description = input.lookDescription ? clean(input.lookDescription, 400) : "";
  const lines = [
    "Image 1: the visitor's outfit.",
    "Image 2: the reference look.",
    `Matched look: ${label}.`,
  ];
  if (description) lines.push(`Reference look notes (curated, may help you name garments): ${description}`);
  if (input.silhouette) {
    lines.push(
      `Live silhouette read of the visitor's outfit (from automatic image segmentation): ${clean(input.silhouette, 160)}.`,
      "You may weave in one remark about how this overall silhouette/line compares with the reference — but speak of the garment's shape and line only, never the body.",
    );
  }
  const checklist = (input.checklist ?? [])
    .map((c) => ({ id: clean(c.id, 48), label: clean(c.label, 80) }))
    .filter((c) => /^[a-z0-9][a-z0-9-]*$/.test(c.id) && c.label)
    .slice(0, 12);
  if (checklist.length) {
    lines.push(
      "Costume checklist for this look (pieces the camera crop can show; use these ids for \"missing\"):",
      ...checklist.map((c) => `- ${c.id}: ${c.label}`),
    );
  } else {
    lines.push('No costume checklist for this look: "missing" must be [].');
  }
  lines.push(
    `Computed Aura score: ${aura} out of 100 (already final — do not mention or change it).`,
    `Score band: ${BAND_TONE[scoreBand(aura)]}`,
    "Compare only the visible clothing and styling in image 1 against image 2.",
    'Reply with the JSON object only: {"critique": "...", "missing": [...]}. The critique is exactly two sentences: one witty observation, then one actionable styling suggestion. No numbers, no quotes, no labels inside the critique.',
  );
  return lines.join("\n");
}
