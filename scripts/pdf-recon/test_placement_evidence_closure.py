"""Offline checks for evidence-guided closure-parent selection.

The property under test is that ordering the closure parents changes *which*
poses fit inside the budget without changing what is legal: a reachable child
must not become unreachable, and an illegal child must not become legal.
"""
import numpy as np
import pytest

import placement_multi_shape_batch as multi
from placement_arrow_parent import arrowhead_residuals, receiving_caps, score_parents
from placement_evidence_closure import combine, merge_ranks, parent_order


def translation(x, y=0., z=0.):
    T = np.eye(4)
    T[:3, 3] = (x, y, z)
    return T


class FakeAssembly:
    """Base offers many mates for A; each A carries exactly one B on top."""

    def __init__(self, items, base=False, mates=6):
        self.items = list(items)
        self.base = base
        self.mates = mates

    def candidates(self, part, kinds=None, check_collision=True, check_occlusion=False):
        if self.base:
            return [{'T': translation(10. * (k + 1))} for k in range(self.mates)]
        return [{'T': translation(0., -8.)}] if part == 'B' else []

    def collides(self, part, T):
        return False


@pytest.fixture(autouse=True)
def fake_assembly(monkeypatch):
    monkeypatch.setattr(multi, 'make_assembly',
                        lambda items: FakeAssembly(items, base=len(items) != 1))


def child_positions(record):
    return {(entry['part'], round(entry['T'][0][3], 5), round(entry['T'][1][3], 5))
            for entry in record['poses']}


def test_bank_order_budget_hides_a_reachable_child():
    """The measured 40377 failure in miniature: the parent is past the budget."""
    record = multi.registry([], [('A', 15), ('B', 15)], closure_rounds=1,
                            max_closure_parents=1)
    assert ('B', 10.0, -8.0) in child_positions(record)
    assert ('B', 60.0, -8.0) not in child_positions(record), 'budget must really bind'


def test_parent_order_recovers_the_child_the_budget_hid():
    bank = multi.ShapeRegistry([], [('A', 15), ('B', 15)])
    last = [index for index, (part, _) in enumerate(bank.poses) if part == 'A'][-1]
    order = [last] + [index for index in range(bank.base_attached_count) if index != last]
    record = bank.close(1, 1, 8192, order, 'test_evidence').record()
    assert ('B', 60.0, -8.0) in child_positions(record)
    assert record['closure_parent_order'] == 'test_evidence'


def test_ordering_cannot_invent_an_illegal_child(monkeypatch):
    monkeypatch.setattr(multi, 'make_assembly',
                        lambda items: type('Blocked', (FakeAssembly,),
                                           {'collides': lambda self, part, T: True})(
                                               items, base=len(items) != 1))
    bank = multi.ShapeRegistry([], [('A', 15), ('B', 15)])
    order = list(reversed(range(bank.base_attached_count)))
    record = bank.close(1, 64, 8192, order, 'test_evidence').record()
    # Base-attached mates are unaffected; the collision test must still veto
    # every closure child however favourably its parent was ranked.
    assert len(record['poses']) == record['base_attached_count']
    assert not record['support_edges']


def test_ordering_with_an_unbounded_budget_reaches_the_same_bank():
    plain = multi.registry([], [('A', 15), ('B', 15)], closure_rounds=1, max_closure_parents=64)
    bank = multi.ShapeRegistry([], [('A', 15), ('B', 15)])
    order = list(reversed(range(bank.base_attached_count)))
    ranked = bank.close(1, 64, 8192, order, 'test_evidence').record()
    assert child_positions(plain) == child_positions(ranked)


def test_parent_order_must_be_a_permutation():
    bank = multi.ShapeRegistry([], [('A', 15)])
    with pytest.raises(ValueError):
        bank.close(1, 4, 8192, [0, 0, 1], 'broken')


def test_shapes_are_interleaved_so_one_cannot_starve_the_other():
    rows = [dict(index=i, feasible=True, novel_pixels=100 - i, outside_pixels=0,
                 arrow_residual_px=None) for i in range(6)]
    shapes = ['A', 'A', 'A', 'B', 'B', 'B']
    order = parent_order(rows, shapes)
    assert order[:2] == [0, 3], 'each shape must reach the front of the budget'
    assert sorted(order) == list(range(6))


