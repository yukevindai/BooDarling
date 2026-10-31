/**
 * Deterministic, image-free critic for local development and demo rehearsal
 * (`CRITIC_PROVIDER=mock`). Text varies by score band and look label only.
 */
import { scoreBand, type ScoreBand } from "../lines";
import type { BaronessReadiness, CriticInput, CriticProvider } from "../types";

const LINES: Record<ScoreBand, Array<(look: string) => string>> = {
  dismal: [
    (look) => `Darling, the ${look} has filed a restraining order against this outfit. Start again with the signature pieces of the reference and let them lead.`,
    (look) => `This is not the ${look}, this is a rumour of it overheard at a bus stop. Copy the reference's palette first and add drama second.`,
  ],
  weak: [
    (look) => `I can see the ${look} from here, faintly, through fog. Match the reference's outer layer and the rest will follow.`,
    (look) => `A timid nod to the ${look}, and timidity is not a colour. Commit to the reference's boldest garment and wear it like a threat.`,
  ],
  promising: [
    (look) => `There is a ${look} trying to escape this outfit, and I almost want to let it. Sharpen the contrast so the reference's key pattern reads from across the room.`,
    (look) => `Half the ${look}, half a polite lunch. Add the reference's statement accessory and stop apologising for it.`,
  ],
  strong: [
    (look) => `How irritating, you have actually understood the ${look}. Tighten the silhouette to match the reference and you might frighten me.`,
    (look) => `Close enough to the ${look} that I am checking my own archive. Push one accent from the reference a little louder.`,
  ],
  iconic: [
    (look) => `I came prepared to be appalled and you have robbed me of the pleasure with this ${look}. Keep every piece exactly as it is and walk like you own the building.`,
    (look) => `Well, the ${look}, and done properly, how very annoying for me. Add nothing, darling, and let the coat do the talking.`,
  ],
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mockCritique(input: Pick<CriticInput, "aura" | "lookId" | "lookLabel">): string {
  const options = LINES[scoreBand(input.aura)];
  const look = (input.lookLabel || input.lookId || "look").trim();
  return options[hash(`${input.lookId}|${Math.round(input.aura)}`) % options.length](look);
}

export class MockCriticProvider implements CriticProvider {
  readonly id = "mock";
  readonly model = "mock-v1";

  constructor(private readonly delayMs = 250) {}

  async critique(input: CriticInput, signal: AbortSignal): Promise<string> {
    if (this.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        const t = setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        }, this.delayMs);
        const onAbort = () => {
          clearTimeout(t);
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    signal.throwIfAborted();
    return mockCritique(input);
  }

  async readiness(): Promise<BaronessReadiness> {
    return { ready: true, provider: this.id, detail: { model: this.model, note: "mock critic (no images sent)" }, problems: [] };
  }
}
