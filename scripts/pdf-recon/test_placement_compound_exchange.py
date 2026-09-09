"""Offline tests for the two-placement exchange moves.

Everything under test is pure index arithmetic over a placement bank, a witnessed
support adjacency and a collision predicate, so these run with no GPU, no PDF and
no reference model. The measured cases they encode are round seven's two
structural loss classes: a closure pose that is legal only together with the
placement witnessing its support, and a pose that collides with the piece already
standing in its place.
"""
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from placement_compound_exchange import (collision_partners, compound_assemblies,
                                         connectivity_partners, double_swap_sets, key_pair,
                                         legal, ordered_replacement, rank_options)


def never(a, b):
    return False


def all_connected(group):
    return True


class DoubleSwapTest(unittest.TestCase):
    def test_the_displaced_pair_must_carry_the_same_key_multiset(self):
        # keys: 0,1 are 'a'; 2,3 are 'b'. Selected holds one of each.
        keys = ['a', 'a', 'b', 'b']
        self.assertEqual(double_swap_sets([0, 2], 1, 3, keys), [(1, 3)])

    def test_a_pair_of_the_same_key_needs_two_of_that_key_in_the_assembly(self):
        keys = ['a', 'a', 'a', 'a', 'b']
        self.assertEqual(double_swap_sets([0, 1, 4], 2, 3, keys), [(2, 3, 4)])
        # Quota one for 'a': the same-key pair can displace nothing legal.
        self.assertEqual(double_swap_sets([0, 4], 2, 3, keys), [])

    def test_every_matching_displaced_pair_is_offered_not_only_the_first(self):
        keys = ['a', 'a', 'a', 'b', 'b']
        # Selected 0,1 ('a','a') and 3 ('b'); incoming 2 ('a') with partner 4 ('b')
        # can displace ('a','b') two ways.
        self.assertEqual(double_swap_sets([0, 1, 3], 2, 4, keys), [(0, 2, 4), (1, 2, 4)])

    def test_a_member_already_present_yields_nothing(self):
        keys = ['a', 'a', 'b', 'b']
        self.assertEqual(double_swap_sets([0, 2], 0, 3, keys), [])
        self.assertEqual(double_swap_sets([0, 2], 1, 2, keys), [])
        self.assertEqual(double_swap_sets([0, 2], 1, 1, keys), [])

    def test_the_result_is_sorted_and_deduplicated(self):
        keys = ['a', 'b', 'a', 'b']
        sets = double_swap_sets([0, 1], 2, 3, keys)
        self.assertEqual(sets, [(2, 3)])
        self.assertEqual(sets, sorted(set(sets)))

    def test_key_pair_is_order_independent(self):
        keys = [('3023b', 191), ('3069b', 1)]
        self.assertEqual(key_pair(keys, 0, 1), key_pair(keys, 1, 0))


class ConnectivityPartnerTest(unittest.TestCase):
    # 0 anchored, 1 witnessed by 0, 2 witnessed by 1 only: 2 alone disconnects.
    adjacency = [{1}, {0, 2}, {1}, set()]

    def test_the_partner_set_is_exactly_the_witnessed_neighbourhood(self):
        partners = connectivity_partners(2, [0], self.adjacency, np.array([0., 5., 0., 9.]), 4)
        self.assertEqual(partners, [1])

    def test_a_neighbour_already_placed_is_not_offered_again(self):
        self.assertEqual(connectivity_partners(2, [0, 1], self.adjacency,
                                               np.zeros(4), 4), [])

    def test_partners_come_back_best_first_under_the_statistic(self):
        adjacency = [{1, 2, 3}, {0}, {0}, {0}]
        statistic = np.array([0., 1., 7., 3.])
        self.assertEqual(connectivity_partners(0, [], adjacency, statistic, 3), [2, 3, 1])

    def test_the_width_bounds_the_partner_set(self):
        adjacency = [{1, 2, 3}, {0}, {0}, {0}]
        self.assertEqual(connectivity_partners(0, [], adjacency, np.array([0., 1., 7., 3.]), 1),
                         [2])
        self.assertEqual(connectivity_partners(0, [], adjacency, np.zeros(4), 0), [])

    def test_a_supplied_tie_rank_decides_an_exact_statistic_tie(self):
        adjacency = [{1, 2}, {0}, {0}]
        statistic = np.array([0., 4., 4.])
        self.assertEqual(connectivity_partners(0, [], adjacency, statistic, 2), [1, 2])
        self.assertEqual(connectivity_partners(0, [], adjacency, statistic, 2,
                                               tie_ranks=np.array([0, 9, 1])), [2, 1])


