"""Inventory capacity: the pool, the draw-down audit, and the near-tie ranker.

The two negative results are tested as deliberately as the positive ones: the
audit must find nothing on a fixture whose allocation is exact, and the ranker
must leave a candidate outside its band alone however capacious it is.
"""
import json
import tempfile
import unittest
from collections import Counter
from pathlib import Path

from placement_capacity import (audit, capacity_of_body, format_key, page_allocations,
                                parse_key, rank, required_after, slot_pool)

SLOTS = Path('output/pdf-placement-diagnosis/41601-slots-color/slot-assignment.json')
ALLOCATION = Path('output/pdf-placement-diagnosis/41601-allocation-v1/global-assignment.json')
SCOPE = [2, 3, 4, 6, 7, 9, 11, 12, 13, 14, 15, 16, 18, 20, 22, 23, 24, 25, 27]
EQUIVALENCE = {'3794a': '15573', '3794b': '15573', '4032b': '4032a'}


def slots(*records):
    return dict(pdf='x', pdf_sha256='y', truth_used=False, runtime_vlm_calls=0, pdf_only=True,
                slots=[dict(inventory_record=index, element_id=str(index), qty=qty,
                            choices=[dict(part=part, color=str(color)) for part, color in choices])
                       for index, (qty, choices) in enumerate(records)])


def allocation(*rows):
    return dict(pdf='x', pdf_sha256='y', truth_used=False, runtime_vlm_calls=0, pdf_only=True,
                evidence=[dict(page=page, part=part, color=str(color), qty=qty)
                          for page, part, color, qty in rows])


class PoolTest(unittest.TestCase):
    def test_keys_round_trip_and_quantities_sum(self):
        self.assertEqual(parse_key(format_key('3069bpb632', 71)), ('3069bpb632', 71))
        record = slot_pool(slots((2, [('3005', 71)]), (3, [('3005', 71)]),
                                 (1, [('4032a', 25), ('4032b', 25)])))
        self.assertEqual(record['pool'], {'3005:71': 5})
        self.assertEqual((record['pool_pieces'], record['ambiguous_pieces']), (5, 1))
        self.assertEqual(record['ambiguous_slots'][0]['choices'], [['4032a', 25], ['4032b', 25]])

    def test_an_equivalence_class_closes_the_ambiguous_pool(self):
        record = slot_pool(slots((1, [('4032a', 25), ('4032b', 25)])), EQUIVALENCE)
        self.assertEqual(record['pool'], {'4032a:25': 1})
        self.assertEqual(record['ambiguous_pieces'], 0)
        self.assertEqual(record['pooled_by_equivalence'], {'4032a:25': ['4032a', '4032b']})

    def test_a_class_spanning_two_colours_is_still_ambiguous(self):
        record = slot_pool(slots((1, [('4032a', 25), ('4032b', 71)])), EQUIVALENCE)
        self.assertEqual(record['pool'], {})
        self.assertEqual(record['ambiguous_pieces'], 1)

    def test_inventory_provenance_is_required(self):
        payload = slots((1, [('3005', 71)]))
        payload['truth_used'] = True
        with self.assertRaises(ValueError):
            slot_pool(payload)

    @unittest.skipUnless(SLOTS.is_file(), 'requires the 41601 inventory artifacts')
    def test_the_real_inventory_is_closed_only_by_the_mould_classes(self):
        bare = slot_pool(SLOTS)
        pooled = slot_pool(SLOTS, EQUIVALENCE)
        self.assertEqual((len(bare['pool']), bare['pool_pieces'], bare['ambiguous_pieces']),
                         (46, 104, 4))
        self.assertEqual((len(pooled['pool']), pooled['pool_pieces'],
                          pooled['ambiguous_pieces']), (48, 108, 0))


