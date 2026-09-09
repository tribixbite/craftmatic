"""Does a changed crop box change what the MATCHER sees?

`crop_items` reports a box; the identity stage feeds `canonical(clean[box])` to
the frozen encoder, and `canonical` re-crops to the largest foreground component
before resizing. So a box that grows around the same artwork can be a no-op
downstream, and a box that changes because a DIFFERENT component was chosen
cannot be. This checks every box an A/B reports as changed, both ways, and
reports byte-equality of the matcher input rather than of the box.

Evaluation of a code change, not of a model: no reference, no encoder, no GPU.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, 'C:/git/clego')


def check(reports, treatment='all'):
    import pymupdf
    from matching_trials import canonical
    from pdf_crop_trial import artwork_pixels
    from recon_extract import extract_e4 as e4
    cases = []
    for path in reports:
        report = json.loads(Path(path).read_text())
        for entry in report['pdfs']:
            for comparison in entry['comparisons']:
                if comparison['treatment'] != treatment:
                    continue
                for row in comparison['changed_boxes']:
                    cases.append(dict(row, pdf=entry['pdf']))
    rows = []
    by_pdf = {}
    for case in cases:
        by_pdf.setdefault(case['pdf'], []).append(case)
    for pdf, group in by_pdf.items():
        with pymupdf.open(pdf) as doc:
            pages = {}
            for case in group:
                page = case['page']
                if page not in pages:
                    rgb = e4.render_page(doc, page)
                    pages[page] = artwork_pixels(rgb, doc[page].get_text('words'), e4.ERA4.pli_bg)
                clean = pages[page]
                images = []
                for box in (case['control'], case['treatment']):
                    x0, y0, x1, y1 = box
                    images.append(canonical(clean[y0:y1, x0:x1]))
                before, after = images
                row = dict(pdf=Path(pdf).name, page=page, qty=case['qty'],
                           control=case['control'], treatment=case['treatment'],
                           control_usable=before is not None, treatment_usable=after is not None)
                if before is not None and after is not None:
                    difference = np.abs(before.astype(int) - after.astype(int))
                    row.update(identical=bool((difference == 0).all()),
                               max_abs_difference=int(difference.max()),
                               changed_pixel_fraction=float((difference.sum(2) > 0).mean()))
                rows.append(row)
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('reports', nargs='+', type=Path)
    parser.add_argument('--treatment', default='all')
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    rows = check(args.reports, args.treatment)
    identical = sum(1 for row in rows if row.get('identical'))
    repaired = sum(1 for row in rows if not row['control_usable'] and row['treatment_usable'])
    lost = sum(1 for row in rows if row['control_usable'] and not row['treatment_usable'])
    for row in rows:
        print('%-16s p%-3d %sx  %s -> %s  %s'
              % (row['pdf'], row['page'], row['qty'], row['control'], row['treatment'],
                 'IDENTICAL' if row.get('identical')
                 else ('repaired (no usable crop before)' if not row['control_usable']
                       else ('LOST' if not row['treatment_usable']
                             else 'differs by %.4f of pixels' % row['changed_pixel_fraction']))))
    print('\n%d changed boxes: %d byte-identical to the matcher, %d newly usable, %d lost, '
          '%d genuinely different' % (len(rows), identical, repaired, lost,
                                      len(rows) - identical - repaired - lost))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(dict(rows=rows, identical=identical, repaired=repaired,
                                        lost=lost, truth_used=False, runtime_vlm_calls=0), indent=2))
    print(args.out)


if __name__ == '__main__':
    main()
