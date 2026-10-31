# Reflect Similarity Service (R3)

FashionCLIP (CLIP fallback) image-to-image similarity and the deterministic Aura
Score. Owned by R3. See `docs/Reflect_Cruella_MVP_Spec.md` §3–§4, §7–§8.

## Layout

| File | Purpose |
|---|---|
| `app.py` | FastAPI service: `GET /health`, `POST /rate` |
| `encoder.py` | Loads one CLIP-family encoder once; unit-normalized embeddings |
| `scoring.py` | Pure, deterministic cosine / look-average / calibration math |
| `refstore.py` | Manifest, calibration, and embedding-cache access |
| `prepare_references.py` | Precompute reference embeddings into `cache/` |
| `calibrate.py` | CLI to measure similarities and set the Aura anchors |
| `calibration_tools.py` | Pure anchor suggestion/validation + `calibration.json` updating |
| `test_calibration.py` | Stdlib `unittest` tests for the calibration tooling |
| `requirements.txt` | Pinned dependencies |
| `cache/` | Generated embeddings/model caches (gitignored) |
| `../../references/manifest.json` | Look groups + source metadata |
| `../../references/calibration.json` | Scoring anchors + versions |
| `../../public/references/cruella/<look-id>/` | Reference images |

## Setup

```bash
python3 -m venv services/similarity/.venv
source services/similarity/.venv/bin/activate
pip install -r services/similarity/requirements.txt
```

The first run downloads the FashionCLIP weights from Hugging Face
(`patrickjohncyh/fashion-clip`); it falls back to `openai/clip-vit-base-patch32`
if FashionCLIP cannot load.

## Prepare references (before demo startup)

Encodes every image in the manifest and writes `cache/embeddings.json`. Re-run
whenever the reference images, the encoder, or preprocessing change.

```bash
python services/similarity/prepare_references.py
```

## Run the service

```bash
python services/similarity/app.py      # binds 127.0.0.1:8000 by default
# or: uvicorn app:app --app-dir services/similarity --host 127.0.0.1 --port 8000
```

Check readiness:

```bash
curl -s http://127.0.0.1:8000/health
```

`ready` only turns true after the encoder is warm and the embedding cache +
calibration are present and version-consistent (same encoder for references and
live crops). Next.js reaches this service through the server-only
`SIMILARITY_SERVICE_URL`; never expose it to browsers.

## Reference images

`public/references/cruella/red-glamour/` holds three crops of one team-provided photo
of Cruella's crimson ball gown (`referenceVersion` `cruella-ref-v2`):

| File | Framing |
|---|---|
| `01.jpg` | Collar to knees, matching the live capture crop (no face) |
| `02.jpg` | Collar to hem: full gown silhouette, slit, train, gloves and cane |
| `03.jpg` | Full look, head to hem |

Adding two more distinct photos of the same look would make scoring more robust
(spec §3). After changing any image, update the manifest (`image` path,
`sourceUrl` for attribution), bump `referenceVersion` in both the manifest and
`calibration.json`, re-run `prepare_references.py`, then recalibrate.

## Calibration

`references/calibration.json` holds game-design anchors (`lowAnchor`, `highAnchor`),
not an accuracy claim. Re-measure them on the real demo setup from unrelated,
partial-match, and strong-recreation sample outfits using this same pipeline;
`highAnchor` must stay greater than `lowAnchor`. Recalibrate if the encoder,
preprocessing, or reference groups change.

### Calibrate on the demo setup (Windows/PowerShell)

The shipped anchors (`cruella-cal-v1`, 0.18 / 0.34) are placeholders: FashionCLIP
image-to-image similarity for almost any photo is above 0.34, so everyone scores 100.
The service prints a startup warning while the placeholders are still in place, and a
log line per rating:

```
[similarity] rate session=abc123def456 look=red-glamour sim=0.5821 ref=red-glamour-02 aura=100 cal=cruella-cal-v1 ms=312
```

Run everything from the repo root, with the venv active.

1. **Swap in the real reference photos** under `public/references/cruella/<look-id>/`.
   If a file name or extension changes, update that reference's `image` path in
   `references/manifest.json` (and `sourceUrl`). Keep three distinct clear images per look.
2. **Re-encode the references:** `python services/similarity/prepare_references.py`
3. **Measure the anchors** — either way:
   - **(a) From the log.** Start the service, stand in front of the mirror in an ordinary
     outfit and note the `sim=` values, then in the costume (or a good recreation) and note
     those. Pick `low` (typical ordinary outfit) and `high` (typical good recreation):
     ```powershell
     python services/similarity/calibrate.py --low 0.52 --high 0.71          # dry run
     python services/similarity/calibrate.py --low 0.52 --high 0.71 --write
     ```
   - **(b) From sample photos.** Put photos (`.jpg/.jpeg/.png/.webp`) in folders and let the
     tool encode them with the same pipeline as the service:
     ```powershell
     python services/similarity/calibrate.py --unrelated samples\unrelated --strong samples\strong --partial samples\partial
     python services/similarity/calibrate.py --unrelated samples\unrelated --strong samples\strong --partial samples\partial --write
     ```
     It prints per-file similarities and per-group min/median/max, then suggests
     `lowAnchor` = median of unrelated and `highAnchor` = median of strong (so a typical
     everyday outfit scores about 0 and a typical good recreation about 100). It warns if
     the groups overlap (`max(unrelated) >= min(strong)`) or the partial median falls
     outside the range, and refuses to write if `highAnchor <= lowAnchor`.
4. **Restart the service.** `calibration.json` is read only at startup. `--write` bumps
   `calibrationVersion` (`cruella-cal-<UTC yyyymmddHHMM>`), and records `modelVersion` and
   `referenceVersion`; without `--write` nothing on disk changes.

Sample photos should be framed like the live crop — clothing, shoulders to knees — not
selfies or full-body shots with lots of background. Use a few photos per group (5+ is
better than 2) taken in the same room and lighting as the demo. Re-run this whenever the
reference photos, encoder, or preprocessing change.

Tests (no torch needed): `cd services/similarity && python -m unittest -v test_calibration`
