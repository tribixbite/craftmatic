"""Mould equivalence: what universal CAD proves, and what it refuses to prove.

Every assertion here is about real parts, because the claim is about geometry
and a stand-in would prove only that the comparison compares.
"""
import unittest
from pathlib import Path

from placement_mould_equivalence import ambiguous_classes, compare, looks_printed

SLOTS = Path('output/pdf-placement-diagnosis/41601-slots-color/slot-assignment.json')


class SelfEquivalenceTest(unittest.TestCase):
    def test_a_part_is_equivalent_to_itself_in_every_representation(self):
        record = compare(['3005', '3005'])
        self.assertTrue(record['bounds_agree'] and record['voxels_agree']
                        and record['cores_agree'] and record['connectors_agree'])
        self.assertTrue(record['placement_equivalent'])
        self.assertEqual(record['canonical'], '3005')


class VariantClassTest(unittest.TestCase):
    def test_the_jumper_variants_share_an_exact_bounding_box_and_nothing_else(self):
        record = compare(['15573', '3794a', '3794b'])
        # The memo's claim, measured: the outsides agree to the LDU exactly.
        self.assertTrue(record['bounds_agree'])
        self.assertEqual(record['bounds_max_difference_ldu'], 0.0)
        # And the pipeline's own predicates do not agree, which is what stops the
        # class from being one search candidate.
        self.assertFalse(record['voxels_agree'])
        self.assertFalse(record['connectors_agree'])
        self.assertFalse(record['placement_equivalent'])
        self.assertTrue(record['shares_capacity_pool'])
        self.assertEqual(record['voxel_symmetric_differences'][0], 0)
        self.assertGreater(max(record['voxel_symmetric_differences']), 0)

    def test_the_round_plate_variants_reach_the_same_disposition(self):
        record = compare(['4032a', '4032b'])
        self.assertTrue(record['bounds_agree'])
        self.assertFalse(record['placement_equivalent'])
        self.assertTrue(record['shares_capacity_pool'])
        self.assertIn('One capacity pool only', record['disposition'])

    def test_a_printed_mould_is_never_pooled_with_its_plain_one(self):
        self.assertTrue(looks_printed('3069bpb632'))
        self.assertFalse(looks_printed('3069b'))
        record = compare(['3069b', '3069bpb632'])
        self.assertTrue(record['printed_member'])
        self.assertFalse(record['shares_capacity_pool'])
        self.assertFalse(record['placement_equivalent'])

    def test_two_genuinely_different_parts_are_refused_on_their_bounds(self):
        record = compare(['3005', '3003'])
        self.assertFalse(record['bounds_agree'])
        self.assertFalse(record['shares_capacity_pool'])
        self.assertIn('Not one piece', record['disposition'])


class SlotSweepTest(unittest.TestCase):
    @unittest.skipUnless(SLOTS.is_file(), 'requires the 41601 inventory artifacts')
    def test_the_fixture_has_exactly_two_classes_and_four_pieces(self):
        record = ambiguous_classes(SLOTS)
        self.assertEqual([entry['members'] for entry in record['classes']],
                         [['15573', '3794a', '3794b'], ['4032a', '4032b']])
        self.assertEqual((record['pieces_in_ambiguous_slots'], record['recoverable_pieces'],
                          record['search_identical_pieces']), (4, 4, 0))
        # Both classes are single-colour, so pooling them settles the count and
        # the colour together.
        self.assertTrue(all(entry['colors_agree'] for entry in record['classes']))


if __name__ == '__main__':
    unittest.main()
