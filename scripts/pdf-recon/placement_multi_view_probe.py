"""Does a SECOND page's view break a construction's single-view score tie?

Round nine measured 41601's opening ending in a 24-way EXACT tie whose members
are geometrically different assemblies - any two share on average 3.5 of 7
placements - and whose 3-of-7 class the objective ranks above a 6-of-7 class by
0.0132. Round nine's costed plan named the probe: re-score the construction's
retained bodies under a LATER page's accepted registration and ask whether the
tie breaks, and in which direction.

That is what this does, and only that. It rebuilds a driven page's own scene,
mask decision, camera and native origin (`placement_retention_stage.rebuild_view`
- self-checked against the run's recorded bank size and coarse score), then
scores each retained construction body as a fixed assembly under that view
(`fixed_native_score`, the same call the search's own exchange uses). No search,
no re-registration, no reference: the reference scores the OUTCOME afterwards.

The honest caveat, stated because it bounds the conclusion: a page's accepted
registration was propagated from the body that run actually drove, so scoring a
different body under it is biased toward that lineage. The probe therefore runs
under EVERY registration it is given - two lineages of the same fixture - and a
conclusion is only claimed where they agree.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))


def body_rows(directory, truth=None):
    """Retained construction bodies with their own objective score and class."""
    import placement_backtrack as backtrack
    census = backtrack.score_classes(directory)
    rows = []
    for index, entry in enumerate(census['classes']):
        for member in entry['members']:
            rows.append(dict(file=member['file'], rank=member['rank'], score=entry['score'],
                             score_class=index, class_width=len(entry['members'])))
    if truth is not None:
        from placement_arrow_contacts import read_items  # noqa: F401  (kept for parity)
        from placement_diagnose_alias_poses import (canonicalize, verified_local_symmetries,
                                                    yaw_equivalent_score)
        from placement_part_library import PartLibrary
        from pose_score import read_parts
        library = PartLibrary()
        reference, _ = canonicalize(read_parts(truth), library)
        for row in rows:
            candidate, _ = canonicalize(read_parts(Path(directory) / row['file']), library)
            row['structural'] = int(yaw_equivalent_score(candidate, reference,
                                                         verified_local_symmetries)['matched'])
    return rows


def probe(construction, run, page, rows, view=None):
    """Every body's native score under one driven page's accepted view."""
    from placement_arrow_contacts import read_items
    from placement_mixed_batch_search import fixed_native_score
    from placement_retention_stage import rebuild_view
    rebuilt = rebuild_view(Path(run), int(page), view)
    scorer, projection, origin = rebuilt['scorer'], rebuilt['projection'], rebuilt['origin']
    scores = []
    for row in rows:
        items = [(str(part), int(color), np.asarray(matrix, float))
                 for part, color, matrix in read_items(Path(construction) / row['file'])]
        evidence = fixed_native_score(scorer, items, projection, origin)
        scores.append(dict(row, native_score=float(evidence['score'])))
    return dict(run=str(run), page=int(page), view=int(rebuilt['view']),
                driven_body=rebuilt['registry'].get('base_source'),
                registration_source=rebuilt['result'].get('registration_source'),
                rows=scores)


def summarise(record):
    """Class-level statistics of one probe, and whether it separates the classes."""
    classes = {}
    for row in record['rows']:
        classes.setdefault(row['score_class'], []).append(row)
    summary = []
    for index in sorted(classes):
        members = classes[index]
        values = [row['native_score'] for row in members]
        structural = [row.get('structural') for row in members if row.get('structural') is not None]
        summary.append(dict(score_class=index, members=len(members),
                            construction_score=members[0]['score'],
                            native_min=min(values), native_max=max(values),
                            native_mean=float(np.mean(values)),
                            distinct_native=len({round(value, 12) for value in values}),
                            structural=sorted(set(structural)) or None))
    separated = None
    if len(summary) >= 2:
        first, second = summary[0], summary[1]
        separated = (first['native_max'] < second['native_min']
                     or second['native_max'] < first['native_min'])
    best = max(record['rows'], key=lambda row: (row['native_score'], -row['rank']))
    return dict(classes=summary, classes_separated=separated,
                best_body=best['file'], best_class=best['score_class'],
                best_structural=best.get('structural'),
                tie_width_at_best=sum(1 for row in record['rows']
                                      if abs(row['native_score'] - best['native_score']) < 1e-12))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--construction', type=Path, required=True)
    parser.add_argument('--probe', action='append', default=[], metavar='RUN=PAGE',
                        help='A completed drive and one of its placed pages to score under')
    parser.add_argument('--truth', default=None, help='Evaluation only; scores the outcome')
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    rows = body_rows(args.construction, args.truth)
    print('%d retained bodies, %d score classes'
          % (len(rows), len({row['score_class'] for row in rows})), flush=True)
    records = []
    for spec in args.probe:
        run, _, page = spec.partition('=')
        record = probe(args.construction, run, page, rows)
        record['summary'] = summarise(record)
        records.append(record)
        print('\nprobe %s page %s (view %d)' % (Path(run).name, page, record['view']), flush=True)
        for entry in record['summary']['classes']:
            print('  class %d  n=%2d  construction %.6f  native %.6f..%.6f  distinct %2d  '
                  'structural %s' % (entry['score_class'], entry['members'],
                                     entry['construction_score'], entry['native_min'],
                                     entry['native_max'], entry['distinct_native'],
                                     entry['structural']), flush=True)
        print('  separated=%s  best=%s (class %s, structural %s), tie width %d'
              % (record['summary']['classes_separated'], record['summary']['best_body'],
                 record['summary']['best_class'], record['summary']['best_structural'],
                 record['summary']['tie_width_at_best']), flush=True)
    agree = None
    if len(records) > 1:
        picks = {record['summary']['best_class'] for record in records}
        agree = len(picks) == 1
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(
        dict(construction=str(args.construction), truth=args.truth, bodies=rows,
             probes=records, lineages_agree=agree, truth_used_at_runtime=False,
             runtime_vlm_calls=0, certified=False,
             scope='A later page\'s accepted camera and drawing, applied to the construction\'s '
                   'own retained bodies as fixed assemblies. No search and no re-registration.',
             limitations='The registration was propagated from the body its own run drove, so a '
                         'single probe is biased toward that lineage; only agreement across '
                         'lineages is evidence. The later page also draws pieces the construction '
                         'does not contain, which lowers every body\'s score equally and is '
                         'therefore a ranking instrument, not an absolute one.'), indent=2))
    print('\nlineages agree: %s' % agree)
    print(args.out)


if __name__ == '__main__':
    main()
