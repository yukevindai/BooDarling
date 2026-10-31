"""Pure calibration helpers for the Aura Score anchors (spec §4).

OWNER: R3 (Similarity engine).

No torch / transformers / PIL imports here, so this module (and its tests) run in
any plain Python environment. `calibrate.py` is the CLI that feeds these functions
with measured similarities.

Anchor choice (documented, deliberately simple):
  lowAnchor  = median similarity of the UNRELATED outfits  -> a typical everyday
               outfit scores about 0.
  highAnchor = median similarity of the STRONG recreations -> a typical good
               recreation scores about 100.
These are game-design anchors, not an accuracy claim.
"""

from __future__ import annotations

import copy
import json
import math
import os
import re
import statistics
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence

PLACEHOLDER_VERSION = "cruella-cal-v1"
PLACEHOLDER_MARKER = "PLACEHOLDER"


# --------------------------------------------------------------------------- stats


@dataclass(frozen=True)
class GroupStats:
    count: int
    minimum: float
    median: float
    maximum: float


def summarize(values: Sequence[float]) -> Optional[GroupStats]:
    """min/median/max of a group, or None when the group is empty."""
    if not values:
        return None
    vals = [float(v) for v in values]
    return GroupStats(
        count=len(vals),
        minimum=min(vals),
        median=float(statistics.median(vals)),
        maximum=max(vals),
    )


# ------------------------------------------------------------------ suggest/validate


@dataclass
class AnchorPlan:
    """Anchors to write plus the measurements behind them."""

    lowAnchor: float
    highAnchor: float
    unrelated: Optional[GroupStats] = None
    partial: Optional[GroupStats] = None
    strong: Optional[GroupStats] = None
    source: str = "measured"  # "measured" (from folders) or "manual" (--low/--high)
    warnings: List[str] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors


def validate_anchors(
    low: float,
    high: float,
    unrelated: Optional[GroupStats] = None,
    partial: Optional[GroupStats] = None,
    strong: Optional[GroupStats] = None,
) -> tuple[List[str], List[str]]:
    """Return (warnings, errors). Errors block writing; warnings do not."""
    warnings: List[str] = []
    errors: List[str] = []

    for name, val in (("lowAnchor", low), ("highAnchor", high)):
        if not math.isfinite(val):
            errors.append(f"{name} is not a finite number ({val}).")
    if errors:
        return warnings, errors

    if not high > low:
        errors.append(
            f"highAnchor ({high:.4f}) must be greater than lowAnchor ({low:.4f}); "
            "refusing to write. Check that --low/--high (or the --unrelated and --strong "
            "folders) are not swapped and that the strong samples really resemble the look."
        )

    if unrelated and strong and unrelated.maximum >= strong.minimum:
        warnings.append(
            f"Groups overlap: max(unrelated)={unrelated.maximum:.4f} >= "
            f"min(strong)={strong.minimum:.4f}. Some unrelated outfits score as high as "
            "some strong recreations, so the score cannot separate them cleanly. "
            "Review those photos, add better samples, or improve the reference images."
        )

    if partial and not (low < partial.median < high):
        warnings.append(
            f"Partial-match median {partial.median:.4f} is outside the anchor range "
            f"({low:.4f}, {high:.4f}); partial outfits will clamp to 0 or 100."
        )

    return warnings, errors


def suggest_anchors(
    unrelated: Sequence[float],
    strong: Sequence[float],
    partial: Sequence[float] = (),
) -> AnchorPlan:
    """Median-based anchors from measured look similarities, with validation."""
    if not unrelated:
        raise ValueError("Need at least one unrelated sample to suggest lowAnchor.")
    if not strong:
        raise ValueError("Need at least one strong sample to suggest highAnchor.")
    u = summarize(unrelated)
    s = summarize(strong)
    p = summarize(partial)
    assert u is not None and s is not None
    low, high = u.median, s.median
    warnings, errors = validate_anchors(low, high, u, p, s)
    return AnchorPlan(
        lowAnchor=low,
        highAnchor=high,
        unrelated=u,
        partial=p,
        strong=s,
        source="measured",
        warnings=warnings,
        errors=errors,
    )


def manual_anchors(low: float, high: float) -> AnchorPlan:
    """Anchors given directly (--low/--high); no measurements, ordering still checked."""
    warnings, errors = validate_anchors(low, high)
    return AnchorPlan(
        lowAnchor=float(low),
        highAnchor=float(high),
        source="manual",
        warnings=warnings,
        errors=errors,
    )


# ------------------------------------------------------------ calibration.json update


def new_calibration_version(now: Optional[datetime] = None) -> str:
    """cruella-cal-<UTC yyyymmddHHMM>."""
    moment = now or datetime.now(timezone.utc)
    if moment.tzinfo is not None:
        moment = moment.astimezone(timezone.utc)
    return "cruella-cal-" + moment.strftime("%Y%m%d%H%M")


