/**
 * Resolve a `referenceId` to its image file and look metadata from R3's
 * `references/manifest.json`. Server-side only; the client never supplies the
 * reference image.
 *
 * The manifest schema is owned by R3, so parsing is deliberately tolerant:
 *  - top-level array of references
 *  - `{ references: [...] }`
 *  - `{ looks: [{ lookId, label|name|title, description, references: [...] }] }`
 *    (looks may also be an object keyed by lookId)
 * Image path keys: imagePath | image | path | file | src (relative to the
 * project root, starting with `public/`, or a public URL path like `/references/...`).
 * A look may also carry a Halloween Aura-max `checklist` (see lib/critic/aura-max.ts);
 * unknown keys are ignored.
 */
import { stat, readFile } from "node:fs/promises";
import path from "node:path";
import { projectRoot, referencesManifestPath } from "./config";
import { parseChecklist, type ChecklistItem } from "./aura-max";
import { isInsideRoot } from "./images";

export type ResolvedReference = {
  referenceId: string;
  lookId: string;
  lookLabel: string;
  lookDescription?: string;
  /** Absolute path inside the project root. */
  imagePath: string;
  /** The look's Aura-max checklist (priority order); omitted when the look has none. */
  checklist?: ChecklistItem[];
};

type Entry = {
  referenceId: string;
  lookId?: string;
  lookLabel?: string;
  lookDescription?: string;
  rawImage?: string;
};

type Parsed = {
  manifestPath: string;
  mtimeMs: number;
  size: number;
  entries: Map<string, Entry>;
  looks: Map<string, LookMeta>;
};

type LookMeta = { label?: string; description?: string; checklist?: ChecklistItem[] };

let cached: Parsed | null = null;

/** Test hook. */
export function clearManifestCache(): void {
  cached = null;
}

