import itertools
from collections import Counter
import unittest
from unittest.mock import patch

from placement_v2_complete_search import (
    CompletePose, CompleteSearchLimits, CompleteSearchRefused,
    search_complete_assemblies,
)


def independent_feasible(poses, quotas, conflicts):
    """Small test-only brute force, independent of the production enumerator."""
    by_id = {pose.pose_id: pose for pose in poses}
    conflict_sets = {frozenset(pair) for pair in conflicts}
    result = []
    for size in range(len(poses) + 1):
        for selected in itertools.combinations(poses, size):
            if Counter(pose.quota_key for pose in selected) != Counter(quotas):
                continue
            ids = {pose.pose_id for pose in selected}
            if any(pair <= ids for pair in conflict_sets):
                continue
            reached = {pose.pose_id for pose in selected if pose.base_supported}
            changed = True
            while changed:
                old = len(reached)
                for pose_id in ids - reached:
                    if any(parent in reached for parent in by_id[pose_id].support_pose_ids):
                        reached.add(pose_id)
                changed = len(reached) != old
            if reached == ids:
                result.append(tuple(sorted(ids)))
    return tuple(sorted(result))


class CompleteSearchTests(unittest.TestCase):
    def test_matches_independent_brute_force_and_scores_every_feasible_assembly(self):
        poses = (
            CompletePose("a1", "a", 11, True),
            CompletePose("a2", "a", 7, False, ("a1", "b2")),
            CompletePose("a3", "a", 5, True),
            CompletePose("b1", "b", 3, True),
            CompletePose("b2", "b", 2, False, ("a3",)),
        )
        quotas = {"a": 2, "b": 1}
        conflicts = (("a1", "b1"),)
        calls = []

        def objective(selected):
            calls.append(tuple(pose.pose_id for pose in selected))
            return sum(pose.payload for pose in selected)

        result = search_complete_assemblies(poses, quotas, conflicts, objective)
        expected = independent_feasible(poses, quotas, conflicts)
        actual = tuple(sorted(item.selected_pose_ids for item in result.assemblies))
        self.assertEqual(actual, expected)
        self.assertEqual(len(calls), len(expected))
        self.assertEqual(len(set(calls)), len(calls))
        self.assertEqual(result.complete_combination_bound, 6)
        self.assertEqual(result.enumerated_complete_combinations, 6)
        self.assertEqual(result.feasible_assembly_count, 2)
        self.assertEqual(result.score_call_count, 2)
        self.assertEqual(result.optimum_selection_ids, (("a2", "a3", "b2"),))

    def test_complete_callback_can_reverse_unary_preference(self):
        poses = (
            CompletePose("x-unary", "x", {"unary": 0}, True),
            CompletePose("x-whole", "x", {"unary": 2}, True),
            CompletePose("y-unary", "y", {"unary": 0}, True),
            CompletePose("y-whole", "y", {"unary": 2}, True),
        )
        unary_choice = ("x-unary", "y-unary")

        def whole_objective(selected):
            ids = tuple(pose.pose_id for pose in selected)
            return 0.0 if ids == ("x-whole", "y-whole") else 10.0

        result = search_complete_assemblies(
            poses, {"x": 1, "y": 1}, (), whole_objective)
        self.assertNotEqual(result.optimum_selection_ids[0], unary_choice)
        self.assertEqual(result.optimum_selection_ids, (("x-whole", "y-whole"),))
        self.assertEqual(result.score_call_count, 4)

    def test_zero_quota_candidates_are_not_selected(self):
        poses = (
            CompletePose("ignored", "zero", "must-not-be-seen", False),
            CompletePose("kept", "one", "kept", True),
        )
        seen = []
        result = search_complete_assemblies(
            poses, {"zero": 0, "one": 1}, (),
            lambda selected: seen.append(tuple(p.payload for p in selected)) or 4.0)
        self.assertEqual(seen, [("kept",)])
        self.assertEqual(result.selected_pose_count, 1)
        self.assertEqual(result.optimum_selection_ids, (("kept",),))

    def test_hidden_rooted_piece_is_feasible_and_exposed_to_objective(self):
        poses = (
            CompletePose("hidden", "hidden-part", {"visible": False}, False, ("root",)),
            CompletePose("root", "root-part", {"visible": True}, True),
        )
        seen = []

        def objective(selected):
            seen.extend(pose.payload["visible"] for pose in selected)
            return 1.0

        result = search_complete_assemblies(
            poses, {"hidden-part": 1, "root-part": 1}, (), objective)
        self.assertEqual(result.optimum_selection_ids, (("hidden", "root"),))
        self.assertEqual(seen, [False, True])

    def test_reports_all_absolute_tolerance_ties(self):
        poses = tuple(CompletePose(name, "q", name, True)
                      for name in ("a", "b", "c"))
        costs = {"a": 1.0, "b": 1.0 + 5e-7, "c": 1.0 + 2e-6}
        result = search_complete_assemblies(
            poses, {"q": 1}, (), lambda selected: costs[selected[0].pose_id],
            absolute_tolerance=1e-6)
        self.assertEqual(result.optimum_score, 1.0)
        self.assertEqual(result.optimum_selection_ids, (("a",), ("b",)))

    def test_candidate_and_quota_permutations_have_identical_order(self):
        poses = (
            CompletePose("z", "right", 3, True),
            CompletePose("b", "left", 2, True),
            CompletePose("a", "left", 1, True),
            CompletePose("y", "right", 4, True),
        )
        seen_one = []
        seen_two = []
        score = lambda selected: float(sum(pose.payload for pose in selected))
        first = search_complete_assemblies(
            poses, {"right": 1, "left": 1}, (),
            lambda selected: seen_one.append(tuple(p.pose_id for p in selected))
            or score(selected))
        second = search_complete_assemblies(
            tuple(reversed(poses)), {"left": 1, "right": 1}, (),
            lambda selected: seen_two.append(tuple(p.pose_id for p in selected))
            or score(selected))
        self.assertEqual(seen_one, seen_two)
        self.assertEqual(first, second)

    def test_pose_limit_refuses_before_any_score_call(self):
        calls = []
        poses = tuple(CompletePose(str(index), "q", None, True) for index in range(3))
        with self.assertRaisesRegex(CompleteSearchRefused, "before scoring"):
            search_complete_assemblies(
                poses, {"q": 1}, (), lambda selected: calls.append(selected) or 0.0,
                limits=CompleteSearchLimits(max_poses=2, max_combinations=10))
        self.assertEqual(calls, [])

    def test_combination_bound_refuses_before_scoring_even_if_conflicts_prune(self):
        calls = []
        poses = tuple(CompletePose(str(index), "q", None, True) for index in range(5))
        conflicts = tuple(itertools.combinations((pose.pose_id for pose in poses), 2))
        with self.assertRaisesRegex(CompleteSearchRefused, "bound 10"):
            search_complete_assemblies(
                poses, {"q": 2}, conflicts,
                lambda selected: calls.append(selected) or 0.0,
                limits=CompleteSearchLimits(max_poses=5, max_combinations=9))
        self.assertEqual(calls, [])

    def test_huge_bound_refuses_before_materializing_combination_pools(self):
        calls = []
        poses = tuple(CompletePose(f"p{index:02}", "q", None, True)
                      for index in range(64))
        with patch("placement_v2_complete_search.combinations",
                   side_effect=AssertionError("combination pool was materialized")):
            with self.assertRaisesRegex(CompleteSearchRefused, "before scoring"):
                search_complete_assemblies(
                    poses, {"q": 32}, (),
                    lambda selected: calls.append(selected) or 0.0,
                    limits=CompleteSearchLimits(
                        max_poses=64, max_combinations=100_000))
        self.assertEqual(calls, [])

    def test_impossible_quota_skips_all_combination_pool_materialization(self):
        calls = []
        poses = (tuple(CompletePose(f"p{index:02}", "large", None, True)
                       for index in range(63))
                 + (CompletePose("only", "impossible", None, True),))
        with patch("placement_v2_complete_search.combinations",
                   side_effect=AssertionError("combination pool was materialized")):
            result = search_complete_assemblies(
                poses, {"large": 31, "impossible": 2}, (),
                lambda selected: calls.append(selected) or 0.0,
                limits=CompleteSearchLimits(max_poses=64, max_combinations=1))
        self.assertEqual(calls, [])
        self.assertEqual(result.complete_combination_bound, 0)
        self.assertEqual(result.enumerated_complete_combinations, 0)
        self.assertEqual(result.optimum_selection_ids, ())

    def test_rootless_complete_bank_has_no_score_calls_or_optimum(self):
        calls = []
        poses = (CompletePose("child", "q", None, False, ("unused",)),
                 CompletePose("unused", "zero", None, True))
        result = search_complete_assemblies(
            poses, {"q": 1, "zero": 0}, (),
            lambda selected: calls.append(selected) or 0.0)
        self.assertEqual(calls, [])
        self.assertEqual(result.assemblies, ())
        self.assertEqual(result.optimum_selection_ids, ())
        self.assertIsNone(result.optimum_score)


if __name__ == "__main__":
    unittest.main()
