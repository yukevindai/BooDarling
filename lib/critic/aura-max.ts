/**
 * Halloween Aura-max (R4). Pure, client-safe helpers — no I/O.
 *
 *  - `parseChecklist`: tolerant reader for a look's `checklist` in references/manifest.json.
 *  - `parseCritiqueOutput`: split the critic's single reply into the spoken critique and the
 *    checklist ids it saw missing. Accepts the JSON the prompt asks for, JSON inside code
 *    fences, or plain text (critique only, missing unknown).
 *  - `resolveAuraMax`: turn `missing` (or "unknown") into the card the mirror shows.
 *  - `parseAuraMax`: validate an `auraMax` object received over the wire (browser client).
 *
 * Honesty rules (spec §5): the critic may only name checklist pieces the collar-down crop can
 * show (`visibleInCrop`). Pieces it cannot see (hair, makeup) are only ever offered as
 * finishing touches, never claimed missing. Nothing here touches or predicts the score.
 */
import type { AuraMax, AuraMaxItem } from "./types";

export type ChecklistItem = AuraMaxItem & {
  /** Can the collar-down capture crop show this piece? Only these can be judged missing. */
  visibleInCrop: boolean;
  /** Lower = more important to the look. */
  priority: number;
};

/** The card shows at most this many next steps. */
export const AURA_MAX_MAX_STEPS = 3;

const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.replace(/\s+/g, " ").trim();
  return t && t.length <= max ? t : undefined;
};

/** Tolerant checklist reader: invalid entries are dropped, ids deduplicated, sorted by priority. */
export function parseChecklist(raw: unknown): ChecklistItem[] {
  if (!Array.isArray(raw)) return [];
  const out: ChecklistItem[] = [];
  const seen = new Set<string>();
  raw.forEach((r, index) => {
    if (!isObj(r)) return;
    const id = typeof r.id === "string" ? r.id.trim() : "";
    const label = text(r.label, 80);
    if (!ID_RE.test(id) || !label || seen.has(id)) return;
    seen.add(id);
    out.push({
      id,
      label,
      why: text(r.why, 240) ?? "",
      search: text(r.search, 120) ?? label,
      // Conservative default: an unmarked piece is never claimed missing.
      visibleInCrop: r.visibleInCrop === true,
      priority: typeof r.priority === "number" && Number.isFinite(r.priority) ? r.priority : 1000 + index,
    });
  });
  return out.sort((a, b) => a.priority - b.priority);
}

/** Checklist pieces the crop can show, in priority order (what the critic is asked about). */
export function visibleChecklist(checklist: readonly ChecklistItem[]): ChecklistItem[] {
  return checklist.filter((c) => c.visibleInCrop);
}

export type ParsedCritiqueOutput = {
  /** Critique text to sanitise (may still contain junk; the sanitiser decides). */
  critique: string;
  /** Known visible ids the critic saw missing (deduped, max 3, its order); null = unknown. */
  missing: string[] | null;
};

function stripWrappers(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/<think>[\s\S]*$/i, " ")
    .replace(/```[a-z]*\s*/gi, "")
    .replace(/```/g, "")
    .trim();
}