/** "classic-dalmatian" → "Classic Dalmatian". */
export function humaniseLookId(lookId: string): string {
  return lookId
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
const firstStr = (o: Obj, keys: string[]): string | undefined => {
  for (const k of keys) {
    const s = str(o[k]);
    if (s) return s;
  }
  return undefined;
};

const IMAGE_KEYS = ["imagePath", "image", "path", "file", "src", "imageUrl", "url"];
const LABEL_KEYS = ["label", "lookLabel", "name", "title", "displayName"];
const REF_ID_KEYS = ["referenceId", "id"];

function addRef(
  out: Map<string, Entry>,
  raw: unknown,
  look?: { lookId?: string; label?: string; description?: string },
): void {
  if (!isObj(raw)) return;
  const referenceId = firstStr(raw, REF_ID_KEYS);
  if (!referenceId) return;
  const lookId = str(raw.lookId) ?? look?.lookId;
  out.set(referenceId, {
    referenceId,
    lookId,
    lookLabel: str(raw.lookLabel) ?? look?.label,
    // Prefer the look-level description (it describes the outfit); fall back to the per-image one.
    lookDescription: look?.description ?? str(raw.lookDescription) ?? str(raw.description),
    rawImage: firstStr(raw, IMAGE_KEYS),
  });
}

/** Exported for tests: parse manifest JSON into reference entries. */
export function parseManifest(json: unknown): Pick<Parsed, "entries" | "looks"> {
  const entries = new Map<string, Entry>();
  const looks = new Map<string, LookMeta>();

  const visitLook = (lookRaw: unknown, keyLookId?: string) => {
    if (!isObj(lookRaw)) return;
    const lookId = str(lookRaw.lookId) ?? str(lookRaw.id) ?? keyLookId;
    const label = firstStr(lookRaw, LABEL_KEYS);
    const description = str(lookRaw.description);
    const checklist = parseChecklist(lookRaw.checklist);
    if (lookId) looks.set(lookId, { label, description, ...(checklist.length ? { checklist } : {}) });
    const refs = lookRaw.references ?? lookRaw.images ?? lookRaw.refs;
    if (Array.isArray(refs)) for (const r of refs) addRef(entries, r, { lookId, label, description });
  };

  if (Array.isArray(json)) {
    for (const r of json) addRef(entries, r);
  } else if (isObj(json)) {
    if (Array.isArray(json.looks)) for (const l of json.looks) visitLook(l);
    else if (isObj(json.looks)) for (const [k, l] of Object.entries(json.looks)) visitLook(l, k);
    if (Array.isArray(json.references)) {
      for (const r of json.references) {
        if (isObj(r) && !entries.has(firstStr(r, REF_ID_KEYS) ?? "")) addRef(entries, r);
      }
    }
  }

  // Fill look metadata for flat references from any look table.
  for (const e of entries.values()) {
    const meta = e.lookId ? looks.get(e.lookId) : undefined;
    if (meta) {
      e.lookLabel ??= meta.label;
      if (meta.description) e.lookDescription = meta.description;
    }
  }
  return { entries, looks };
}

/**
 * Candidate absolute file paths (inside `root`, in priority order) for a
 * manifest image path. Empty for remote URLs or anything escaping the root.
 */
export function imagePathCandidates(raw: string, root: string): string[] {
  let p = raw.trim();
  if (/^file:\/\//i.test(p)) p = p.replace(/^file:\/\//i, "");
  else if (/^[a-z][a-z0-9+.-]*:/i.test(p)) return []; // http(s), data:, etc.
  p = p.split(/[?#]/)[0];
  const candidates: string[] = [];
  if (path.isAbsolute(p)) {
    candidates.push(p);
    // Public URL path like "/references/cruella/x.jpg" → <root>/public/references/...
    candidates.push(path.join(root, "public", p));
  } else {
    const rel = p.replace(/^\.\//, "");
    candidates.push(path.join(root, rel));
    if (!rel.startsWith("public/")) candidates.push(path.join(root, "public", rel));
  }
  return [...new Set(candidates.map((c) => path.resolve(c)))].filter((c) => isInsideRoot(root, c));
}

async function loadManifest(): Promise<Parsed> {
  const manifestPath = referencesManifestPath();
  const st = await stat(manifestPath);
  if (cached && cached.manifestPath === manifestPath && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached;
  }
  const text = await readFile(manifestPath, "utf8");
  const parsed = parseManifest(JSON.parse(text) as unknown);
  cached = { manifestPath, mtimeMs: st.mtimeMs, size: st.size, ...parsed };
  return cached;
}

async function exists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve `referenceId` to its image + look metadata. Returns null when the
 * manifest is missing/unreadable, the reference is unknown, or its image file
 * cannot be found inside the project root. Never throws.
 *
 * `expectedLookId` (from RateResult) is used as a fallback lookId only; the
 * manifest wins when they disagree.
 */
export async function resolveReference(referenceId: string, expectedLookId?: string): Promise<ResolvedReference | null> {
  let manifest: Parsed;
  try {
    manifest = await loadManifest();
  } catch {
    return null;
  }
  const entry = manifest.entries.get(referenceId);
  if (!entry || !entry.rawImage) return null;
  const root = projectRoot();

  let imagePath: string | null = null;
  for (const candidate of imagePathCandidates(entry.rawImage, root)) {
    if (await exists(candidate)) {
      imagePath = candidate;
      break;
    }
  }
  if (!imagePath) return null;

  const lookId = entry.lookId ?? expectedLookId ?? referenceId;
  const meta = manifest.looks.get(lookId);
  return {
    referenceId,
    lookId,
    lookLabel: entry.lookLabel ?? meta?.label ?? humaniseLookId(lookId),
    lookDescription: entry.lookDescription ?? meta?.description,
    imagePath,
    ...(meta?.checklist ? { checklist: meta.checklist } : {}),
  };
}

/** Readiness helper: is the manifest present and parseable, and how many references does it list. */
export async function manifestStatus(): Promise<{ ok: boolean; references: number; problem?: string }> {
  try {
    const m = await loadManifest();
    if (m.entries.size === 0) return { ok: false, references: 0, problem: "Reference manifest lists no references." };
    return { ok: true, references: m.entries.size };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return {
      ok: false,
      references: 0,
      problem:
        code === "ENOENT"
          ? `Reference manifest not found at ${path.relative(projectRoot(), referencesManifestPath()) || referencesManifestPath()}.`
          : "Reference manifest could not be parsed.",
    };
  }
}
