import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest


HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from placement_v2_fixture_controls import (  # noqa: E402
    MAX_ALTERNATIVES, PROTOCOL, _load_and_validate_manifest,
    _support_witness, _truth_assignment,
)


class FixtureControlTests(unittest.TestCase):
    def test_truth_assignment_enforces_quota_and_distinct_truth_instances(self):
        rows = [
            dict(pose_id="a", quota_key="brick:4", truth_indices=[10], normalized_cost=.3),
            dict(pose_id="b", quota_key="brick:4", truth_indices=[10], normalized_cost=.1),
            dict(pose_id="c", quota_key="brick:4", truth_indices=[11], normalized_cost=.2),
            dict(pose_id="d", quota_key="pin:0", truth_indices=[12], normalized_cost=.4),
        ]
        selected, witness = _truth_assignment(rows, {"brick:4": 2, "pin:0": 1})
        self.assertEqual({row["pose_id"] for row in selected}, {"b", "c", "d"})
        self.assertEqual(set(witness), {10, 11, 12})

    def test_truth_assignment_rejects_duplicate_only_truth(self):
        rows = [
            dict(pose_id="a", quota_key="brick:4", truth_indices=[10], normalized_cost=.1),
            dict(pose_id="b", quota_key="brick:4", truth_indices=[10], normalized_cost=.2),
        ]
        self.assertIsNone(_truth_assignment(rows, {"brick:4": 2}))

    def test_support_witness_requires_path_to_physical_root(self):
        registry = {"base_supported": [2], "support_edges": [[0, 1], [1, 2], [3, 4]]}
        rows = {f"p{i}": {"registry_index": i} for i in range(5)}
        connected = _support_witness(["p0", "p1", "p2"], rows, registry)
        self.assertTrue(connected["feasible"])
        self.assertEqual(connected["paths"]["p0"], [0, 1, 2])
        disconnected = _support_witness(["p2", "p3", "p4"], rows, registry)
        self.assertFalse(disconnected["feasible"])
        self.assertIsNone(disconnected["paths"]["p3"])

    def test_manifest_loader_refuses_unbounded_or_changed_inputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runtime = {}
            for name in ("report", "pdf", "base", "registry", "registration"):
                path = root / name
                path.write_text(name)
                runtime[name] = str(path)
                runtime[f"{name}_sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
            manifest = root / "fixture.json"
            record = dict(protocol=PROTOCOL, truth_use="evaluation_only", runtime=runtime,
                          bounds=dict(raw_registry_scan=False,
                                      candidate_assemblies=MAX_ALTERNATIVES + 1))
            manifest.write_text(json.dumps(record))
            seal = hashlib.sha256(manifest.read_bytes()).hexdigest()
            Path(str(manifest) + ".sha256").write_text(seal + "  fixture.json\n")
            with self.assertRaisesRegex(ValueError, "bounded assembly limit"):
                _load_and_validate_manifest(manifest)
            record["bounds"]["candidate_assemblies"] = 2
            manifest.write_text(json.dumps(record))
            seal = hashlib.sha256(manifest.read_bytes()).hexdigest()
            Path(str(manifest) + ".sha256").write_text(seal + "  fixture.json\n")
            Path(runtime["pdf"]).write_text("changed")
            with self.assertRaisesRegex(ValueError, "input changed: pdf"):
                _load_and_validate_manifest(manifest)


if __name__ == "__main__":
    unittest.main()
