/**
 * The Baroness's scripted lines: framing guidance, flow announcements and
 * preset critiques used when the critic model times out or fails.
 *
 * Rules (spec §5):
 *  - Presets make NO image-specific claims (no colours, garments, details).
 *  - Target clothing/styling only — never bodies, faces or identity.
 *  - Exactly two sentences for critiques: one witty observation + one suggestion.
 *  - No numbers in lines, so pre-generated clips in `public/audio/baroness/` stay reusable.
 *
 * Every line has a stable `id`; pre-generated audio lives at
 * `/audio/baroness/<id>.mp3` (see `lib/critic/generate-audio.ts`).
 */

export type BaronessLine = { id: string; text: string };

/** Framing guidance keys. R2 detects the condition; R4 voices it. */
export type GuidanceKey =
  | "step-back"
  | "step-closer"
  | "move-left"
  | "move-right"
  | "center"
  | "show-full-outfit"
  | "hold-still"
  | "one-at-a-time"
  | "face-mirror"
  | "dont-move";

export const GUIDANCE_LINES: Record<GuidanceKey, BaronessLine> = {
  "step-back": { id: "guidance-step-back", text: "Step back a little, darling." },
  "step-closer": { id: "guidance-step-closer", text: "Closer, darling. I can't see the fabric." },
  "move-left": { id: "guidance-move-left", text: "A touch to your left, darling." },
  "move-right": { id: "guidance-move-right", text: "A touch to your right, darling." },
  center: { id: "guidance-center", text: "To the centre, darling." },
  "show-full-outfit": { id: "guidance-show-full-outfit", text: "Let me see the whole look, darling." },
  "hold-still": { id: "guidance-hold-still", text: "Hold still. Let me look at you." },
  "one-at-a-time": { id: "guidance-one-at-a-time", text: "One at a time, darlings." },
  "face-mirror": { id: "guidance-face-mirror", text: "Face the mirror, darling. Fashion is a frontal assault." },
  "dont-move": { id: "guidance-dont-move", text: "Perfect. Don't move." },
};

/**
 * R2 (`lib/capture`) reports framing as `FramingState.guidanceKey`, using its own
 * status names. The spoken lines above match R2's on-screen captions word for word,
 * so caption and voice agree. Statuses not listed here ("empty", "idle", "captured")
 * mean "say nothing".
 */
export type FramingGuidanceKey =
  | "multiple"
  | "partial"
  | "tooClose"
  | "tooFar"
  | "offCenter"
  | "settling"
  | "capturing";

export const FRAMING_TO_GUIDANCE: Record<FramingGuidanceKey, GuidanceKey> = {
  multiple: "one-at-a-time",
  partial: "show-full-outfit",
  tooClose: "step-back",
  tooFar: "step-closer",
  offCenter: "center",
  settling: "hold-still",
  capturing: "dont-move",
};

/** Accepts an R4 GuidanceKey or an R2 framing status; returns null when nothing should be said. */
export function toGuidanceKey(key: string | null | undefined): GuidanceKey | null {
  if (!key) return null;
  if (Object.prototype.hasOwnProperty.call(GUIDANCE_LINES, key)) return key as GuidanceKey;
  if (Object.prototype.hasOwnProperty.call(FRAMING_TO_GUIDANCE, key)) {
    return FRAMING_TO_GUIDANCE[key as FramingGuidanceKey];
  }
  return null;
}

/** Flow announcements the UI may play around the assessment. */
export type AnnouncementKey = "welcome" | "analysing" | "farewell" | "audio-test" | "unavailable";

export const ANNOUNCEMENT_LINES: Record<AnnouncementKey, BaronessLine> = {
  welcome: { id: "announce-welcome", text: "Ah. A visitor. Let me see what you've done." },
  analysing: { id: "announce-analysing", text: "Hmm. Let me consult the archive." },
  farewell: { id: "announce-farewell", text: "Next." },
  "audio-test": { id: "announce-audio-test", text: "Testing, testing. The Baroness is ready to judge." },
  unavailable: {
    id: "announce-unavailable",
    text: "Even I cannot rate this look at the moment. Step away and try again, darling.",
  },
};

/** Score bands for preset critiques (inclusive lower bound). */
export type ScoreBand = "dismal" | "weak" | "promising" | "strong" | "iconic";

export const SCORE_BANDS: ReadonlyArray<{ band: ScoreBand; min: number }> = [
  { band: "iconic", min: 90 },
  { band: "strong", min: 75 },
  { band: "promising", min: 50 },
  { band: "weak", min: 25 },
  { band: "dismal", min: 0 },
];

export function scoreBand(aura: number): ScoreBand {
  const a = Number.isFinite(aura) ? aura : 0;
  for (const { band, min } of SCORE_BANDS) if (a >= min) return band;
  return "dismal";
}

/**
 * Preset critiques, two sentences each, no image-specific claims.
 * Used on critic timeout/failure. The score itself is never changed.
 */
export const PRESET_CRITIQUES: Record<ScoreBand, BaronessLine[]> = {
  iconic: [
    { id: "preset-iconic-1", text: "Well. I'm almost irritated by how little I have to say. Keep the attitude exactly where it is and own every step." },
    { id: "preset-iconic-2", text: "At last, someone who read the brief. Carry it with more swagger and let the look do the talking." },
  ],
  strong: [
    { id: "preset-strong-1", text: "Not bad, darling, not bad at all. Commit to one more bold detail and you might frighten me." },
    { id: "preset-strong-2", text: "You're circling greatness without landing on it. Sharpen the silhouette and walk like you mean it." },
  ],
  promising: [
    { id: "preset-promising-1", text: "There is an idea in here, struggling to get out. Push the contrast harder and let it breathe." },
    { id: "preset-promising-2", text: "Half villain, half hesitation. Choose drama, darling, and choose it louder." },
  ],
  weak: [
    { id: "preset-weak-1", text: "I see effort, and effort is not the same as style. Study the archive and return with conviction." },
    { id: "preset-weak-2", text: "This whispers when it should scream. Go bigger, bolder, and far less polite." },
  ],
  dismal: [
    { id: "preset-dismal-1", text: "Darling, this is a costume in the witness protection programme. Start again with black, white and a great deal more nerve." },
    { id: "preset-dismal-2", text: "I've seen more villainy in a beige raincoat. Begin with drama and work backwards from there." },
  ],
};

/** Deterministic preset choice so repeated identical requests return identical text. */
export function pickPresetCritique(aura: number, seed: string): BaronessLine {
  const options = PRESET_CRITIQUES[scoreBand(aura)];
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return options[(h >>> 0) % options.length];
}

/** All lines that should have pre-generated audio. */
export function allScriptedLines(): BaronessLine[] {
  return [
    ...Object.values(GUIDANCE_LINES),
    ...Object.values(ANNOUNCEMENT_LINES),
    ...Object.values(PRESET_CRITIQUES).flat(),
  ];
}

/** Lookup by exact text → line id (used by the client to prefer a pre-generated clip). */
export function scriptedLineIdForText(text: string): string | undefined {
  const t = text.trim();
  return allScriptedLines().find((l) => l.text === t)?.id;
}
