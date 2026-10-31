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
GEMINI_FALLBACK_MODELS=gemini-flash-lite-latest,gemini-2.5-flash   # tried in order when the primary is overloaded (429/5xx) or gone (404); "none" disables
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3-vl:4b   # `ollama pull qwen3-vl:4b` (Ollama >= 0.12.7)
CRITIC_TIMEOUT_MS=8000     # total budget incl. one transient retry; then a preset line (500..120000)

# Voice
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=       # any theatrical voice from your ElevenLabs Voice Library
ELEVENLABS_MODEL_ID=eleven_multilingual_v2
SPEECH_TIMEOUT_MS=6000     # per upstream attempt (time to headers); one retry
# Optional tuning (0..1): ELEVENLABS_STABILITY=0.4 ELEVENLABS_SIMILARITY=0.8 ELEVENLABS_STYLE=0.5

# Optional paths (default: process.cwd() and <root>/references/manifest.json)
# REFLECT_PROJECT_ROOT=
# REFERENCES_MANIFEST_PATH=
```

**Client deadlines follow the server.** `GET /api/critique` and `GET /api/speech`
report `detail.timeoutMs`; `AudioSetupControl` passes them to
`configureBaronessTimeouts()`, so the browser waits
`max(12s, CRITIC_TIMEOUT_MS + 3s)` for a critique and
`max(15s, 2 × SPEECH_TIMEOUT_MS + 3s)` for live speech (guidance: 5s). If you do
not mount `AudioSetupControl`, call
`configureBaronessTimeouts({ critiqueServerMs, speechServerMs })` yourself, or the
12s / 15s defaults apply (too short if `CRITIC_TIMEOUT_MS` > 9000).

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
// (Also configures client timeouts from the server's readiness; see above.)
<AudioSetupControl onReadyChange={({ audioUnlocked, critic, speech }) => setAudioReady(audioUnlocked)} />

const baroness = useBaroness();
// Person detected (new sessionId):   baroness.startSession(sessionId);   // please do call this
// Framing guidance from R2:          <ReflectCamera onFramingChange={(f) => baroness.guide(f.guidanceKey)} />
//                                    // throttled; null/"empty"/"captured" are no-ops; silent once the critique starts
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
remains if audio fails; every playback has a safety timeout (clip duration + 3s,
max 60s) so the flow cannot get stuck.

**Stale runs are refused.** `run()` resolves `{ cancelled: true }` immediately —
no request, no audio, no state change — when its `capture.sessionId`:

- was cancelled (`cancel()`), or superseded by `startSession(other)` or by a
  `run()` for another session (the last 64 retired ids are remembered), or
- differs from the session passed to the latest `startSession()`.

So **R1 should call `baroness.startSession(newId)` on person-detected**: a late
`run()` from the previous visitor (rating resolved after they left) can then
never abort the new visitor or roast an empty room. `run()` without any
`startSession()` still works (each new id supersedes and retires the previous
one). `cancel()` forgets the started session, so the next visitor may again use
either style. The pure decision is exported as `decideRun()` for tests.

**Operator audio test** never interrupts a visitor: while a visitor session is
active, the setup button only unlocks audio (if still locked) and is otherwise
disabled with a hint.

Guidance keys: `guide()` and `<BaronessGuidance>` accept R2's
`FramingState.guidanceKey` directly (`multiple`, `partial`, `tooClose`, `tooFar`,
`offCenter`, `settling`, `capturing`) as well as R4's own `GuidanceKey`s. The
spoken lines match R2's on-screen captions word for word (enforced by
`lib/critic/lines.test.ts`). R2's `ReflectCamera` already draws the caption, so
`<BaronessGuidance>` is optional. Mapping: `FRAMING_TO_GUIDANCE` in `lib/critic/lines.ts`.

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
