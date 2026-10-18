import itertools
import unittest

from placement_v2_controls import (
    ExhaustiveControlLimits, check_physical_pose_selection,
    solve_exhaustive_joint_base_assignment,
)
from placement_v2_correspondence import (
    CorrespondenceConfig, ObservedFeatureToken, PredictedFeatureToken,
)
from placement_v2_joint_assignment import BaseFeature, solve_joint_base_assignment
from placement_v2_pose_assignment import PoseOption


def predicted(token_id, x, *, seam=None, visible=True, kind="boundary", material=None):
    return PredictedFeatureToken(
        token_id, (token_id,), (float(x), 0.0), (1.0, 0.0),
        visible=visible, shared_boundary_id=seam, feature_kind=kind,
        material_class=material)


def observed(token_id, x, *, uncertainty=1.0, kind="boundary", material=None,
             annotation=0.0):
    return ObservedFeatureToken(
        token_id, (float(x), 0.0), (1.0, 0.0), uncertainty=uncertainty,
        feature_kind=kind, material_class=material,
        annotation_probability=annotation)


def public_for_fixed_selection(options, observations, quotas, base_features,
                               conflicts, selected, config, floor):
    """Force one physical selection by passing exactly those options."""
    selected = set(selected)
    fixed_options = tuple(PoseOption(
        option.pose_id, option.quota_key, option.tokens, option.base_supported,
        tuple(parent for parent in option.support_pose_ids if parent in selected))
        for option in options if option.pose_id in selected)
    fixed_features = tuple(BaseFeature(
        feature.feature_id, feature.tokens,
        tuple(pose_id for pose_id in feature.occluding_pose_ids if pose_id in selected))
        for feature in base_features)
    fixed_conflicts = tuple(pair for pair in conflicts if set(pair) <= selected)
    return solve_joint_base_assignment(
        fixed_options, observations, quotas, fixed_features,
        conflicts=fixed_conflicts, config=config, time_limit=10.0,
        minimum_matches_per_real_pose=floor)


