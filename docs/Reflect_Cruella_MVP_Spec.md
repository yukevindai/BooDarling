# Reflect — Cruella MVP Spec v4

**Team:** 4 people · **Deadline:** ASAP, no later than noon on October 31, 2026 (Toronto time)

## 1. Product

A hands-free costume mirror: **stand in front of the webcam, receive a Cruella Aura Score, and hear the Baroness critique your outfit through ElevenLabs.**

The score comes from image-to-image similarity against curated Cruella reference outfits. A separate vision-language model writes the critique; it cannot assign or change the score. “Aura” means character-outfit resemblance, not overall fashion quality or personal attractiveness.

**MVP:** automatic detection → automatic capture/crop → reference comparison → score reveal → spoken critique → automatic reset.

**Phase two:** BooCamp facial-expression scare scoring, only after the MVP works. No body-pose performance challenge. Body landmarks in the MVP serve framing only.

**Design:** black, ivory, red; fashion-editorial typography; mirror frame; large score; user photo beside the closest reference.

## 2. Hands-free interaction

**Operator setup only:** start the app, grant camera permission, enable/test audio through a user gesture, and verify model/reference readiness. Camera denial or blocked audio is resolved here; visitors do not operate controls.

1. **Waiting:** camera remains active; detect a person entering the capture area.
2. **Framing:** automatically locate the outfit. Display/speak brief guidance only if needed, such as “Step back a little, darling.” Require one person, adequate visibility, and stable framing.
3. **Capturing:** when ready, automatically capture one sharp frame and crop the clothing region.
4. **Analysing:** compute reference similarities; display a brief theatrical progress state.
5. **Speaking/results:** reveal score, matched look, and reference image; play a two-sentence Baroness critique. Keep text visible if audio fails.
6. **Awaiting departure:** retain results without repeated captures or roasts. Once the area is empty for a short continuous interval, clear the session and return to Waiting.

No visitor uploads, crop handles, character selectors, rating buttons, or retry clicks. Cruella is fixed. Re-entry starts a new assessment.

Use a unique session ID; cancel requests/audio and discard late responses when the person leaves. Allow one assessment in flight. Debounce brief tracking loss so a single missed frame does not restart a session. If multiple people are detected, pause and request one person at a time.

## 3. Automatic capture and references

Use MediaPipe Pose Landmarker for body locations and framing checks, with detection configured to notice multiple people. Derive a padded clothing crop from shoulders, hips, and lower-body landmarks; avoid clipping coat sleeves or hems. Start with a plain backdrop and a fixed camera position. A bounding crop still includes background: do not claim background invariance. Add segmentation only if testing shows it is necessary.

Set a consistent framing policy for live images and reference crops, focusing on clothing rather than faces. Preserve aspect ratio and check that model preprocessing does not crop away important outfit details. Select a sharp frame from a short stable window; tune readiness thresholds on the actual demo setup. Use workers/throttling if vision inference blocks the interface.

**Initial reference set:** one specific Cruella look, three distinct clear images. The team prepares these before the demo; visitors provide nothing. Later looks each get their own similarly sized reference group. Do not average unrelated outfits together.

Store images and a JSON manifest with `characterId`, `lookId`, `referenceId`, image path, source URL, crop metadata, and description. Store normalized reference embeddings alongside model/preprocessing versions. No database or vector database required. Precompute embeddings and warm the model before showing Ready.

## 4. Similarity and Aura Score

Use one pretrained image encoder for all images. FashionCLIP is the first candidate; a standard CLIP image encoder is the fallback if actual costume tests favour it. No training or fine-tuning.

1. Encode the outfit crop and normalize its embedding to unit length.
2. Compute cosine similarity to each normalized reference: `similarity = dot(userEmbedding, referenceEmbedding)`.
3. Average similarities within each look: `lookSimilarity = sum(referenceSimilarities) / referenceCount`.
4. For multiple looks, choose the look with the highest average. Display its highest-similarity individual reference.
5. Convert the winning average to a 0–100 game score using fixed calibration anchors:

`aura = round(100 × clamp((lookSimilarity - lowAnchor) / (highAnchor - lowAnchor), 0, 1))`

Determine anchors from unrelated, partial-match, and strong-match sample outfits using the same reference pipeline; require `highAnchor > lowAnchor`. Check separate sample photos before freezing them. These anchors are game-design calibration, not statistical proof of accuracy. A raw similarity of 0.76 does not mean 76% costume accuracy.

Keep anchors, reference groups, and model versions fixed across visitors. Recalibrate if those change. Never rescale against just one visitor’s comparisons. Validate that close recreations generally rank above unrelated outfits; test background/pose changes. If the model fails this basic check, fix preprocessing or change the encoder. Do not silently substitute an LLM-generated score.

