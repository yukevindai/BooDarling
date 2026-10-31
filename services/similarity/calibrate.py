"""Calibrate the Aura Score anchors on the real demo setup (spec §4).

OWNER: R3 (Similarity engine).

Two ways to use it (run from the repo root; works from PowerShell too):

  # (a) Measure: encode sample photos exactly like the live service does
  python services/similarity/calibrate.py --unrelated samples/unrelated --strong samples/strong
  python services/similarity/calibrate.py --unrelated samples/unrelated --strong samples/strong --partial samples/partial --write

  # (b) Manual: you read look similarities from the service log line and pick anchors
  python services/similarity/calibrate.py --low 0.52 --high 0.71 --write

Anchor rule: lowAnchor = median similarity of the unrelated photos (typical everyday
outfit ~ 0), highAnchor = median similarity of the strong recreations (typical good
recreation ~ 100). Without --write nothing on disk changes (dry run). The service
reads calibration.json at startup, so RESTART it after writing.

Measurement uses the same encoder, reference embeddings (cache/embeddings.json),
look-averaging and best-look selection as POST /rate. Run prepare_references.py first.
Heavy imports (torch/transformers/PIL) happen lazily, only when measuring.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from calibration_tools import (
    AnchorPlan,
    GroupStats,
    manual_anchors,
    suggest_anchors,
    summarize,
    update_calibration,
    write_calibration_json,
)
from refstore import calibration_path, embeddings_path, load_manifest

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}

# (file name, group, best look id, look similarity)
Row = Tuple[str, str, str, float]


def list_images(folder: Path) -> List[Path]:
    """Non-recursive, case-insensitive listing of supported image files, sorted."""
    if not folder.is_dir():
        raise FileNotFoundError(f"Not a folder: {folder}")
    return sorted(
        (p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_SUFFIXES),
        key=lambda p: p.name.lower(),
    )


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="calibrate.py",
        description="Measure similarities and set the Aura Score anchors in references/calibration.json.",
    )
    p.add_argument("--unrelated", type=Path, help="Folder of ordinary/unrelated outfit photos (-> lowAnchor).")
    p.add_argument("--strong", type=Path, help="Folder of strong costume recreations (-> highAnchor).")
    p.add_argument("--partial", type=Path, help="Optional folder of partial-match outfits (sanity check).")
    p.add_argument("--low", type=float, help="Use this lowAnchor instead of measuring (needs --high).")
    p.add_argument("--high", type=float, help="Use this highAnchor instead of measuring (needs --low).")
    p.add_argument("--write", action="store_true", help="Update references/calibration.json (default: dry run).")
    return p


# ---------------------------------------------------------------- measuring (lazy)


def _measure_folders(folders: Dict[str, Optional[Path]]) -> Tuple[Dict[str, List[float]], List[Row], str, str]:
    """Encode every image in each folder with the service pipeline.

    Returns (similarities by group, table rows, encoder modelVersion, referenceVersion).
    """
    # Lazy heavy imports: only needed when actually measuring.
    from PIL import Image, ImageOps

    from encoder import load_encoder
    from refstore import load_embeddings, looks_with_embeddings
    from scoring import score_look, select_best_look

    manifest = load_manifest()
    reference_version = str(manifest.get("referenceVersion", ""))
    cache = load_embeddings()
    embeddings = cache["embeddings"]
    looks = looks_with_embeddings(manifest, embeddings)

    print("Loading encoder (first run may download model weights)...")
    encoder = load_encoder()
    info = encoder.info
    if str(cache.get("modelVersion", "")) != info.modelVersion:
        raise RuntimeError(
            f"Embedding cache modelVersion '{cache.get('modelVersion')}' != live encoder "
            f"'{info.modelVersion}'. Re-run prepare_references.py."
        )
    if str(cache.get("referenceVersion", "")) != reference_version:
        raise RuntimeError(
            f"Embedding cache referenceVersion '{cache.get('referenceVersion')}' != manifest "
            f"'{reference_version}'. Re-run prepare_references.py."
        )
    print(f"Encoder: {info.modelVersion} ({info.preprocessingVersion}); references: {reference_version}")

    sims: Dict[str, List[float]] = {}
    rows: List[Row] = []
    for group, folder in folders.items():
        if folder is None:
            continue
        values: List[float] = []
        for path in list_images(folder):
            try:
                with Image.open(path) as img:
                    img.load()
                    # Phone photos carry EXIF rotation; the live canvas crop does not.
                    rgb = ImageOps.exif_transpose(img).convert("RGB")
                vec = encoder.encode_to_list(rgb)
            except Exception as exc:  # noqa: BLE001 - skip one bad file, keep going
                print(f"  WARNING: skipped {path.name}: {exc}", file=sys.stderr)
                continue
            winner = select_best_look(
                [score_look(look_id, refs, vec) for look_id, refs in looks.items()]
            )
            values.append(winner.lookSimilarity)
            rows.append((path.name, group, winner.lookId, winner.lookSimilarity))
        sims[group] = values
    return sims, rows, info.modelVersion, reference_version


# ---------------------------------------------------------------------- printing


def format_table(rows: Sequence[Row]) -> str:
    if not rows:
        return "(no images measured)"
    w_file = max(len("file"), *(len(r[0]) for r in rows))
    w_group = max(len("group"), *(len(r[1]) for r in rows))
    w_look = max(len("best look"), *(len(r[2]) for r in rows))
    lines = [f"{'file':<{w_file}}  {'group':<{w_group}}  {'best look':<{w_look}}  lookSimilarity"]
    lines.append("-" * len(lines[0]))
    for name, group, look, sim in rows:
        lines.append(f"{name:<{w_file}}  {group:<{w_group}}  {look:<{w_look}}  {sim:.4f}")
    return "\n".join(lines)


def format_group_stats(name: str, stats: Optional[GroupStats]) -> str:
    if stats is None:
        return f"  {name:<10} (no samples)"
    return (
        f"  {name:<10} n={stats.count:<3} min={stats.minimum:.4f}  "
        f"median={stats.median:.4f}  max={stats.maximum:.4f}"
    )


def _print_plan(plan: AnchorPlan) -> None:
    if plan.source == "measured":
        print("\nPer-group look similarity:")
        print(format_group_stats("unrelated", plan.unrelated))
        if plan.partial is not None:
            print(format_group_stats("partial", plan.partial))
        print(format_group_stats("strong", plan.strong))
        print("\nSuggested anchors (lowAnchor = median unrelated, highAnchor = median strong):")
    else:
        print("\nAnchors given on the command line (no measurement):")
    print(f"  lowAnchor  = {plan.lowAnchor:.4f}")
    print(f"  highAnchor = {plan.highAnchor:.4f}")
    for w in plan.warnings:
        print(f"\nWARNING: {w}")
    for e in plan.errors:
        print(f"\nERROR: {e}", file=sys.stderr)


# -------------------------------------------------------------------------- main


def _cached_model_version() -> str:
    """modelVersion recorded in the embedding cache (what the service checks against)."""
    path = embeddings_path()
    try:
        with path.open("r", encoding="utf-8") as fh:
            return str(json.load(fh).get("modelVersion", ""))
    except (OSError, ValueError):
        return ""


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    manual = args.low is not None or args.high is not None
    measuring = any(f is not None for f in (args.unrelated, args.strong, args.partial))
    if manual and measuring:
        parser.error("use either --low/--high or the sample folders, not both.")
    if manual:
        if args.low is None or args.high is None:
            parser.error("--low and --high must be given together.")
    else:
        if args.unrelated is None or args.strong is None:
            parser.error("give --unrelated and --strong (optionally --partial), or --low and --high.")

    try:
        manifest = load_manifest()
    except (OSError, ValueError) as exc:
        print(f"ERROR: cannot read manifest: {exc}", file=sys.stderr)
        return 1
    reference_version = str(manifest.get("referenceVersion", ""))

    cal_path = calibration_path()
    try:
        with cal_path.open("r", encoding="utf-8") as fh:
            raw_cal = json.load(fh)
    except (OSError, ValueError) as exc:
        print(f"ERROR: cannot read {cal_path}: {exc}", file=sys.stderr)
        return 1

    if manual:
        plan = manual_anchors(args.low, args.high)
        # No encoder load in manual mode: take the version from the embedding cache
        # (the one the service will verify), else keep what the file already says.
        model_version = _cached_model_version() or str(raw_cal.get("modelVersion", ""))
    else:
        folders: Dict[str, Optional[Path]] = {
            "unrelated": args.unrelated,
            "partial": args.partial,
            "strong": args.strong,
        }
        try:
            sims, rows, model_version, reference_version = _measure_folders(folders)
        except (OSError, ValueError, RuntimeError) as exc:
            print(f"ERROR: {exc}", file=sys.stderr)
            return 1
        print()
        print(format_table(rows))
        try:
            plan = suggest_anchors(
                sims.get("unrelated", []), sims.get("strong", []), sims.get("partial", [])
            )
        except ValueError as exc:
            print(f"ERROR: {exc} (no readable images found?)", file=sys.stderr)
            return 1

    _print_plan(plan)

    if not plan.ok:
        print("\nNothing written.", file=sys.stderr)
        return 1

    if not args.write:
        print(f"\nDRY RUN: {cal_path} not modified. Re-run with --write to apply.")
        return 0

    updated = update_calibration(
        raw_cal, plan, model_version=model_version, reference_version=reference_version
    )
    write_calibration_json(cal_path, updated)
    print(f"\nWrote {cal_path}")
    print(f"  calibrationVersion = {updated['calibrationVersion']}")
    print(f"  modelVersion       = {updated.get('modelVersion', '')}")
    print(f"  referenceVersion   = {updated.get('referenceVersion', '')}")
    print("\nRESTART the similarity service now: it loads calibration.json only at startup.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
