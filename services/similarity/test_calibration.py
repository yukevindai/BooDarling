"""Tests for calibration tooling (stdlib unittest; no torch required).

Run:  cd services/similarity && python -m unittest -v test_calibration
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import calibrate  # noqa: E402
import calibration_tools as ct  # noqa: E402
from scoring import Calibration, aura_score  # noqa: E402

PLACEHOLDER_CAL = {
    "calibrationVersion": "cruella-cal-v1",
    "modelVersion": "fashion-clip",
    "referenceVersion": "cruella-ref-v1",
    "lowAnchor": 0.18,
    "highAnchor": 0.34,
    "anchors": {
        "unrelated": {"similarity": 0.18, "note": "old"},
        "partial": {"similarity": 0.26, "note": "old"},
        "strong": {"similarity": 0.34, "note": "old"},
    },
    "extraKey": {"keep": "me"},
    "notes": (
        "Game-design calibration anchors (spec §4), NOT a statistical accuracy claim. "
        "These are PLACEHOLDER values; re-measure on the actual demo setup. "
        "Requirement: highAnchor > lowAnchor. Recalibrate whenever the encoder changes."
    ),
}
NOW = datetime(2026, 10, 31, 17, 5, tzinfo=timezone.utc)


class SuggestTests(unittest.TestCase):
    def test_median_based(self):
        plan = ct.suggest_anchors(
            unrelated=[0.50, 0.54, 0.52, 0.90],  # median 0.53 (outlier ignored)
            strong=[0.70, 0.74, 0.72],
            partial=[0.60, 0.62],
        )
        self.assertAlmostEqual(plan.lowAnchor, 0.53)
        self.assertAlmostEqual(plan.highAnchor, 0.72)
        self.assertEqual(plan.unrelated.count, 4)
        self.assertAlmostEqual(plan.unrelated.minimum, 0.50)
        self.assertAlmostEqual(plan.unrelated.maximum, 0.90)
        self.assertTrue(plan.ok)

    def test_requires_samples(self):
        with self.assertRaises(ValueError):
            ct.suggest_anchors([], [0.7])
        with self.assertRaises(ValueError):
            ct.suggest_anchors([0.5], [])

    def test_clean_groups_have_no_warnings(self):
        plan = ct.suggest_anchors([0.50, 0.52], [0.70, 0.72], [0.61])
        self.assertEqual(plan.warnings, [])
        self.assertEqual(plan.errors, [])

    def test_overlap_warning(self):
        plan = ct.suggest_anchors([0.50, 0.71], [0.70, 0.80])
        self.assertTrue(plan.ok)  # warning, not an error
        self.assertTrue(any("overlap" in w for w in plan.warnings))

    def test_partial_outside_range_warning(self):
        plan = ct.suggest_anchors([0.50], [0.70], [0.80])
        self.assertTrue(any("Partial-match median" in w for w in plan.warnings))
        plan = ct.suggest_anchors([0.50], [0.70], [0.40])
        self.assertTrue(any("Partial-match median" in w for w in plan.warnings))

    def test_refuses_when_high_not_above_low(self):
        plan = ct.suggest_anchors([0.70, 0.72], [0.50, 0.52])  # swapped folders
        self.assertFalse(plan.ok)
        self.assertTrue(any("greater than lowAnchor" in e for e in plan.errors))
        with self.assertRaises(ValueError):
            ct.update_calibration(PLACEHOLDER_CAL, plan, model_version="m", reference_version="r")

    def test_equal_anchors_refused(self):
        self.assertFalse(ct.manual_anchors(0.5, 0.5).ok)

    def test_manual_path(self):
        plan = ct.manual_anchors(0.52, 0.71)
        self.assertEqual(plan.source, "manual")
        self.assertTrue(plan.ok)
        self.assertEqual((plan.lowAnchor, plan.highAnchor), (0.52, 0.71))
        self.assertFalse(ct.manual_anchors(0.71, 0.52).ok)
        self.assertFalse(ct.manual_anchors(float("nan"), 0.5).ok)


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.plan = ct.suggest_anchors([0.50, 0.54], [0.70, 0.74], [0.62, 0.64, 0.60])

    def test_preserves_other_keys_and_bumps_version(self):
        before = json.loads(json.dumps(PLACEHOLDER_CAL))
        out = ct.update_calibration(
            PLACEHOLDER_CAL, self.plan, model_version="fashion-clip", reference_version="cruella-ref-v2", now=NOW
        )
        self.assertEqual(PLACEHOLDER_CAL, before, "input must not be mutated")
        self.assertEqual(out["extraKey"], {"keep": "me"})
        self.assertEqual(list(out.keys()), list(PLACEHOLDER_CAL.keys()))
        self.assertEqual(out["calibrationVersion"], "cruella-cal-202610311705")
        self.assertEqual(out["referenceVersion"], "cruella-ref-v2")
        self.assertEqual(out["modelVersion"], "fashion-clip")
        self.assertEqual(out["lowAnchor"], 0.52)
        self.assertEqual(out["highAnchor"], 0.72)
        self.assertEqual(out["anchors"]["unrelated"]["similarity"], 0.52)
        self.assertEqual(out["anchors"]["partial"]["similarity"], 0.62)
        self.assertEqual(out["anchors"]["strong"]["similarity"], 0.72)
        self.assertIn("n=2", out["anchors"]["unrelated"]["note"])
        self.assertIn("n=3", out["anchors"]["partial"]["note"])
        self.assertNotIn("PLACEHOLDER", out["notes"])
        self.assertIn("Anchors measured on 2026-10-31 17:05 UTC", out["notes"])
        self.assertIn("Requirement: highAnchor > lowAnchor.", out["notes"])  # other sentences kept
        self.assertFalse(ct.is_placeholder_calibration(out))

    def test_no_partial_uses_midpoint(self):
        plan = ct.suggest_anchors([0.50], [0.70])
        out = ct.update_calibration(PLACEHOLDER_CAL, plan, model_version="m", reference_version="r", now=NOW)
        self.assertEqual(out["anchors"]["partial"]["similarity"], 0.6)
        self.assertIn("no partial samples", out["anchors"]["partial"]["note"])

    def test_manual_update(self):
        out = ct.update_calibration(
            PLACEHOLDER_CAL, ct.manual_anchors(0.52, 0.71), model_version="fashion-clip",
            reference_version="cruella-ref-v1", now=NOW,
        )
        self.assertEqual((out["lowAnchor"], out["highAnchor"]), (0.52, 0.71))
        self.assertNotIn("PLACEHOLDER", out["notes"])
        self.assertIn("by hand", out["notes"])

    def test_repeat_calibration_does_not_pile_up_notes(self):
        once = ct.update_calibration(PLACEHOLDER_CAL, self.plan, model_version="m", reference_version="r", now=NOW)
        twice = ct.update_calibration(once, self.plan, model_version="m", reference_version="r", now=NOW)
        self.assertEqual(twice["notes"].count("Anchors measured on"), 1)

    def test_empty_versions_keep_existing(self):
        out = ct.update_calibration(PLACEHOLDER_CAL, self.plan, model_version="", reference_version="", now=NOW)
        self.assertEqual(out["modelVersion"], "fashion-clip")
        self.assertEqual(out["referenceVersion"], "cruella-ref-v1")

    def test_placeholder_detection(self):
        self.assertTrue(ct.is_placeholder_calibration(PLACEHOLDER_CAL))
        self.assertFalse(ct.is_placeholder_calibration({**PLACEHOLDER_CAL, "calibrationVersion": "cruella-cal-2"}))
        self.assertFalse(ct.is_placeholder_calibration({**PLACEHOLDER_CAL, "notes": "measured"}))

    def test_written_file_loads_in_scoring_calibration(self):
        out = ct.update_calibration(
            PLACEHOLDER_CAL, self.plan, model_version="fashion-clip", reference_version="cruella-ref-v1", now=NOW
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "calibration.json"
            ct.write_calibration_json(path, out)
            self.assertTrue(path.read_text(encoding="utf-8").endswith("\n"))
            with mock.patch.dict(os.environ, {"SIMILARITY_PROJECT_ROOT": tmp}):
                (Path(tmp) / "references").mkdir()
                path.replace(Path(tmp) / "references" / "calibration.json")
                from refstore import load_calibration

                cal = load_calibration()
        self.assertIsInstance(cal, Calibration)
        self.assertEqual(cal.calibrationVersion, "cruella-cal-202610311705")
        self.assertEqual((cal.lowAnchor, cal.highAnchor), (0.52, 0.72))
        self.assertEqual(aura_score(0.52, cal), 0)
        self.assertEqual(aura_score(0.72, cal), 100)
        self.assertEqual(aura_score(0.62, cal), 50)


class CliTests(unittest.TestCase):
    """End-to-end through calibrate.main for the --low/--high path (no torch)."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        root = Path(self._tmp.name)
        (root / "references").mkdir()
        (root / "references" / "manifest.json").write_text(
            json.dumps({"referenceVersion": "cruella-ref-v9", "looks": []}), encoding="utf-8"
        )
        self.cal_path = root / "references" / "calibration.json"
        self.cal_path.write_text(json.dumps(PLACEHOLDER_CAL, indent=2), encoding="utf-8")
        env = mock.patch.dict(os.environ, {"SIMILARITY_PROJECT_ROOT": str(root)})
        env.start()
        self.addCleanup(env.stop)

    def run_cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                code = calibrate.main(list(argv))
            except SystemExit as exc:  # argparse usage errors
                code = exc.code
        return code, out.getvalue(), err.getvalue()

    def test_dry_run_does_not_write(self):
        before = self.cal_path.read_text(encoding="utf-8")
        code, out, _ = self.run_cli("--low", "0.5", "--high", "0.7")
        self.assertEqual(code, 0)
        self.assertIn("DRY RUN", out)
        self.assertEqual(self.cal_path.read_text(encoding="utf-8"), before)

    def test_write_manual(self):
        code, out, _ = self.run_cli("--low", "0.5", "--high", "0.7", "--write")
        self.assertEqual(code, 0)
        self.assertIn("RESTART", out)
        data = json.loads(self.cal_path.read_text(encoding="utf-8"))
        self.assertEqual((data["lowAnchor"], data["highAnchor"]), (0.5, 0.7))
        self.assertEqual(data["referenceVersion"], "cruella-ref-v9")
        self.assertEqual(data["modelVersion"], "fashion-clip")  # no cache -> existing kept
        self.assertTrue(data["calibrationVersion"].startswith("cruella-cal-2"))
        self.assertNotEqual(data["calibrationVersion"], "cruella-cal-v1")
        self.assertEqual(data["extraKey"], {"keep": "me"})

    def test_refuses_high_below_low(self):
        before = self.cal_path.read_text(encoding="utf-8")
        code, _, err = self.run_cli("--low", "0.7", "--high", "0.5", "--write")
        self.assertEqual(code, 1)
        self.assertIn("greater than lowAnchor", err)
        self.assertEqual(self.cal_path.read_text(encoding="utf-8"), before)

    def test_usage_errors(self):
        self.assertEqual(self.run_cli("--low", "0.5")[0], 2)
        self.assertEqual(self.run_cli("--unrelated", "x")[0], 2)
        self.assertEqual(self.run_cli("--low", "0.5", "--high", "0.7", "--strong", "x")[0], 2)
        self.assertEqual(self.run_cli()[0], 2)


class HelperTests(unittest.TestCase):
    def test_list_images_filters_and_sorts(self):
        with tempfile.TemporaryDirectory() as tmp:
            for name in ["b.JPG", "a.png", "c.webp", "d.jpeg", "notes.txt", "e.gif"]:
                (Path(tmp) / name).write_bytes(b"x")
            (Path(tmp) / "sub.png").mkdir()
            names = [p.name for p in calibrate.list_images(Path(tmp))]
        self.assertEqual(names, ["a.png", "b.JPG", "c.webp", "d.jpeg"])
        with self.assertRaises(FileNotFoundError):
            calibrate.list_images(Path(tmp) / "missing")

    def test_table_format(self):
        text = calibrate.format_table([("x.jpg", "strong", "red-glamour", 0.71234)])
        self.assertIn("0.7123", text)
        self.assertIn("red-glamour", text)


if __name__ == "__main__":
    unittest.main()