function tryParseObject(s: string): Obj | null {
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(s.slice(start, end + 1)) as unknown;
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

/** Salvage `"critique": "..."` from truncated/broken JSON. */
function salvageCritique(s: string): string | null {
  const m = /"critique"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(s);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return m[1].replace(/\\(["\\/])/g, "$1").replace(/\\n/g, " ");
  }
}

/**
 * Filter model-reported ids to known visible checklist ids (also accepting an exact label),
 * keeping the model's order, deduplicated, at most `AURA_MAX_MAX_STEPS`.
 */
export function filterMissing(raw: unknown, visible: ReadonlyArray<{ id: string; label: string }>): string[] | null {
  if (!Array.isArray(raw)) return null;
  const byKey = new Map<string, string>();
  for (const v of visible) {
    byKey.set(v.id.toLowerCase(), v.id);
    byKey.set(v.label.toLowerCase(), v.id);
  }
  const out: string[] = [];
  for (const r of raw) {
    if (typeof r !== "string") continue;
    const id = byKey.get(r.trim().toLowerCase());
    if (id && !out.includes(id)) out.push(id);
    if (out.length >= AURA_MAX_MAX_STEPS) break;
  }
  return out;
}

export function parseCritiqueOutput(
  raw: unknown,
  visible: ReadonlyArray<{ id: string; label: string }>,
): ParsedCritiqueOutput {
  if (typeof raw !== "string") return { critique: "", missing: null };
  const s = stripWrappers(raw);
  const obj = tryParseObject(s);
  if (obj) {
    const critique = typeof obj.critique === "string" ? obj.critique : "";
    // A JSON reply without a usable critique is a failure (the sanitiser returns a preset).
    return { critique, missing: critique ? filterMissing(obj.missing, visible) : null };
  }
  const salvaged = salvageCritique(s);
  if (salvaged !== null) return { critique: salvaged, missing: null };
  // Plain text: the whole reply is the critique; what is missing is unknown.
  return { critique: s.startsWith("{") ? "" : raw, missing: null };
}

const toItem = (c: ChecklistItem): AuraMaxItem => ({ id: c.id, label: c.label, why: c.why, search: c.search });

/**
 * Build the Aura-max card. `missing`:
 *  - array → what the critic saw missing (only known visible ids are kept); [] → complete;
 *  - null  → unknown (preset/timeout): steps are the look's top visible pieces, source "fallback".
 * Returns undefined when the look has no checklist.
 */
export function resolveAuraMax(
  look: { lookId: string; lookLabel: string; checklist?: readonly ChecklistItem[] },
  missing: readonly string[] | null,
): AuraMax | undefined {
  const checklist = look.checklist ?? [];
  if (checklist.length === 0) return undefined;
  const visible = visibleChecklist(checklist);
  const finishing = checklist.filter((c) => !c.visibleInCrop).map(toItem);
  const base = { lookId: look.lookId, lookLabel: look.lookLabel, finishing };
  if (missing === null) {
    return { ...base, steps: visible.slice(0, AURA_MAX_MAX_STEPS).map(toItem), complete: false, source: "fallback" };
  }
  const byId = new Map(visible.map((c) => [c.id, c]));
  const steps: AuraMaxItem[] = [];
  for (const id of missing) {
    const c = byId.get(id);
    if (c && !steps.some((s) => s.id === id)) steps.push(toItem(c));
    if (steps.length >= AURA_MAX_MAX_STEPS) break;
  }
  return { ...base, steps, complete: steps.length === 0, source: "model" };
}

function parseItem(v: unknown): AuraMaxItem | null {
  if (!isObj(v)) return null;
  const id = typeof v.id === "string" && ID_RE.test(v.id) ? v.id : null;
  const label = text(v.label, 80);
  if (!id || !label) return null;
  return { id, label, why: text(v.why, 240) ?? "", search: text(v.search, 120) ?? label };
}

/** Validate an `auraMax` value from the wire; undefined when absent or malformed. */
export function parseAuraMax(value: unknown): AuraMax | undefined {
  if (!isObj(value)) return undefined;
  const lookId = typeof value.lookId === "string" && ID_RE.test(value.lookId) ? value.lookId : null;
  const lookLabel = text(value.lookLabel, 80);
  if (!lookId || !lookLabel) return undefined;
  if (!Array.isArray(value.steps) || !Array.isArray(value.finishing)) return undefined;
  if (value.source !== "model" && value.source !== "fallback") return undefined;
  const steps = value.steps.map(parseItem).filter((x): x is AuraMaxItem => x !== null).slice(0, AURA_MAX_MAX_STEPS);
  const finishing = value.finishing.map(parseItem).filter((x): x is AuraMaxItem => x !== null).slice(0, 8);
  return { lookId, lookLabel, steps, finishing, complete: value.complete === true && steps.length === 0, source: value.source };
}

/** Amazon.ca search for a checklist piece (a search link only — no specific product, no affiliation). */
export function amazonSearchUrl(search: string): string {
  const q = search.replace(/\s+/g, " ").trim().slice(0, 120);
  return `https://www.amazon.ca/s?k=${encodeURIComponent(q)}`;
}
