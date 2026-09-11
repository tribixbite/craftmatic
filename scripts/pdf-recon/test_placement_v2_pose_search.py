import random
import unittest

import numpy as np

from placement_v2_pose_search import (
    CUBE_ROTATIONS,
    DrawingCandidate,
    close_support_candidates,
    padded_camera_scene,
    quota_key,
    rotation_family,
    selected_items,
    support_records,
    thin_drawing_candidates,
    _projected_descriptor,
    _suppressed_base_feature_ids,
)


def candidate(pose_id, key, index, overlap, distance, rotation="rotation:unspecified", cell=(0, 0)):
    part, color = key.split(":")
    return DrawingCandidate(pose_id, key, index, part, int(color),
                            tuple(tuple(float(x) for x in row) for row in np.eye(4)),
                            overlap, distance, rotation, cell)


class DrawingThinTest(unittest.TestCase):
    def test_budget_is_per_key_and_drawing_ranked(self):
        rows = [candidate("a0", "a:1", 0, .1, 1),
                candidate("a1", "a:1", 1, .9, 9),
                candidate("a2", "a:1", 2, .9, 2),
                candidate("b0", "b:2", 3, .2, 5),
                candidate("b1", "b:2", 4, .3, 7)]
        retained, counts = thin_drawing_candidates(rows, 2)
        self.assertEqual([row.pose_id for row in retained], ["a2", "a1", "b1", "b0"])
        self.assertEqual({name: counts["a:1"][name]
                          for name in ("input", "retained", "budget")},
                         {"input": 3, "retained": 2, "budget": 2})
        self.assertEqual(counts["b:2"]["retained"], 2)

    def test_order_is_invariant_to_registry_iteration_order(self):
        rows = [candidate(f"p{i}", "a:1", i, i % 3, i % 2) for i in range(12)]
        expected = thin_drawing_candidates(rows, 5)
        random.Random(7).shuffle(rows)
        self.assertEqual(thin_drawing_candidates(rows, 5), expected)

    def test_duplicate_pose_id_and_invalid_budget_are_rejected(self):
        row = candidate("same", "a:1", 0, 1, 1)
        with self.assertRaisesRegex(ValueError, "duplicate"):
            thin_drawing_candidates([row, row], 1)
        with self.assertRaisesRegex(ValueError, "positive"):
            thin_drawing_candidates([], 0)

    def test_rotation_families_round_robin_before_a_second_pose(self):
        rows = [candidate("r0-best", "a:1", 0, 9, 0, "r0"),
                candidate("r0-next", "a:1", 1, 8, 0, "r0", (1, 0)),
                candidate("r1", "a:1", 2, 1, 9, "r1")]
        retained, counts = thin_drawing_candidates(rows, 2)
        self.assertEqual([row.pose_id for row in retained], ["r0-best", "r1"])
        self.assertEqual(counts["a:1"]["retained_rotation_classes"], 2)

    def test_cube_rotation_grouping_has_exactly_24_stable_families(self):
        self.assertEqual(len(CUBE_ROTATIONS), 24)
        self.assertEqual(len({rotation_family(matrix) for matrix in CUBE_ROTATIONS}), 24)

    def test_descriptor_never_mutates_cached_projected_geometry(self):
        cached = np.asarray([[[0., 0.], [1., 0.], [0., 1.]]])
        class CachedScorer:
            def _project_part(self, part, color, transform, matrix):
                return {"xy": cached}
        pose = {"part": "a", "T": np.eye(4).tolist(), "_index": 7}
        pose["T"][0][3] = 4
        tree = type("Tree", (), {"query": lambda self, points, k: (np.zeros(len(points)), None)})()
        before = cached.copy()
        first = _projected_descriptor(CachedScorer(), pose, 1, np.eye(2, 3),
                                      np.asarray([3., 2.]), tree,
                                      np.ones((20, 20), bool), 0)
        second = _projected_descriptor(CachedScorer(), pose, 1, np.eye(2, 3),
                                       np.asarray([3., 2.]), tree,
                                       np.ones((20, 20), bool), 0)
        self.assertTrue(np.array_equal(cached, before))
        self.assertEqual(first, second)


