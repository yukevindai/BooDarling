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

The three images under `public/references/cruella/red-glamour/` are **placeholders**
generated for pipeline bring-up. Replace them with curated Cruella photos (one look,
three distinct clear images), update `sourceUrl` in the manifest for attribution,
then re-run `prepare_references.py`.

## Calibration

`references/calibration.json` holds game-design anchors (`lowAnchor`, `highAnchor`),
not an accuracy claim. Re-measure them on the real demo setup from unrelated,
partial-match, and strong-recreation sample outfits using this same pipeline;
`highAnchor` must stay greater than `lowAnchor`. Recalibrate if the encoder,
preprocessing, or reference groups change.
