import sys
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent))

from placement_v2_complete_objective import (
    CompleteObjectiveConfig,
    CompleteObjectiveScorer,
    CompleteRenderBuffers,
    score_complete_objective,
)
from placement_v2_correspondence import score_correspondence
from placement_v2_observations import instance_owner, observed_tokens, predicted_tokens


def item(name, x=0, y=0):
    transform = np.eye(4)
    transform[:2, 3] = (x, y)
    return name, 1, transform


def scene():
    rgb = np.full((12, 12, 3), 245, np.uint8)
    mask = np.zeros((12, 12), bool)
    mask[3:8, 3:8] = True
    rgb[mask] = 90
    return {"rgb": rgb, "mask": mask}


class FakeBufferBackend:
    """Small deterministic renderer with real ownership/token extraction."""

    def create_renderer(self, value):
        return value

    def projected_bounds(self, renderer, items, projection, origin):
        return tuple((float(transform[0, 3]), float(transform[1, 3]),
                      float(transform[0, 3] + 4), float(transform[1, 3] + 4))
                     for _, _, transform in items)

    def render(self, renderer, items, projection, origin):
        height, width = renderer["mask"].shape
        mask = np.zeros((height, width), bool)
        outline = np.full((height, width, 3), 245, np.uint8)
        triangle_owner = np.zeros((height, width), np.int32)
        for index, (_, _, transform) in enumerate(items):
            x = int(round(origin[0] + transform[0, 3]))
            y = int(round(origin[1] + transform[1, 3]))
            x0, x1 = max(0, x), min(width, x + 4)
            y0, y1 = max(0, y), min(height, y + 4)
            if x0 < x1 and y0 < y1:
                mask[y0:y1, x0:x1] = True
                outline[y0:y1, x0:x1] = 90
                triangle_owner[y0:y1, x0:x1] = index + 1
        return CompleteRenderBuffers(
            outline, mask, triangle_owner, tuple(1 for _ in items),
            {"backend": "fake", "item_count": len(items)})


def scorer(coverage, base=()):
    camera = {"projection": [[1, 0, 0], [0, 1, 0]], "origin": [3, 3]}
    with patch("placement_v2_complete_objective.curve_observations", return_value=[]):
        return CompleteObjectiveScorer(
            scene(), base, camera, coverage, backend=FakeBufferBackend())


def test_fake_buffer_matches_direct_exclusive_edge_pipeline_and_metadata():
    complete = (item("left", 0, 0), item("right", 3, 0))
    objective = scorer(complete)
    with patch("placement_v2_complete_objective.curve_observations", return_value=[]):
        result = objective(complete)

    rendered = objective.backend.render(
        objective.renderer, complete, objective.projection, objective.padded_origin)
    owners = instance_owner(rendered.triangle_owner, rendered.triangle_counts)
    tokens, _ = predicted_tokens(rendered.outline_rgb, rendered.mask, owners,
                                 spacing=objective.config.edge_spacing, include_seams=True)
    shifted = [type(token)(
        token_id=token.token_id, owner_ids=token.owner_ids,
        position=tuple(np.asarray(token.position) - objective.pad), tangent=token.tangent,
        visible=token.visible, shared_boundary_id=token.shared_boundary_id,
        feature_kind=token.feature_kind, material_class=token.material_class)
        for token in tokens]
    expected = score_correspondence(shifted, objective.observations,
                                    objective.config.correspondence)

    assert result.normalized_cost == expected.normalized_cost
    assert result.edge == expected
    assert result.components == {
        "edge_normalized_cost": expected.normalized_cost,
        "curve_normalized_cost": 0.0,
        "edge_weight": 1.0,
        "curve_weight": 0.0,
    }
    assert result.raster_evidence == {"backend": "fake", "item_count": 2}
    assert set(result.visible_owner_ids) == {"part:0", "part:1"}
    assert any(len(token.owner_ids) == 2 for token in shifted)  # actual shared seam


