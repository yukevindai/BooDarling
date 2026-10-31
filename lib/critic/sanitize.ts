/**
 * Clean critic model output into short, speakable text — or reject it.
 * A `null` result tells the orchestrator to use a preset line instead.
 */

export const CRITIQUE_MAX_CHARS = 300;
export const CRITIQUE_MIN_CHARS = 20;

export type SanitizeResult =
  | { text: string; reason?: undefined }
  | { text: null; reason: "empty" | "too-short" | "score-claim" | "blocked-term" };

/**
 * Body / identity terms the Baroness must never use (spec §5: clothing only).
 * Some common styling compounds are allowed through with negative lookaheads
 * (e.g. "thin belt", "skinny jeans", "skin-tight", "old-fashioned").
 */
const BLOCKED_TERMS: RegExp[] = [
  /\b(?:fat|fatter|fattest|chubby|plump|obese|overweight|underweight|curvy|scrawny|bony|stocky|portly)\b/i,
  /\bthin(?:ner|nest)?\b(?!\s+(?:belts?|stripes?|straps?|lines?|scarf|chains?|bands?|trim|heels?|lapels?|ties?|gloves?|fabric|layers?|brim|collar|piping|veil))/i,
  /\bskinny\b(?!\s+(?:jeans|trousers|pants|ties?|belts?|scarf|lapels?))/i,
  /\b(?:weight|weigh|weighs|belly|tummy|thighs?|buttocks?|bum|butt|breasts?|bust|cleavage|muscles?|muscular|physique)\b/i,
  /\bbod(?:y|ies)\b(?!-?(?:con|suit))/i,
  /\b(?:face|faces|facial|nose|teeth|jaw|cheeks?|wrinkles?|wrinkled|freckles?|acne|complexion|eyes)\b/i,
  /\bskin(?:ned|s)?\b(?!-?tight)/i,
  /\b(?:ugly|unattractive|attractive|sexy|homely|plain-looking)\b/i,
  /\b(?:age|aged|ageing|aging|elderly|wrinkly|youthful|young|younger|teen|teenager|child)\b/i,
  /\bold(?:er|est)?\b(?!-(?:fashioned|school|world|money|style))(?!\s+(?:hollywood|money|world|school))/i,
  /\b(?:race|racial|ethnic|ethnicity|gender|male|female|man|men|woman|women|boy|girl|lady|ladies|gentleman|gentlemen|sir|madam|ma'am)\b/i,
  /\b(?:disabled|disability|wheelchair|pregnant|shorter\s+than|bald|balding|hairline)\b/i,
];

/** Score / embedding talk: the critic must not change, dispute or explain the score. */
const SCORE_TALK: RegExp[] = [
  /\b(?:scor(?:e|ed|es|ing)|rating|rated|grade|graded)\b/i,
  /\b(?:embedding|algorithm|similarity|percent|percentage)\b/i,
  /\bout\s+of\s+(?:ten|a\s+hundred|one\s+hundred|hundred)\b/i,
];

/** Any explicit number that looks like a score claim, e.g. "72%", "60/100", "80 out of 100", "9 points". */
const NUMBER_CLAIM = /(\d{1,3}(?:\.\d+)?)\s*(?:%|\/\s*(?:10|100)\b|out\s+of\s+(?:10|100|ten|a\s+hundred)\b|points?\b)/gi;

const LABEL_RE =
  /^(?:(?:the\s+)?baroness(?:\s+von\s+hellman)?|observation|witty\s+observation|suggestion|styling\s+suggestion|tip|advice|critique|verdict|answer|response|sentence\s*(?:one|two|\d))\s*[:\-–—]\s*/i;

const QUOTE_CHARS = `"'“”‘’«»„‟\``;
const SURROUNDING_QUOTES = new RegExp(`^[${QUOTE_CHARS}]+|[${QUOTE_CHARS}]+$`, "g");

function stripThinking(s: string): string {
  return s
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/<think>[\s\S]*$/i, " ") // unterminated thinking block: drop the rest
    .replace(/<\/?[a-z][^>]*>/gi, " "); // any stray tags
}

