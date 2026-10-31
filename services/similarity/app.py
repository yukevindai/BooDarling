"""Reflect similarity service — FastAPI (spec §4, §7, §8).

OWNER: R3 (Similarity engine).

Endpoints:
  GET  /health  -> readiness report
  POST /rate    -> Capture -> RateResult

The model is loaded once at startup and reference embeddings + calibration are read
from disk. Readiness is false (503 on /rate) until the encoder, embedding cache, and
calibration are all present and version-consistent (same encoder for references and
live crops; spec §4). Bind locally for the laptop demo; Next.js reaches this via the
server-only SIMILARITY_SERVICE_URL and never exposes it to browsers (spec §7).

The score is computed here from embedding similarity only. Clients cannot supply
their own anchors, references, or score (spec §8).
"""

from __future__ import annotations

import base64
import binascii
import io
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, Field

from refstore import (
    load_calibration,
    load_embeddings,
    load_manifest,
    looks_with_embeddings,
)
from scoring import aura_score, score_look, select_best_look

# Safety ceiling on the decoded image. The Capture contract is "decoded image <= 1 MB"
# (spec §8); the Next proxy enforces it. This is a defensive upper bound in bytes.
MAX_IMAGE_BYTES = 2 * 1024 * 1024


class Capture(BaseModel):
    sessionId: str = Field(min_length=1)
    outfitImage: str = Field(min_length=1)  # JPEG data URL


class _State:
    def __init__(self) -> None:
        self.ready: bool = False
        self.error: Optional[str] = None
        self.encoder = None
        self.model_version: str = ""
        self.preprocessing_version: str = ""
        self.reference_version: str = ""
        self.calibration = None
        self.looks: Dict[str, Dict[str, List[float]]] = {}
        self.embedding_dim: int = 0


STATE = _State()


def _warm() -> None:
    """Load manifest, calibration, embedding cache, and the encoder. Set readiness.

    Any failure leaves STATE.ready False with a human-readable STATE.error, so
    /health reports the reason and /rate returns 'unavailable' instead of guessing.
    """
    try:
        manifest = load_manifest()
        reference_version = str(manifest.get("referenceVersion", ""))
        calibration = load_calibration()
        cache = load_embeddings()
        embeddings = cache["embeddings"]
        looks = looks_with_embeddings(manifest, embeddings)

        # Version consistency: the cache must match the manifest, and calibration
        # anchors must have been measured against this reference/model (spec §4).
        cache_ref_version = str(cache.get("referenceVersion", ""))
        if cache_ref_version != reference_version:
            raise RuntimeError(
                f"Embedding cache referenceVersion '{cache_ref_version}' != manifest "
                f"'{reference_version}'. Re-run prepare_references.py."
            )
        if calibration.referenceVersionMismatch(reference_version):
            raise RuntimeError(
                f"Calibration referenceVersion '{calibration.referenceVersion}' != "
                f"manifest '{reference_version}'. Recalibrate."
            )

        # Load the encoder last (slowest) and verify it matches the cached embeddings.
        from encoder import load_encoder  # imported lazily so torch isn't needed to import this module

        encoder = load_encoder()
        info = encoder.info
        cache_model_version = str(cache.get("modelVersion", ""))
        if cache_model_version != info.modelVersion:
            raise RuntimeError(
                f"Embedding cache modelVersion '{cache_model_version}' != live encoder "
                f"'{info.modelVersion}'. Re-run prepare_references.py with this encoder."
            )
        if calibration.modelVersionMismatch(info.modelVersion):
            raise RuntimeError(
                f"Calibration modelVersion '{calibration.modelVersion}' != live encoder "
                f"'{info.modelVersion}'. Recalibrate."
            )

        # Verify dimensions line up with the cached vectors.
        any_vec = next(iter(embeddings.values()))
        if len(any_vec) != info.embeddingDim:
            raise RuntimeError(
                f"Embedding dim mismatch: cache={len(any_vec)} encoder={info.embeddingDim}."
            )

        STATE.encoder = encoder
        STATE.model_version = info.modelVersion
        STATE.preprocessing_version = info.preprocessingVersion
        STATE.reference_version = reference_version
        STATE.calibration = calibration
        STATE.looks = looks
        STATE.embedding_dim = info.embeddingDim
        STATE.error = None
        STATE.ready = True
    except Exception as exc:  # noqa: BLE001 - surface the reason via /health
        STATE.ready = False
        STATE.error = str(exc)
        print(f"[similarity] not ready: {exc}")


