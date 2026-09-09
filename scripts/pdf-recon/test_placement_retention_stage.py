"""Offline tests for the retention-stage mechanism measurements.

Every function tested here is pure: no GPU, no PDF, no reference model. The
run-artifact reconstruction in `placement_retention_stage` is self-checking at
runtime instead (it reproduces the recorded bank size and the recorded coarse
score, and raises otherwise), which is the check that cannot be written offline.
"""
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from placement_retention_stage import (assembly_diversity, classify_mechanism, connected,
                                       own_agreement, plateau_stats, rank_within, support_stage,
                                       swap_sets, window_indices)


class PlateauTest(unittest.TestCase):
    def test_counts_the_exact_zero_delta_band(self):
        base = 0.5
        scores = np.array([0.5, 0.5, 0.5, 0.6, 0.4])
        stats = plateau_stats(scores, base)
        self.assertEqual(stats['candidates'], 5)
        self.assertEqual(stats['zero_delta'], 3)
        self.assertAlmostEqual(stats['zero_delta_fraction'], 0.6)
        self.assertEqual(stats['distinct_scores'], 3)
        self.assertAlmostEqual(stats['best_score'], 0.6)
        self.assertAlmostEqual(stats['best_over_base'], 0.1)
        self.assertAlmostEqual(stats['span'], 0.2)
        self.assertEqual(stats['best_score_ties'], 1)

    def test_infinities_are_excluded_rather_than_counted(self):
        stats = plateau_stats(np.array([1., -np.inf, 1., 2.]), 1.)
        self.assertEqual(stats['candidates'], 3)
        self.assertEqual(stats['zero_delta'], 2)

    def test_empty_input_is_an_error_not_a_zero(self):
        with self.assertRaises(ValueError):
            plateau_stats(np.zeros(0), 0.)


class RankTest(unittest.TestCase):
    def test_ties_break_on_index_exactly_as_a_stable_sort_does(self):
        scores = np.array([0.3, 0.3, 0.3, 0.9])
        self.assertEqual(rank_within(scores, 3), 0)
        self.assertEqual(rank_within(scores, 0), 1)
        self.assertEqual(rank_within(scores, 1), 2)
        self.assertEqual(rank_within(scores, 2), 3)

    def test_key_mask_ranks_inside_one_quota_key_only(self):
        scores = np.array([0.9, 0.1, 0.5, 0.4])
        mask = np.array([False, True, True, True])
        self.assertEqual(rank_within(scores, 2, mask), 0)
        self.assertEqual(rank_within(scores, 3, mask), 1)
        self.assertEqual(rank_within(scores, 1, mask), 2)


class SupportTest(unittest.TestCase):
    def setUp(self):
        # 0 anchored; 1 hangs off 0; 2 hangs off 1; 3 is witnessed by nothing.
        self.adjacency = [{1}, {0, 2}, {1}, set()]

    def test_anchored_placement_is_zero_hops(self):
        stage = support_stage(0, {0}, self.adjacency)
        self.assertTrue(stage['anchored'])
        self.assertEqual(stage['hops_to_anchor'], 0)

    def test_second_layer_pose_reports_its_hop_count(self):
        self.assertEqual(support_stage(1, {0}, self.adjacency)['hops_to_anchor'], 1)
        self.assertEqual(support_stage(2, {0}, self.adjacency)['hops_to_anchor'], 2)

    def test_a_pose_with_no_witnessed_path_is_unreachable(self):
        stage = support_stage(3, {0}, self.adjacency)
        self.assertFalse(stage['support_reachable'])
        self.assertIsNone(stage['hops_to_anchor'])

    def test_connectivity_requires_an_anchor_in_the_set_itself(self):
        self.assertTrue(connected((0, 1), {0}, self.adjacency))
        self.assertFalse(connected((1, 2), {0}, self.adjacency))


class SwapTest(unittest.TestCase):
    def test_only_same_key_members_may_be_displaced(self):
        keys = ['a', 'a', 'b', 'a']
        self.assertEqual(sorted(swap_sets([0, 2], 3, keys)), [(2, 3)])

    def test_every_same_key_slot_yields_one_exchange(self):
        keys = ['a', 'a', 'a', 'b']
        self.assertEqual(sorted(swap_sets([0, 1, 3], 2, keys)), [(0, 2, 3), (1, 2, 3)])

    def test_a_target_already_present_needs_no_exchange(self):
        self.assertEqual(swap_sets([0, 1], 0, ['a', 'a']), [])