## 5. Critic, voice, and stack

| Layer | Choice | Responsibility |
|---|---|---|
| Web app | Next.js + TypeScript | Shared camera, session state, UI, server routes |
| Auto-framing | MediaPipe Pose Landmarker + Canvas | Person detection, readiness, automatic clothing crop |
| Similarity | FashionCLIP via a small Python service; CLIP fallback | Embeddings, reference averages, calibrated score |
| Critic | Qwen3-VL local if readily usable; Gemini hosted fallback | Compare user crop with matched reference and explain visible differences |
| Voice | ElevenLabs TTS using existing credits | Spoken Baroness delivery |
| Optional palette | Color Thief | Supporting colour display/evidence; no independent aura points |
| Phase two | MediaPipe Face Landmarker | Facial movement challenge |

FashionCLIP mainly trained on product images without people; verify live costume performance rather than assuming superiority. Qwen setup must not delay delivery: switch promptly if unsuitable. A hosted web server cannot reach a laptop’s service through localhost; run the app and Python service on the demo machine or configure reachable hosted endpoints. Keep API keys server-side.

The critic receives both images, the computed score, and matched-look label. Return one witty observation plus one useful suggestion, grounded in visible styling. Do not infer exact reasons for an embedding score or invent missing details. Target clothing, not bodies/identities. Use an available theatrical ElevenLabs voice; no actor clone required.

Critic timeout/failure: retain the valid score and use a preset line that makes no image-specific claims. Embedding failure: display “Unable to rate this look,” never a fabricated score. Allow one automatic transient-error retry while the same session remains present. Speech failure: retain text and finish without trapping the flow.

## 6. Four-person ownership

| Role | Owned area | Deliverable |
|---|---|---|
| R1 — Integration/UI | App shell, shared camera/types/styles/dependencies | Hands-free state machine, operator setup, result display, cancellation/reset, integration |
| R2 — Capture/vision | `components/reflect/`, `lib/capture/` | Detection, framing guidance, stable-frame selection, automatic crop |
| R3 — Similarity engine | `services/similarity/`, `references/`, `app/api/rate/` | Reference assets, encoder, calibration, deterministic scores |
| R4 — Baroness/audio | `components/baroness/`, `app/api/critique/`, `app/api/speech/` | Critic provider/prompt, ElevenLabs, preset guidance/fallback audio |

Separate Claude sessions and branches from one scaffold. Work only in owned files; coordinate shared changes through R1. Start with mock contracts and integrate each working increment ASAP. R1 owns one camera stream. Phase-two work begins only after the MVP is verified.

## 7. GitHub repository structure

**Repository:** https://github.com/yukevindai/hack-or-treat · **Default/integration branch:** `main`

Use one repository with a root Next.js app and one Python similarity service. This is the target layout to implement; the spec does not imply these modules already exist.

| Path | Purpose / owner |
|---|---|
| `docs/Reflect_Cruella_MVP_Spec.md` | Shared build specification; keep aligned with interfaces |
| `README.md` | Setup, run commands, demo instructions; R1 |
| `app/layout.tsx`, `app/page.tsx`, `app/globals.css` | App entry and shared styling; R1 |
| `components/mirror/`, `lib/session.ts`, `lib/camera.ts` | Session state, shared stream, operator setup, results; R1 |
| `lib/types.ts` | Shared request/result contracts; R1 coordinates all changes |
| `components/reflect/`, `lib/capture/` | Detection, readiness, auto-crop; R2 |
| `app/api/rate/route.ts` | Validated proxy to Python similarity service; R3 |
| `services/similarity/app.py`, `encoder.py`, `scoring.py` | Python FastAPI endpoint, loaded encoder, deterministic scoring; R3 |
| `services/similarity/requirements.txt`, `prepare_references.py` | Python dependencies and reference-embedding preparation; R3 |
| `references/manifest.json`, `references/calibration.json` | Look groups, source metadata, scoring anchors and versions; R3 |
| `public/references/cruella/<look-id>/` | Curated display/reference images; R3 |
| `services/similarity/cache/` | Generated embeddings/model caches; ignored by Git |
| `components/baroness/`, `lib/baroness-prompt.ts`, `lib/critic/` | Character UI, prompt, provider adapter; R4 |
| `app/api/critique/route.ts`, `app/api/speech/route.ts` | Critic and ElevenLabs endpoints; R4 |
| `public/audio/` | Optional pre-generated guidance/fallback clips; R4 |
| `components/boocamp/`, `lib/expressions/` | Phase-two expression feature only |
| `package.json`, lockfile, TypeScript/Next config, `.gitignore`, `.env.example` | Shared project setup; R1 |