class CollisionPartnerTest(unittest.TestCase):
    keys = ['a', 'b', 'b', 'b']

    def collides(self, pairs):
        pairs = {tuple(sorted(p)) for p in pairs}

        def conflict(a, b):
            return tuple(sorted((int(a), int(b)))) in pairs
        return conflict

    def test_no_blocker_means_no_compound_move_is_needed(self):
        partners, blockers = collision_partners(0, [1], self.keys, self.collides([]),
                                                np.zeros(4), 4)
        self.assertEqual((partners, blockers), ([], []))

    def test_a_partner_carries_the_blockers_key_and_clears_the_incoming(self):
        # 0 collides with the placed 1; 2 also collides, 3 does not.
        conflict = self.collides([(0, 1), (0, 2)])
        partners, blockers = collision_partners(0, [1], self.keys, conflict,
                                                np.array([0., 0., 9., 5.]), 4)
        self.assertEqual(blockers, [1])
        self.assertEqual(partners, [3])

    def test_the_limit_stops_the_lazy_collision_probing(self):
        conflict = self.collides([(0, 1)])
        partners, _ = collision_partners(0, [1], self.keys, conflict,
                                         np.array([0., 0., 9., 5.]), 1)
        self.assertEqual(partners, [2])


class LegalityTest(unittest.TestCase):
    keys = ['a', 'a', 'b']

    def test_a_quota_violation_is_named_as_such(self):
        ok, reason = legal((0, 1), self.keys, {'a': 1, 'b': 1}, never, all_connected)
        self.assertEqual((ok, reason), (False, 'quota'))

    def test_a_collision_is_found_over_every_pair_not_only_the_new_ones(self):
        def conflict(a, b):
            return tuple(sorted((int(a), int(b)))) == (0, 2)
        ok, reason = legal((0, 2), self.keys, None, conflict, all_connected)
        self.assertEqual((ok, reason), (False, 'collision'))

    def test_a_disconnected_set_is_named_as_such(self):
        ok, reason = legal((0, 2), self.keys, None, never, lambda group: False)
        self.assertEqual((ok, reason), (False, 'connectivity'))

    def test_a_legal_set_reports_legal(self):
        self.assertEqual(legal((0, 2), self.keys, {'a': 1, 'b': 1}, never, all_connected),
                         (True, 'legal'))