class PaddedSceneTest(unittest.TestCase):
    def test_padding_is_spaced_and_preserves_native_scene(self):
        rgb = np.arange(2 * 3 * 3, dtype=np.uint8).reshape(2, 3, 3)
        mask = np.asarray([[False, True, False], [True, False, True]])
        scene = {"rgb": rgb, "mask": mask, "label": "native"}
        padded, record = padded_camera_scene(
            scene, [(-1.0, -4.0, 7.0, 4.0)], spacing=3, max_dimension=20)
        self.assertEqual(record["padding"], [3, 6, 6, 3])
        self.assertEqual(record["padded_size"], [12, 11])
        self.assertFalse(record["refused"])
        self.assertEqual(padded["label"], "native")
        self.assertTrue(np.array_equal(padded["rgb"][6:8, 3:6], rgb))
        self.assertTrue(np.array_equal(padded["mask"][6:8, 3:6], mask))

    def test_oversize_projection_is_explicitly_refused(self):
        scene = {"rgb": np.zeros((2, 3, 3), np.uint8),
                 "mask": np.zeros((2, 3), bool)}
        padded, record = padded_camera_scene(
            scene, [(-100.0, 0.0, 3.0, 2.0)], spacing=3, max_dimension=50)
        self.assertIsNone(padded)
        self.assertTrue(record["refused"])
        self.assertGreater(record["padded_size"][0], 50)

    def test_suppression_uses_exact_candidate_owner_at_base_samples(self):
        owner = np.asarray([[1, 3, 0], [2, 1, 3]], dtype=np.int32)
        pixels = {"left": (0, 0), "covered-a": (1, 0), "covered-b": (2, 1)}
        self.assertEqual(_suppressed_base_feature_ids(owner, 3, pixels),
                         ("covered-a", "covered-b"))
        with self.assertRaisesRegex(ValueError, "outside"):
            _suppressed_base_feature_ids(owner, 3, {"bad": (4, 0)})


class SupportMappingTest(unittest.TestCase):
    def test_support_cycles_and_base_witnesses_are_preserved(self):
        rows = [candidate("p0", "a:1", 0, 1, 1),
                candidate("p1", "a:1", 1, 1, 1),
                candidate("p2-red", "b:2", 2, 1, 1),
                candidate("p2-blue", "b:3", 2, 1, 1)]
        mapped = support_records(rows, [0], [[0, 1], [1, 2]])
        self.assertTrue(mapped["p0"]["base_supported"])
        self.assertFalse(mapped["p1"]["base_supported"])
        self.assertEqual(mapped["p1"]["support_pose_ids"],
                         ("p0", "p2-blue", "p2-red"))
        self.assertEqual(mapped["p2-red"]["support_pose_ids"], ("p1",))

    def test_missing_support_pose_is_not_invented(self):
        rows = [candidate("p0", "a:1", 0, 1, 1)]
        self.assertEqual(support_records(rows, [], [[0, 99]])["p0"]["support_pose_ids"], ())

    def test_support_closure_adds_an_already_rendered_path_to_base(self):
        child = candidate("child", "a:1", 2, 3, 0)
        middle = candidate("middle", "a:1", 1, 2, 0)
        root = candidate("root", "a:1", 0, 1, 0)
        closed, record = close_support_candidates(
            [child], [child, middle, root], [0], [[2, 1], [1, 0]], extra_cap=2)
        self.assertEqual({row.pose_id for row in closed}, {"child", "middle", "root"})
        self.assertEqual(record["added_pose_ids"], ["middle", "root"])
        self.assertEqual(record["unreachable_pose_ids"], [])

    def test_support_closure_reports_cap_refusal(self):
        child = candidate("child", "a:1", 2, 3, 0)
        middle = candidate("middle", "a:1", 1, 2, 0)
        root = candidate("root", "a:1", 0, 1, 0)
        closed, record = close_support_candidates(
            [child], [child, middle, root], [0], [[2, 1], [1, 0]], extra_cap=1)
        self.assertEqual([row.pose_id for row in closed], ["child"])
        self.assertEqual(record["unreachable_pose_ids"], ["child"])


class AssemblyExportTest(unittest.TestCase):
    def test_selected_ids_map_to_distinct_colored_items(self):
        rows = [candidate("red", "brick:4", 3, 1, 1),
                candidate("blue", "brick:1", 4, 1, 1)]
        base = [("base", 7, np.eye(4))]
        items = selected_items(base, ("red", "blue"), rows)
        self.assertEqual([(part, color) for part, color, _ in items],
                         [("base", 7), ("brick", 4), ("brick", 1)])
        self.assertEqual(quota_key("brick", 4), "brick:4")

    def test_unknown_or_duplicate_selection_is_rejected(self):
        rows = [candidate("red", "brick:4", 3, 1, 1)]
        with self.assertRaisesRegex(ValueError, "unknown"):
            selected_items([], ("missing",), rows)
        with self.assertRaisesRegex(ValueError, "not unique"):
            selected_items([], ("red", "red"), rows)


if __name__ == "__main__":
    unittest.main()