function stripMarkdownLine(line: string): string {
  let l = line;
  l = l.replace(/^\s{0,3}#{1,6}\s+/, ""); // headings
  l = l.replace(/^\s*>+\s?/, ""); // blockquotes
  l = l.replace(/^\s*(?:[-*+•]|\d{1,2}[.)])\s+/, ""); // list markers
  l = l.replace(/!\[[^\]]*\]\([^)]*\)/g, " "); // images
  l = l.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"); // links → text
  l = l.replace(/\[[^\]]*\]/g, " "); // [stage directions]
  l = l.replace(/[*_~`]+/g, ""); // emphasis / code markers (keep words)
  l = l.trim().replace(SURROUNDING_QUOTES, "").trim();
  for (let i = 0; i < 2; i++) l = l.replace(LABEL_RE, "").replace(SURROUNDING_QUOTES, "").trim();
  return l;
}

/**
 * Split into sentences, keeping terminal punctuation (and any closing quote).
 * Short interjections ("Well.", "Hmm. Darling.") are merged into the next
 * sentence so they don't use up one of the two allowed sentences.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  const re = /[^.!?…]+(?:[.!?…]+["'”’)]*|$)/g;
  let pending = "";
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    const s = m[0].trim();
    if (!s) continue;
    const joined = pending ? `${pending} ${s}` : s;
    if (joined.split(/\s+/).length < 3) {
      pending = joined;
      continue;
    }
    out.push(joined);
    pending = "";
  }
  if (pending) {
    if (out.length) out[out.length - 1] = `${out[out.length - 1]} ${pending}`;
    else out.push(pending);
  }
  return out;
}

function capLength(text: string, max: number): string {
  if (text.length <= max) return text;
  const sentences = splitSentences(text);
  let acc = "";
  for (const s of sentences) {
    const next = acc ? `${acc} ${s}` : s;
    if (next.length > max) break;
    acc = next;
  }
  if (acc.length >= CRITIQUE_MIN_CHARS) return acc;
  // Fall back to a word boundary.
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  const trimmed = (lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:\-–—]+$/, "");
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Detailed variant (reason is useful for server logs; never contains the text itself). */
export function sanitizeCritiqueDetailed(raw: unknown, opts: { aura?: number } = {}): SanitizeResult {
  if (typeof raw !== "string") return { text: null, reason: "empty" };

  let s = stripThinking(raw.normalize("NFKC"));
  s = s.replace(/```[a-z]*\s*/gi, "").replace(/```/g, "");
  s = s
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[‍︎️⃣]/g, "")
    .replace(/\p{Regional_Indicator}/gu, "")
    .replace(/(^|\s)#[\p{L}\p{N}_]+/gu, "$1"); // hashtags

  const lines = s
    .split(/\r?\n+/)
    .map(stripMarkdownLine)
    .filter(Boolean);
  s = lines.join(" ");

  // Leading stage direction in parentheses, e.g. "(sniffs) Darling..."
  s = s.replace(/^\s*\([^)]{0,60}\)\s*/, "");
  s = s.replace(/\s+/g, " ").trim().replace(SURROUNDING_QUOTES, "").trim();
  s = s.replace(/\s+([,.;:!?])/g, "$1");

  if (!s) return { text: null, reason: "empty" };

  // Keep at most two sentences.
  const sentences = splitSentences(s);
  s = sentences.slice(0, 2).join(" ").trim();
  if (s && !/[.!?…]["'”’)]*$/.test(s)) s = `${s}.`;
  s = capLength(s, CRITIQUE_MAX_CHARS);

  if (s.replace(/[^\p{L}]/gu, "").length < CRITIQUE_MIN_CHARS * 0.6 || s.length < CRITIQUE_MIN_CHARS) {
    return { text: null, reason: "too-short" };
  }

  // Score claims: a different number, or any talk about scores/ratings/embeddings.
  const aura = opts.aura !== undefined && Number.isFinite(opts.aura) ? Math.round(opts.aura) : undefined;
  for (const m of s.matchAll(NUMBER_CLAIM)) {
    const n = Number(m[1]);
    if (aura === undefined || n !== aura) return { text: null, reason: "score-claim" };
  }
  if (SCORE_TALK.some((re) => re.test(s))) return { text: null, reason: "score-claim" };

  if (BLOCKED_TERMS.some((re) => re.test(s))) return { text: null, reason: "blocked-term" };

  return { text: s };
}

/** Clean model text; `null` → use a preset critique. */
export function sanitizeCritique(raw: unknown, opts: { aura?: number } = {}): string | null {
  return sanitizeCritiqueDetailed(raw, opts).text;
}
