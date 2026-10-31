/**
 * Tiny in-memory LRU for exact repeated critique inputs (spec §8).
 * Keys are sha256 digests, so no visitor image data is retained as a key.
 * Only model-written critiques are cached; presets are cheap and deterministic.
 */
import { createHash } from "node:crypto";

export type CritiqueCacheKeyParts = {
  outfitImage: string;
  referenceId: string;
  lookId: string;
  aura: number;
  modelVersion: string;
  referenceVersion: string;
  calibrationVersion: string;
  providerId: string;
  providerModel: string;
  promptVersion: string;
};

export function critiqueCacheKey(p: CritiqueCacheKeyParts): string {
  const h = createHash("sha256");
  // Length-prefix every field so concatenation is unambiguous.
  for (const v of [
    p.outfitImage,
    p.referenceId,
    p.lookId,
    String(p.aura),
    p.modelVersion,
    p.referenceVersion,
    p.calibrationVersion,
    p.providerId,
    p.providerModel,
    p.promptVersion,
  ]) {
    h.update(`${v.length}:`);
    h.update(v);
    h.update("\u0000");
  }
  return h.digest("hex");
}

export class LruCache<V> {
  private readonly map = new Map<string, { value: V; expires: number }>();

  constructor(
    private readonly maxEntries = 200,
    private readonly ttlMs = 30 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, { value, expires: this.now() + this.ttlMs });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

/** Process-wide critique text cache (model-sourced text only). */
export const critiqueCache = new LruCache<string>(200, 30 * 60_000);
