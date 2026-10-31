"""Reference manifest, calibration, and embedding-cache access (spec §3, §7).

OWNER: R3 (Similarity engine).

Resolves all paths from a configured project root (SIMILARITY_PROJECT_ROOT, default:
two levels above this file). Loads the reference manifest and calibration, and reads
/writes the precomputed embedding cache. No database or vector database (spec §3):
embeddings live in a single JSON cache alongside the model/preprocessing versions.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List

from scoring import Calibration

EMBEDDINGS_SCHEMA = "reflect-embeddings-v1"


def project_root() -> Path:
    env = os.environ.get("SIMILARITY_PROJECT_ROOT")
    if env:
        return Path(env).expanduser().resolve()
    # services/similarity/refstore.py -> services/similarity -> services -> <root>
    return Path(__file__).resolve().parents[2]


def manifest_path() -> Path:
    return project_root() / "references" / "manifest.json"


def calibration_path() -> Path:
    return project_root() / "references" / "calibration.json"


def cache_dir() -> Path:
    return Path(__file__).resolve().parent / "cache"


def embeddings_path() -> Path:
    return cache_dir() / "embeddings.json"


def load_manifest() -> Dict[str, Any]:
    path = manifest_path()
    if not path.exists():
        raise FileNotFoundError(f"Reference manifest missing: {path}")
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def load_calibration() -> Calibration:
    path = calibration_path()
    if not path.exists():
        raise FileNotFoundError(f"Calibration missing: {path}")
    with path.open("r", encoding="utf-8") as fh:
        raw = json.load(fh)
    return Calibration(
        calibrationVersion=str(raw["calibrationVersion"]),
        lowAnchor=float(raw["lowAnchor"]),
        highAnchor=float(raw["highAnchor"]),
        modelVersion=str(raw.get("modelVersion", "")),
        referenceVersion=str(raw.get("referenceVersion", "")),
    )


@dataclass(frozen=True)
class ReferenceEntry:
    lookId: str
    referenceId: str
    imagePath: Path
    description: str


def iter_references(manifest: Dict[str, Any]) -> List[ReferenceEntry]:
    """Flatten the manifest into reference entries with resolved absolute image paths."""
    root = project_root()
    entries: List[ReferenceEntry] = []
    for look in manifest.get("looks", []):
        look_id = str(look["lookId"])
        for ref in look.get("references", []):
            entries.append(
                ReferenceEntry(
                    lookId=look_id,
                    referenceId=str(ref["referenceId"]),
                    imagePath=(root / str(ref["image"])).resolve(),
                    description=str(ref.get("description", "")),
                )
            )
    if not entries:
        raise ValueError("Manifest contains no references.")
    return entries


def save_embeddings(
    *,
    model_version: str,
    preprocessing_version: str,
    reference_version: str,
    embeddings: Dict[str, List[float]],
) -> Path:
    cache_dir().mkdir(parents=True, exist_ok=True)
    payload = {
        "schema": EMBEDDINGS_SCHEMA,
        "modelVersion": model_version,
        "preprocessingVersion": preprocessing_version,
        "referenceVersion": reference_version,
        "embeddings": embeddings,
    }
    path = embeddings_path()
    with path.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh)
    return path


def load_embeddings() -> Dict[str, Any]:
    path = embeddings_path()
    if not path.exists():
        raise FileNotFoundError(
            f"Embedding cache missing: {path}. Run prepare_references.py first."
        )
    with path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    if data.get("schema") != EMBEDDINGS_SCHEMA:
        raise ValueError(
            f"Embedding cache schema mismatch: {data.get('schema')} != {EMBEDDINGS_SCHEMA}."
        )
    return data


def looks_with_embeddings(
    manifest: Dict[str, Any], embeddings: Dict[str, List[float]]
) -> Dict[str, Dict[str, List[float]]]:
    """Group embeddings by lookId -> {referenceId: embedding}, in manifest order.

    Fails if any reference in the manifest is missing from the embedding cache, so
    a stale cache cannot silently drop references from a look average.
    """
    grouped: Dict[str, Dict[str, List[float]]] = {}
    for look in manifest.get("looks", []):
        look_id = str(look["lookId"])
        refs: Dict[str, List[float]] = {}
        for ref in look.get("references", []):
            ref_id = str(ref["referenceId"])
            if ref_id not in embeddings:
                raise ValueError(
                    f"Reference '{ref_id}' (look '{look_id}') missing from embedding "
                    "cache. Re-run prepare_references.py."
                )
            refs[ref_id] = embeddings[ref_id]
        if refs:
            grouped[look_id] = refs
    if not grouped:
        raise ValueError("No looks with embeddings available.")
    return grouped