class ExhaustivePlacementControlTest(unittest.TestCase):
    def assert_public_parity(self, options, observations, quotas, base_features=(),
                             conflicts=(), config=CorrespondenceConfig(), floor=0):
        control = solve_exhaustive_joint_base_assignment(
            options, observations, quotas, base_features, conflicts=conflicts,
            config=config, minimum_matches_per_real_pose=floor)
        scores = {item.selected_pose_ids: item for item in control.assemblies}
        by_quota = {key: [] for key in quotas}
        for option in options:
            by_quota[option.quota_key].append(option.pose_id)
        exact_choices = [tuple(itertools.combinations(sorted(by_quota[key]), quotas[key]))
                         for key in sorted(quotas)]
        exact_selections = tuple(
            tuple(sorted(pose_id for group in groups for pose_id in group))
            for groups in itertools.product(*exact_choices))
        for selected in exact_selections:
            if selected not in scores:
                with self.assertRaisesRegex(ValueError, "infeasible"):
                    public_for_fixed_selection(
                        options, observations, quotas, base_features, conflicts,
                        selected, config, floor)
                continue
            public = public_for_fixed_selection(
                options, observations, quotas, base_features, conflicts,
                selected, config, floor)
            self.assertTrue(public.optimal)
            self.assertAlmostEqual(public.total_cost, scores[selected].total_cost)
            self.assertEqual(public.visible_base_feature_ids,
                             scores[selected].visible_base_feature_ids)
            self.assertEqual(public.suppressed_base_feature_ids,
                             scores[selected].suppressed_base_feature_ids)
        public = solve_joint_base_assignment(
            options, observations, quotas, base_features, conflicts=conflicts,
            config=config, time_limit=10.0,
            minimum_matches_per_real_pose=floor)
        self.assertTrue(public.optimal)
        self.assertAlmostEqual(public.total_cost, control.optimum_cost)
        self.assertIn(public.selected_pose_ids, control.optimum_selection_ids)
        self.assertEqual(set(control.feasible_selection_ids), set(scores))
        return control

    def test_exact_quota_conflict_and_root_reachability_feasible_set(self):
        options = (
            PoseOption("root", "root", ()),
            PoseOption("attached", "child", (), False, ("root",)),
            PoseOption("cycle-a", "child", (), False, ("cycle-b",)),
            PoseOption("cycle-b", "child", (), False, ("cycle-a",)),
        )
        control = self.assert_public_parity(
            options, (), {"root": 1, "child": 1}, conflicts=(("root", "cycle-b"),),
            floor=0)
        self.assertEqual(control.mechanically_feasible_selection_ids,
                         (("attached", "root"),))
        self.assertEqual(control.feasible_selection_ids, (("attached", "root"),))
        self.assertEqual(control.enumerated_pose_combinations, 3)

    def test_rooted_cycle_is_valid_but_rootless_cycle_is_rejected(self):
        rooted = (
            PoseOption("root", "root", ()),
            PoseOption("a", "a", (), False, ("root", "b")),
            PoseOption("b", "b", (), False, ("a",)),
        )
        result = self.assert_public_parity(
            rooted, (), {"root": 1, "a": 1, "b": 1}, floor=0)
        self.assertEqual(result.feasible_selection_ids, (("a", "b", "root"),))
        rootless = (
            PoseOption("a", "a", (), False, ("b",)),
            PoseOption("b", "b", (), False, ("a",)),
        )
        with self.assertRaisesRegex(ValueError, "infeasible"):
            solve_exhaustive_joint_base_assignment(
                rootless, (), {"a": 1, "b": 1}, (),
                minimum_matches_per_real_pose=0)
        with self.assertRaisesRegex(ValueError, "infeasible"):
            solve_joint_base_assignment(
                rootless, (), {"a": 1, "b": 1}, (),
                minimum_matches_per_real_pose=0)

    def test_fixed_physical_check_scales_separately_from_visual_oracle(self):
        options = (
            PoseOption("root", "root", ()),
            PoseOption("child", "child", (), False, ("root",)),
        )
        features = tuple(BaseFeature(
            f"base-{index}", (predicted(f"base-token-{index}", index),),
            ("child",)) for index in range(20))
        valid = check_physical_pose_selection(
            options, {"root": 1, "child": 1}, features,
            ("root", "child"), limits=ExhaustiveControlLimits(max_base_features=20))
        self.assertTrue(valid.feasible)
        self.assertEqual(valid.visible_base_feature_ids, ())
        self.assertEqual(len(valid.suppressed_base_feature_ids), 20)
        invalid = check_physical_pose_selection(
            options, {"root": 1, "child": 1}, features, ("child",),
            limits=ExhaustiveControlLimits(max_base_features=20))
        self.assertFalse(invalid.feasible)
        self.assertFalse(invalid.exact_quotas)
        self.assertFalse(invalid.rooted_support)

    def test_zero_token_supported_hidden_piece_requires_explicit_floor_zero(self):
        options = (
            PoseOption("root", "root", ()),
            PoseOption("hidden-piece", "piece", (), False, ("root",)),
        )
        feature = BaseFeature(
            "covered-base", (predicted("base-edge", 20),), ("hidden-piece",))
        control = self.assert_public_parity(
            options, (), {"root": 1, "piece": 1}, (feature,), floor=0)
        self.assertEqual(control.optimum_selection_ids,
                         (("hidden-piece", "root"),))
        self.assertEqual(control.assemblies[0].suppressed_base_feature_ids,
                         ("covered-base",))
        with self.assertRaisesRegex(ValueError, "infeasible"):
            solve_exhaustive_joint_base_assignment(
                options, (), {"root": 1, "piece": 1}, (feature,),
                minimum_matches_per_real_pose=1)
        with self.assertRaisesRegex(ValueError, "infeasible"):
            solve_joint_base_assignment(
                options, (), {"root": 1, "piece": 1}, (feature,),
                minimum_matches_per_real_pose=1)

    def test_base_visibility_is_direct_or_of_selected_occluders(self):
        options = (
            PoseOption("left", "piece", ()),
            PoseOption("right", "piece", ()),
            PoseOption("clear", "piece", ()),
        )
        feature = BaseFeature(
            "base", (predicted("base", 0),), ("left", "right"))
        control = self.assert_public_parity(
            options, (observed("ink", 0),), {"piece": 1}, (feature,), floor=0)
        by_selection = {item.selected_pose_ids: item for item in control.assemblies}
        self.assertEqual(by_selection[("clear",)].visible_base_feature_ids, ("base",))
        self.assertEqual(by_selection[("left",)].suppressed_base_feature_ids, ("base",))
        self.assertEqual(by_selection[("right",)].suppressed_base_feature_ids, ("base",))

    def test_overlap_exclusivity_and_pose_scoped_shared_seam(self):
        options = (
            PoseOption("seam", "a", (
                predicted("seam-left", 0, seam="one-physical-seam"),
                predicted("seam-right", 0, seam="one-physical-seam"))),
            PoseOption("overlap", "b", (predicted("overlap", 0),)),
        )
        control = self.assert_public_parity(
            options, (observed("only-ink", 0),), {"a": 1, "b": 1}, floor=0)
        score = control.assemblies[0]
        self.assertEqual(len(score.matches), 1)
        self.assertAlmostEqual(score.total_cost, 2.0)
        matched_groups = {match.predicted_token_ids for match in score.matches}
        self.assertTrue(matched_groups <= {
            ("overlap",), ("seam-left", "seam-right")})

    def test_uncertainty_controls_edge_admissibility_and_cost(self):
        config = CorrespondenceConfig(max_distance_sigma=4.0)
        options = (PoseOption("pose", "piece", (predicted("edge", 0),)),)
        observations = (
            observed("near-ineligible", 5, uncertainty=1),
            observed("far-eligible", 10, uncertainty=3),
        )
        control = self.assert_public_parity(
            options, observations, {"piece": 1}, config=config, floor=1)
        match = control.assemblies[0].matches[0]
        self.assertEqual(match.observed_token_id, "far-eligible")
        self.assertAlmostEqual(match.distance_sigma, 10 / 3)

    def test_all_optimum_ties_are_reported_and_public_winner_is_a_member(self):
        options = (
            PoseOption("a", "piece", (predicted("a-edge", 0),)),
            PoseOption("b", "piece", (predicted("b-edge", 0),)),
        )
        control = self.assert_public_parity(
            options, (observed("ink", 0),), {"piece": 1}, floor=1)
        self.assertEqual(control.optimum_selection_ids, (("a",), ("b",)))

    def test_permutation_invariance_and_nonempty_zero_quota_pool(self):
        options = (
            PoseOption("b", "chosen", (predicted("b-edge", 0),)),
            PoseOption("unused", "zero", (predicted("unused-edge", 50),)),
            PoseOption("a", "chosen", (predicted("a-edge", 0),)),
        )
        observations = (observed("far-annotation", 50, annotation=1.0),
                        observed("ink", 0))
        forward = solve_exhaustive_joint_base_assignment(
            options, observations, {"chosen": 1, "zero": 0}, (),
            minimum_matches_per_real_pose=1)
        reverse = solve_exhaustive_joint_base_assignment(
            reversed(options), reversed(observations),
            {"zero": 0, "chosen": 1}, (),
            minimum_matches_per_real_pose=1)
        self.assertEqual(forward.feasible_selection_ids,
                         (("a",), ("b",)))
        self.assertEqual(forward.optimum_selection_ids,
                         reverse.optimum_selection_ids)
        self.assertAlmostEqual(forward.optimum_cost, reverse.optimum_cost)
        self.assertNotIn("unused", set().union(*map(set, forward.feasible_selection_ids)))
        public = solve_joint_base_assignment(
            options, observations, {"chosen": 1, "zero": 0}, (),
            minimum_matches_per_real_pose=1)
        self.assertIn(public.selected_pose_ids, forward.optimum_selection_ids)
        self.assertAlmostEqual(public.total_cost, forward.optimum_cost)

    def test_deterministic_small_binary_fixture_matches_public_optimum(self):
        # A fixed exhaustive family exercises distance, kind, material, and
        # annotation costs without relying on random seeds or solver ordering.
        config = CorrespondenceConfig(
            distance_weight=0.7, tangent_weight=0.4,
            kind_mismatch_cost=1.3, material_mismatch_cost=0.6,
            unmatched_visible_prediction_cost=2.2,
            unmatched_observation_cost=1.7)
        options = tuple(
            PoseOption(f"{key}{choice}", key, (
                predicted(f"p-{key}{choice}", choice * 3 + offset,
                          kind="seam" if choice else "boundary",
                          material="red" if key == "a" else "blue"),))
            for key, offset in (("a", 0), ("b", 1)) for choice in (0, 1))
        observations = (
            observed("o0", 0, kind="boundary", material="red"),
            observed("o1", 4, uncertainty=1.5, kind="seam", material="blue"),
            observed("annotation", 30, annotation=0.75),
        )
        control = self.assert_public_parity(
            options, observations, {"a": 1, "b": 1}, config=config, floor=0)
        self.assertEqual(len(control.mechanically_feasible_selection_ids), 4)

    def test_refuses_every_bound_instead_of_truncating(self):
        two = (
            PoseOption("a", "piece", (predicted("a", 0),)),
            PoseOption("b", "piece", (predicted("b", 0),)),
        )
        with self.assertRaisesRegex(ValueError, "max_options"):
            solve_exhaustive_joint_base_assignment(
                two, (), {"piece": 1}, (), minimum_matches_per_real_pose=0,
                limits=ExhaustiveControlLimits(max_options=1))
        with self.assertRaisesRegex(ValueError, "max_pose_combinations"):
            solve_exhaustive_joint_base_assignment(
                two, (), {"piece": 1}, (), minimum_matches_per_real_pose=0,
                limits=ExhaustiveControlLimits(max_pose_combinations=1))
        with self.assertRaisesRegex(ValueError, "max_total_matching_states"):
            solve_exhaustive_joint_base_assignment(
                (two[0],), (observed("x", 0), observed("y", 1)),
                {"piece": 1}, (), minimum_matches_per_real_pose=0,
                limits=ExhaustiveControlLimits(max_total_matching_states=2))
        capped = CorrespondenceConfig(max_neighbors_per_prediction=1)
        with self.assertRaisesRegex(ValueError, "would prune eligible edges"):
            solve_exhaustive_joint_base_assignment(
                (two[0],), (observed("x", 0), observed("y", 1)),
                {"piece": 1}, (), config=capped,
                minimum_matches_per_real_pose=0)


if __name__ == "__main__":
    unittest.main()
