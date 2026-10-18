import unittest

from placement_v2_correspondence import ObservedFeatureToken, PredictedFeatureToken
from placement_v2_registration import align_tokens


def prediction(token_id="p", owner="part", position=(0.0, 0.0), visible=True):
    return PredictedFeatureToken(token_id, (owner,), position, (1.0, 0.0), visible=visible)


def observation(token_id="o", position=(0.0, 0.0)):
    return ObservedFeatureToken(token_id, position, (1.0, 0.0))


class TranslationRegistrationTest(unittest.TestCase):
    def test_recovers_known_translation_and_preserves_identity(self):
        source = prediction(position=(2.0, 7.0))
        result = align_tokens([source], [observation(position=(7.0, 4.0))],
                              steps=(4, 2, 1))
        self.assertEqual(result.offset, (5.0, -3.0))
        self.assertEqual(result.cost, 0.0)
        self.assertLess(result.cost, result.initial_cost)
        shifted = result.shifted_tokens[0]
        self.assertEqual(shifted.token_id, source.token_id)
        self.assertEqual(shifted.owner_ids, source.owner_ids)
        self.assertEqual(shifted.position, (7.0, 4.0))
        self.assertEqual(shifted.tangent, source.tangent)

    def test_every_accepted_step_is_monotonic(self):
        result = align_tokens([prediction()], [observation(position=(3.0, 0.0))],
                              steps=(2, 1, .5))
        self.assertTrue(result.improved)
        self.assertEqual(result.offset, (3.0, 0.0))
        self.assertGreaterEqual(result.evaluations, 1 + 8 * 3)

    def test_no_observations_do_not_create_spurious_registration_confidence(self):
        result = align_tokens([prediction()], [], steps=(8, 4, 2))
        self.assertEqual(result.offset, (0.0, 0.0))
        self.assertFalse(result.improved)
        self.assertEqual(result.accepted_offsets, ())
        self.assertEqual(result.shifted_tokens[0].position, (0.0, 0.0))

    def test_fully_hidden_owner_does_not_move_or_gain_support(self):
        result = align_tokens([prediction(visible=False)], [observation(position=(4, 2))],
                              steps=(4, 2, 1))
        self.assertEqual(result.offset, (0.0, 0.0))
        self.assertFalse(result.improved)
        self.assertIsNone(result.correspondence.per_owner[0].support_fraction)

    def test_empty_inputs_are_stable(self):
        result = align_tokens([], [], steps=())
        self.assertEqual((result.offset, result.cost, result.evaluations), ((0.0, 0.0), 0.0, 1))

    def test_invalid_step_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "steps"):
            align_tokens([], [], steps=(2, 0))


if __name__ == "__main__":
    unittest.main()
