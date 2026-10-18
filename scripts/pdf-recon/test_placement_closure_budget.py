"""Offline checks for round seven's closure budget and the screened-set cap.

Two properties, both of which round six's reading of the budget depended on and
neither of which was ever asserted:

* the three ways a closure can stop - parent budget, pose budget, wall clock -
  must be *distinguishable* in the record, and "nothing stopped it" must be
  distinguishable from all three;
* capping how many screened candidates reach the bank must not let one quota key
  crowd out another, because that is the same scale bias that loses small pieces
  in the traversal.
"""
import numpy as np
import pytest

import placement_multi_shape_batch as multi
from placement_multi_shape_search import stratified_cap


def translation(x, y=0., z=0.):
    T = np.eye(4)
    T[:3, 3] = (x, y, z)
    return T


class FakeAssembly:
    """Base offers `mates` mates for A; each A carries one B, which carries none."""

    def __init__(self, items, base=False, mates=40):
        self.items = list(items)
        self.base = base
        self.mates = mates

    def candidates(self, part, kinds=None, check_collision=True, check_occlusion=False):
        if self.base:
            return [{'T': translation(10. * (k + 1))} for k in range(self.mates)]
        return [{'T': translation(0., -8.)}] if part == 'A' else []

    def collides(self, part, T):
        return False


@pytest.fixture(autouse=True)
def fake_assembly(monkeypatch):
    monkeypatch.setattr(multi, 'make_assembly',
                        lambda items: FakeAssembly(items, base=len(items) != 1))


def test_no_parent_budget_expands_every_base_attached_pose():
    record = multi.registry([], [('A', 15)], closure_rounds=1, max_closure_parents=None,
                            max_poses=10_000)
    assert record['closure_parents_processed'] == record['base_attached_count'] == 40
    assert record['closure_parent_budget_hit'] is False
    assert record['closure_pose_budget_hit'] is False
    assert record['closure_time_budget_hit'] is False
    assert record['closure_rounds_complete'] is True


def test_a_parent_budget_is_still_reported_as_the_thing_that_stopped_it():
    record = multi.registry([], [('A', 15)], closure_rounds=1, max_closure_parents=5,
                            max_poses=10_000)
    assert record['closure_parents_processed'] == 5
    assert record['closure_parent_budget_hit'] is True
    assert record['closure_rounds_complete'] is False


def test_the_pose_budget_is_a_different_event_from_the_parent_budget():
    record = multi.registry([], [('A', 15)], closure_rounds=1, max_closure_parents=None,
                            max_poses=45)
    assert record['closure_pose_budget_hit'] is True
    assert record['closure_parent_budget_hit'] is False
    assert record['closure_rounds_complete'] is False


def test_a_zero_time_budget_stops_before_the_first_parent_and_says_so():
    record = multi.registry([], [('A', 15)], closure_rounds=1, max_closure_parents=None,
                            max_poses=10_000, max_seconds=0.0)
    assert record['closure_parents_processed'] == 0
    assert record['closure_time_budget_hit'] is True
    assert record['closure_parent_budget_hit'] is False
    assert record['closure_pose_budget_hit'] is False
    assert record['closure_rounds_complete'] is False
    assert record['closure_max_seconds'] == 0.0
    # The bank still holds the base-attached enumeration: a spent clock loses
    # the closure, never the poses that were already there.
    assert len(record['poses']) == record['base_attached_count'] == 40


def test_a_generous_time_budget_changes_nothing():
    bounded = multi.registry([], [('A', 15)], closure_rounds=1, max_closure_parents=None,
                             max_poses=10_000, max_seconds=600.)
    free = multi.registry([], [('A', 15)], closure_rounds=1, max_closure_parents=None,
                          max_poses=10_000)
    for record in (bounded, free):
        record.pop('seconds')
        record.pop('closure_seconds')
        record.pop('closure_max_seconds')
    assert bounded == free


def placements_for(counts):
    """One placement per (key, candidate), numbered so bank indices are distinct."""
    placements, original, rows, index = [], [], [], 0
    for key, entries in counts.items():
        for covered, occupied in entries:
            placements.append(dict(key=key, pose_index=index))
            original.append(index)
            rows.append(dict(index=index, covered_pixels=covered, occupied_pixels=occupied,
                             outside_pixels=0))
            index += 1
    return placements, original, dict(candidates=rows)


def test_no_cap_below_the_limit():
    placements, original, gate = placements_for({('A', 15): [(10, 10)] * 3})
    kept, record = stratified_cap(placements, original, gate, 10)
    assert kept == [0, 1, 2] and record is None
    assert stratified_cap(placements, original, gate, None)[1] is None


def test_the_cap_is_by_rate_not_by_painted_area():
    """A small candidate that fits perfectly must beat a large one that does not.

    This is the property the whole cap exists for: ranking by raw covered pixels
    would keep the 9,000-of-20,000 candidate and drop the 400-of-400 one.
    """
    placements, original, gate = placements_for(
        {('A', 15): [(9000, 20000), (400, 400), (100, 1000)]})
    kept, record = stratified_cap(placements, original, gate, 1)
    assert kept == [1]
    assert record['retained'] == 1


def test_each_quota_key_keeps_a_share_of_the_budget():
    """A commoner shape's poses must not consume the whole cap."""
    placements, original, gate = placements_for(
        {('A', 15): [(100, 100)] * 8, ('B', 4): [(50, 100)] * 2})
    kept, record = stratified_cap(placements, original, gate, 4)
    assert len(kept) == 4
    assert record['per_key_retained'] == {'A:15': 2, 'B:4': 2}
    # Even though every B candidate scores worse than every A candidate.
    assert sorted(kept) == kept


def test_the_cap_returns_positions_in_bank_order():
    placements, original, gate = placements_for(
        {('A', 15): [(1, 100), (100, 100), (50, 100)]})
    kept, _ = stratified_cap(placements, original, gate, 2)
    assert kept == sorted(kept)
    assert kept == [1, 2]
