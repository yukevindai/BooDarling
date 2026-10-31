"use client";
import { useEffect, useState } from "react";
import type { JudgeMode } from "@/lib/types";
import { loadEntries, rank, subscribe, type Entry } from "./store";

/** One board's ranked entries, live-updated when anyone adds or clears. Empty during SSR. */
export function useLeaderboard(mode: JudgeMode): Entry[] {
  const [entries, setEntries] = useState<Entry[]>([]);
  useEffect(() => {
    const refresh = () => setEntries(rank(loadEntries(), mode));
    refresh();
    return subscribe(refresh);
  }, [mode]);
  return entries;
}
