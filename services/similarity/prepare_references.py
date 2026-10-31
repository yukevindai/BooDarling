"""Precompute normalized reference embeddings (spec §3, §7).

OWNER: R3 (Similarity engine).

Reads references/manifest.json, encodes every reference image with the same encoder
used for live crops, L2-normalizes, and writes the embeddings to the gitignored
cache alongside the model/preprocessing/reference versions. Run this before demo
startup; the service refuses readiness until the cache exists and matches.

Usage:
    python services/similarity/prepare_references.py
"""

from __future__ import annotations

import sys

from PIL import Image

from encoder import load_encoder
from refstore import iter_references, load_calibration, load_manifest, save_embeddings


def main() -> int:
    manifest = load_manifest()
    reference_version = str(manifest.get("referenceVersion", ""))
    if not reference_version:
        print("ERROR: manifest is missing 'referenceVersion'.", file=sys.stderr)
        return 1

    # Validate calibration now so a bad (highAnchor <= lowAnchor) config fails early.
    calibration = load_calibration()
    if calibration.referenceVersionMismatch(reference_version):
        print(
            "WARNING: calibration.referenceVersion does not match the manifest "
            f"referenceVersion ('{reference_version}'). Recalibrate if references changed.",
            file=sys.stderr,
        )

    entries = iter_references(manifest)
    print(f"Preparing {len(entries)} reference embedding(s) for '{reference_version}'...")

    encoder = load_encoder()
    info = encoder.info
    print(f"Encoder: model={info.modelVersion} preprocessing={info.preprocessingVersion} dim={info.embeddingDim}")

    embeddings: dict[str, list[float]] = {}
    for entry in entries:
        if not entry.imagePath.exists():
            print(f"ERROR: image not found: {entry.imagePath}", file=sys.stderr)
            return 1
        with Image.open(entry.imagePath) as img:
            vec = encoder.encode_to_list(img)
        embeddings[entry.referenceId] = vec
        print(f"  [{entry.lookId}] {entry.referenceId}  <- {entry.imagePath.name}")

    path = save_embeddings(
        model_version=info.modelVersion,
        preprocessing_version=info.preprocessingVersion,
        reference_version=reference_version,
        embeddings=embeddings,
    )
    print(f"Wrote {len(embeddings)} embedding(s) to {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
