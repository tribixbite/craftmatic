"""Rank a construction's retained assemblies by their own bilateral symmetry.

A subassembly built from nothing has no parent body to register against, so the
only evidence its search has is one drawing - and round five measured that 40377
page 20's five-piece head reaches 1 of 5 with a 3-of-5 candidate retained and not
selected. This adds an evidence channel that does not come from the drawing at
all: a LEGO subassembly is usually bilaterally symmetric about its own plane, and
a candidate that is not says something about itself.

The signal is `placement_mirror_completion.detect_plane` applied to the candidate
*alone*, with the plane-agreement floor and the eligibility floor both relaxed,
because a five-piece head has only a handful of mirror-eligible parts. That
relaxation is exactly why this is reported as a measurement with its sample size
attached rather than shipped as a default: on 40377 page 20 the discrimination
rests on three eligible parts, so it is one part wide.

Evaluation-only in this form. The ranking itself reads nothing but the candidate
assemblies and universal CAD; the reference model scores the outcome afterwards.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))


def rank(directory, truth_path=None, minimum_eligible=2, band=None):
    """Rank retained constructions by their own bilateral plane agreement.

    `truth_path` is optional and is used for nothing but *reporting* the
    structural score of each candidate. The selection reads only the candidate
    assemblies and universal CAD, so omitting the reference gives the identical
    pick with no reference anywhere in the loop - which is what a production
    (and an autonomous-measurement) run needs.
    """
    from placement_arrow_contacts import read_items
    from placement_diagnose_alias_poses import (canonicalize, verified_local_symmetries,
                                                yaw_equivalent_score)
    from placement_mirror_completion import detect_plane
    from placement_part_library import PartLibrary
    from placement_population_table import canonical_name
    from placement_seated_contact import seated_contact
    from pose_score import read_parts
    directory = Path(directory)
    result = json.loads((directory / 'results.json').read_text())
    if result.get('truth_used') is not False:
        raise ValueError('Run artifacts lack truth-free provenance')
    library = PartLibrary()
    truth = None if truth_path is None else canonicalize(read_parts(truth_path), library)[0]
    rows = []
    for entry in result['results']:
        path = directory / entry['file']
        if not path.is_file():
            continue
        items = [(canonical_name(part, library), int(color), np.asarray(T, float))
                 for part, color, T in read_items(path)]
        plane = detect_plane(items, minimum_fraction=0.0, minimum_eligible=minimum_eligible)
        structural = None
        if truth is not None:
            recon, _ = canonicalize(read_parts(path), library)
            structural = int(yaw_equivalent_score(recon, truth, verified_local_symmetries)['matched'])
        seating = seated_contact(items[:1], items[1:]) if len(items) > 1 else {}
        rows.append(dict(file=entry['file'], score=float(entry['evidence']['score']),
                         structural=structural, parts=len(items),
                         plane_fraction=(plane or {}).get('fraction'),
                         plane_matched=(plane or {}).get('matched'),
                         plane_eligible=(plane or {}).get('eligible'),
                         engaged=seating.get('engaged'), contacts=seating.get('contacts')))
    if not rows:
        raise ValueError('The construction retained no candidate assemblies')
    selected = max(rows, key=lambda row: row['score'])
    window = rows if band is None else [row for row in rows
                                        if row['score'] >= selected['score'] - band]
    reranked = max(window, key=lambda row: ((row['plane_fraction'] or 0.0), row['score']))
    return dict(directory=str(directory),
                truth=None if truth_path is None else str(truth_path), rows=rows,
                candidates=len(rows), band=band, eligible_for_rerank=len(window),
                selected=selected, symmetry_reranked=reranked,
                delta=(None if truth is None
                       else reranked['structural'] - selected['structural']),
                oracle_best=(None if truth is None
                             else max(row['structural'] for row in rows)),
                minimum_eligible=minimum_eligible,
                truth_used_at_runtime=False, runtime_vlm_calls=0, certified=False,
                scope='The ranking reads only the candidate assemblies and universal CAD. The '
                      'reference model scores the outcome afterwards and selects nothing.',
                limitations='The plane-agreement floor and the eligibility floor are both relaxed '
                            'to make a five-piece subassembly measurable at all, so the '
                            'discrimination can be one part wide; the eligible count is reported '
                            'beside every fraction for that reason.')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('directory', type=Path)
    parser.add_argument('--truth', default=None,
                        help='Optional reference model, used only to REPORT each candidate\'s '
                             'structural score; the selection never reads it')
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--minimum-eligible', type=int, default=2)
    parser.add_argument('--band', type=float, default=None)
    args = parser.parse_args()
    record = rank(args.directory, args.truth, args.minimum_eligible, args.band)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(record, indent=2))
    print(f"{'file':<14} {'score':>8} {'struct':>7} {'plane':>7} {'m/e':>7} {'engaged':>8}")
    for row in sorted(record['rows'], key=lambda r: -r['score']):
        fraction = row['plane_fraction']
        ratio = '%s/%s' % (row['plane_matched'], row['plane_eligible'])
        print(f"{row['file']:<14} {row['score']:>8.4f} {str(row['structural']):>7} "
              f"{(('%.3f' % fraction) if fraction is not None else '-'):>7} "
              f"{ratio:>7} {str(row['engaged']):>8}")
    print(f"selected {record['selected']['file']} -> {record['selected']['structural']}; "
          f"symmetry-reranked {record['symmetry_reranked']['file']} -> "
          f"{record['symmetry_reranked']['structural']}; "
          f"delta {'-' if record['delta'] is None else '%+d' % record['delta']}; "
          f"oracle {record['oracle_best']}")
    print(args.out)


if __name__ == '__main__':
    main()
