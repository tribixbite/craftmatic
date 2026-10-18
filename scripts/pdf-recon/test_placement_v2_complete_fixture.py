import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np


HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from placement_v2_complete_fixture import (  # noqa: E402
    EXPECTED_PARENT_SHA256, MAX_RENDERS, PROTOCOL, _load_manifest,
    _strict_added_count,
)


class CompleteFixtureTests(unittest.TestCase):
    def test_strict_added_count_reserves_base_truth_and_uses_frozen_frame(self):
        eye = np.eye(3)
        truth = [("base", 1, np.array([0., 0., 0.]), eye),
                 ("new", 2, np.array([10., 0., 0.]), eye)]
        base = [("base", 1, np.array([0., 0., 0.]), eye)]
        selected = [("new", 2, np.array([10., 0., 0.]), eye)]
        self.assertEqual(_strict_added_count(selected, base, truth, eye, np.zeros(3)), 1)
        rotated = [("new", 2, np.array([10., 0., 0.]), np.diag([-1., 1., -1.]))]
        self.assertEqual(_strict_added_count(rotated, base, truth, eye, np.zeros(3)), 0)

    def test_loader_refuses_bounds_and_parent_provenance(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            parent = root / "parent.json"
            parent.write_text("parent")
            Path(str(parent) + ".sha256").write_text(
                hashlib.sha256(parent.read_bytes()).hexdigest() + "  parent.json\n")
            manifest = root / "manifest.json"
            record = {"protocol": PROTOCOL, "truth_use": "evaluation_only",
                      "selector_contract": {"truth_labels_visible": False},
                      "domain": {"raw_registry_scan": False},
                      "bounds": {"pose_count": 6, "raw_exact_quota_combinations": 12,
                                 "maximum_complete_renders": MAX_RENDERS},
                      "parent": {"path": str(parent), "sha256": EXPECTED_PARENT_SHA256,
                                 "seal_sha256": hashlib.sha256(
                                     Path(str(parent) + ".sha256").read_bytes()).hexdigest()},
                      "source_hashes": {}}
            manifest.write_text(json.dumps(record))
            Path(str(manifest) + ".sha256").write_text(
                hashlib.sha256(manifest.read_bytes()).hexdigest() + "  manifest.json\n")
            with patch("placement_v2_complete_fixture._source_hashes", return_value={}):
                with self.assertRaisesRegex(ValueError, "parent manifest provenance"):
                    _load_manifest(manifest)
            record["bounds"]["raw_exact_quota_combinations"] = 13
            manifest.write_text(json.dumps(record))
            Path(str(manifest) + ".sha256").write_text(
                hashlib.sha256(manifest.read_bytes()).hexdigest() + "  manifest.json\n")
            with patch("placement_v2_complete_fixture._source_hashes", return_value={}):
                with self.assertRaisesRegex(ValueError, "bounds differ"):
                    _load_manifest(manifest)


if __name__ == "__main__":
    unittest.main()
