"""A/B the artwork-association layer over whole PDFs, one change at a time.

The two on-ramp defects round nine left named are association failures, not
placement failures, and a repair for either one is only admissible if it does
not silently move an association that already worked. This drives `crop_items`
over every non-inventory page of a PDF under each configuration and reports the
per-anchor status transitions, so a repair's cost and its benefit are separate
numbers.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, 'C:/git/clego')

CONFIGS = {
    'baseline': dict(group_fragments=False, exclusive=False, panels=False),
    'grouped': dict(group_fragments=True, exclusive=False, panels=False),
    'exclusive': dict(group_fragments=False, exclusive=True, panels=False),
    'panels': dict(group_fragments=False, exclusive=False, panels=True),
    'both': dict(group_fragments=True, exclusive=True, panels=False),
    'all': dict(group_fragments=True, exclusive=True, panels=True),
}


def anchors_of(pdf, configs):
    import pymupdf
    from pdf_crop_trial import crop_items, pdf_pli_panel_bounds
    from recon_extract import extract_e4 as e4
    from recon_extract.pdf_inventory import is_inventory_page
    rows = {name: {} for name in configs}
    with pymupdf.open(pdf) as doc:
        for page in range(len(doc)):
            if is_inventory_page(doc[page]):
                continue
            tokens = e4.page_tokens(doc, page, style=e4.ERA4)
            if not tokens['qty_small']:
                continue
            rgb = e4.render_page(doc, page)
            words = doc[page].get_text('words')
            bounds = pdf_pli_panel_bounds(doc[page], e4.ERA4.pli_bg)
            for name in configs:
                settings = dict(CONFIGS[name])
                panel_bounds = bounds if settings.pop('panels') else ()
                for record in crop_items(rgb, words, tokens['qty_small'], e4.ERA4.pli_bg,
                                         panel_bounds=panel_bounds, **settings):
                    rows[name][(page, tuple(record['anchor']), record['qty'])] = record
    return rows


def compare(rows, control, treatment):
    keys = sorted(set(rows[control]) | set(rows[treatment]), key=lambda k: (k[0], k[1]))
    moved, repaired, broken, same_box, changed_box = [], [], [], 0, []
    for key in keys:
        a, b = rows[control].get(key), rows[treatment].get(key)
        if a is None or b is None:
            moved.append(dict(anchor=list(key[1]), page=key[0], reason='anchor set differs'))
            continue
        resolved_a, resolved_b = 'bbox' in a, 'bbox' in b
        if resolved_a and resolved_b:
            if list(a['bbox']) == list(b['bbox']):
                same_box += 1
            else:
                changed_box.append(dict(page=key[0], qty=key[2], anchor=[round(v, 2) for v in key[1]],
                                        control=list(a['bbox']), treatment=list(b['bbox'])))
        elif resolved_b:
            repaired.append(dict(page=key[0], qty=key[2], was=a.get('unresolved'),
                                 bbox=list(b['bbox'])))
        elif resolved_a:
            broken.append(dict(page=key[0], qty=key[2], now=b.get('unresolved'),
                               was_bbox=list(a['bbox'])))
    return dict(control=control, treatment=treatment, anchors=len(keys),
                resolved_control=sum('bbox' in r for r in rows[control].values()),
                resolved_treatment=sum('bbox' in r for r in rows[treatment].values()),
                identical_boxes=same_box, changed_boxes=changed_box,
                repaired=repaired, broken=broken, anchor_set_differences=moved)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('pdfs', nargs='+', type=Path)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--configs', nargs='+', default=sorted(CONFIGS))
    args = parser.parse_args()
    report = dict(configs=args.configs, runtime_vlm_calls=0, truth_used=False, certified=False,
                  pdfs=[], limitations=[
                      'Association coverage is not identity accuracy and not placement accuracy',
                      'A repaired anchor still has to match an inventory slot downstream'])
    for pdf in args.pdfs:
        rows = anchors_of(pdf, args.configs)
        entry = dict(pdf=str(pdf), anchors=len(rows[args.configs[0]]),
                     resolved={name: sum('bbox' in r for r in rows[name].values())
                               for name in args.configs},
                     comparisons=[compare(rows, 'baseline', name)
                                  for name in args.configs if name != 'baseline'])
        report['pdfs'].append(entry)
        print(json.dumps(dict(pdf=pdf.name, anchors=entry['anchors'], resolved=entry['resolved'])),
              flush=True)
        for row in entry['comparisons']:
            print('  %-10s repaired %2d broken %2d changed-box %2d identical %3d'
                  % (row['treatment'], len(row['repaired']), len(row['broken']),
                     len(row['changed_boxes']), row['identical_boxes']), flush=True)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2))
    print(args.out)


if __name__ == '__main__':
    main()
