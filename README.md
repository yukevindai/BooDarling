<img width="1446" height="420" alt="Screenshot 2026-10-31 at 15 19 50" src="https://github.com/user-attachments/assets/36c70530-03aa-40df-a21e-67a285d7e1c2" />

# Boo, Darling!
## Run
Scoring needs the Python similarity service running alongside Next.js; without it
every rating shows "Similarity service is unreachable." First-time setup is in
[`services/similarity/README.md`](services/similarity/README.md). Terminal 1:
```powershell
services\similarity\.venv\Scripts\activate          # macOS/Linux: source services/similarity/.venv/bin/activate
python services/similarity/prepare_references.py    # once, and after reference changes
python services/similarity/app.py                   # http://127.0.0.1:8000/health should report "ready": true
```
Terminal 2:
```powershell
npm install
copy .env.example .env.local   # fill in keys (server-side only); SIMILARITY_SERVICE_URL=http://127.0.0.1:8000
npm run dev                    # http://localhost:3000 (use Chrome/Edge for speech recognition)
```
On Vercel, the service runs on the laptop behind a tunnel: see [`docs/deploy-vercel.md`](docs/deploy-vercel.md).
Click **Open the dressing room** once (camera + audio unlock). Say "Mirror, mirror on the wall, who's the fairest of them all?" or use the fallback link.

## What works now (all mocks)
Fog → voice reveal → 3-2-1 → capture → red scan → verdict typed over the photo → reset.
Mocks to replace, each by its owner, keeping `lib/types.ts` contracts:

| Owner | Replace |
|---|---|
| R2 | `components/reflect/CaptureStub.tsx` (+ `lib/capture/`): real detection/auto-crop. Keep props: `onCountdown`, `onReadyCapture` (once per session). Add deps (e.g. `@mediapipe/tasks-vision`) to `package.json` via R1. |
| R3 | `app/api/rate/route.ts`, `services/similarity/`, `references/`, `public/references/cruella/<lookId>/<referenceId>.jpg` |
| R4 | `app/api/critique/route.ts`, `app/api/speech/route.ts`, `components/baroness/`, `lib/critic/` |

R1 owns `components/mirror/`, `lib/session.ts`, `lib/camera.ts`, `app/globals.css`, `lib/types.ts`.

## Notes
- The design's THE LOOK / THE FRIGHT / THE FACE sub-scores are not in the frozen `RateResult` (the spec has a single Aura score), so they are not shown. Add them to the contract first if wanted.
- Glitch effects: CSS only (`.glitch`, `.frame.burst`, scanlines in `globals.css`); disabled under `prefers-reduced-motion`.
- Branches: `feature/r1-mirror`, `feature/r2-capture`, `feature/r3-similarity`, `feature/r4-baroness`. Small PRs to `main`.
