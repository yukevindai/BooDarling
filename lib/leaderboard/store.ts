/**
 * Local leaderboard: names and scores kept in this browser's localStorage on
 * the demo laptop. No face or outfit images are stored (spec §8: visitor
 * images stay in session memory and are cleared on departure).
 *
 * Two boards share one store: "costume" entries (ranked by outfit Aura) and
 * "scare" entries (ranked by BooCamp Scare Score). Entries saved before modes
 * existed have no `mode` and are read as costume entries.
 */
import type { JudgeMode } from "../types";

export type Entry = {
  id: string;
  name: string;
  /** Which board the entry belongs to. */
  mode: JudgeMode;
  /** Outfit Aura (costume entries); null for scare entries. */
  aura: number | null;
  /** Scare Score (scare entries). Legacy costume entries may also carry one; null when skipped. */
  scare: number | null;
  /** The score this entry is ranked by on its board (legacy entries: 60/40 combined score). */
  total: number;
  /** Matched Cruella look (costume entries); null for scare entries. */
  lookId: string | null;
  at: number;
};

export type NewEntry =
  | { mode: "costume"; name: string; aura: number; lookId: string }
  | { mode: "scare"; name: string; scare: number };

const KEY = "reflect.leaderboard.v1";
const MAX_ENTRIES = 300;
const NAME_MAX = 20;
export const ANONYMOUS = "Mystery Guest";
const EVENT = "reflect-leaderboard";

/** Legacy ranking score (before separate boards): 60% outfit Aura + 40% Scare. */
export function combinedScore(aura: number, scare: number | null): number {
  return Math.round(0.6 * aura + 0.4 * (scare ?? 0));
}

export function cleanName(raw: string): string {
  const name = raw.replace(/<[^>]*>/g, "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
  return name || ANONYMOUS;
}

/** The score an entry is ranked by on its own board: Aura for costume, Scare for scare. */
export function boardScore(e: Entry): number {
  return (e.mode === "scare" ? e.scare : e.aura) ?? 0;
}

/** One board: that mode's entries, highest score first; ties go to the earlier entry. */
export function rank(entries: Entry[], mode: JudgeMode): Entry[] {
  return entries.filter((e) => e.mode === mode).sort((a, b) => boardScore(b) - boardScore(a) || a.at - b.at);
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const storage = (): StorageLike | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

export function loadEntries(store: StorageLike | null = storage()): Entry[] {
  try {
    const parsed = JSON.parse(store?.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.map(normalise).filter((e): e is Entry => e !== null) : [];
  } catch {
    return [];
  }
}

export function addEntry(input: NewEntry, store: StorageLike | null = storage()): Entry {
  const base = {
    id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now()),
    name: cleanName(input.name),
    at: Date.now(),
  };
  const entry: Entry =
    input.mode === "scare"
      ? { ...base, mode: "scare", aura: null, scare: input.scare, total: input.scare, lookId: null }
      : { ...base, mode: "costume", aura: input.aura, scare: null, total: input.aura, lookId: input.lookId };
  // Keep the best MAX_ENTRIES of each board so the store can't grow forever.
  const all = [...loadEntries(store), entry];
  const next = [...rank(all, "costume").slice(0, MAX_ENTRIES), ...rank(all, "scare").slice(0, MAX_ENTRIES)];
  try {
    store?.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage full or blocked: the entry still shows for this session */
  }
  notify();
  return entry;
}

/** Operator reset (e.g. before the judges arrive). */
export function clearEntries(store: StorageLike | null = storage()) {
  try {
    store?.removeItem(KEY);
  } catch {
    /* ignore */
  }
  notify();
}

/** Subscribe to changes from this tab and other tabs. Returns an unsubscribe. */
export function subscribe(fn: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (e: StorageEvent) => e.key === KEY && fn();
  window.addEventListener(EVENT, fn);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT, fn);
    window.removeEventListener("storage", onStorage);
  };
}

function notify() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT));
}

const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** Validates a stored entry; v1 entries without `mode` become costume entries. */
function normalise(x: unknown): Entry | null {
  const e = x as Partial<Entry> | null;
  if (!e || typeof e !== "object" || typeof e.name !== "string") return null;
  const mode: JudgeMode = e.mode === "scare" ? "scare" : "costume";
  const aura = num(e.aura) ? e.aura : null;
  const scare = num(e.scare) ? e.scare : null;
  if (mode === "costume" && aura === null) return null;
  if (mode === "scare" && scare === null) return null;
  return {
    id: typeof e.id === "string" ? e.id : `${e.name}-${e.at ?? 0}`,
    name: e.name,
    mode,
    aura,
    scare,
    total: num(e.total) ? e.total : ((mode === "scare" ? scare : aura) ?? 0),
    lookId: typeof e.lookId === "string" ? e.lookId : null,
    at: num(e.at) ? e.at : 0,
  };
}
