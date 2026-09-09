"""Offline checks for PDF-icon confirmation of bridged element identities."""
import numpy as np
import pytest

from placement_element_bridge import confirm, dominant_color


def icon(base, outline=(20, 20, 20), background=(208, 224, 240), size=40):
    """Flat-coloured part with a dark outline on the page background."""
    image = np.zeros((size, size, 3), np.uint8)
    image[:, :] = background
    image[8:32, 8:32] = outline
    image[10:30, 10:30] = base
    return image


def test_modal_colour_survives_a_dark_outline():
    observed, evidence = dominant_color(icon((250, 250, 250)))
    assert np.allclose(observed, (250, 250, 250), atol=1)
    assert evidence['foreground_pixels'] > 0
    # The mean over the same foreground is dragged toward the outline; this is
    # the error that first resolved white 99206 to Light Bluish Grey.
    mean = np.asarray(icon((250, 250, 250)), float)[8:32, 8:32].reshape(-1, 3).mean(0)
    assert mean[0] < 230


def test_black_part_reads_black_not_outline_grey():
    observed, _ = dominant_color(icon((16, 16, 16), outline=(90, 90, 90)))
    assert np.allclose(observed, (16, 16, 16), atol=1)


def test_uniform_background_icon_abstains():
    plain = np.full((12, 12, 3), 208, np.uint8)
    observed, evidence = dominant_color(plain)
    assert observed is None and evidence['foreground_pixels'] == 0


def test_confirm_picks_the_separated_nearest_colour():
    choices = [dict(part='99206', color='15'), dict(part='99206', color='71'),
               dict(part='99206', color='0')]
    rows, evidence = confirm(choices, icon((250, 250, 250)))
    assert rows[0]['color'] == '15' and rows[0]['confirmed'] is True
    assert all(not row['confirmed'] for row in rows[1:])
    assert evidence['separated'] and evidence['single_part']


def test_confirm_refuses_when_two_candidates_are_close():
    choices = [dict(part='X', color='15'), dict(part='X', color='79')]  # white vs milky white
    rows, _ = confirm(choices, icon((250, 250, 250)))
    assert all(not row['confirmed'] for row in rows), 'nearby colours must not resolve'


def test_confirm_never_settles_a_disputed_part_by_colour():
    choices = [dict(part='A', color='15'), dict(part='B', color='0')]
    rows, evidence = confirm(choices, icon((250, 250, 250)))
    assert evidence['single_part'] is False
    assert all(not row['confirmed'] for row in rows)


def test_confirm_abstains_on_an_empty_icon():
    rows, evidence = confirm([dict(part='X', color='0')], np.full((8, 8, 3), 208, np.uint8))
    assert rows == [] and 'reason' in evidence


def test_single_candidate_is_confirmed_without_a_runner_up():
    rows, _ = confirm([dict(part='X', color='0')], icon((16, 16, 16), outline=(90, 90, 90)))
    assert rows[0]['confirmed'] is True


@pytest.mark.parametrize('color,expected', [((201, 26, 9), '4'), ((242, 205, 55), '14'),
                                            ((160, 165, 169), '71')])
def test_common_ldraw_colours_are_recovered_from_flat_icons(color, expected):
    choices = [dict(part='X', color=c) for c in ('0', '4', '14', '15', '71', '72')]
    rows, _ = confirm(choices, icon(color))
    assert rows[0]['color'] == expected and rows[0]['confirmed'] is True
