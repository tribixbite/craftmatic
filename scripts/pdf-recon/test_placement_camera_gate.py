"""Offline tests for the camera acceptance test. No PDF, CAD, GPU or truth."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import numpy as np

from placement_camera_gate import (SCALE_TOLERANCE, UNEXPLAINED_MAX, gate, measure,
                                   projection_scale, verdict)

# The real 40377 page-16 projection, renormalised so scaling it scales the
# measured pixels per LDU exactly.
PAGE16 = np.array([[.9642598887424072, .0031706494619972176, -1.390121986862126],
                   [.7800651200513223, 1.399106617041673, .5442843071801319]])
UNIT_MATRIX = PAGE16 / projection_scale(PAGE16)


def hypothesis(scale, coverage, contained=True, template=.4, outside=2, fallback=False,
               target=50000):
    matrix = (UNIT_MATRIX * scale).tolist()
    row = dict(projection=matrix, template_score=template, contained=contained,
               outside_pixels=outside, occupied_pixels=49000,
               covered_pixels=int(round(coverage * target)), target_pixels=target,
               best_containment=dict(outside_pixels=outside, occupied_pixels=49000))
    if fallback:
        row['containment_fallback'] = True
    return row


def test_measure_reads_scale_and_coverage():
    values = measure(hypothesis(1.6918, .9776), prior_scale=1.6918)
    assert abs(values['px_per_ldu'] - 1.6918) < 1e-9
    assert abs(values['coverage'] - .9776) < 1e-6
    assert abs(values['scale_ratio'] - 1.) < 1e-9


def test_measure_falls_back_to_the_containment_record():
    row = hypothesis(1.6918, .95)
    row.pop('covered_pixels')
    row.pop('target_pixels')
    row['best_containment'].update(covered_pixels=100, target_pixels=200)
    assert abs(measure(row)['coverage'] - .5) < 1e-9


def test_the_measured_good_and_bad_pages_separate():
    """Real numbers from 40377 pages 16-19 must land on opposite verdicts."""
    good = verdict(hypothesis(1.6918, 1 - 1170 / 52177, target=52177),
                   prior_scale=1.6918, new_piece_area=22282)
    bad = verdict(hypothesis(1.4791, 1 - 14388 / 55568, target=55568, outside=255),
                  prior_scale=1.6918, new_piece_area=13020)
    assert good['accepted'], good
    assert abs(good['unexplained_share'] - 1170 / 22282) < 1e-6
    assert not bad['accepted']
    assert any(r.startswith('unexplained_ink') for r in bad['reasons'])
    assert any(r.startswith('scale_differs') for r in bad['reasons'])


def test_a_small_body_early_in_a_model_is_not_refused_for_low_coverage():
    """41624 page 3 covers only 78% of its drawing and is a good registration.

    Most of what it does not cover is the three pieces the page is adding, so a
    raw coverage threshold would refuse every early page of a small model.
    """
    row = verdict(hypothesis(1.0753, 1 - 1543 / 7123, target=7123, outside=0),
                  prior_scale=None, new_piece_area=3775)
    assert row['accepted'], row
    assert row['coverage'] < .79
    assert row['unexplained_share'] < 1.


def test_unexplained_ink_alone_refuses_without_a_prior_scale():
    row = verdict(hypothesis(.8723, 1 - 4552 / 11596, target=11596, outside=69),
                  prior_scale=None, new_piece_area=3180)
    assert not row['accepted']
    assert row['scale_ratio'] is None
    assert [r for r in row['reasons'] if r.startswith('unexplained_ink')]


def test_a_page_that_allocates_nothing_is_not_failed_for_being_unmeasurable():
    row = verdict(hypothesis(1.6918, .93), prior_scale=1.6918, new_piece_area=None)
    assert row['accepted'] and row['unexplained_share'] is None
    assert row['unexplained_note']


def test_a_registration_without_coverage_is_refused():
    row = hypothesis(1.6918, .99)
    row.pop('covered_pixels')
    row.pop('target_pixels')
    assert 'registration_reports_no_coverage' in verdict(row, 1.6918, 1000.)['reasons']


def test_a_fallback_registration_is_never_accepted():
    row = verdict(hypothesis(1.6918, .99, fallback=True), prior_scale=1.6918,
                  new_piece_area=100000.)
    assert not row['accepted'] and 'not_contained' in row['reasons']


def test_enforce_keeps_only_accepted_and_reports_a_refusal():
    rows = [hypothesis(1.4791, .74, template=.9), hypothesis(1.6918, .99, template=.3)]
    kept, record = gate(rows, prior_scale=1.6918, new_piece_area=20000., mode='enforce')
    assert len(kept) == 1 and kept[0] is rows[1]
    assert record['accepted'] == 1 and 'refusal' not in record
    none_kept, refused = gate([rows[0]], prior_scale=1.6918, new_piece_area=20000.,
                              mode='enforce')
    assert none_kept == [] and refused['refusal']


def test_report_reorders_without_dropping_and_off_changes_nothing():
    rows = [hypothesis(1.4791, .74, template=.9), hypothesis(1.6918, .99, template=.3)]
    ordered, record = gate(rows, prior_scale=1.6918, new_piece_area=20000., mode='report')
    assert [id(r) for r in ordered] == [id(rows[1]), id(rows[0])]
    assert record['accepted'] == 1
    untouched, off = gate(rows, prior_scale=1.6918, new_piece_area=20000., mode='off')
    assert [id(r) for r in untouched] == [id(r) for r in rows]
    assert off['accepted'] == len(rows)


def test_thresholds_are_configurable_and_the_mode_is_validated():
    row = hypothesis(1.4791, .7411)
    assert verdict(row, 1.6918, 1000., unexplained_max=50., scale_tolerance=.5)['accepted']
    try:
        gate([row], mode='sometimes')
    except ValueError:
        pass
    else:
        raise AssertionError('An unknown gate mode must be rejected')


def test_the_published_defaults_sit_in_the_measured_gap():
    assert .62 < UNEXPLAINED_MAX < 1.10
    assert .052 < SCALE_TOLERANCE < .126


if __name__ == '__main__':
    failures = 0
    for name, function in sorted(globals().items()):
        if name.startswith('test_') and callable(function):
            try:
                function()
                print('ok  ', name)
            except AssertionError as error:
                failures += 1
                print('FAIL', name, error)
    print('failures', failures)
    sys.exit(1 if failures else 0)
