import json
from pathlib import Path
import tempfile

import numpy as np
import pytest

from placement_v2_detached import (allocated_from_bank, distinct_matrices,
                                   rank_component, translation_domain)


def row(key, cost, camera=0, rotation=0):
    return dict(key=key, normalized_cost=cost,
                camera_index=camera, rotation_index=rotation)


def test_pose_rows_are_collapsed_by_identity_before_margin_decision():
    decision = rank_component([
        row('2420:15', .20, 1, 4), row('2420:15', .10, 0, 3),
        row('15571:15', .16), row('99780:15', .40)], min_margin=.02)
    assert decision['status'] == 'identified'
    assert decision['selected'] == '2420:15'
    assert decision['margin'] == pytest.approx(.06)
    assert [item['key'] for item in decision['ranking']] == [
        '2420:15', '15571:15', '99780:15']


def test_close_or_exact_identity_ties_are_refused_and_reported():
    close = rank_component([row('2420:15', .10), row('15571:15', .115)], min_margin=.02)
    assert close['status'] == 'refused'
    assert close['reason'] == 'identity_margin_below_threshold'
    exact = rank_component([row('2420:15', .10), row('15571:15', .10)], min_margin=.02)
    assert exact['status'] == 'refused'
    assert exact['reason'] == 'exact_identity_tie'


def test_allocation_must_be_truth_free_and_match_bank_pdf_page():
    with tempfile.TemporaryDirectory(dir=Path.cwd()) as tmp:
        bank = Path(tmp) / 'construction'
        bank.mkdir()
        record = dict(truth_used=False, runtime_vlm_calls=0, pdf='book.pdf',
                      pdf_sha256='abc', page=2,
                      allocated_pieces=[['2420', 15], ['2420', 15], ['15571', 15]])
        path = bank.parent / 'construction.json'
        path.write_text(json.dumps(record))
        pieces, source = allocated_from_bank(
            bank, dict(pdf='book.pdf', pdf_sha256='abc', page=2))
        assert pieces == [('2420', 15), ('2420', 15), ('15571', 15)]
        assert source == path
        record['truth_used'] = True
        path.write_text(json.dumps(record))
        with pytest.raises(ValueError, match='truth-free zero-VLM'):
            allocated_from_bank(bank, dict(pdf='book.pdf', pdf_sha256='abc', page=2))


def test_camera_union_is_deduplicated_and_malformed_matrices_refused():
    rows = [{'projection': [[1, 0, 0], [0, 1, 0]]},
            {'projection': [[1, 0, 0], [0, 1, 0]]},
            {'projection': [[0, 0, 1], [0, 1, 0]]}]
    assert len(distinct_matrices(rows)) == 2
    with pytest.raises(ValueError, match='Invalid bank camera'):
        distinct_matrices([{'projection': [[1, 0], [0, 1]]}])


def test_component_center_lifts_to_an_explicit_unbounded_depth_domain():
    proposal = translation_domain(
        part_center=(1., 2., 3.), component_center=(14., 18.),
        projection=((2., 0., 0.), (0., 2., 0.)), rotation=np.eye(3),
        match_id='component:0:2420:15')
    domain = proposal['domain']
    assert domain['base_translation'] == pytest.approx((6., 7., 0.))
    assert domain['nullspace_direction'] == pytest.approx((0., 0., 1.))
    assert domain['depth_interval'] is None
    assert proposal['final_pose_claim'] is False
