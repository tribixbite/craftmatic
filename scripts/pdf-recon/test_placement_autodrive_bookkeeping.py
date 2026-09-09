"""Offline tests for the driver's unplaced-allocation bookkeeping.

No PDF, CAD, GPU or reference model. The property under test is the one that
decides whether the camera gate can be used at all on a page after a skipped one:
a page the drive did not place still owes its pieces to every later page, and an
attachment discharges the pages whose subassembly it consumed.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from placement_autodrive import page_allocation, projection_scale, update_outstanding


def test_a_page_that_did_not_place_keeps_owing_its_pieces():
    outstanding = {}
    assert update_outstanding(outstanding, 20, False, [('3023b', 15), ('6091', 191)]) == [
        ('3023b', 15), ('6091', 191)]
    # A later page adds its own two, places them, and page 20's are still owed.
    assert update_outstanding(outstanding, 22, True) == [('3023b', 15), ('6091', 191)]


def test_pieces_are_returned_in_page_order_whatever_the_insertion_order():
    outstanding = {}
    update_outstanding(outstanding, 31, False, [('3958', 0)])
    result = update_outstanding(outstanding, 20, False, [('6091', 191)])
    assert result == [('6091', 191), ('3958', 0)]


def test_placing_a_page_discharges_it():
    outstanding = {}
    update_outstanding(outstanding, 20, False, [('6091', 191)])
    assert update_outstanding(outstanding, 20, True) == []


def test_an_attachment_discharges_the_page_it_consumed():
    outstanding = {}
    update_outstanding(outstanding, 20, False, [('6091', 191), ('3069b', 191)])
    update_outstanding(outstanding, 21, False, [])
    assert update_outstanding(outstanding, 21, True, (), [20]) == []


def test_an_unplaced_page_with_no_allocation_owes_nothing():
    outstanding = {}
    assert update_outstanding(outstanding, 21, False, []) == []
    assert outstanding == {}


def test_pieces_are_normalised_to_string_part_and_integer_colour():
    outstanding = {}
    result = update_outstanding(outstanding, 20, False, [(3023, '15')])
    assert result == [('3023', 15)]


def test_a_page_outside_the_allocation_scope_yields_nothing_rather_than_raising():
    missing = Path('output/pdf-placement-diagnosis/does-not-exist-for-tests')
    assert page_allocation(Path('does-not-exist.pdf'), 99, missing) == []


def test_projection_scale_is_the_mean_singular_value():
    assert abs(projection_scale([[2., 0., 0.], [0., 2., 0.]]) - 2.0) < 1e-12


if __name__ == '__main__':
    failures = 0
    for name, function in sorted(globals().items()):
        if name.startswith('test_') and callable(function):
            try:
                function()
                print('ok  ', name)
            except AssertionError as error:
                failures += 1
                print('FAIL', name, error)
    print('failures', failures)
    sys.exit(1 if failures else 0)