def is_placeholder_calibration(raw: Mapping[str, Any]) -> bool:
    """True for the shipped placeholder anchors (version v1 + PLACEHOLDER note)."""
    return (
        str(raw.get("calibrationVersion", "")) == PLACEHOLDER_VERSION
        and PLACEHOLDER_MARKER in str(raw.get("notes", ""))
    )


def _fmt_group(stats: Optional[GroupStats]) -> str:
    if stats is None:
        return "no samples"
    return f"n={stats.count}, range {stats.minimum:.4f}-{stats.maximum:.4f}"


def _replace_placeholder_note(notes: str, measured_sentence: str) -> str:
    """Swap the PLACEHOLDER sentence (or an earlier measured-on sentence) for a new
    measured-on sentence, keeping the remaining sentences in place."""
    parts = [p for p in re.split(r"(?<=\.)\s+", notes.strip()) if p]
    out: List[str] = []
    inserted = False
    for part in parts:
        if PLACEHOLDER_MARKER in part or part.startswith("Anchors measured on"):
            if not inserted:
                out.append(measured_sentence)
                inserted = True
            continue
        out.append(part)
    if not inserted:
        out.append(measured_sentence)
    return " ".join(out)


def update_calibration(
    raw: Mapping[str, Any],
    plan: AnchorPlan,
    *,
    model_version: str,
    reference_version: str,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """Return a NEW calibration dict with the plan applied. Never mutates `raw`.

    Keys not owned by calibration (anything we don't set) are preserved, as is key
    order. Raises ValueError if the plan is not writable.
    """
    if not plan.ok:
        raise ValueError("; ".join(plan.errors))

    moment = now or datetime.now(timezone.utc)
    stamp = moment.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    out: Dict[str, Any] = copy.deepcopy(dict(raw))

    out["calibrationVersion"] = new_calibration_version(moment)
    if model_version:
        out["modelVersion"] = model_version
    if reference_version:
        out["referenceVersion"] = reference_version
    out["lowAnchor"] = round(plan.lowAnchor, 4)
    out["highAnchor"] = round(plan.highAnchor, 4)

    low, high = out["lowAnchor"], out["highAnchor"]
    mid = round((low + high) / 2.0, 4)
    anchors = out.get("anchors")
    if not isinstance(anchors, dict):
        anchors = {}
        out["anchors"] = anchors

    def _set(key: str, similarity: float, note: str) -> None:
        entry = anchors.get(key)
        if not isinstance(entry, dict):
            entry = {}
            anchors[key] = entry
        entry["similarity"] = round(similarity, 4)
        entry["note"] = note

    if plan.source == "measured":
        u, p, s = plan.unrelated, plan.partial, plan.strong
        _set(
            "unrelated",
            low,
            f"Median winning-look similarity of unrelated everyday outfits ({_fmt_group(u)}). "
            "This is lowAnchor (score 0).",
        )
        if p is not None:
            _set(
                "partial",
                p.median,
                f"Median winning-look similarity of partial-match outfits ({_fmt_group(p)}).",
            )
        else:
            _set("partial", mid, "Midpoint of lowAnchor and highAnchor; no partial samples were measured.")
        _set(
            "strong",
            high,
            f"Median winning-look similarity of strong recreations ({_fmt_group(s)}). "
            "This is highAnchor (score 100).",
        )
        measured = (
            f"Anchors measured on {stamp} with {model_version or 'the loaded encoder'} against "
            f"{reference_version or 'the current references'}: lowAnchor = median of unrelated "
            f"({_fmt_group(plan.unrelated)}), highAnchor = median of strong "
            f"({_fmt_group(plan.strong)})."
        )
    else:
        _set("unrelated", low, "Ordinary-outfit similarity read from the service log (--low). This is lowAnchor (score 0).")
        _set("partial", mid, "Midpoint of lowAnchor and highAnchor; not measured.")
        _set("strong", high, "Costume similarity read from the service log (--high). This is highAnchor (score 100).")
        measured = (
            f"Anchors measured on {stamp} with {model_version or 'the loaded encoder'} against "
            f"{reference_version or 'the current references'}: lowAnchor and highAnchor were "
            "set by hand from similarities in the service log."
        )

    out["notes"] = _replace_placeholder_note(str(out.get("notes", "")), measured)
    return out


def write_calibration_json(path: Path, data: Mapping[str, Any]) -> None:
    """Atomically write calibration JSON (utf-8, 2-space indent, trailing newline)."""
    path = Path(path)
    text = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    tmp = path.with_name(path.name + ".tmp")
    with tmp.open("w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    os.replace(tmp, path)