class DiversityTest(unittest.TestCase):
    def test_a_frozen_key_is_one_pose_across_every_retained_assembly(self):
        keys = {0: 'a', 1: 'a', 2: 'a', 9: 'b'}
        report = assembly_diversity([[9, 0], [9, 1], [9, 2]], keys)
        self.assertEqual(report['assemblies'], 3)
        self.assertEqual(report['distinct_poses_per_key'], {'a': 3, 'b': 1})
        self.assertEqual(report['frozen_keys'], ['b'])
        self.assertEqual(report['hamming_from_best'], {'0': 1, '1': 2})

    def test_no_assemblies_reports_no_diversity_rather_than_failing(self):
        self.assertEqual(assembly_diversity([], {})['assemblies'], 0)


class OwnAgreementTest(unittest.TestCase):
    def test_counts_each_candidates_own_matching_pixels(self):
        # candidate 0 paints three pixels, two matching; candidate 1 paints two,
        # neither matching; candidate 2 paints nothing.
        segments = np.array([0, 0, 0, 1, 1])
        labels = np.array([3, 3, 4, 5, 6])
        target = np.array([3, 3, 9, 9, 9])
        agreement = own_agreement(segments, labels, target, 3)
        self.assertEqual(list(agreement), [2., 0., 0.])

    def test_it_is_independent_of_what_else_is_placed(self):
        # The whole point: the statistic reads only the candidate's own pixels,
        # so no already-placed piece can flatten it the way a composite delta is
        # flattened. Same arrays, evaluated twice, must give the same answer.
        segments = np.array([0, 1, 1])
        labels = np.array([2, 2, 2])
        target = np.array([2, 2, 7])
        first = own_agreement(segments, labels, target, 2)
        second = own_agreement(segments, labels, target, 2)
        self.assertEqual(list(first), list(second))
        self.assertEqual(list(first), [1., 1.])


class WindowTest(unittest.TestCase):
    keys = [('a', 1), ('a', 1), ('a', 1), ('b', 1)]

    def test_window_holds_only_same_key_candidates(self):
        window = window_indices(np.array([9., 8., 7., 100.]), self.keys, [0], 0, 4)
        self.assertEqual(window, [1, 2])

    def test_window_excludes_placements_already_chosen(self):
        window = window_indices(np.array([9., 8., 7., 0.]), self.keys, [1], 1, 4)
        self.assertEqual(window, [0, 2])

    def test_width_caps_the_render_budget(self):
        self.assertEqual(window_indices(np.array([9., 8., 7., 0.]), self.keys, [], 0, 2),
                         [0, 1])

    def test_a_flat_statistic_orders_the_window_by_index_alone(self):
        # This is the shipped failure in miniature: when every candidate ties,
        # the window is the first `width` bank indices and nothing else.
        self.assertEqual(window_indices(np.zeros(4), self.keys, [], 0, 2), [0, 1])


class MechanismTest(unittest.TestCase):
    def test_support_is_named_only_when_no_placement_is_reachable(self):
        probes = [dict(support_reachable=False, any_legal_assembly=False,
                       best_native_delta=None, on_plateau=False)]
        self.assertEqual(classify_mechanism(probes), 'support_unreachable')

    def test_illegality_is_named_when_no_quota_preserving_edit_exists(self):
        probes = [dict(support_reachable=True, any_legal_assembly=False,
                       best_native_delta=None, on_plateau=False)]
        self.assertEqual(classify_mechanism(probes), 'no_legal_assembly')

    def test_a_better_legal_assembly_names_the_search(self):
        probes = [dict(support_reachable=True, any_legal_assembly=True,
                       best_native_delta=1e-3, on_plateau=True)]
        self.assertEqual(classify_mechanism(probes),
                         'search_missed_a_better_assembly')

    def test_a_worse_legal_assembly_names_the_objective(self):
        probes = [dict(support_reachable=True, any_legal_assembly=True,
                       best_native_delta=-1e-3, on_plateau=False)]
        self.assertEqual(classify_mechanism(probes),
                         'objective_prefers_another_pose')

    def test_the_plateau_is_reported_when_the_objective_is_indifferent(self):
        probes = [dict(support_reachable=True, any_legal_assembly=True,
                       best_native_delta=-1e-9, on_plateau=True)]
        self.assertEqual(classify_mechanism(probes),
                         'objective_prefers_another_pose_target_on_plateau')


if __name__ == '__main__':
    unittest.main()
