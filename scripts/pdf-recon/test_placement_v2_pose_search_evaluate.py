import hashlib
import json

import pytest

from placement_v2_pose_search_evaluate import _rendered_rows, validate_runtime


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def runtime_fixture(tmp_path):
    source = tmp_path / 'source'; source.mkdir()
    (source / 'results.json').write_text('{}')
    pdf = tmp_path / 'manual.pdf'; pdf.write_bytes(b'pdf')
    base = tmp_path / 'base.ldr'; base.write_text('0 base')
    registry = tmp_path / 'registry.json'
    registry.write_text(json.dumps(dict(truth_used=False, runtime_vlm_calls=0,
                                        poses=[dict(part='3001', T=[[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]])])))
    registration = tmp_path / 'registration.json'
    registration.write_text(json.dumps(dict(truth_used=False, runtime_vlm_calls=0)))
    run = tmp_path / 'run'; run.mkdir()
    (run / 'sources').mkdir()
    report = dict(truth_used=False, runtime_vlm_calls=0, sources_unchanged=True,
                  source_hashes_start={}, source_hashes_end={},
                  source_placement=str(source), source_results_sha256=sha(source / 'results.json'),
                  pdf=str(pdf), pdf_sha256=sha(pdf), base_source=str(base), base_sha256=sha(base),
                  registry_source=str(registry), registry_sha256=sha(registry),
                  registration_source=str(registration), registration_sha256=sha(registration),
                  raw_pose_count=1, cameras=[], selected=None)
    (run / 'report.json').write_text(json.dumps(report))
    return run, source, report


def test_runtime_hash_mismatch_is_rejected(tmp_path):
    run, source, _ = runtime_fixture(tmp_path)
    (source / 'results.json').write_text('changed')
    with pytest.raises(ValueError, match='source placement differs'):
        validate_runtime(run)


def test_runtime_requires_truth_free_provenance(tmp_path):
    run, _, report = runtime_fixture(tmp_path)
    report['truth_used'] = None
    (run / 'report.json').write_text(json.dumps(report))
    with pytest.raises(ValueError, match='truth-free'):
        validate_runtime(run)


def test_selected_model_hash_is_checked(tmp_path):
    run, _, report = runtime_fixture(tmp_path)
    (run / 'model.ldr').write_text('model')
    report['selected'] = dict(camera_index=0, selected_pose_ids=[], model_sha256='0' * 64)
    report['cameras'] = [dict(camera_index=0, raw_pose_count=1, rendered_pose_count=0,
                              standalone_candidates=[], cheap_counts={}, render_counts={},
                              rendered_retained_pose_ids=[], support_pruned_pose_ids=[],
                              solver=dict(selected_pose_ids=[]),
                              actual=dict(normalized_cost=1.0))]
    report['selected']['normalized_cost'] = 1.0
    (run / 'report.json').write_text(json.dumps(report))
    with pytest.raises(ValueError, match='Selected model differs'):
        validate_runtime(run)


def test_rendered_tier_uses_explicit_ids_after_support_prune():
    rows = [dict(pose_id='keep', quota_key='part:1', normalized_cost=2),
            dict(pose_id='prune', quota_key='part:1', normalized_cost=1)]
    camera = dict(standalone_candidates=rows,
                  render_counts={'part:1': {'retained': 2}},
                  rendered_retained_pose_ids=['keep'], support_pruned_pose_ids=['prune'])
    assert [row['pose_id'] for row in _rendered_rows(camera)] == ['keep']


def test_v4_rendered_tier_reconciles_primary_support_and_prune():
    rows = [dict(pose_id=name, quota_key='part:1', normalized_cost=index)
            for index, name in enumerate(('primary', 'support', 'prune'))]
    camera = dict(standalone_candidates=rows,
                  render_counts={'part:1': dict(rendered_input=3, visually_ineligible=1,
                                                eligible=2, retained=1, budget=1)},
                  primary_render_retained_pose_ids=['primary'],
                  support_closure=dict(added_pose_ids=['support', 'prune'], extra_cap=2),
                  support_pruned_pose_ids=['prune'],
                  rendered_retained_pose_ids=['primary', 'support'])
    assert {row['pose_id'] for row in _rendered_rows(camera)} == {'primary', 'support'}
