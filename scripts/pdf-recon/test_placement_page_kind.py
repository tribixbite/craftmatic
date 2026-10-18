"""Offline checks for measured page-kind classification.

Fixture numbers are the largest non-panel drawing per page of 40377, measured
from the PDF, together with the body silhouette the driver renders at that
point in the build.
"""
import pytest

from placement_page_kind import KINDS, classify

BODY_PAGES = {12: 39715, 14: 42432, 15: 50250, 16: 52304, 17: 65869,
              18: 55568, 19: 56043, 21: 56986, 22: 59535, 32: 83378}
SUBASSEMBLY_PAGES = {13: 18066, 20: 8136}


@pytest.mark.parametrize('page,area', sorted(BODY_PAGES.items()))
def test_body_pages_are_ordinary_additions(page, area):
    kind, evidence = classify([area], body_area=40000, allocated=2)
    assert kind == 'addition' and evidence['shows_body'] is True


@pytest.mark.parametrize('page,area', sorted(SUBASSEMBLY_PAGES.items()))
def test_pages_without_a_body_view_are_subassemblies(page, area):
    kind, evidence = classify([area], body_area=40000, allocated=3)
    assert kind == 'subassembly' and evidence['shows_body'] is False


def test_page_14_attaches_because_it_allocates_nothing_and_draws_the_body():
    kind, _ = classify([42432], body_area=39715, allocated=0, pending=True)
    assert kind == 'attachment'


def test_the_same_page_without_a_pending_body_is_simply_unallocated():
    kind, _ = classify([42432], body_area=39715, allocated=0, pending=False)
    assert kind == 'no_allocation'


def test_a_pending_body_does_not_attach_on_a_page_with_no_body_view():
    kind, _ = classify([8136], body_area=56043, allocated=0, pending=True)
    assert kind == 'no_allocation'


def test_an_unmeasurable_body_abstains_to_the_addition_path():
    kind, evidence = classify([100], body_area=0, allocated=2)
    assert kind == 'addition' and evidence['shows_body'] is False


def test_the_largest_drawing_decides_not_the_first():
    kind, evidence = classify([900, 52304, 1200], body_area=50000, allocated=1)
    assert kind == 'addition' and evidence['largest_scene_area'] == 52304


def test_a_page_with_no_drawing_and_pieces_is_a_subassembly():
    kind, _ = classify([], body_area=50000, allocated=2)
    assert kind == 'subassembly'


def test_ratio_must_be_a_proper_fraction():
    for bad in (0.0, -0.1, 1.5):
        with pytest.raises(ValueError):
            classify([1], 1, 1, ratio=bad)


def test_every_returned_kind_is_declared():
    for args in (([50000], 40000, 2), ([50000], 40000, 0), ([100], 40000, 2), ([100], 40000, 0)):
        assert classify(*args)[0] in KINDS
