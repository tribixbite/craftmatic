"""Offline checks for the multi-shape pose registry and placement bank."""
import numpy as np
import pytest

import placement_multi_shape_batch as multi
from placement_multi_shape_batch import registry, shape_bank


def translation(x, y=0., z=0.):
    T = np.eye(4)
    T[:3, 3] = (x, y, z)
    return T


class FakeAssembly:
    """Deterministic stand-in: mates translate a shape by its own step."""

    STEP = {'A': 10., 'B': 20.}

    def __init__(self, items, base=False):
        self.items = list(items)
        self.base = base

    def candidates(self, part, kinds=None, check_collision=True, check_occlusion=False):
        if self.base:
            return [{'T': translation(self.STEP[part] * k)} for k in (1, 2)]
        return [{'T': translation(self.STEP[part])}]

    def collides(self, part, T):
        # Anything at the origin overlaps the existing body.
        return bool(np.allclose(T[:3, 3], 0))


@pytest.fixture(autouse=True)
def fake_assembly(monkeypatch):
    monkeypatch.setattr(multi, 'make_assembly',
                        lambda items: FakeAssembly(items, base=len(items) != 1))


def test_registry_enumerates_every_allocated_shape():
    result = registry([], [('A', 15), ('A', 4), ('B', 15)])
    assert result['parts'] == ['A', 'B']
    parts = [entry['part'] for entry in result['poses'][:result['base_attached_count']]]
    assert sorted(parts) == ['A', 'A', 'B', 'B']
    assert len(result['base_supported']) == result['base_attached_count']


def test_closure_adds_cross_shape_children_with_support_edges():
    result = registry([], [('A', 15), ('B', 15)], closure_rounds=1)
    positions = {(entry['part'], round(entry['T'][0][3], 5)) for entry in result['poses']}
    # A at 10 is a base mate; B mounted on it lands at 10 + 20.
    assert ('B', 30.0) in positions
    assert ('A', 20.0) in positions
    assert result['support_edges'], 'closure must witness parent/child support'
    for a, b in result['support_edges']:
        assert 0 <= a < b < len(result['poses'])


def test_pose_budget_is_reported_not_silently_exceeded():
    result = registry([], [('A', 15), ('B', 15)], closure_rounds=1, max_poses=4)
    assert len(result['poses']) <= 4
    assert result['closure_budget_hit'] is True
    assert result['closure_exhaustive'] is False


def test_shape_bank_pairs_each_pose_only_with_its_own_shape_colours():
    record = registry([], [('A', 15), ('A', 4), ('B', 15)], closure_rounds=0)
    placements, quotas = shape_bank(record, [('A', 15), ('A', 4), ('B', 15)])
    assert quotas == {('A', 15): 1, ('A', 4): 1, ('B', 15): 1}
    for placement in placements:
        part, color, _ = placement['items'][0]
        assert placement['key'] == (part, color)
        assert (part, color) in quotas
    a_poses = sum(1 for entry in record['poses'] if entry['part'] == 'A')
    b_poses = sum(1 for entry in record['poses'] if entry['part'] == 'B')
    assert len(placements) == 2 * a_poses + b_poses


def test_repeated_allocation_rows_become_one_quota_count():
    record = registry([], [('A', 15)], closure_rounds=0)
    _, quotas = shape_bank(record, [('A', 15), ('A', 15), ('A', 15)])
    assert quotas == {('A', 15): 3}


def test_allocation_without_any_matching_shape_is_rejected():
    record = registry([], [('A', 15)], closure_rounds=0)
    with pytest.raises(ValueError):
        shape_bank(record, [('C', 15)])
    with pytest.raises(ValueError):
        registry([], [])


def test_quota_keys_are_accepted_by_the_cardinality_search():
    from placement_cardinality_search import search_layers
    shape = (4, 4)
    zeros = np.full(shape, -np.inf)
    labels = np.zeros(shape, np.uint8)
    target = np.zeros(shape, np.uint8)
    target[0, 0] = 1
    target[1, 1] = 2
    depths = np.stack([np.where(np.arange(16).reshape(shape) == i, 0., -np.inf)
                       for i in (0, 5)])
    layers = np.stack([np.where(np.arange(16).reshape(shape) == i, c, 0).astype(np.uint8)
                       for i, c in ((0, 1), (5, 2))])
    result = search_layers(zeros, labels, depths, layers,
                           [('A', 15), ('B', 4)], {('A', 15): 1, ('B', 4): 1}, target)
    assert result['indices'] == (0, 1)
    assert result['search_exhaustive'] is True
