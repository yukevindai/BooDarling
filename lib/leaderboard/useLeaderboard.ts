"use client";
import { useEffect, useState } from "react";
import { loadEntries, rank, subscribe, type Entry } from "./store";

/** Ranked entries, live-updated when anyone adds or clears. Empty during SSR. */
export function useLeaderboard(): Entry[] {
  const [entries, setEntries] = useState<Entry[]>([]);
  useEffect(() => {
    const refresh = () => setEntries(rank(loadEntries()));
    refresh();
    return subscribe(refresh);
  }, []);
  return entries;
}
