import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ANONYMOUS, addEntry, boardScore, cleanName, clearEntries, combinedScore, loadEntries, rank, type Entry } from "./store";

const KEY = "reflect.leaderboard.v1";
function memory(init?: unknown) {
  const m = new Map<string, string>();
  if (init !== undefined) m.set(KEY, JSON.stringify(init));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    raw: () => JSON.parse(m.get(KEY) ?? "null"),
  };
}

describe("leaderboard store: per-mode boards", () => {
  it("costume entries are ranked by Aura, scare entries by Scare", () => {
    const st = memory();
    addEntry({ mode: "costume", name: "Ann", aura: 60, lookId: "red-glamour" }, st);
    addEntry({ mode: "costume", name: "Bo", aura: 90, lookId: "dalmatian" }, st);
    addEntry({ mode: "scare", name: "Cy", scare: 40 }, st);
    addEntry({ mode: "scare", name: "Di", scare: 95 }, st);
    const all = loadEntries(st);
    assert.deepEqual(rank(all, "costume").map((e) => e.name), ["Bo", "Ann"]);
    assert.deepEqual(rank(all, "scare").map((e) => e.name), ["Di", "Cy"]);
  });

  it("scare entries have no Aura or look; costume entries have no Scare", () => {
    const st = memory();
    const s = addEntry({ mode: "scare", name: "Cy", scare: 72 }, st);
    assert.equal(s.mode, "scare");
    assert.equal(s.aura, null);
    assert.equal(s.lookId, null);
    assert.equal(s.total, 72);
    assert.equal(boardScore(s), 72);
    const c = addEntry({ mode: "costume", name: "Ann", aura: 81, lookId: "red-glamour" }, st);
    assert.equal(c.scare, null);
    assert.equal(c.total, 81);
    assert.equal(boardScore(c), 81);
    assert.equal(loadEntries(st).length, 2);
  });

  it("ties go to the earlier entry", () => {
    const a: Entry = { id: "a", name: "A", mode: "scare", aura: null, scare: 50, total: 50, lookId: null, at: 2 };
    const b: Entry = { ...a, id: "b", name: "B", at: 1 };
    assert.deepEqual(rank([a, b], "scare").map((e) => e.id), ["b", "a"]);
  });

  it("reads v1 entries (no mode) as costume entries ranked by Aura, not the old combined total", () => {
    const v1 = [
      { id: "1", name: "Old High Total", aura: 70, scare: 100, total: combinedScore(70, 100), lookId: "x", at: 1 },
      { id: "2", name: "Old Best Aura", aura: 80, scare: null, total: combinedScore(80, null), lookId: "y", at: 2 },
    ];
    const st = memory(v1);
    const all = loadEntries(st);
    assert.equal(all.length, 2);
    assert.ok(all.every((e) => e.mode === "costume"));
    assert.deepEqual(rank(all, "costume").map((e) => e.id), ["2", "1"]);
    assert.deepEqual(rank(all, "scare"), []); // a legacy scare value doesn't put it on the scare board
    assert.equal(all.find((e) => e.id === "1")!.scare, 100);
  });

  it("keeps v1 entries when a new entry is added", () => {
    const st = memory([{ id: "1", name: "Old", aura: 70, scare: null, total: 42, lookId: "x", at: 1 }]);
    addEntry({ mode: "scare", name: "New", scare: 10 }, st);
    const stored = st.raw() as Entry[];
    assert.equal(stored.length, 2);
    assert.equal(stored.find((e) => e.id === "1")!.mode, "costume");
  });

  it("drops corrupt entries and survives corrupt storage", () => {
    const st = memory([
      null, 7, { name: 3 }, { name: "No aura", aura: "x" }, { name: "Scare w/o score", mode: "scare", aura: null, scare: null },
      { name: "Fine", mode: "scare", aura: null, scare: 12, total: 12, lookId: null, at: 5, id: "f" },
    ]);
    assert.deepEqual(loadEntries(st).map((e) => e.name), ["Fine"]);
    const bad = memory();
    bad.setItem(KEY, "{not json");
    assert.deepEqual(loadEntries(bad), []);
    assert.deepEqual(loadEntries(null), []);
  });

  it("clearEntries empties both boards", () => {
    const st = memory();
    addEntry({ mode: "scare", name: "A", scare: 1 }, st);
    addEntry({ mode: "costume", name: "B", aura: 1, lookId: "x" }, st);
    clearEntries(st);
    assert.deepEqual(loadEntries(st), []);
  });

  it("cleans names", () => {
    assert.equal(cleanName("  <b>Cruella</b>   de  Vil "), "Cruella de Vil");
    assert.equal(cleanName("   "), ANONYMOUS);
    assert.equal(cleanName("x".repeat(40)).length, 20);
  });
});
