"""A chain A/B is only as trustworthy as how its exact ties are broken.

`placement_score_ties` counts exact top-score ties among genuinely different
assemblies on 7 of 13 driven 40377 pages and 15 of 27 on 41624, up to twelve
ways. Within a tie the correct-part counts are equal - it is variance, not bias -
but each fork sends the chain down a different camera path, and round six's
parent-budget chain diverged from round five at page 22 for exactly that reason.

The property under test is that the tie-break is a function of the POSE, so two
configurations that both hold a tied pair resolve it the same way however the
bank happened to order them.
"""
import numpy as np
import pytest

from placement_layer_beam import search_beam
from placement_multi_shape_search import pose_tie_ranks


def placement(part, color, x):
    T = np.eye(4)
    T[0, 3] = x
    return dict(key=(part, color), pose_index=0, part=part, color=color,
                items=[(part, color, T)])


def test_ranks_follow_the_pose_not_the_position():
    forward = [placement('A', 15, 30.), placement('A', 15, 10.), placement('A', 15, 20.)]
    reversed_bank = list(reversed(forward))
    ranks = pose_tie_ranks(forward)
    other = pose_tie_ranks(reversed_bank)
    # The same three placements in either bank order must give the same
    # ordering OF THE PLACEMENTS, which is what a stable index sort cannot do.
    assert [forward[i]['items'][0][2][0, 3] for i in np.argsort(ranks)] == [10., 20., 30.]
    assert [reversed_bank[i]['items'][0][2][0, 3] for i in np.argsort(other)] == [10., 20., 30.]


def test_ranks_are_a_permutation():
    rows = [placement('B', 4, 5.), placement('A', 15, 5.), placement('A', 15, 1.)]
    assert sorted(pose_tie_ranks(rows).tolist()) == [0, 1, 2]


def test_key_orders_before_pose():
    rows = [placement('B', 4, 0.), placement('A', 15, 99.)]
    ranks = pose_tie_ranks(rows)
    assert ranks[1] < ranks[0]


def flat_bank(count, height=4, width=4):
    """`count` candidates that all paint the same pixels with the same class.

    Every one of them scores identically, so which survives is decided purely by
    the tie-break - which is the situation being tested.
    """
    target = np.ones((height, width), np.uint8)
    base_depth = np.full((height, width), -np.inf)
    base_labels = np.zeros((height, width), np.uint8)
    depths = np.zeros((count, height, width))
    labels = np.ones((count, height, width), np.uint8)
    return base_depth, base_labels, depths, labels, target


def test_the_beam_resolves_a_total_tie_by_the_supplied_rank():
    base_depth, base_labels, depths, labels, target = flat_bank(4)
    keys = [('A', 15)] * 4
    quotas = {('A', 15): 1}
    # Rank 0 is candidate 3, so a pose-ranked beam must retain it and an
    # index-ranked one must retain candidate 0.
    ranks = np.array([3, 2, 1, 0], np.int64)
    by_pose = search_beam(base_depth, base_labels, depths, labels, keys, quotas, target,
                          base_supported=range(4), beam=1, top_k=1, improve_rounds=0,
                          tie_ranks=ranks)
    by_index = search_beam(base_depth, base_labels, depths, labels, keys, quotas, target,
                           base_supported=range(4), beam=1, top_k=1, improve_rounds=0)
    assert by_pose['candidates'][0]['indices'] == (3,)
    assert by_index['candidates'][0]['indices'] == (0,)
    assert by_pose['candidates'][0]['score'] == by_index['candidates'][0]['score']


def test_the_ranked_beam_is_unchanged_when_nothing_ties():
    """A rank must only ever decide a tie, never outrank a real score gap."""
    base_depth, base_labels, depths, labels, target = flat_bank(3)
    labels[0] = 0                       # candidate 0 explains nothing
    keys = [('A', 15)] * 3
    quotas = {('A', 15): 1}
    ranks = np.array([0, 2, 1], np.int64)
    ranked = search_beam(base_depth, base_labels, depths, labels, keys, quotas, target,
                         base_supported=range(3), beam=1, top_k=1, improve_rounds=0,
                         tie_ranks=ranks)
    assert ranked['candidates'][0]['indices'] == (2,)


@pytest.mark.parametrize('count', [2, 5])
def test_a_pose_rank_makes_the_result_independent_of_bank_order(count):
    """The same candidates in a shuffled bank must select the same POSE."""
    base_depth, base_labels, depths, labels, target = flat_bank(count)
    keys = [('A', 15)] * count
    quotas = {('A', 15): 1}
    poses = [placement('A', 15, float(x)) for x in range(count)]
    picks = set()
    for order in ([*range(count)], [*reversed(range(count))]):
        shuffled = [poses[i] for i in order]
        chosen = search_beam(base_depth, base_labels, depths[list(order)],
                             labels[list(order)], keys, quotas, target,
                             base_supported=range(count), beam=1, top_k=1, improve_rounds=0,
                             tie_ranks=pose_tie_ranks(shuffled))['candidates'][0]['indices'][0]
        picks.add(float(shuffled[chosen]['items'][0][2][0, 3]))
    assert len(picks) == 1
