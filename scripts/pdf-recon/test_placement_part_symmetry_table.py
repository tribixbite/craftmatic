"""Offline checks for the proof-driven symmetry table."""
import json
import numpy as np
import pytest

from placement_part_symmetry_table import is_printed, load_proof, symmetries, table

YAW180 = np.diag([-1., 1., -1.])
YAW90 = np.array([[0., 0., 1.], [0., 1., 0.], [-1., 0., 0.]])


def write_proof(directory, part, rows, truth_used=False, files=None):
    payload = dict(part=part, truth_used=truth_used, geometry_files=files or {},
                   method='test', rotations=rows)
    (directory / f'{part}-full-symmetry.json').write_text(json.dumps(payload))


def rotation_row(R, vertex=0.0, triangle=False, identity=False):
    return dict(rotation=np.asarray(R).tolist(), identity=identity,
                max_vertex_hausdorff_ldu=vertex, full_colored_triangle_invariant=triangle)


@pytest.fixture
def proofs(tmp_path):
    write_proof(tmp_path, 'plate', [
        rotation_row(np.eye(3), 0.0, True, identity=True),
        rotation_row(YAW180, 0.0, True),
        rotation_row(YAW90, 0.0, False),        # same surface, different tessellation
        rotation_row(np.diag([1., -1., -1.]), 7.5, False),
    ])
    write_proof(tmp_path, '3010pb291', [
        rotation_row(np.eye(3), 0.0, True, identity=True),
        rotation_row(YAW180, 0.0, True),        # proof allows it; the print rule does not
    ])
    symmetries.cache_clear()
    yield tmp_path
    symmetries.cache_clear()


def test_vertex_level_includes_tessellation_only_differences(proofs):
    group = symmetries('plate', 'vertex', str(proofs))
    assert len(group) == 3
    assert any(np.allclose(R, YAW90) for R in group)


def test_triangle_level_is_stricter_than_vertex_level(proofs):
    group = symmetries('plate', 'triangle', str(proofs))
    assert len(group) == 2
    assert not any(np.allclose(R, YAW90) for R in group)


def test_printed_moulds_keep_identity_even_when_a_proof_allows_more(proofs):
    group = symmetries('3010pb291', 'vertex', str(proofs))
    assert len(group) == 1
    assert np.allclose(group[0], np.eye(3))


def test_a_part_without_a_proof_gets_no_symmetry(proofs):
    assert len(symmetries('nosuchpart', 'vertex', str(proofs))) == 1
    assert table(['nosuchpart'], 'vertex', str(proofs))['unproven'] == ['nosuchpart']


def test_changed_universal_cad_invalidates_the_proof(proofs, tmp_path):
    geometry = tmp_path / 'part.dat'
    geometry.write_text('0 original')
    write_proof(proofs, 'drifted', [rotation_row(np.eye(3), 0.0, True, identity=True)],
                files={str(geometry): 'not-the-real-digest'})
    with pytest.raises(ValueError):
        load_proof('drifted', str(proofs))


def test_proof_without_truth_free_provenance_is_rejected(proofs):
    write_proof(proofs, 'tainted', [rotation_row(np.eye(3), 0.0, True, identity=True)],
                truth_used=True)
    with pytest.raises(ValueError):
        load_proof('tainted', str(proofs))


def test_proof_failing_its_own_identity_control_is_rejected(proofs):
    write_proof(proofs, 'broken', [rotation_row(np.eye(3), 0.0, False, identity=True)])
    with pytest.raises(ValueError):
        load_proof('broken', str(proofs))


def test_printed_name_detection():
    assert is_printed('3010pb291')
    assert is_printed('98138pb072')
    assert is_printed('3245cpb117')
    assert is_printed('3010py3')
    assert not is_printed('3031')
    assert not is_printed('3023b')
    assert not is_printed('4032a')
