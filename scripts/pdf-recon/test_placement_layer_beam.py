"""Offline checks for the layer beam search."""
import numpy as np
import pytest

from placement_layer_beam import LayerComposite, search_beam


def layer(shape, pixels, value):
    label = np.zeros(shape, np.uint8)
    depth = np.full(shape, -np.inf)
    for y, x in pixels:
        label[y, x] = value
        depth[y, x] = 0.
    return depth, label


def bank(shape, specs):
    depths, labels = zip(*[layer(shape, pixels, value) for pixels, value in specs])
    return np.stack(depths), np.stack(labels)


SHAPE = (4, 4)


def empty_base(shape=SHAPE):
    return np.full(shape, -np.inf), np.zeros(shape, np.uint8)


def test_finds_the_exact_cover_of_a_two_part_target():
    target = np.zeros(SHAPE, np.uint8)
    target[0, 0] = 1
    target[3, 3] = 2
    depths, labels = bank(SHAPE, [([(0, 0)], 1), ([(3, 3)], 2), ([(1, 1)], 1)])
    base_depth, base_labels = empty_base()
    result = search_beam(base_depth, base_labels, depths, labels,
                         [('A', 15), ('B', 4), ('A', 15)],
                         {('A', 15): 1, ('B', 4): 1}, target, base_supported=(0, 1, 2))
    assert result['indices'] == (0, 1)
    assert result['score'] == pytest.approx(1.0)


def test_respects_the_exact_quota_per_key():
    target = np.zeros(SHAPE, np.uint8)
    target[0, :2] = 1
    depths, labels = bank(SHAPE, [([(0, 0)], 1), ([(0, 1)], 1), ([(1, 0)], 1)])
    base_depth, base_labels = empty_base()
    result = search_beam(base_depth, base_labels, depths, labels,
                         [('A', 15)] * 3, {('A', 15): 2}, target, base_supported=(0, 1, 2))
    assert len(result['indices']) == 2
    assert set(result['indices']) == {0, 1}


def test_disconnected_candidates_are_rejected():
    target = np.zeros(SHAPE, np.uint8)
    target[0, 0] = 1
    target[3, 3] = 1
    depths, labels = bank(SHAPE, [([(0, 0)], 1), ([(3, 3)], 1)])
    base_depth, base_labels = empty_base()
    # Only candidate 0 touches the body and there is no support edge between them.
    result = search_beam(base_depth, base_labels, depths, labels,
                         [('A', 15)] * 2, {('A', 15): 2}, target, base_supported=(0,))
    assert result['indices'] is None
    assert result['complete_states'] == 0
    # The same bank succeeds once the support edge is witnessed.
    joined = search_beam(base_depth, base_labels, depths, labels,
                         [('A', 15)] * 2, {('A', 15): 2}, target,
                         base_supported=(0,), support_edges=[(0, 1)])
    assert joined['indices'] == (0, 1)


def test_collision_conflicts_exclude_pairs():
    target = np.zeros(SHAPE, np.uint8)
    target[0, :2] = 1
    depths, labels = bank(SHAPE, [([(0, 0)], 1), ([(0, 1)], 1), ([(2, 2)], 1)])
    base_depth, base_labels = empty_base()
    result = search_beam(base_depth, base_labels, depths, labels,
                         [('A', 15)] * 3, {('A', 15): 2}, target, base_supported=(0, 1, 2),
                         conflict_test=lambda i, j: {i, j} == {0, 1})
    assert set(result['indices']) != {0, 1}
    assert result['complete_states'] >= 1


def test_scores_use_the_real_depth_composite_not_the_union_ranking():
    # Candidate 1 is nearer and hides candidate 0's only correct pixel.
    target = np.zeros(SHAPE, np.uint8)
    target[0, 0] = 1
    target[1, 1] = 2
    depths = np.stack([np.where(np.eye(4) > 0, 0., -np.inf),
                       np.full(SHAPE, 5.)])
    labels = np.stack([np.where(np.eye(4) > 0, 1, 0).astype(np.uint8),
                       np.full(SHAPE, 2, np.uint8)])
    base_depth, base_labels = empty_base()
    result = search_beam(base_depth, base_labels, depths, labels, [('A', 15), ('B', 4)],
                         {('A', 15): 1, ('B', 4): 1}, target, base_supported=(0, 1))
    best = result['candidates'][0]
    assert best['indices'] == (0, 1)
    # Candidate 1 wins every pixel, so class 1 scores zero and class 2 scores
    # one correct pixel against fifteen false ones. A union ranking that
    # ignored occlusion would report a higher number.
    assert best['score'] == pytest.approx((0.0 + 1 / 16) / 2)


def test_beam_width_and_budget_are_reported():
    target = np.zeros(SHAPE, np.uint8)
    target[0, 0] = 1
    depths, labels = bank(SHAPE, [([(0, 0)], 1), ([(1, 1)], 1)])
    base_depth, base_labels = empty_base()
    result = search_beam(base_depth, base_labels, depths, labels, [('A', 15)] * 2,
                         {('A', 15): 1}, target, base_supported=(0, 1), beam=1)
    assert result['beam'] == 1
    assert result['search_exhaustive'] is False
    assert result['expansions'] >= 1


def test_invalid_inputs_are_rejected():
    target = np.zeros(SHAPE, np.uint8)
    target[0, 0] = 1
    depths, labels = bank(SHAPE, [([(0, 0)], 1)])
    base_depth, base_labels = empty_base()
    with pytest.raises(ValueError):
        search_beam(base_depth, base_labels, depths, labels, [('A', 15), ('A', 15)],
                    {('A', 15): 1}, target)
    with pytest.raises(ValueError):
        search_beam(base_depth, base_labels, depths, labels, [('A', 15)],
                    {('B', 15): 1}, target)
    with pytest.raises(ValueError):
        search_beam(base_depth, base_labels, depths, labels, [('A', 15)],
                    {('A', 15): 1}, np.zeros(SHAPE, np.uint8))


