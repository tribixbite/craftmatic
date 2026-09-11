import unittest

import numpy as np

from placement_v2_proposals import (
    CalibratedView,
    ConnectorTranslationWitness,
    DepthInterval,
    FeatureMatch,
    lift_translation,
    triangulate_translation,
)


IDENTITY = np.eye(3)
FRONT = ((1, 0, 0), (0, 1, 0))
SIDE = ((0, 1, 0), (0, 0, 1))


def match(match_id, part_point, image_point, uncertainty=1.0):
    return FeatureMatch(match_id, part_point, image_point, uncertainty,
                        observation_id=f"obs:{match_id}",
                        predicted_feature_id=f"cad:{match_id}")


def projected(match_id, point, translation, projection):
    point = np.asarray(point, float)
    image = np.asarray(projection, float) @ (point + np.asarray(translation, float))
    return match(match_id, tuple(point), tuple(image))


class SingleViewLiftTest(unittest.TestCase):
    def test_exact_image_translation_retains_explicit_depth_ambiguity(self):
        rows = [projected("a", (0, 0, 0), (4, -2, 7), FRONT),
                projected("b", (2, 3, 1), (4, -2, 7), FRONT)]
        result = lift_translation(rows, FRONT, IDENTITY,
                                  depth_interval=DepthInterval(5, 9, "connector_span"))
        self.assertTrue(np.allclose(result.domain.base_translation, (4, -2, 0)))
        self.assertTrue(np.allclose(result.domain.nullspace_direction, (0, 0, 1)))
        self.assertEqual(result.domain.depth_interval.minimum, 5)
        self.assertEqual(result.domain.depth_interval.maximum, 9)
        self.assertEqual(result.domain.rank, 2)
        self.assertAlmostEqual(result.domain.normalized_residual_rms, 0.0)
        self.assertEqual(result.hypotheses, ())

    def test_compatible_connector_witness_instantiates_pose(self):
        rows = [projected("a", (1, 2, 3), (4, -2, 7), FRONT)]
        result = lift_translation(
            rows, FRONT, IDENTITY, depth_interval=DepthInterval(6, 8, "mate_bounds"),
            connector_witnesses=[ConnectorTranslationWitness("mate:1", (4, -2, 7))])
        self.assertEqual(len(result.hypotheses), 1)
        self.assertEqual(result.hypotheses[0].translation, (4.0, -2.0, 7.0))
        self.assertIn("mate_bounds", result.hypotheses[0].provenance)

    def test_incompatible_contacts_are_rejected_for_image_or_depth(self):
        rows = [projected("a", (0, 0, 0), (4, -2, 7), FRONT)]
        result = lift_translation(
            rows, FRONT, IDENTITY, depth_interval=DepthInterval(6, 8, "bounds"),
            connector_witnesses=[
                ConnectorTranslationWitness("bad-image", (9, -2, 7)),
                ConnectorTranslationWitness("bad-depth", (4, -2, 20)),
            ], image_residual_tolerance=.1)
        self.assertEqual(result.hypotheses, ())
        self.assertEqual({row.witness_id: row.reason for row in result.rejected_witnesses},
                         {"bad-depth": "outside_depth_interval",
                          "bad-image": "image_residual"})


class MultiViewTriangulationTest(unittest.TestCase):
    def test_nonparallel_views_resolve_exact_translation(self):
        translation = (4, -2, 7)
        front = (projected("p", (1, 2, 3), translation, FRONT),)
        side = (projected("p", (1, 2, 3), translation, SIDE),)
        result = triangulate_translation([
            CalibratedView("front", FRONT, front),
            CalibratedView("side", SIDE, side),
        ], IDENTITY)
        self.assertEqual(result.rank, 3)
        self.assertTrue(np.allclose(result.translation, translation))
        self.assertAlmostEqual(result.normalized_residual_rms, 0.0)

    def test_parallel_views_are_rejected_instead_of_guessing_depth(self):
        translation = (4, -2, 7)
        with self.assertRaisesRegex(ValueError, "rank deficient"):
            triangulate_translation([
                CalibratedView("a", FRONT,
                               (projected("p", (0, 0, 0), translation, FRONT),)),
                CalibratedView("b", FRONT,
                               (projected("p", (1, 1, 1), translation, FRONT),)),
            ], IDENTITY)


class InvalidInputTest(unittest.TestCase):
    def test_empty_matches_and_bad_camera_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "feature match"):
            lift_translation([], FRONT, IDENTITY)
        with self.assertRaisesRegex(ValueError, "rank 2"):
            lift_translation([match("a", (0, 0, 0), (0, 0))],
                             ((1, 0, 0), (2, 0, 0)), IDENTITY)

    def test_one_view_is_not_triangulation(self):
        with self.assertRaisesRegex(ValueError, "at least two"):
            triangulate_translation([
                CalibratedView("front", FRONT,
                               (match("a", (0, 0, 0), (0, 0)),))
            ], IDENTITY)


if __name__ == "__main__":
    unittest.main()
