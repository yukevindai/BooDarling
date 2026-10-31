# R4 — The Baroness (critic + voice)

The Baroness writes and speaks a two-sentence critique after the Aura score is
revealed. She **never** computes or changes the score (spec §1, §5).

| Path | What it is |
|---|---|
| `lib/baroness-prompt.ts` | Persona + prompt (two sentences: one witty observation, one useful suggestion; clothing only) |
| `lib/critic/` | Critic providers (Gemini / Ollama Qwen3-VL / mock), manifest lookup, sanitiser, cache, ElevenLabs client, scripted lines |
| `app/api/critique/route.ts` | `POST {capture, result}` → `{sessionId, text, source}` · `GET` → readiness |
| `app/api/speech/route.ts` | `POST {sessionId, text}` → `audio/mpeg` stream (text capped at 500 chars) · `GET` → readiness |
| `components/baroness/` | `useBaroness` hook, `BaronessCritique`, `BaronessGuidance`, `AudioSetupControl`, voice controller |
| `public/audio/baroness/` | Optional pre-generated clips for scripted lines (see its README) |

## Environment (server-only — add to `.env.local`, never commit)

```bash
# Critic: gemini (default) | ollama | mock
CRITIC_PROVIDER=gemini
GEMINI_API_KEY=            # required when CRITIC_PROVIDER=gemini
GEMINI_MODEL=gemini-flash-latest
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3-vl:4b   # `ollama pull qwen3-vl:4b` (Ollama >= 0.12.7)
CRITIC_TIMEOUT_MS=8000     # total budget incl. one transient retry; then a preset line

# Voice
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=       # any theatrical voice from your ElevenLabs Voice Library
ELEVENLABS_MODEL_ID=eleven_multilingual_v2
SPEECH_TIMEOUT_MS=10000
# Optional tuning (0..1): ELEVENLABS_STABILITY=0.4 ELEVENLABS_SIMILARITY=0.8 ELEVENLABS_STYLE=0.5

# Optional paths (default: process.cwd() and <root>/references/manifest.json)
# REFLECT_PROJECT_ROOT=
# REFERENCES_MANIFEST_PATH=
```

Only the selected critic provider needs credentials. Without any keys the app
still works: critiques fall back to preset lines (`source: "preset"`) and the
critique shows as text only.

**Voice ID:** in ElevenLabs → Voices, pick an imperious British voice (an older,
dry, theatrical female voice fits the Baroness best), add it to "My Voices",
and copy its Voice ID. No voice cloning.

## Integrating into R1's session state machine

```tsx
import { useBaroness, BaronessCritique, BaronessGuidance, AudioSetupControl } from "@/components/baroness";

// Operator setup screen — block "Ready" until audioUnlocked is true.
<AudioSetupControl onReadyChange={({ audioUnlocked, critic, speech }) => setAudioReady(audioUnlocked)} />

const baroness = useBaroness();
// Person detected (new sessionId):   baroness.startSession(sessionId);
// Framing guidance from R2:          baroness.guide("step-back");    // throttled; silent once the critique starts
// Analysing (optional):              baroness.announce("analysing");
// RateResult arrived (ok or unavailable):
const out = await baroness.run({ capture, result });
if (out.cancelled) return;          // visitor left / superseded — show nothing
// → Awaiting departure. Text stays on screen until cancel().
// Departure (area empty for the debounce interval):
baroness.cancel();                  // aborts request, stops audio, drops late responses

<BaronessCritique text={baroness.text} status={baroness.status} source={baroness.source} speaking={baroness.speaking} />
<BaronessGuidance guidance={currentGuidanceKeyOrNull} />   {/* absolutely positioned; place in a relative parent */}
```

Guarantees: `run()` never rejects; one critique per session (a repeated `run`
for the same session returns the same promise); text appears before audio and
remains if audio fails; every playback has a safety timeout so the flow cannot
get stuck.

Guidance keys (R2 → R4): `step-back`, `step-closer`, `move-left`, `move-right`,
`center`, `show-full-outfit`, `hold-still`, `one-at-a-time`, `face-mirror`
(`GuidanceKey` in `lib/critic/lines.ts`).

## Dependencies on other roles

- **R1:** `lib/types.ts` must export `Capture` and `RateResult` exactly as in
  spec §8 (R4 imports them from `@/lib/types`). Please add `tsx` as a
  devDependency and these scripts:
  `"test:baroness": "tsx --test lib/critic/*.test.ts lib/*.test.ts components/baroness/*.test.ts app/api/speech/route.test.ts"`,
  `"audio:generate": "tsx lib/critic/generate-audio.ts"`, and add the env block
  above (placeholders only) to `.env.example`. No runtime npm dependencies are needed.
- **R3:** `/api/critique` resolves the reference image server-side from
  `references/manifest.json` by `referenceId`. The reader accepts
  `{looks:[{lookId, label, description, references:[{referenceId, imagePath, ...}]}]}`,
  `{references:[...]}`, or a bare array; the image field may be `imagePath`,
  `image`, `path`, `file` or `src`, relative to the project root, `public/…`,
  or a public URL path (`/references/cruella/...`). A look `label` (or `name`)
  and `description` give the Baroness better vocabulary.

## Operator checklist (demo day)

1. Set keys in `.env.local`; `npm run audio:generate` (optional, saves credits/latency).
2. If using Ollama, warm the model first (the first call can exceed the timeout).
3. Start the app, open setup, click **Enable & test audio** — you should hear the Baroness.
4. Check the readiness list: critic and voice green, no problems listed.
