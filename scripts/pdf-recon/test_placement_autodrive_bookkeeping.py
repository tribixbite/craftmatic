"""Offline tests for the driver's unplaced-allocation bookkeeping.

No PDF, CAD, GPU or reference model. The property under test is the one that
decides whether the camera gate can be used at all on a page after a skipped one:
a page the drive did not place still owes its pieces to every later page, and an
attachment discharges the pages whose subassembly it consumed.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from placement_autodrive import (page_allocation, page_withheld, projection_scale,
                                 update_outstanding)


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



def test_an_excluded_construction_still_owes_its_pieces():
    # `construction_excluded` is not `placed`, so page 20's seven pieces stay
    # attributable to page 20 and the camera gate on pages 22 to 30 does not
    # charge their ink to whatever two pieces those pages happen to add.
    outstanding = {}
    pieces = [('3023b', 15), ('3069b', 191), ('6091', 191), ('6091', 191),
              ('3023b', 191), ('98138pb072', 0), ('98138pb072', 0)]
    assert update_outstanding(outstanding, 20, False, pieces) == pieces
    assert update_outstanding(outstanding, 23, True) == pieces


def test_the_exclusion_option_is_parsed_per_page():
    from placement_autodrive import add_page_options, build_options
    import argparse
    parser = add_page_options(argparse.ArgumentParser())
    args = parser.parse_args(['--exclude-construction', '20=1 of 5 structural',
                              '--exclude-construction', '31=1 of 4 structural'])
    options = build_options(args)
    assert options['excluded_constructions'] == {'20': '1 of 5 structural',
                                                 '31': '1 of 4 structural'}


def test_a_withheld_mould_class_is_attributable_without_being_allocated():
    # `--mould-policy withhold` admits the page and declares the class row. The
    # piece is drawn, so the gate has to be allowed to attribute its ink; it is
    # not allocated, so the search never places it and no filename is guessed.
    import json
    import tempfile
    with tempfile.TemporaryDirectory() as directory:
        run = Path(directory)
        (run / 'global-assignment.json').write_text(json.dumps(dict(
            evidence=[], withheld_classes=[
                dict(page=8, qty=1, canonical='15573', color=72,
                     members=['15573', '3794a', '3794b']),
                dict(page=10, qty=2, canonical='4032a', color=25,
                     members=['4032a', '4032b'])])))
        assert page_withheld(8, run) == [('15573', 72)]
        assert page_withheld(10, run) == [('4032a', 25), ('4032a', 25)]
        assert page_withheld(11, run) == []
    # An allocation written before the policy existed has no such rows and must
    # not become an error.
    assert page_withheld(8, Path(directory)) == []


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
