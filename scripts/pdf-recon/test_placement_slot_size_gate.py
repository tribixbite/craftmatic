import math
import unittest

from placement_slot_size_gate import violations


class Library:
    """A stand-in part library; the gate only ever asks for bounding boxes."""


DIAGONALS = {'3005': 20.0, '3023b': 40.0, '3031': 80.0, '3022': 40.0}


def cache():
    return {part: value for part, value in DIAGONALS.items()}


def row(page, part, box, slot=0):
    return dict(page=page, part=part, color=71, inventory_slot=slot, bbox=list(box), score=0.9)


class SizeConsistency(unittest.TestCase):
    """One page draws its PLI at one scale, so its callouts must agree."""

    def scene(self, plate='3031'):
        # A page whose scale is 1.0: every crop diagonal equals the part's own.
        return [row(2, '3005', [0, 0, 12, 16]),          # diagonal 20
                row(2, '3023b', [0, 0, 24, 32], 1),      # diagonal 40
                row(2, plate, [0, 0, 48, 64], 2)]        # diagonal 80

    def test_a_consistent_page_flags_nothing(self):
        flagged, detail = violations(self.scene(), Library(), cache())
        self.assertEqual(flagged, [])
        self.assertLess(max(entry['log_deviation'] for entry in detail), 1e-9)

    def test_a_part_half_the_size_of_its_crop_is_flagged(self):
        # The same 48x64 crop read as a 2x2 plate implies twice the page scale.
        flagged, _ = violations(self.scene('3022'), Library(), cache())
        self.assertEqual([entry['part'] for entry in flagged], ['3022'])
        self.assertGreater(flagged[0]['log_deviation'], math.log(2) - 1e-6)

    def test_a_page_with_too_few_callouts_is_skipped_not_guessed(self):
        rows = [row(2, '3005', [0, 0, 12, 16]), row(2, '3022', [0, 0, 48, 64], 1)]
        flagged, detail = violations(rows, Library(), cache(), min_rows=3)
        self.assertEqual(flagged, [])
        self.assertEqual(detail, [])

    def test_pages_are_scored_independently(self):
        # A second page at half the scale is not a violation of anything.
        rows = self.scene() + [row(5, '3005', [0, 0, 6, 8], 3),
                               row(5, '3023b', [0, 0, 12, 16], 4),
                               row(5, '3031', [0, 0, 24, 32], 5)]
        flagged, detail = violations(rows, Library(), cache())
        self.assertEqual(flagged, [])
        self.assertEqual(len({round(entry['page_median'], 6) for entry in detail}), 2)


if __name__ == '__main__':
    unittest.main()