def test_new_part_occlusion_reports_hidden_physical_owner():
    # Later fake-rendered items overwrite earlier ones, as a depth buffer would.
    complete = (item("hidden", 0, 0), item("front", 0, 0))
    objective = scorer(complete)
    with patch("placement_v2_complete_objective.curve_observations", return_value=[]):
        result = objective(complete)
    assert result.hidden_owner_ids == ("part:0",)
    assert result.visible_owner_ids == ("part:1",)
    assert all(account.owner_id != "part:0" for account in result.edge.per_owner)


def test_off_native_prediction_is_kept_and_outside_declared_padding_is_refused():
    covered = item("off-native", -5, 0)
    objective = scorer((covered,))
    with patch("placement_v2_complete_objective.curve_observations", return_value=[]):
        result = objective((covered,))
    left_pad = result.padding["padding"][0]
    assert left_pad == 6
    assert result.predicted_token_count > 0
    assert any(int(token_id.split(":")[2]) < left_pad
               for token_id in result.edge.unmatched_predicted_token_ids)
    with patch("placement_v2_complete_objective.curve_observations", return_value=[]):
        with pytest.raises(ValueError, match="outside declared coverage padding"):
            objective((item("undeclared", -20, 0),))


def test_curve_channel_uses_sealed_normalized_half_weights():
    complete = (item("only", 0, 0),)
    camera = {"projection": [[1, 0, 0], [0, 1, 0]], "origin": [3, 3]}
    target = {"center": [1, 1], "axes": [4, 4], "angle": 0, "confidence": 1}
    predicted = {"center": [2, 2], "axes": [4, 4], "angle": 0, "confidence": 1}
    with patch("placement_v2_complete_objective.curve_observations",
               side_effect=[[target], [predicted]]):
        objective = CompleteObjectiveScorer(
            scene(), (), camera, complete, backend=FakeBufferBackend())
        result = objective(complete)
    assert result.edge_weight == result.curve_weight == 0.5
    assert result.normalized_cost == pytest.approx(
        0.5 * (result.edge.normalized_cost + result.curves["normalized_cost"]))
    assert result.curves["predicted_count"] == result.curves["observed_count"] == 1


def test_one_shot_wrapper_and_config_declaration_are_stable():
    complete = (item("only", 0, 0),)
    camera = {"projection": [[1, 0, 0], [0, 1, 0]], "origin": [3, 3]}
    with patch("placement_v2_complete_objective.curve_observations", return_value=[]):
        result = score_complete_objective(
            scene(), (), camera, complete, backend=FakeBufferBackend())
    assert result.config["protocol"] == "placement-v2-complete-objective-v1"
    assert result.config["correspondence"]["kind_mismatch_cost"] == 4.0
    assert np.isfinite(result.normalized_cost)
    with pytest.raises(ValueError, match="weights must sum to one"):
        CompleteObjectiveScorer(
            scene(), (), camera, complete,
            config=CompleteObjectiveConfig(edge_weight_with_curves=.7,
                                           curve_weight_with_curves=.7),
            backend=FakeBufferBackend())


def test_declared_larger_v8_padding_is_preserved_and_range_checked():
    complete = (item("only", 0, 0),)
    camera = {
        "projection": [[1, 0, 0], [0, 1, 0]], "origin": [3, 3],
        "padding": {"native_size": [12, 12], "padding": [6, 3, 3, 0],
                    "padded_size": [21, 15], "spacing": 3, "refused": False},
    }
    with patch("placement_v2_complete_objective.curve_observations", return_value=[]):
        objective = CompleteObjectiveScorer(
            scene(), (), camera, complete, backend=FakeBufferBackend())
        result = objective(complete)
    assert result.padding["padding"] == [6, 3, 3, 0]
    bad = dict(camera, padding=dict(camera["padding"], padding=[0, 0, 0, 0],
                                    padded_size=[12, 12]))
    with patch("placement_v2_complete_objective.curve_observations", return_value=[]):
        with pytest.raises(ValueError, match="does not cover the candidate domain"):
            CompleteObjectiveScorer(
                scene(), (), bad, (item("off", -2, 0),), backend=FakeBufferBackend())
