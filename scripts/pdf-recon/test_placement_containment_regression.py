"""Offline checks for the containment replay.

The replay's value is that it reproduces a run's own decisions exactly, so what
is pinned here is that property: given the numbers a run recorded, the "after"
column under the rule the run used must be what the run did, and the "before"
column must be what the previous rule would have done.
"""
import json

import numpy as np
import pytest

from placement_containment_regression import admissions, order, replay


def evaluated(rows):
    """Recorded hypotheses in the shape `registration-refined-*.json` saves."""
    out = []
    for index, (outside, occupied, covered, score, contained) in enumerate(rows):
        out.append(dict(source_index=index, template_score=score, contained=contained,
                        admission='absolute' if contained else None,
                        projection=np.eye(2, 3).tolist(),
                        best_containment=dict(offset=[0, 0], scale=1.0,
                                              outside_pixels=outside,
                                              occupied_pixels=occupied,
                                              covered_pixels=covered,
                                              target_pixels=59535,
                                              anchor=[0.0, 0.0])))
    return out


# 40377 page index 22, exactly as the round-four run recorded it: two propagated
# registrations covering 92.4% and 90.3%, then contained body-template ones
# covering 76-80%.
PAGE22 = evaluated([(1199, 57638, 55026, 0.8923, False),
                    (669, 55333, 53777, 0.8900, False),
                    (327, 46380, 45536, 0.3193, True),
                    (147, 46380, 45953, 0.3065, True)])


def test_the_absolute_rule_admits_only_what_the_run_admitted():
    admitted, floor, ceiling = admissions(PAGE22, 0, 0.01, 0.0, 0.03)
    assert [row['source_index'] for row in admitted] == [2, 3]
    assert all(row['admission'] == 'absolute' for row in admitted)
    assert ceiling is None and round(floor, 5) == round(147 / 46380, 5)


def test_the_within_page_rule_admits_the_propagated_registration():
    admitted, floor, ceiling = admissions(PAGE22, 0, 0.01, 4.0, 0.03)
    assert [row['source_index'] for row in admitted] == [1, 2, 3]
    relative = next(row for row in admitted if row['source_index'] == 1)
    assert relative['admission'] == 'relative' and relative['outside_pixels'] == 669
    assert ceiling == pytest.approx(4 * floor)


def test_the_driver_ordering_keeps_propagated_registrations_first():
    admitted, _, _ = admissions(PAGE22, 0, 0.01, 4.0, 0.03)
    assert [row['source_index'] for row in order(admitted, 2, False)] == [1, 2, 3]
    # Coverage ordering is a different policy and is reported, not adopted.
    assert [row['source_index'] for row in order(admitted, 2, True)] == [1, 3, 2]


def test_a_page_whose_floor_exceeds_the_cap_is_left_alone():
    # 40377 page index 26's second drawing: nothing registers better than 7.3%.
    rows = evaluated([(2072, 28369, 25596, 0.4, False), (9825, 36976, 26386, 0.9, False)])
    admitted, floor, ceiling = admissions(rows, 0, 0.01, 4.0, 0.03)
    assert admitted == [] and ceiling is None and floor > 0.03


def test_replay_reads_a_recorded_page_and_reproduces_both_columns(tmp_path):
    step = tmp_path / 'page-022'
    step.mkdir()
    (step / 'registration-refined-00.json').write_text(json.dumps(
        dict(page=22, xref=180, drawing_registration_hypotheses=2, evaluated=PAGE22)))
    (step / 'camera-gate-00.json').write_text(json.dumps(
        dict(prior_px_per_ldu=None, addable_pixels=None, unexplained_max=1.0,
             scale_tolerance=.06, drawing_ratio=None)))
    before = replay(step, 0, 0.01, 0.0, 0.03, False)[0]
    after = replay(step, 0, 0.01, 4.0, 0.03, False)[0]
    assert before['first_accepted'] == 2 and before['first_source'] == 'body_template'
    assert after['first_accepted'] == 1 and after['first_source'] == 'drawing_to_drawing'
    assert after['relative_admissions'] == 1
    assert round(after['first_coverage'], 4) == round(53777 / 59535, 4)
