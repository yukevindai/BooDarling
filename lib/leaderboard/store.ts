/**
 * Local leaderboard: names and scores kept in this browser's localStorage on
 * the demo laptop. No face or outfit images are stored (spec §8: visitor
 * images stay in session memory and are cleared on departure).
 */
export type Entry = {
  id: string;
  name: string;
  aura: number;
  /** null when BooCamp was skipped (mask, makeup, walked away). */
  scare: number | null;
  /** Ranking score: 60% outfit Aura + 40% Scare (skipped scare counts as 0). */
  total: number;
  lookId: string;
  at: number;
};

const KEY = "reflect.leaderboard.v1";
const MAX_ENTRIES = 300;
const NAME_MAX = 20;
export const ANONYMOUS = "Mystery Guest";
const EVENT = "reflect-leaderboard";

export function combinedScore(aura: number, scare: number | null): number {
  return Math.round(0.6 * aura + 0.4 * (scare ?? 0));
}

export function cleanName(raw: string): string {
  const name = raw.replace(/<[^>]*>/g, "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
  return name || ANONYMOUS;
}

/** Highest total first; ties go to the higher Aura, then the earlier entry. */
export function rank(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => b.total - a.total || b.aura - a.aura || a.at - b.at);
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
    return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
  } catch {
    return [];
  }
}

export function addEntry(
  input: { name: string; aura: number; scare: number | null; lookId: string },
  store: StorageLike | null = storage(),
): Entry {
  const entry: Entry = {
    id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now()),
    name: cleanName(input.name),
    aura: input.aura,
    scare: input.scare,
    total: combinedScore(input.aura, input.scare),
    lookId: input.lookId,
    at: Date.now(),
  };
  // Keep the best MAX_ENTRIES so the board can't grow forever.
  const next = rank([...loadEntries(store), entry]).slice(0, MAX_ENTRIES);
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

function isEntry(x: unknown): x is Entry {
  const e = x as Entry;
  return !!e && typeof e.name === "string" && typeof e.aura === "number" && typeof e.total === "number";
}
