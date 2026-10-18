"""Offline checks for withholding pieces a construction's drawing does not contain."""
import numpy as np
import pytest

import placement_undrawn_pieces as undrawn_module
from placement_undrawn_pieces import split_pieces, undrawn


PIECES = [('3023b', 15), ('3069b', 191), ('6091', 191), ('6091', 191), ('3023b', 191),
          ('98138pb072', 0), ('98138pb072', 0)]


def fake_measurements(monkeypatch, counts, areas):
    """Pin the two measurements so the rule itself is what is under test."""
    # `drawn_class_pixels` grew a third `context_colors` argument when the rule
    # learned to classify against the body's colours as well as the page's own;
    # the stand-in has to accept it or the rule under test never runs.
    monkeypatch.setattr(undrawn_module, 'drawn_class_pixels',
                        lambda scene, colors, context_colors=(): (dict(counts),
                                                                  sum(counts.values()), 0))
    import placement_exploded_page
    monkeypatch.setattr(placement_exploded_page, 'silhouette_area_range',
                        lambda part, color, projection, resolver=None: (areas[color],
                                                                        areas[color] * 2))


def test_page_twenty_withholds_only_the_colour_its_drawing_lacks(monkeypatch):
    # 40377 page index 20, xref 164, measured: 6,523 orange, 509 white, 57 black
    # against a 509-pixel round tile, a 999-pixel curved brick and a 1,117-pixel plate.
    fake_measurements(monkeypatch, {0: 57, 15: 509, 191: 6523},
                      {0: 509.5, 15: 1117.1, 191: 999.0})
    record = undrawn(None, PIECES, np.eye(2, 3))
    assert record['withheld_keys'] == [('98138pb072', 0)]
    assert len(record['kept']) == 5
    black = next(row for row in record['colors'] if row['color'] == 0)
    assert black['absent'] and round(black['drawn_share'], 3) == 0.112
    assert all(not row['absent'] for row in record['colors'] if row['color'] != 0)


def test_page_thirty_one_keeps_every_piece_because_black_is_drawn(monkeypatch):
    # 40377 page index 31 draws four black parts on a black plate: 24,064 black
    # pixels against a 1,504-pixel piece, a share of 16.
    pieces = [('2431', 0), ('3958', 0), ('87079', 0), ('92593', 0)]
    fake_measurements(monkeypatch, {0: 24064}, {0: 1503.6})
    record = undrawn(None, pieces, np.eye(2, 3))
    assert record['withheld_keys'] == []
    assert 'enough drawn ink' in record['reason']


def test_it_refuses_rather_than_leaving_fewer_than_two_pieces(monkeypatch):
    # Withholding both absent colours would leave one piece, which is not a
    # construction, so the drawing is not treated as evidence at all.
    pieces = [('3023b', 15), ('3069b', 191), ('98138pb072', 0)]
    fake_measurements(monkeypatch, {0: 1, 15: 1, 191: 6000},
                      {0: 509.5, 15: 1117.1, 191: 999.0})
    record = undrawn(None, pieces, np.eye(2, 3))
    assert record['withheld_keys'] == []
    assert 'fewer than two pieces' in record['reason']
    assert [row['absent'] for row in record['colors'] if row['color'] in (0, 15)] == [True, True]


def test_the_threshold_is_a_share_of_one_piece_not_of_the_drawing(monkeypatch):
    # Ink just under and just over a quarter of a single piece's silhouette.
    fake_measurements(monkeypatch, {0: 127, 15: 509, 191: 6523},
                      {0: 509.5, 15: 1117.1, 191: 999.0})
    assert undrawn(None, PIECES, np.eye(2, 3))['withheld_keys'] == [('98138pb072', 0)]
    fake_measurements(monkeypatch, {0: 128, 15: 509, 191: 6523},
                      {0: 509.5, 15: 1117.1, 191: 999.0})
    assert undrawn(None, PIECES, np.eye(2, 3))['withheld_keys'] == []


def test_split_preserves_order_and_multiplicity(monkeypatch):
    fake_measurements(monkeypatch, {0: 57, 15: 509, 191: 6523},
                      {0: 509.5, 15: 1117.1, 191: 999.0})
    kept, held = split_pieces(PIECES, undrawn(None, PIECES, np.eye(2, 3)))
    assert held == [('98138pb072', 0), ('98138pb072', 0)]
    assert kept == PIECES[:5]


def test_invalid_share_is_rejected():
    with pytest.raises(ValueError):
        undrawn(None, PIECES, np.eye(2, 3), min_share=0.0)
    with pytest.raises(ValueError):
        undrawn(None, PIECES, np.eye(2, 3), min_share=1.0)
