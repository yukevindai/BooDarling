/**
 * Pre-generate the Baroness's scripted lines as MP3 clips.
 *
 *   npx tsx lib/critic/generate-audio.ts [--force] [--only <id-prefix>]
 *
 * Writes `public/audio/baroness/<id>.mp3` for every line in `allScriptedLines()`
 * plus `public/audio/baroness/manifest.json`. Existing clips are skipped unless
 * `--force`. Reads `.env.local` (real environment variables take precedence).
 *
 * Relative imports only so this runs under plain `tsx` without path aliases.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ElevenLabsError, synthesize } from "./elevenlabs";
import { allScriptedLines } from "./lines";
import { getModelId, getVoiceId, speechConfigProblems } from "./speech-config";
import { normalizeSpeechText } from "./speech";

const OUT_DIR = path.join(process.cwd(), "public", "audio", "baroness");
const DELAY_MS = 600;
const MAX_ATTEMPTS = 3;

/** Minimal .env parser: KEY=VALUE, optional `export`, quotes, `#` comments. */
function loadEnvFile(file: string): void {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

function parseArgs(argv: string[]): { force: boolean; only?: string } {
  let force = false;
  let only: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") force = true;
    else if (a === "--only") only = argv[++i];
    else if (a.startsWith("--only=")) only = a.slice("--only=".length);
    else throw new Error(`Unknown argument: ${a}\nUsage: npx tsx lib/critic/generate-audio.ts [--force] [--only <id-prefix>]`);
  }
  if (argv.includes("--only") && !only) throw new Error("--only needs an id prefix, e.g. --only guidance-");
  return { force, only };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function synthesizeWithRetry(text: string): Promise<Uint8Array> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await synthesize(text);
    } catch (err) {
      const retryable = err instanceof ElevenLabsError && err.retryable;
      if (!retryable || attempt >= MAX_ATTEMPTS) throw err;
      await sleep(1500 * attempt);
    }
  }
}

async function main(): Promise<void> {
  const { force, only } = parseArgs(process.argv.slice(2));
  loadEnvFile(path.join(process.cwd(), ".env.local"));

  const problems = speechConfigProblems();
  if (problems.length > 0) {
    console.error("Cannot generate audio:");
    for (const p of problems) console.error(`  - ${p}`);
    console.error("Set them in .env.local or the environment, then re-run.");
    process.exit(1);
  }

  const all = allScriptedLines();
  const selected = only ? all.filter((l) => l.id.startsWith(only)) : all;
  if (selected.length === 0) {
    console.error(`No scripted line id starts with "${only}".`);
    process.exit(1);
  }

  await mkdir(OUT_DIR, { recursive: true });
  let generated = 0;
  let skipped = 0;
  let first = true;

  for (const line of selected) {
    const file = path.join(OUT_DIR, `${line.id}.mp3`);
    if (!force && existsSync(file)) {
      skipped++;
      console.log(`skip     ${line.id} (exists)`);
      continue;
    }
    if (!first) await sleep(DELAY_MS);
    first = false;
    // Same normalisation the live route applies, so clip text == what /api/speech would voice.
    const bytes = await synthesizeWithRetry(normalizeSpeechText(line.text));
    await writeFile(file, bytes);
    generated++;
    console.log(`generate ${line.id} (${bytes.length} bytes)`);
  }

  const manifest = {
    voiceId: getVoiceId(),
    modelId: getModelId(),
    generatedAt: new Date().toISOString(),
    lines: all.filter((l) => existsSync(path.join(OUT_DIR, `${l.id}.mp3`))).map((l) => ({
      id: l.id,
      text: l.text,
      file: `${l.id}.mp3`,
    })),
  };
  await writeFile(path.join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Done: ${generated} generated, ${skipped} skipped, ${manifest.lines.length}/${all.length} clips in manifest.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