def test_arrow_residual_outranks_silhouette_novelty():
    rows = [dict(index=0, feasible=True, novel_pixels=9000, outside_pixels=0,
                 arrow_residual_px=140.),
            dict(index=1, feasible=True, novel_pixels=10, outside_pixels=0,
                 arrow_residual_px=3.)]
    assert parent_order(rows, ['A', 'A']) == [1, 0]


def test_infeasible_poses_sort_after_every_feasible_one():
    rows = [dict(index=0, feasible=False, novel_pixels=9000, outside_pixels=500,
                 arrow_residual_px=1.),
            dict(index=1, feasible=True, novel_pixels=1, outside_pixels=0,
                 arrow_residual_px=900.)]
    assert parent_order(rows, ['A', 'A']) == [1, 0]


def test_merge_ranks_promotes_a_pose_any_view_nominates():
    assert merge_ranks([[2, 0, 1], [0, 1, 2]], 3) == [0, 2, 1]


def test_combine_rejects_views_that_disagree_on_pose_count():
    a = dict(rows=[dict(occupied_pixels=1, outside_pixels=0, novel_pixels=1)],
             body=dict(occupied_pixels=1, outside_pixels=0))
    b = dict(rows=[], body=dict(occupied_pixels=1, outside_pixels=0))
    with pytest.raises(ValueError):
        combine([a, b])
    with pytest.raises(ValueError):
        combine([])


def test_combine_marks_a_pose_feasible_when_any_view_allows_it():
    views = [dict(rows=[dict(occupied_pixels=10, outside_pixels=99, novel_pixels=4)],
                  body=dict(occupied_pixels=100, outside_pixels=0)),
             dict(rows=[dict(occupied_pixels=10, outside_pixels=1, novel_pixels=7)],
                  body=dict(occupied_pixels=100, outside_pixels=5))]
    merged = combine(views)
    assert merged[0]['feasible'] is True
    assert merged[0]['outside_pixels'] == 1 and merged[0]['novel_pixels'] == 7


def test_arrow_residuals_abstain_without_usable_pairs(monkeypatch):
    monkeypatch.setattr('placement_arrow_parent.transformed_connectors',
                        lambda part, T, gender: [])
    rows = arrowhead_residuals('X', [np.eye(4)], np.eye(3)[:2], (0, 0), [(1., 1.)])
    assert rows == [] or rows[0]['matched'] is False


def test_arrow_residuals_rank_the_pose_whose_studs_lie_under_the_heads(monkeypatch):
    monkeypatch.setattr('placement_arrow_parent.transformed_connectors',
                        lambda part, T, gender: [
                            dict(pos=np.asarray(T, float)[:3, :3] @ np.array([-10., 0., 0.])
                                 + np.asarray(T, float)[:3, 3],
                                 axis=np.array([0., 1., 0.]), radius=6., length=4., gid=None),
                            dict(pos=np.asarray(T, float)[:3, :3] @ np.array([10., 0., 0.])
                                 + np.asarray(T, float)[:3, 3],
                                 axis=np.array([0., 1., 0.]), radius=6., length=4., gid=None)])
    projection = np.array([[1., 0., 0.], [0., 0., 1.]])
    heads = [(-10., 0.), (10., 0.)]
    rows = arrowhead_residuals('X', [np.eye(4), translation(40.)], projection, (0., 0.), heads)
    assert rows[0]['matched'] and rows[0]['residual_px'] < 1e-6
    assert rows[1]['residual_px'] > rows[0]['residual_px']


def test_score_parents_abstains_for_other_shapes_and_without_arrows():
    poses = [('A', np.eye(4)), ('B', np.eye(4))]
    rows, summary = score_parents('A', poses, np.eye(3)[:2], (0, 0), [])
    assert summary['scored_poses'] == 0
    assert all(row['matched'] is False for row in rows)


def test_receiving_caps_step_back_along_the_stud_axis(monkeypatch):
    monkeypatch.setattr('placement_arrow_parent.transformed_connectors',
                        lambda part, T, gender: [dict(pos=np.zeros(3), axis=np.array([0., 1., 0.]),
                                                      radius=6., length=4., gid=None)])
    assert np.allclose(receiving_caps('X', 'M'), [[0., -4., 0.]])
    assert np.allclose(receiving_caps('X', 'F'), [[0., 0., 0.]])
