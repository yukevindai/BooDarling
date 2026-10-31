# R2 — Capture / vision

Hands-free detection, framing guidance, stable sharp-frame selection and automatic clothing crop (spec §2–3).

## Files

| File | What it does |
|---|---|
| `lib/capture/config.ts` | **All thresholds.** Tune these on the demo laptop. |
| `lib/capture/framing.ts` | Pure logic: person counting, clothing-crop policy, framing status + Cruella guidance lines |
| `lib/capture/stability.ts` | Hold-still tracker, debounced presence (enter 400 ms / leave 2.5 s), guidance hysteresis |
| `lib/capture/image.ts` | Crop rendering (aspect preserved), Laplacian sharpness, JPEG ≤ 1 MB encoding |
| `lib/capture/detector.ts` | MediaPipe Pose Landmarker loader (GPU → CPU fallback, cached, `numPoses: 2`) |
| `lib/capture/controller.ts` | The loop: detect → frame → hold still → sample ~0.7 s → keep sharpest → emit once |
| `lib/capture/reference.ts` | `cropReferenceImage(img)`: same crop policy for R3's reference photos |
| `components/reflect/ReflectCamera.tsx` | Overlay for R1's `<video>`: brackets, guidance caption, progress bar, debug panel |
| `components/reflect/CaptureSandbox.tsx` | Standalone test bench with its own camera (dev only) |

## Dependency (R1: add to package.json)

```
npm i @mediapipe/tasks-vision@1.2.0
```

Imports use the `@/` alias (default in create-next-app). Both component files are `"use client"`.

## Integration for R1

```tsx
<div style={{ position: "relative" }}>
  <video ref={videoRef} autoPlay muted playsInline style={{ transform: "scaleX(-1)" }} />
  <ReflectCamera
    videoRef={videoRef}
    sessionId={session?.id ?? null}      // fresh id per visitor arms ONE capture; null disarms
    onReadyCapture={(capture) => rate(capture)}   // Capture → POST /api/rate
    onPresenceChange={(present) => present ? startSession() : endSession()}
    onFramingChange={(s) => /* s.guidanceKey → R4 audio clip if wanted */ null}
    onReady={() => markPoseModelReady()}   // operator "Ready" check
  />
</div>
```

- `onReadyCapture` fires **once per armed session**. R2 never re-arms; R1 re-arms after departure (spec §8).
- `onPresenceChange(false)` = area empty for `leaveDebounceMs`. Single missed frames don't trigger it.
- Multiple people → status `multiple`, guidance "One at a time, darlings.", capture paused (no emit) until one person remains.
- `mirrored` defaults to true; set it to match the `<video>` CSS. Crops always come from the raw (unmirrored) frame.
- `object-fit: cover`/`contain` on the video is handled by the overlay.
- Warm the model during operator setup: `getPoseDetector()` from `lib/capture/detector`.

## Statuses → guidance (`guidanceKey` for R4's pre-generated clips)

| status | line |
|---|---|
| `multiple` | One at a time, darlings. |
| `partial` | Let me see the whole look, darling. |
| `tooClose` | Step back a little, darling. |
| `tooFar` | Closer, darling. I can't see the fabric. |
| `offCenter` | To the centre, darling. |
| `settling` | Hold still. Let me look at you. |
| `capturing` | Perfect. Don't move. |

## Crop policy (keep identical for references)

Box from shoulders, elbows, wrists, hips, knees, ankles/feet. Top sits just above the shoulders (collar, not face); sides padded 0.55× shoulder width and at least 2.1× shoulder width total (coat flare); bottom 0.15× torso below the lowest visible lower-body point. Default `requireLowerBody: "none"`: shoulders in frame are enough (upper-body webcam framing); when the legs are out of view the crop runs to the bottom of the frame. `"hips" | "knees" | "ankles"` give stricter full-length framing; in `"knees"` mode, knees hidden under a gown but located in frame still count. No stretching; long side ≤ 768 px. Background is still included — we make no background-invariance claim.

## Tuning on the demo setup

1. Mount `<CaptureSandbox />` on a temporary dev page, stand where visitors will stand.
2. Read `shoulderW`, `centerOff`, `sharp` from the debug panel at the near/far limits you want, and set `min/maxShoulderWidth`, `centerTolerance`, `minSharpness`.
3. If captures feel slow, lower `stableHoldMs`; if they fire while people are still walking in, raise it.
4. For an offline demo, copy `node_modules/@mediapipe/tasks-vision/wasm` to `public/mediapipe/wasm` and the `.task` model to `public/mediapipe/`, then point `wasmUrl`/`modelUrl` there.
