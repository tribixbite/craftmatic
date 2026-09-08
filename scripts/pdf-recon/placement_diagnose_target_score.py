"""Post-hoc diagnostic: how does the reference assembly score against the run?

Given a bank-recall report (which pose-bank entries reproduce the reference
poses for a page) this builds the reference-equivalent assembly out of the
runtime's own enumerated poses and scores it with the runtime scorer at the
runtime's registrations. Comparing that with the selected candidate separates:

* a scoring failure - the reference-equivalent assembly is reachable and legal
  but scores lower than the selected one, and
* a search failure  - it scores higher and was simply never reached.

The independent model is used only to choose which enumerated poses to score.
Nothing here feeds candidate generation, runtime scoring or selection, and the
assembly built here is never emitted as a reconstruction.
"""
import argparse
import hashlib
import itertools
import json
from pathlib import Path
import numpy as np


def build(registry, recall, colors_from_reference=True):
    """Every combination of the recalled bank poses, one per reference target."""
    options = []
    for row in recall['rows']:
        if not row['present']:
            continue
        options.append([(row['part'], int(row['color']), index) for index in row['bank_indices']])
    if not options:
        return []
    combinations = []
    for choice in itertools.product(*options):
        items = [(part, color, np.asarray(registry['poses'][index]['T'], float))
                 for part, color, index in choice]
        combinations.append((tuple(index for _, _, index in choice), items))
    return combinations


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--registry', type=Path, required=True)
    parser.add_argument('--recall', type=Path, required=True)
    parser.add_argument('--run', type=Path, required=True, help='Completed placement directory')
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--limit', type=int, default=64)
    args = parser.parse_args()
    import pymupdf
    from placement_arrow_contacts import read_items
    from placement_material_scene_score import MaterialFeatureSceneScorer
    from placement_mixed_batch_search import fixed_native_score
    from vector_scene import scene_images
    registry = json.loads(args.registry.read_text())
    recall = json.loads(args.recall.read_text())
    run = json.loads((args.run / 'results.json').read_text())
    if registry.get('truth_used') is not False or run.get('truth_used') is not False:
        raise ValueError('Runtime artifacts lack truth-free provenance')
    base = read_items(Path(registry['base_source']))
    with pymupdf.open(registry['pdf']) as doc:
        scene = next(s for s in scene_images(doc, doc[registry['page']])
                     if s['xref'] == run['xref'])
    scorer = MaterialFeatureSceneScorer(scene, plane_depth=True)
    views = []
    for row in run['results'][:1]:
        views.append((np.asarray(row['projection'], float), np.asarray(row['origin'], float)))
    seen = {tuple(np.round(v[1], 6)) for v in views}
    for row in run['results']:
        key = tuple(np.round(np.asarray(row['origin'], float), 6))
        if key not in seen:
            seen.add(key)
            views.append((np.asarray(row['projection'], float), np.asarray(row['origin'], float)))
    combinations = build(registry, recall)[:args.limit]
    rows = []
    for indices, items in combinations:
        for view_index, (M, origin) in enumerate(views):
            evidence = fixed_native_score(scorer, base + items, M, origin)
            rows.append(dict(bank_indices=list(indices), view=view_index,
                             score=evidence['score'],
                             balanced_color_iou=evidence.get('balanced_color_iou'),
                             material_iou=evidence.get('material_iou'),
                             edge_score=evidence.get('edge_score')))
    rows.sort(key=lambda r: -r['score'])
    selected = run['results'][0]['evidence']['score'] if run['results'] else None
    result = dict(reference_equivalent_best=rows[0] if rows else None,
                  reference_equivalent_rows=rows,
                  selected_runtime_score=selected,
                  verdict=('scoring_failure' if rows and selected is not None and rows[0]['score'] < selected
                           else 'search_failure' if rows and selected is not None else 'inconclusive'),
                  combinations_scored=len(combinations), views_scored=len(views),
                  registry=str(args.registry), run=str(args.run),
                  run_sha256=hashlib.sha256((args.run / 'results.json').read_bytes()).hexdigest(),
                  scope='Evaluation-only diagnostic executed after the run.',
                  limitations='Only reference targets present in the pose bank are assembled; the '
                              'reference file order need not equal PDF step order. Scores are the '
                              'runtime scorer at the runtime registrations, not a certification.')
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2))
    print(json.dumps(dict(verdict=result['verdict'], best=rows[0] if rows else None,
                          selected=selected)))