def test_body_pixels_are_not_credited_twice_to_a_candidate():
    # The body already explains the class-1 pixel correctly. A candidate that
    # merely repaints it must not outrank one that explains a new pixel.
    target = np.zeros(SHAPE, np.uint8)
    target[0, 0] = 1
    target[2, 2] = 1
    base_depth = np.where(np.arange(16).reshape(SHAPE) == 0, 0., -np.inf)
    base_labels = np.where(np.arange(16).reshape(SHAPE) == 0, 1, 0).astype(np.uint8)
    depths, labels = bank(SHAPE, [([(0, 0)], 1), ([(2, 2)], 1)])
    result = search_beam(base_depth, base_labels, depths, labels, [('A', 15)] * 2,
                         {('A', 15): 1}, target, base_supported=(0, 1))
    assert result['indices'] == (1,)


def test_exchange_recovers_from_a_greedy_first_choice():
    # Candidate 0 is the single most attractive layer, but the only exact cover
    # is {1, 2}. With a beam of one the expansion commits to 0; the
    # quota-preserving exchange pass must repair it.
    target = np.zeros(SHAPE, np.uint8)
    target[0, :2] = 1
    depths, labels = bank(SHAPE, [([(0, 0), (0, 1), (3, 3)], 1),
                                  ([(0, 0)], 1), ([(0, 1)], 1)])
    base_depth, base_labels = empty_base()
    greedy = search_beam(base_depth, base_labels, depths, labels, [('A', 15)] * 3,
                         {('A', 15): 2}, target, base_supported=(0, 1, 2), beam=1,
                         improve_rounds=0)
    assert 0 in greedy['indices']
    repaired = search_beam(base_depth, base_labels, depths, labels, [('A', 15)] * 3,
                           {('A', 15): 2}, target, base_supported=(0, 1, 2), beam=1,
                           improve_rounds=4, improve_from=4)
    assert repaired['indices'] == (1, 2)
    assert repaired['score'] == pytest.approx(1.0)
    assert repaired['exchanges'] >= 1


def test_exchange_preserves_the_quota_of_every_key():
    target = np.zeros(SHAPE, np.uint8)
    target[0, 0] = 1
    target[1, 1] = 2
    depths, labels = bank(SHAPE, [([(3, 3)], 1), ([(0, 0)], 1),
                                  ([(2, 0)], 2), ([(1, 1)], 2)])
    base_depth, base_labels = empty_base()
    result = search_beam(base_depth, base_labels, depths, labels,
                         [('A', 15), ('A', 15), ('B', 4), ('B', 4)],
                         {('A', 15): 1, ('B', 4): 1}, target, base_supported=(0, 1, 2, 3),
                         beam=1, improve_rounds=4)
    chosen_keys = sorted([('A', 15), ('A', 15), ('B', 4), ('B', 4)][i]
                         for i in result['indices'])
    assert chosen_keys == [('A', 15), ('B', 4)]


def test_incremental_deltas_agree_with_a_rebuilt_composite():
    generator = np.random.default_rng(11)
    shape = (6, 6)
    target = generator.integers(0, 3, shape).astype(np.uint8)
    depths, labels = [], []
    for _ in range(5):
        painted = generator.random(shape) > 0.4
        depths.append(np.where(painted, generator.random(shape) * 4, -np.inf))
        labels.append(np.where(painted, generator.integers(1, 3, shape), 0).astype(np.uint8))
    depths, labels = np.stack(depths), np.stack(labels)
    base_depth = np.where(generator.random(shape) > 0.5, 1.0, -np.inf)
    base_labels = np.where(np.isfinite(base_depth), 1, 0).astype(np.uint8)
    model = LayerComposite(base_depth, base_labels, depths, labels, target)
    chosen = (1, 3)
    depth, label = model.composite(chosen)
    correct, false = model.counts(label)
    dc, df = model.deltas(depth, label)
    for index in range(len(labels)):
        rebuilt = model.counts(model.composite(tuple(sorted(set(chosen) | {index})))[1])
        if index in chosen:
            continue
        assert list(correct + dc[index]) == list(rebuilt[0])
        assert list(false + df[index]) == list(rebuilt[1])


def test_perturbed_restarts_can_beat_a_plain_exchange():
    # Two disjoint pairs cover the target; the greedy first pick and every
    # single exchange from it are worse than the true optimum.
    target = np.zeros((6, 6), np.uint8)
    target[0, 0] = target[0, 1] = target[5, 5] = target[5, 4] = 1
    def make(pixels):
        return layer((6, 6), pixels, 1)
    depths, labels = zip(*[make(p) for p in (
        [(0, 0), (0, 1), (3, 3), (3, 4), (2, 2)],   # attractive but impure
        [(0, 0), (0, 1)],
        [(5, 5), (5, 4)],
        [(5, 5), (2, 0)],
    )])
    depths, labels = np.stack(depths), np.stack(labels)
    base_depth = np.full((6, 6), -np.inf)
    base_labels = np.zeros((6, 6), np.uint8)
    result = search_beam(base_depth, base_labels, depths, labels, [('A', 15)] * 4,
                         {('A', 15): 2}, target, base_supported=(0, 1, 2, 3),
                         beam=1, improve_rounds=6, improve_from=4, restarts=6, perturb=2,
                         seed=3)
    assert result['indices'] == (1, 2)
    assert result['score'] == pytest.approx(1.0)
