import numpy as np
import pytest

from placement_v2_observations import instance_owner, instance_seams, observed_tokens, predicted_tokens


def test_triangle_ids_map_across_zero_count_instances():
    owner = np.array([[0, 1, 2, 3, 4]])
    assert instance_owner(owner, [2, 0, 2]).tolist() == [[0, 1, 1, 3, 3]]
    with pytest.raises(ValueError):
        instance_owner(owner, [2, 1])


def test_coplanar_instance_seam_is_visible_but_tessellation_is_not():
    mask = np.zeros((40, 60), bool)
    mask[5:35, 5:55] = True
    rgb = np.full((40, 60, 3), 245, np.uint8)
    rgb[mask] = 180
    owners = mask.astype(np.int32)
    owners[:, 30:] *= 2
    assert instance_seams(owners)[10:30, 30].all()
    tokens, image = predicted_tokens(rgb, mask, owners, spacing=2)
    assert image['edges'][10:30, 28:33].any()
    assert any(len(t.owner_ids) == 2 for t in tokens)
    one = mask.astype(np.int32)
    assert not instance_seams(one).any()


def test_hidden_instance_gets_no_visible_evidence_and_sampling_is_deterministic():
    mask = np.zeros((30, 30), bool)
    mask[5:25, 5:25] = True
    rgb = np.full((30, 30, 3), 245, np.uint8)
    rgb[mask] = 90
    owner = mask.astype(np.int32) * 2
    tokens, _ = predicted_tokens(rgb, mask, owner)
    assert tokens and all(t.owner_ids == ('part:1',) for t in tokens)
    assert observed_tokens(rgb, mask) == observed_tokens(rgb, mask)
    assert observed_tokens(rgb, np.zeros_like(mask)) == []