Keep model weights, caches, visitor photos, `.env.local`, API keys, and Python virtual environments out of Git. Commit a pinned dependency lockfile and `.env.example` with placeholders only. Document required model downloads and run reference preparation before demo startup. Source URLs in the reference manifest preserve asset attribution; the repository licence does not automatically cover third-party images.

Python service contract: `GET /health` reports readiness; `POST /rate` accepts the Capture payload and returns RateResult. Resolve paths from configured project root, load the model once, and fail readiness if references/calibration are missing. Bind locally for the laptop demo; Next.js accesses it using server-only `SIMILARITY_SERVICE_URL`. Do not expose this service or secrets directly to browsers.

Other server configuration: `CRITIC_PROVIDER`, `OLLAMA_BASE_URL`, `GEMINI_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`. Only the selected critic provider needs credentials. Provide an explicit audio-enabled startup control for the operator.

**Git workflow:** R1 commits the shared scaffold/contracts first. Teammates branch from it using `feature/r1-mirror`, `feature/r2-capture`, `feature/r3-similarity`, and `feature/r4-baroness`. Open small PRs to `main`; R1 integrates working increments ASAP. Pull the latest integrated changes before continuing. Avoid force-pushes to `main`, duplicate app scaffolds, and edits outside assigned areas. Preserve teammates’ functionality when resolving conflicts.

## 8. Shared interfaces

Freeze in `lib/types.ts` before splitting:

```ts
type Capture = {
  sessionId: string;
  outfitImage: string; // JPEG data URL; decoded image <= 1 MB
};
type RateResult =
  | { status: "ok"; sessionId: string; aura: number;
      lookId: string; referenceId: string; similarity: number;
      referenceScores: { referenceId: string; similarity: number }[];
      modelVersion: string; referenceVersion: string;
      calibrationVersion: string }
  | { status: "unavailable"; sessionId: string; message: string };
```

- R2 emits `onReadyCapture(capture)` once per session; R1 owns re-arming after departure.
- `POST /api/rate`: `Capture` → `RateResult`. Server fixes the character/reference set and loads calibration; clients cannot supply their own anchors or score.
- `POST /api/critique`: `{ capture, result }` → `{ sessionId, text, source: "model" | "preset" }`. Server resolves the reference image from the local manifest. Critique never changes the rating.
- `POST /api/speech`: `{ sessionId, text }` → audio; cap text at 500 characters. Play only for the active session.
- Cache exact repeated inputs with model/reference/calibration versions. Keep visitor images in session memory; clear on departure. Stop audio on departure, keep camera available for the next visitor, and release tracks when the operator stops the app.

## 9. Phase two and acceptance

BooCamp adds one five-second facial-expression challenge after the outfit verdict, with spoken guidance and automatic progression. Use a neutral baseline plus smoothed brow/eye/mouth coefficients for a separate **Scare Score**. Measure performed expression, not actual fear. Pause/skip when tracking fails, especially with masks or heavy makeup; never block the core mirror flow.

**Deadline:** finish ASAP, no later than noon Toronto time on October 31, 2026. No milestone schedule. Prioritize the complete automatic experience and fix integration issues immediately.

**MVP accepted when:** after operator startup, a visitor can enter, receive one reference-based score and spoken critique, and leave without touching controls. The next visitor starts cleanly. Verify incomplete framing, multiple people, tracking loss, departure during requests/audio, model failures, calibration ordering, and browser audio readiness. Test on the actual camera/laptop and record a backup demo.

**Defer first:** phase two, extra reference looks, optional palette, decorative polish. Preserve automatic capture, image comparison, score reveal, and ElevenLabs critique.

**Out of scope:** visitor uploads/manual crops, arbitrary character search, body-pose scoring, virtual try-on, generated outfits, model training, voice cloning, accounts, hardware.

## Official references

- [FashionCLIP](https://github.com/patrickjohncyh/fashion-clip) · [Model card](https://huggingface.co/patrickjohncyh/fashion-clip)
- [CLIP image features](https://huggingface.co/docs/transformers/model_doc/clip)
- [MediaPipe body landmarks](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js) · [Face landmarks](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker/web_js)
- [Qwen3-VL](https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct) · [Gemini image input](https://ai.google.dev/gemini-api/docs/image-understanding)
- [ElevenLabs TTS](https://elevenlabs.io/docs/api-reference/text-to-speech/stream)
- [Color Thief](https://github.com/lokesh/color-thief)
