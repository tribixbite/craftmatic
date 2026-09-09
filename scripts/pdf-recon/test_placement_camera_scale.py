"""Offline checks for the cross-page camera-scale prior and scale refinement."""
import numpy as np
import pytest

from placement_autodrive import projection_scale, scale_prior_matrices
from placement_origin_refine import refine


def projection(scale, angle=0.3):
    """A 2x3 native projection with both singular values equal to `scale`."""
    c, s = np.cos(angle), np.sin(angle)
    return (scale * np.array([[c, 0., -s], [0., 1., 0.]])).tolist()


def test_projection_scale_recovers_pixels_per_ldu():
    assert projection_scale(projection(1.69)) == pytest.approx(1.69)
    assert projection_scale(projection(1.48)) == pytest.approx(1.48)


def test_prior_scale_is_offered_when_this_page_disagrees():
    # The measured 40377 case: pages 15-16 give ~1.69 px/LDU, page 17 gives 1.48.
    extra = scale_prior_matrices([projection(1.48)], prior_scale=1.69)
    assert len(extra) == 1
    assert projection_scale(extra[0]) == pytest.approx(1.69)


def test_prior_scale_preserves_orientation():
    original = np.asarray(projection(1.48, angle=0.7), float)
    rescaled = np.asarray(scale_prior_matrices([original.tolist()], 1.69)[0], float)
    assert np.allclose(rescaled / projection_scale(rescaled), original / projection_scale(original))


def test_agreeing_pages_add_no_redundant_hypothesis():
    assert scale_prior_matrices([projection(1.69)], prior_scale=1.70) == []
    assert scale_prior_matrices([projection(1.69)], prior_scale=None) == []


def test_prior_scale_is_an_addition_not_a_replacement():
    matrices = [projection(1.48), projection(1.50)]
    extra = scale_prior_matrices(matrices, 1.69)
    assert len(extra) == 2
    assert [projection_scale(m) for m in matrices] == pytest.approx([1.48, 1.50])


class FakeScorer:
    pass


def fake_screen(scale_area, contained_below=1.06, target=1000):
    """Screen whose body grows with the camera scale and overflows past a limit."""
    def screen(base, placements, projection_matrix, origin, scorer, **kwargs):
        scale = projection_scale(projection_matrix)
        occupied = int(scale_area * scale ** 2)
        outside = 0 if scale <= contained_below else int(1000 * (scale - contained_below))
        return dict(base=dict(occupied_pixels=occupied, outside_pixels=outside,
                              covered_pixels=min(target, occupied), target_pixels=target,
                              centroid=[10.0, 20.0], allowed=outside == 0))
    return screen


def test_scale_ladder_prefers_the_contained_scale_that_covers_most():
    hypotheses = [dict(projection=projection(1.0), origin=[0., 0.], score=1.0, rotation_index=0)]
    result = refine([], hypotheses, FakeScorer(), window=0, screen_fn=fake_screen(600),
                    scales=(0.9, 1.0, 1.05, 1.2))
    assert result['retained'] == 1
    # 1.2 overflows and is rejected; among the contained scales 1.05 covers most.
    assert result['hypotheses'][0]['applied_scale'] == pytest.approx(1.05)
    assert result['applied_scales'] == [pytest.approx(1.05)]


def test_single_scale_ladder_leaves_the_projection_untouched():
    matrix = projection(1.0)
    hypotheses = [dict(projection=matrix, origin=[3., 4.], score=1.0, rotation_index=0)]
    result = refine([], hypotheses, FakeScorer(), window=0, screen_fn=fake_screen(600))
    row = result['hypotheses'][0]
    assert np.allclose(row['projection'], matrix)
    assert row['origin'] == [3., 4.] and row['scale_ladder'] is None


def test_scale_ladder_rejects_a_degenerate_ladder():
    hypotheses = [dict(projection=projection(1.0), origin=[0., 0.], score=1.0)]
    with pytest.raises(ValueError):
        refine([], hypotheses, FakeScorer(), screen_fn=fake_screen(600), scales=())
    with pytest.raises(ValueError):
        refine([], hypotheses, FakeScorer(), screen_fn=fake_screen(600), scales=(0.0,))