@asynccontextmanager
async def lifespan(_: FastAPI):
    _warm()
    yield


app = FastAPI(title="Reflect Similarity Service", lifespan=lifespan)


@app.get("/health")
def health() -> Dict[str, Any]:
    return {
        "ready": STATE.ready,
        "error": STATE.error,
        "modelVersion": STATE.model_version,
        "preprocessingVersion": STATE.preprocessing_version,
        "referenceVersion": STATE.reference_version,
        "calibrationVersion": STATE.calibration.calibrationVersion if STATE.calibration else "",
        "lookCount": len(STATE.looks),
    }


def _unavailable(session_id: str, message: str, status_code: int = 200) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"status": "unavailable", "sessionId": session_id, "message": message},
    )


def _decode_image(outfit_image: str) -> Image.Image:
    """Decode a JPEG data URL (or bare base64) into an RGB PIL image."""
    payload = outfit_image
    if payload.startswith("data:"):
        comma = payload.find(",")
        if comma == -1:
            raise ValueError("Malformed data URL.")
        payload = payload[comma + 1 :]
    try:
        raw = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("Image is not valid base64.") from exc
    if len(raw) > MAX_IMAGE_BYTES:
        raise ValueError(f"Image exceeds {MAX_IMAGE_BYTES} bytes.")
    try:
        img = Image.open(io.BytesIO(raw))
        img.load()
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError("Could not decode image.") from exc
    return img.convert("RGB")


@app.post("/rate")
def rate(capture: Capture) -> JSONResponse:
    if not STATE.ready or STATE.encoder is None or STATE.calibration is None:
        return _unavailable(
            capture.sessionId,
            "Similarity service is not ready.",
            status_code=503,
        )

    # Decode + encode. A decode/encode failure is an embedding failure: never
    # fabricate a score (spec §5) — return 'unavailable'.
    try:
        image = _decode_image(capture.outfitImage)
    except ValueError as exc:
        return _unavailable(capture.sessionId, f"Invalid image: {exc}")

    try:
        user_embedding = STATE.encoder.encode_to_list(image)
    except Exception as exc:  # noqa: BLE001
        print(f"[similarity] encode failed: {exc}")
        return _unavailable(capture.sessionId, "Unable to rate this look.")

    try:
        look_scores = [
            score_look(look_id, refs, user_embedding)
            for look_id, refs in STATE.looks.items()
        ]
        winner = select_best_look(look_scores)
        aura = aura_score(winner.lookSimilarity, STATE.calibration)
    except Exception as exc:  # noqa: BLE001
        print(f"[similarity] scoring failed: {exc}")
        return _unavailable(capture.sessionId, "Unable to rate this look.")

    return JSONResponse(
        status_code=200,
        content={
            "status": "ok",
            "sessionId": capture.sessionId,
            "aura": aura,
            "lookId": winner.lookId,
            "referenceId": winner.bestReferenceId,
            "similarity": winner.lookSimilarity,
            "referenceScores": [
                {"referenceId": rs.referenceId, "similarity": rs.similarity}
                for rs in winner.referenceScores
            ],
            "modelVersion": STATE.model_version,
            "referenceVersion": STATE.reference_version,
            "calibrationVersion": STATE.calibration.calibrationVersion,
        },
    )


if __name__ == "__main__":
    import os

    import uvicorn

    host = os.environ.get("SIMILARITY_HOST", "127.0.0.1")
    port = int(os.environ.get("SIMILARITY_PORT", "8000"))
    uvicorn.run(app, host=host, port=port)
