import numpy as np
import pytest
import cv2
from placement_v2_curves import covariance, score_curves, curve_observations


def ellipse(x=0., y=0., axes=(8., 14.), angle=90.):
    return dict(center=[x,y], axes=axes, angle=angle)


def test_whole_curve_capacity_prevents_duplicate_credit():
    one = score_curves([ellipse()], [ellipse()])
    duplicate = score_curves([ellipse(), ellipse()], [ellipse()])
    assert one['normalized_cost'] == 0
    assert len(duplicate['matches']) == 1
    assert duplicate['unmatched_predicted'] == 1
    assert duplicate['normalized_cost'] > one['normalized_cost']


def test_ellipse_axis_angle_conventions_preserve_covariance():
    assert np.allclose(covariance(ellipse()), covariance(ellipse(axes=(14.,8.), angle=0.)))


def test_wrong_size_and_position_cost_more_and_empty_is_explicit():
    assert score_curves([ellipse(axes=(4.,7.))], [ellipse()])['normalized_cost'] > 0
    assert score_curves([ellipse(100.)], [ellipse()])['matches'] == []
    assert score_curves([], [ellipse()])['unmatched_observed'] == 1
    with pytest.raises(ValueError):
        score_curves([ellipse(axes=(0.,4.))], [ellipse()])


def test_saturated_surface_does_not_erase_closed_curve():
    image = np.full((80,80,3),(180,0,0),np.uint8)
    cv2.ellipse(image,(40,40),(12,7),0,0,360,(20,0,0),-1)
    curves = curve_observations(image,np.ones((80,80),bool))
    assert any(np.linalg.norm(np.asarray(c['center'])-[40,40]) < 1 for c in curves)
