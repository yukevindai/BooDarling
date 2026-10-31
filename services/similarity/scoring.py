"""Deterministic Aura scoring (spec §4).

OWNER: R3 (Similarity engine).

Pure, dependency-free math so the scoring rules can be reasoned about and tested
on their own. The encoder produces unit-normalized embeddings; everything here is
cosine similarity (a dot product of unit vectors), look averaging, best-look
selection, and the fixed calibration mapping to a 0-100 game score.

The score is decided ONLY here, from embedding similarity. No language model can
assign or change it (spec §1, §4).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Mapping, Sequence


@dataclass(frozen=True)
class ReferenceScore:
    referenceId: str
    similarity: float


@dataclass(frozen=True)
class LookScore:
    lookId: str
    lookSimilarity: float
    bestReferenceId: str
    referenceScores: list[ReferenceScore]


@dataclass(frozen=True)
class Calibration:
    calibrationVersion: str
    lowAnchor: float
    highAnchor: float
    # Versions the anchors were measured against (spec §4: recalibrate if these change).
    modelVersion: str = ""
    referenceVersion: str = ""

    def __post_init__(self) -> None:
        if not self.highAnchor > self.lowAnchor:
            raise ValueError(
                f"Invalid calibration: highAnchor ({self.highAnchor}) must be "
                f"greater than lowAnchor ({self.lowAnchor})."
            )

    def referenceVersionMismatch(self, reference_version: str) -> bool:
        return bool(self.referenceVersion) and self.referenceVersion != reference_version

    def modelVersionMismatch(self, model_version: str) -> bool:
        return bool(self.modelVersion) and self.modelVersion != model_version


def cosine_similarity(a: Sequence[float], b: Sequence[float]) -> float:
    """Cosine similarity.

    Inputs are expected to be unit-normalized (the encoder normalizes every
    embedding), so this reduces to a dot product. We still divide by the norms
    defensively in case a caller passes un-normalized vectors; for unit vectors
    the denominator is 1.0 and the result is identical to a plain dot product.
    """
    if len(a) != len(b):
        raise ValueError(f"Embedding length mismatch: {len(a)} vs {len(b)}.")
    dot = 0.0
    na = 0.0
    nb = 0.0
    for x, y in zip(a, b):
        xf = float(x)
        yf = float(y)
        dot += xf * yf
        na += xf * xf
        nb += yf * yf
    denom = math.sqrt(na) * math.sqrt(nb)
    if denom == 0.0:
        return 0.0
    return dot / denom


def score_look(
    look_id: str,
    reference_embeddings: Mapping[str, Sequence[float]],
    user_embedding: Sequence[float],
) -> LookScore:
    """Score one look: similarity to each reference, then the look average.

    `reference_embeddings` maps referenceId -> embedding for THIS look only.
    Reference ids are sorted for a stable, deterministic iteration order.
    """
    if not reference_embeddings:
        raise ValueError(f"Look '{look_id}' has no reference embeddings.")
    ref_scores: list[ReferenceScore] = []
    for ref_id in sorted(reference_embeddings):
        sim = cosine_similarity(user_embedding, reference_embeddings[ref_id])
        ref_scores.append(ReferenceScore(referenceId=ref_id, similarity=sim))

    look_similarity = sum(rs.similarity for rs in ref_scores) / len(ref_scores)
    # Display the highest-similarity individual reference (spec §4.4).
    # Ties break on referenceId for determinism.
    best = max(ref_scores, key=lambda rs: (rs.similarity, _neg_key(rs.referenceId)))
    return LookScore(
        lookId=look_id,
        lookSimilarity=look_similarity,
        bestReferenceId=best.referenceId,
        referenceScores=ref_scores,
    )


def select_best_look(looks: Sequence[LookScore]) -> LookScore:
    """Choose the look with the highest average similarity (spec §4.4).

    Ties break on lookId for determinism.
    """
    if not looks:
        raise ValueError("No looks to score.")
    return max(looks, key=lambda ls: (ls.lookSimilarity, _neg_key(ls.lookId)))


def aura_score(look_similarity: float, calibration: Calibration) -> int:
    """Map a winning look-average similarity to a 0-100 Aura Score (spec §4.5).

    aura = round(100 * clamp((sim - low) / (high - low), 0, 1))

    Uses round-half-up so a boundary value maps the intuitive way and the result
    is stable across runs (Python's built-in round() is banker's rounding).
    """
    span = calibration.highAnchor - calibration.lowAnchor
    t = (look_similarity - calibration.lowAnchor) / span
    t = max(0.0, min(1.0, t))
    return _round_half_up(100.0 * t)


def _round_half_up(value: float) -> int:
    return int(math.floor(value + 0.5))


def _neg_key(s: str) -> tuple[int, ...]:
    """Key that sorts strings in REVERSE within a max() so the lexicographically
    smaller id wins a tie (max picks the largest tuple; negating code points makes
    'a' beat 'b')."""
    return tuple(-ord(c) for c in s)
