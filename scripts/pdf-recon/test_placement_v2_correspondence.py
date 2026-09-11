import math
import unittest

from placement_v2_correspondence import (
    CorrespondenceConfig,
    ObservedFeatureToken,
    PredictedFeatureToken,
    score_correspondence,
)


def predicted(token_id, owner, x=0.0, visible=True, seam=None):
    owners = owner if isinstance(owner, tuple) else (owner,)
    return PredictedFeatureToken(token_id, owners, (x, 0.0), (1.0, 0.0),
                                 visible=visible, shared_boundary_id=seam,
                                 material_class="red")


def observed(token_id, x=0.0, annotation=0.0):
    return ObservedFeatureToken(token_id, (x, 0.0), (1.0, 0.0),
                                material_class="red", annotation_probability=annotation)


class ExclusiveCorrespondenceTest(unittest.TestCase):
    def test_one_same_color_stroke_cannot_reward_two_instances(self):
        result = score_correspondence(
            [predicted("p-a", "brick-a"), predicted("p-b", "brick-b")],
            [observed("ink")])
        self.assertEqual(len(result.matches), 1)
        self.assertEqual(len(result.unmatched_predicted_token_ids), 1)
        self.assertEqual(result.unmatched_visible_prediction_cost, 2.0)
        owners = {row.owner_id: row for row in result.per_owner}
        self.assertEqual(sorted(row.support_fraction for row in owners.values()), [0.0, 1.0])

    def test_assignment_is_global_instead_of_greedy(self):
        config = CorrespondenceConfig(max_distance_sigma=20, tangent_weight=0,
                                      unmatched_visible_prediction_cost=100,
                                      unmatched_observation_cost=100)
        result = score_correspondence(
            [predicted("flexible", "a", 0), predicted("constrained", "b", 1)],
            [observed("left", 0), observed("right", 10)], config)
        pairs = {(match.predicted_token_ids[0], match.observed_token_id)
                 for match in result.matches}
        self.assertEqual(pairs, {("flexible", "left"), ("constrained", "right")})

    def test_input_order_does_not_change_tie_resolution(self):
        predictions = [predicted("p-b", "b"), predicted("p-a", "a")]
        observations = [observed("o-b"), observed("o-a")]
        forward = score_correspondence(predictions, observations)
        reverse = score_correspondence(reversed(predictions), reversed(observations))
        self.assertEqual(forward, reverse)


class VisibilityAndAccountingTest(unittest.TestCase):
    def test_fully_occluded_owner_gets_no_invented_visual_confidence(self):
        result = score_correspondence(
            [predicted("front", "front"), predicted("hidden", "hidden", visible=False)],
            [observed("ink")])
        owners = {row.owner_id: row for row in result.per_owner}
        self.assertEqual(owners["front"].support_fraction, 1.0)
        self.assertIsNone(owners["hidden"].support_fraction)
        self.assertEqual(owners["hidden"].matched_feature_share, 0.0)
        self.assertEqual(owners["hidden"].match_cost, 0.0)

    def test_shared_seam_is_scored_once_and_split_between_owners(self):
        result = score_correspondence([
            predicted("left-copy", "left", seam="seam-7"),
            predicted("right-copy", "right", seam="seam-7"),
        ], [observed("ink")])
        self.assertEqual(result.visible_prediction_count, 1)
        self.assertEqual(result.total_cost, 0.0)
        self.assertEqual(result.matches[0].owner_ids, ("left", "right"))
        self.assertEqual([row.matched_feature_share for row in result.per_owner], [.5, .5])

    def test_unmatched_observed_annotation_is_soft_background_alternative(self):
        result = score_correspondence([], [observed("line", annotation=.75)])
        self.assertEqual(result.unmatched_observation_cost, .5)
        self.assertEqual(result.normalization_evidence, .25)
        self.assertEqual(result.normalized_cost, 2.0)

    def test_unequal_counts_are_normalized_by_visible_evidence(self):
        result = score_correspondence([predicted("p", "owner")],
                                      [observed("match"), observed("extra", 100)])
        self.assertEqual(result.total_cost, 2.0)
        self.assertEqual(result.normalization_evidence, 3.0)
        self.assertAlmostEqual(result.normalized_cost, 2 / 3)


class BoundaryCasesTest(unittest.TestCase):
    def test_empty_inputs_have_a_zero_finite_score(self):
        result = score_correspondence([], [])
        self.assertEqual(result.total_cost, 0.0)
        self.assertEqual(result.normalized_cost, 0.0)
        self.assertTrue(math.isfinite(result.normalized_cost))

    def test_no_observations_penalizes_only_visible_predictions(self):
        result = score_correspondence(
            [predicted("shown", "a"), predicted("hidden", "b", visible=False)], [])
        self.assertEqual(result.total_cost, 2.0)
        self.assertEqual(result.unmatched_predicted_token_ids, ("shown",))

    def test_invalid_and_duplicate_records_fail_loudly(self):
        with self.assertRaisesRegex(ValueError, "uncertainty"):
            score_correspondence([], [ObservedFeatureToken("o", (0, 0), (1, 0), 0)])
        with self.assertRaisesRegex(ValueError, "duplicate predicted"):
            score_correspondence([predicted("p", "a"), predicted("p", "b")], [])
        with self.assertRaisesRegex(ValueError, "non-zero"):
            score_correspondence(
                [PredictedFeatureToken("p", ("a",), (0, 0), (0, 0))], [])

    def test_inconsistent_duplicate_seam_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "inconsistent shared boundary"):
            score_correspondence([
                predicted("a", "left", x=0, seam="same"),
                predicted("b", "right", x=1, seam="same"),
            ], [])


if __name__ == "__main__":
    unittest.main()
