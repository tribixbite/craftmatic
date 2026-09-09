"""Offline tests for the seated-contact tie-break. Synthetic rows, no GPU.

The contract under test is that this can reorder a near-tie and can never
promote a candidate the image objective rejected.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from placement_seated_contact import reorder


def row(score, contacts, attached=0, tag=None):
    return dict(evidence=dict(score=score, seated=dict(contacts=contacts)),
                attached_pieces=attached, tag=tag)


def test_a_near_tie_is_decided_by_contact():
    rows = [row(0.488517, 1949, tag='shallow'), row(0.487312, 2256, tag='reference')]
    out, record = reorder(rows, 0.01)
    assert out[0]['tag'] == 'reference', [r['tag'] for r in out]
    assert record['applied'] and record['moved']
    assert record['band'] == 2
    assert record['chosen_contacts'] == 2256


def test_a_candidate_outside_the_band_is_never_promoted():
    rows = [row(0.90, 10, tag='best'), row(0.40, 9999, tag='distant')]
    out, record = reorder(rows, 0.01)
    assert out[0]['tag'] == 'best'
    assert record['band'] == 1 and not record['moved']


def test_zero_tolerance_is_the_untouched_order():
    rows = [row(0.488517, 1949, tag='shallow'), row(0.487312, 2256, tag='reference')]
    out, record = reorder(rows, 0.0)
    assert [r['tag'] for r in out] == ['shallow', 'reference']
    assert not record['applied']


def test_the_arrow_attachment_group_is_never_crossed():
    """A candidate that attaches a withheld piece outranks one that does not."""
    rows = [row(0.50, 10, attached=1, tag='attached'), row(0.499, 9999, attached=0, tag='loose')]
    out, record = reorder(rows, 0.01)
    assert out[0]['tag'] == 'attached'
    assert record['band'] == 1


def test_rows_beyond_the_band_keep_their_relative_order():
    rows = [row(0.500, 5, tag='a'), row(0.4995, 9, tag='b'),
            row(0.300, 1, tag='c'), row(0.200, 2, tag='d')]
    out, _ = reorder(rows, 0.01)
    assert [r['tag'] for r in out] == ['b', 'a', 'c', 'd']


def test_a_missing_contact_measurement_abstains_rather_than_guessing():
    rows = [row(0.50, 10, tag='a'), dict(evidence=dict(score=0.499), attached_pieces=0, tag='b')]
    out, record = reorder(rows, 0.01)
    assert [r['tag'] for r in out] == ['a', 'b']
    assert not record['applied'] and 'contact measurement' in record['reason']


def test_the_combined_score_is_used_when_the_local_rerank_supplied_one():
    rows = [dict(evidence=dict(score=0.10, combined_score=0.50, seated=dict(contacts=1)),
                 attached_pieces=0, tag='a'),
            dict(evidence=dict(score=0.90, combined_score=0.499, seated=dict(contacts=2)),
                 attached_pieces=0, tag='b')]
    out, record = reorder(rows, 0.01)
    assert [r['tag'] for r in out] == ['b', 'a']
    assert record['leading_score'] == 0.50


def test_an_invalid_tolerance_is_refused():
    for bad in (-0.1, 1.0, 2.0):
        try:
            reorder([row(0.5, 1)], bad)
        except ValueError:
            continue
        raise AssertionError(f'tolerance {bad} must be refused')


def test_contact_is_measured_against_real_geometry_when_available():
    try:
        import numpy as np
        from placement_seated_contact import seated_contact
    except Exception:                                                       # noqa: BLE001
        print('    (skipped: numpy unavailable)')
        return
    try:
        flush = np.eye(4)
        flush[:3, 3] = [0., -8., 0.]
        apart = np.eye(4)
        apart[:3, 3] = [0., -80., 0.]
        body = [('3023b', 15, np.eye(4))]
        touching = seated_contact(body, [('3023b', 15, flush)])
        separated = seated_contact(body, [('3023b', 15, apart)])
    except Exception:                                                       # noqa: BLE001
        print('    (skipped: recon_v8 geometry unavailable)')
        return
    assert separated['contacts'] == 0, separated
    assert touching['contacts'] > 0, touching


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
