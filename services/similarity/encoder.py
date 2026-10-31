"""Image encoder for Reflect similarity (spec §4, §5).

OWNER: R3 (Similarity engine).

One pretrained image encoder is used for ALL images (references and live crops).
FashionCLIP is the first candidate; a standard CLIP image encoder is the fallback
if costume tests favour it (spec §4, §5). No training or fine-tuning.

Every embedding is L2-normalized to unit length so downstream cosine similarity is
a plain dot product. Inference runs on CPU in eval mode under torch.no_grad for
deterministic, reproducible embeddings.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from typing import List

import numpy as np
import torch
from PIL import Image
from transformers import CLIPModel, CLIPProcessor

# Model choices. Override the primary via SIMILARITY_MODEL if needed.
FASHION_CLIP_ID = os.environ.get("SIMILARITY_MODEL", "patrickjohncyh/fashion-clip")
CLIP_FALLBACK_ID = os.environ.get("SIMILARITY_MODEL_FALLBACK", "openai/clip-vit-base-patch32")

# Bump when the preprocessing contract changes (resize, normalization, etc.).
PREPROCESSING_VERSION = "clip-processor-v1"


@dataclass(frozen=True)
class EncoderInfo:
    modelVersion: str
    preprocessingVersion: str
    embeddingDim: int


class ImageEncoder:
    """Loads a CLIP-family image encoder once and produces unit embeddings."""

    def __init__(self, model_id: str, model: CLIPModel, processor: CLIPProcessor) -> None:
        self._model_id = model_id
        self._model = model.eval()
        self._processor = processor
        # Short, stable model version label used in RateResult + calibration pinning.
        self._model_version = "fashion-clip" if "fashion-clip" in model_id else model_id

    @property
    def info(self) -> EncoderInfo:
        dim = int(self._model.config.projection_dim)
        return EncoderInfo(
            modelVersion=self._model_version,
            preprocessingVersion=PREPROCESSING_VERSION,
            embeddingDim=dim,
        )

    @torch.no_grad()
    def encode(self, image: Image.Image) -> np.ndarray:
        """Encode a single PIL image into a unit-normalized float32 embedding."""
        rgb = image.convert("RGB")
        inputs = self._processor(images=rgb, return_tensors="pt")
        features = self._model.get_image_features(**inputs)
        vec = features[0].to(torch.float32).cpu().numpy()
        norm = np.linalg.norm(vec)
        if norm == 0.0:
            raise ValueError("Encoder produced a zero vector; cannot normalize.")
        return (vec / norm).astype(np.float32)

    def encode_to_list(self, image: Image.Image) -> List[float]:
        return self.encode(image).tolist()


def _load(model_id: str) -> tuple[CLIPModel, CLIPProcessor]:
    model = CLIPModel.from_pretrained(model_id)
    processor = CLIPProcessor.from_pretrained(model_id)
    return model, processor


@lru_cache(maxsize=1)
def load_encoder() -> ImageEncoder:
    """Load the encoder once (cached). Try FashionCLIP, fall back to CLIP.

    Loading here warms the model so readiness only flips to ready after the
    encoder is usable (spec §3: warm the model before showing Ready).
    """
    try:
        model, processor = _load(FASHION_CLIP_ID)
        return ImageEncoder(FASHION_CLIP_ID, model, processor)
    except Exception as primary_error:  # noqa: BLE001 - fall back and report both
        try:
            model, processor = _load(CLIP_FALLBACK_ID)
            enc = ImageEncoder(CLIP_FALLBACK_ID, model, processor)
            print(
                f"[encoder] FashionCLIP unavailable ({primary_error}); "
                f"using CLIP fallback '{CLIP_FALLBACK_ID}'."
            )
            return enc
        except Exception as fallback_error:  # noqa: BLE001
            raise RuntimeError(
                "Failed to load both FashionCLIP and the CLIP fallback. "
                f"primary={primary_error!r} fallback={fallback_error!r}"
            ) from fallback_error