class AuditTest(unittest.TestCase):
    def test_an_overdrawn_pool_names_the_page_that_overdrew_it(self):
        pool = slot_pool(slots((2, [('4070', 72)])))
        pages = page_allocations(allocation((3, '4070', 72, 1), (4, '4070', 72, 2)))
        record = audit(pool, pages, [3, 4])
        self.assertEqual([(row['page'], row['required'], row['available'])
                          for row in record['deficits']], [(4, 2, 1)])
        self.assertEqual(record['slack'], {'4070:72': -1})

    def test_a_key_in_no_slot_is_a_deficit_rather_than_a_silent_pass(self):
        pool = slot_pool(slots((2, [('4070', 72)])))
        pages = page_allocations(allocation((3, '3005', 71, 1)))
        record = audit(pool, pages, [3])
        self.assertEqual(len(record['deficits']), 1)
        self.assertIn('no unambiguous inventory slot', record['deficits'][0]['reason'])

    def test_an_equivalence_class_makes_a_variant_draw_from_the_pooled_key(self):
        pool = slot_pool(slots((1, [('4032a', 25), ('4032b', 25)])), EQUIVALENCE)
        pages = page_allocations(allocation((10, '4032b', 25, 1)))
        self.assertEqual(audit(pool, pages, [10], EQUIVALENCE)['deficits'], [])
        self.assertEqual(audit(pool, pages, [10])['deficits'][0]['available'], 0)

    @unittest.skipUnless(SLOTS.is_file() and ALLOCATION.is_file(),
                         'requires the 41601 allocation artifacts')
    def test_the_real_allocation_is_exact_so_the_audit_finds_nothing(self):
        record = audit(slot_pool(SLOTS), page_allocations(ALLOCATION), SCOPE)
        self.assertEqual(record['deficits'], [])
        # 34 of 46 keys have their whole pool allocated inside the scope, which is
        # why a count term cannot rank two assemblies of the same page.
        self.assertEqual((record['keys'], record['exhausted_keys'],
                          record['allocated_pieces']), (46, 34, 83))


class LookAheadTest(unittest.TestCase):
    @unittest.skipUnless(ALLOCATION.is_file(), 'requires universal CAD and the allocation')
    def test_a_body_reports_mates_and_non_chaining_locations_per_key(self):
        from placement_arrow_contacts import read_items
        body = read_items(Path('output/pdf-placement-beam/41601-r8-construction/construction')
                          / 'beam_00.ldr')
        record = capacity_of_body(body, Counter({('3005', 71): 1}))
        row = record['rows'][0]
        self.assertEqual(row['part'], '3005')
        self.assertGreater(row['base_attached_mates'], 0)
        # Locations are the one-stud lattice cells the mates occupy, so they never
        # exceed the mate count and never chain into a single region.
        self.assertLessEqual(row['distinct_locations'], row['base_attached_mates'])
        self.assertEqual(row['slack'], row['distinct_locations'] - 1)

    def test_no_requirement_is_not_a_deficit(self):
        record = capacity_of_body([], Counter())
        self.assertEqual((record['deficient_keys'], record['total_deficit']), (0, 0))
        self.assertIsNone(record['min_slack'])

    def test_required_after_reads_only_the_later_pages_of_the_scope(self):
        pages = page_allocations(allocation((2, '3005', 71, 4), (3, '4070', 72, 4),
                                            (4, '4070', 72, 4)))
        self.assertEqual(required_after(pages, [2, 3, 4], after_page=2),
                         Counter({('4070', 72): 8}))
        self.assertEqual(required_after(pages, [2, 3, 4], after_page=4), Counter())


class RankTest(unittest.TestCase):
    def candidate(self, label, score, deficient=0, deficit=0, slack=5):
        return dict(label=label, score=score,
                    capacity=dict(deficient_keys=deficient, total_deficit=deficit,
                                  min_slack=slack))

    def test_capacity_reorders_an_exact_tie(self):
        rows = [self.candidate('a', 0.5, deficient=2, deficit=3),
                self.candidate('b', 0.5, deficient=0, slack=9)]
        ordered, summary = rank(rows, 0.0)
        self.assertEqual([row['label'] for row in ordered], ['b', 'a'])
        self.assertEqual((summary['in_band'], summary['selected_after']), (2, 'b'))

    def test_a_candidate_outside_the_band_never_moves(self):
        rows = [self.candidate('a', 0.65, deficient=4, deficit=9),
                self.candidate('b', 0.60, deficient=0, slack=40)]
        ordered, summary = rank(rows, 0.014)
        self.assertEqual([row['label'] for row in ordered], ['a', 'b'])
        self.assertEqual((summary['in_band'], summary['reordered']), (1, 0))
        # The same pair inside a wide enough band does reorder, and the band it
        # needed is the number the report has to state.
        self.assertEqual([row['label'] for row in rank(rows, 0.06)[0]], ['b', 'a'])

    def test_equal_capacity_inside_the_band_keeps_the_objective_order(self):
        rows = [self.candidate('a', 0.5), self.candidate('b', 0.49)]
        ordered, _ = rank(rows, 0.02)
        self.assertEqual([row['label'] for row in ordered], ['a', 'b'])

    def test_an_empty_candidate_set_is_not_an_error(self):
        self.assertEqual(rank([], 0.01), ([], dict(band=0.01, reordered=0, in_band=0)))


class ProbeShapeTest(unittest.TestCase):
    def test_a_probe_directory_needs_truth_free_provenance(self):
        from placement_capacity import probe_directory
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / 'results.json').write_text(json.dumps(dict(truth_used=True, results=[])))
            with self.assertRaises(ValueError):
                probe_directory(path, Counter({('3005', 71): 1}))


if __name__ == '__main__':
    unittest.main()