class CompoundAssemblyTest(unittest.TestCase):
    """The two measured classes, reduced to their smallest reproductions."""

    def test_closure_parent_connectivity_recovers_a_one_hop_pose(self):
        # Bank: 0 anchored ('a') and placed, 1 an unrelated 'a', 2 the target
        # ('b') whose only witness is 3, 3 the witnessing 'a' (itself anchored -
        # which is what `hops_to_anchor == 1` means, measured over the screened
        # bank and not over the chosen assembly), 4 the placed 'b'.
        # Selected = (0, 4), quota one 'a' and one 'b'.
        keys = ['a', 'a', 'b', 'a', 'b']
        adjacency = [{4}, set(), {3}, {2}, {0}]
        anchored = {0, 3}

        def connected(group):
            wanted = set(int(i) for i in group)
            seen = wanted & anchored
            todo = list(seen)
            while todo:
                fresh = (adjacency[todo.pop()] & wanted) - seen
                seen.update(fresh)
                todo.extend(fresh)
            return seen == wanted

        # The one-swap the run can make is illegal: 2 has no witness in it.
        self.assertFalse(connected((0, 2)))
        self.assertTrue(connected((0, 4)))
        groups, report = compound_assemblies([0, 4], 2, keys, adjacency, never, connected,
                                             np.array([0., 0., 0., 1., 0.]), 4,
                                             mode='connectivity',
                                             quotas={'a': 1, 'b': 1})
        self.assertEqual(groups, [(2, 3)])
        self.assertEqual(report['connectivity_partners'], [3])
        self.assertEqual(report['legal'], 1)
        self.assertTrue(connected(groups[0]))

    def test_conflict_guided_double_exchange_replaces_the_blocker(self):
        # 2 ('b') is the target and collides with the placed 4 ('b')'s neighbour
        # 0 ('a'); the alternative 'a' is 1 and does not collide.
        keys = ['a', 'a', 'b', 'b', 'b']
        adjacency = [{1, 2, 3, 4}, {0, 2, 3, 4}, {0, 1}, {0, 1}, {0, 1}]

        def conflict(a, b):
            return tuple(sorted((int(a), int(b)))) in {(0, 2)}
        groups, report = compound_assemblies([0, 3], 2, keys, adjacency, conflict,
                                             all_connected, np.array([0., 5., 0., 0., 1.]), 4,
                                             mode='collision', quotas={'a': 1, 'b': 1})
        self.assertEqual(report['blockers'], [0])
        self.assertEqual(report['collision_partners'], [1])
        self.assertEqual(groups, [(1, 2)])

    def test_an_enumerated_but_illegal_set_is_counted_rather_than_dropped(self):
        keys = ['a', 'a', 'b', 'b']
        adjacency = [{2, 3}, {2, 3}, {0, 1}, {0, 1}]
        groups, report = compound_assemblies([0, 3], 2, keys, adjacency, never,
                                             lambda group: False, np.zeros(4), 4,
                                             mode='connectivity')
        self.assertEqual(groups, [])
        self.assertEqual(report['rejected'], {'connectivity': 1})
        self.assertEqual(report['enumerated'], 1)

    def test_both_modes_offer_the_union_without_duplicating_an_assembly(self):
        keys = ['a', 'a', 'b', 'b']
        adjacency = [{2, 3}, {2, 3}, {0, 1}, {0, 1}]

        def conflict(a, b):
            return tuple(sorted((int(a), int(b)))) == (0, 2)
        groups, report = compound_assemblies([0, 3], 2, keys, adjacency, conflict,
                                             all_connected, np.zeros(4), 4, mode='both')
        self.assertEqual(groups, [(1, 2)])
        self.assertEqual(report['connectivity_partners'], [1])
        self.assertEqual(report['collision_partners'], [1])
        self.assertEqual(report['legal'], 1)

    def test_an_unknown_mode_is_an_error_not_a_silent_default(self):
        with self.assertRaises(ValueError):
            compound_assemblies([0], 1, ['a', 'a'], [set(), set()], never, all_connected,
                                np.zeros(2), 1, mode='parent')

    def test_the_move_is_deterministic_under_a_pose_tie_break(self):
        keys = ['a', 'a', 'a', 'b']
        adjacency = [{1, 2, 3}, {0, 3}, {0, 3}, {0, 1, 2}]
        statistic = np.array([0., 4., 4., 0.])
        first, _ = compound_assemblies([0, 3], 1, keys, adjacency, never, all_connected,
                                       statistic, 1, mode='connectivity',
                                       tie_ranks=np.array([3, 2, 1, 0]))
        second, _ = compound_assemblies([0, 3], 1, keys, adjacency, never, all_connected,
                                        statistic, 1, mode='connectivity',
                                        tie_ranks=np.array([3, 2, 1, 0]))
        self.assertEqual(first, second)


class OrderedReplacementTest(unittest.TestCase):
    """Slot order is load-bearing: it decides ties between equal improvements."""

    keys = ['a', 'b', 'c', 'a', 'b']

    def test_each_displaced_slot_receives_the_incoming_of_its_own_key(self):
        self.assertEqual(ordered_replacement([0, 1, 2], (2, 3, 4), self.keys), [3, 4, 2])

    def test_an_untouched_slot_keeps_its_position(self):
        self.assertEqual(ordered_replacement([0, 1, 2], (0, 2, 4), self.keys), [0, 4, 2])

    def test_a_non_quota_preserving_group_is_an_error_not_a_guess(self):
        with self.assertRaises(ValueError):
            ordered_replacement([0, 1], (0, 2), self.keys)

    def test_the_result_is_a_permutation_of_the_group(self):
        out = ordered_replacement([0, 1, 2], (2, 3, 4), self.keys)
        self.assertEqual(sorted(out), [2, 3, 4])


class RankOptionTest(unittest.TestCase):
    def test_without_tie_ranks_an_exact_tie_falls_to_the_index(self):
        self.assertEqual(rank_options([2, 1, 0], np.array([5., 5., 5.])), [0, 1, 2])

    def test_with_tie_ranks_the_pose_rank_decides_instead(self):
        self.assertEqual(rank_options([2, 1, 0], np.array([5., 5., 5.]),
                                      tie_ranks=np.array([2, 0, 1])), [1, 2, 0])


if __name__ == '__main__':
    unittest.main(verbosity=2)
