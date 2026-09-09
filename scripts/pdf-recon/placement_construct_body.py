"""Build an assembly from one drawing when there is no body to register against.

Every page the driver can handle registers the assembly it already has against
the drawing. The first page of a booklet has no such assembly, and neither does
a page that starts a separate subassembly - 41624 page index 2 and 40377 pages
13 and 20. Those pages were the reason the driver needed a construction supplied
to it.

The observation that makes them ordinary pages is that the reconstruction's
global frame is free: evaluation aligns whole frames, and `placement_body_
registration` already sweeps all 24 cube rotations of the *camera*, which is the
same set of hypotheses as rotating the assembly. So one allocated piece can be
nailed to the identity transform without loss of generality, and the page then
becomes an addition of the remaining pieces to a one-piece body - exactly what
`place_page` already does, including its exploded-piece handling.

What is not free is *which* piece to nail down. A root must be distinctive
enough for its own template to register, so roots are tried in descending drawn
area and the best complete result by the page's own image score is kept. Every
root that is tried is recorded with its outcome.

PDF pixels, PDF text allocations and universal CAD only. No reference model, set
inventory, manual pose or VLM participates, and nothing here is certified.
"""
import argparse
import hashlib
import json
import shutil
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))


def root_order(pieces, projection):
    """Distinct allocated pieces, largest drawn area first."""
    from placement_exploded_page import silhouette_area_range
    distinct = list(dict.fromkeys((str(part), int(color)) for part, color in pieces))
    areas = {key: silhouette_area_range(key[0], key[1], projection)[1] for key in distinct}
    return sorted(distinct, key=lambda key: -areas[key]), areas


def write_root(path, part, color):
    path.parent.mkdir(parents=True, exist_ok=True)
    transform = np.eye(4)
    line = ('1 ' + str(int(color)) + ' ' + ' '.join(
        f'{v:.8g}' for v in np.r_[transform[:3, 3], transform[:3, :3].flatten()])
        + ' ' + str(part) + '.dat')
    path.write_text('0 Quarantined PDF body construction root; uncertified\n' + line + '\n')
    return [(str(part), int(color), transform)]


def construct(pdf, page, allocation_run, out, options, roots=2, prescan_pages=()):
    """Construct this page's body and return (status, detail, directory)."""
    from placement_autodrive import nearest_prescan, place_page, prescan_cameras, write_atomic
    from placement_page_camera import page_camera
    from placement_pdf_group_evidence import load_allocations
    out.mkdir(parents=True, exist_ok=True)
    pieces, provenance = load_allocations(pdf, page, allocation_run)
    if len(pieces) < 2:
        return ('construction_unsupported',
                dict(reason='A construction needs at least two allocated pieces',
                     allocated=len(pieces)), None)
    # An empty prior, not None: there is no body yet, but the page's own
    # allocation still supplies the CAD palette that protects real red and green
    # parts from the arrow filter, and the drawing must still be segmented.
    camera = page_camera(pdf, page, allocation_run, out / 'camera', prior_parts=())
    write_atomic(out / 'camera.json', json.dumps(camera, indent=2, default=str))
    matrices = [h['matrix'] for record in camera.get('native_scenes', ())
                for h in record['multirow']['hypotheses']]
    # A first page draws few pieces and can expose no stud row at all - 41624
    # page index 2 is exactly that. Later pages of the same booklet draw the
    # same assembly, so their measured cameras are PDF-derived proposals, and
    # the page pipeline already knows how to borrow one.
    borrowed_from, prescan = None, None
    if prescan_pages:
        prescan = prescan_cameras(pdf, allocation_run,
                                  [p for p in prescan_pages if p != page], [], out / 'prescan')
        if not matrices:
            matrices, borrowed_from = nearest_prescan(prescan, page)
    if not matrices:
        return ('construction_camera_unsupported',
                dict(reason=camera.get('status'), scene_kinds=camera.get('scene_kinds'),
                     prescan_pages=sorted(prescan) if prescan else []), None)
    order, areas = root_order(pieces, matrices[0])
    attempts, best = [], None
    for index, root in enumerate(order[:max(1, roots)]):
        attempt = out / f'root-{index:02d}'
        if attempt.exists():
            shutil.rmtree(attempt)
        attempt.mkdir(parents=True)
        base_items = write_root(attempt / 'model.ldr', *root)
        remainder = list(pieces)
        remainder.remove(root)
        started = time.perf_counter()
        try:
            status, detail, placement, _, scale, _registration = place_page(
                pdf, page, allocation_run, attempt / 'model.ldr', attempt / 'page',
                options, prescan=prescan, pieces_override=remainder)
        except Exception as error:                                  # noqa: BLE001
            attempts.append(dict(root=list(root), status='construction_error',
                                 error=f'{type(error).__name__}: {error}'))
            continue
        record = dict(root=list(root), root_drawn_area=areas[root], status=status,
                      seconds=time.perf_counter() - started,
                      score=(detail or {}).get('score'), directory=str(placement) if placement else None,
                      selected_parts=(detail or {}).get('selected_parts'),
                      exploded_withheld=(detail or {}).get('exploded_withheld'))
        attempts.append(record)
        if status == 'placed' and (best is None or record['score'] > best['score']):
            best = record
    result = dict(pdf=str(pdf), page=page, pdf_sha256=provenance['pdf_sha256'],
                  allocation_run=str(allocation_run), allocated_pieces=[list(p) for p in pieces],
                  roots_considered=[list(r) for r in order], attempts=attempts,
                  borrowed_camera_page=borrowed_from,
                  prescan_pages=sorted(prescan) if prescan else [],
                  selected=best, truth_used=False, runtime_vlm_calls=0, certified=False,
                  protocol='One allocated piece fixed at the identity transform, the rest placed '
                           'by the ordinary page pipeline; camera rotations cover every root '
                           'orientation because the reconstruction frame is free',
                  limitations='Roots are tried in drawn-area order up to an explicit limit, so a '
                              'construction whose only registrable root is small can be missed. '
                              'A one-piece body registers weakly, and containment barely '
                              'constrains it. Nothing here is certified.')
    write_atomic(out / 'construction.json', json.dumps(result, indent=2, default=str))
    if best is None:
        return 'construction_failed', result, None
    # Publish the selected construction as an ordinary placement directory so a
    # driver can consume it with --base-run or --group-run unchanged.
    selected = out / 'construction'
    if selected.exists():
        shutil.rmtree(selected)
    shutil.copytree(best['directory'], selected)
    result['construction'] = str(selected)
    write_atomic(out / 'construction.json', json.dumps(result, indent=2, default=str))
    return 'constructed', result, selected


if __name__ == '__main__':
    from placement_autodrive import build_options, add_page_options
    parser = argparse.ArgumentParser()
    parser.add_argument('--pdf', type=Path, required=True)
    parser.add_argument('--allocation-run', type=Path, required=True)
    parser.add_argument('--page', type=int, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--roots', type=int, default=2)
    parser.add_argument('--prescan-pages', type=int, nargs='+', default=[],
                        help='Pages whose own stud-row cameras may be borrowed when this page '
                             'exposes none of its own')
    add_page_options(parser)
    args = parser.parse_args()
    status, detail, directory = construct(args.pdf, args.page, args.allocation_run, args.out,
                                          build_options(args), args.roots, args.prescan_pages)
    print(json.dumps(dict(status=status, construction=str(directory) if directory else None,
                          selected=detail.get('selected') if isinstance(detail, dict) else None,
                          attempts=[a for a in (detail.get('attempts') or [])]
                          if isinstance(detail, dict) else None), indent=1, default=str))
