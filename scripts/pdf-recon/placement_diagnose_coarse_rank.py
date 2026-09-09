"""Evaluation-only: where does the correct pose sit in the coarse ranking?

The search ranks and prunes with the coarse depth-composite per-class IoU, then
reranks the survivors with the native colour-and-edge scorer that actually
selects. When those two disagree, a pose the native scorer would choose can be
dropped before it is ever rendered natively - and the failure looks exactly like
a scoring failure in the output.

This tool rebuilds the page's own bank, scores every screened placement with
both objectives, and reports the rank of each requested pose under each. The
requested poses come from the reference model, which chooses nothing at runtime.
"""
import argparse
import json
from pathlib import Path
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--registry', type=Path, required=True)
    parser.add_argument('--registration', type=Path, required=True)
    parser.add_argument('--run', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--view', type=int, default=0)
    parser.add_argument('--outside-fraction', type=float, default=0.,
                        help="Proportional occupancy allowance in each candidate's own units")
    parser.add_argument('--translations', type=float, nargs='+', default=(),
                        help='Flat x y z triples to locate in both rankings')
    parser.add_argument('--local', action='store_true',
                        help='Also score each sampled placement by the local objective - the '
                             'evidence restricted to the region the addition changes - which is '
                             'the lever a late page adding one small piece to a large body needs '
                             'measured, since the whole drawing is dominated by the body')
    args = parser.parse_args()

    from placement_arrow_contacts import read_items
    from placement_cardinality_bank import build_bank
    from placement_layer_beam import LayerComposite
    from placement_material_scene_score import MaterialFeatureSceneScorer
    from placement_mixed_batch_search import fixed_native_score
    from placement_multi_shape_batch import shape_bank
    from placement_occupancy_screen import screen
    from placement_run_scene import run_scene

    registry = json.loads(args.registry.read_text())
    registration = json.loads(args.registration.read_text())
    run = json.loads((args.run / 'results.json').read_text())
    if registry.get('truth_used') is not False or run.get('truth_used') is not False:
        raise ValueError('Runtime artifacts lack truth-free provenance')
    base = read_items(Path(registry['base_source']))
    scene, mask_source = run_scene(run, read_items(args.run / 'model.ldr'))
    scorer = MaterialFeatureSceneScorer(scene, plane_depth=True)
    view = registration['hypotheses'][args.view]
    M = np.asarray(view['projection'], float)
    origin = np.asarray(view['origin'], float)
    allowance = int(view.get('outside_pixels') or 0)

    shapes = [dict(items=[(str(e['part']), 15, np.asarray(e['T'], float))])
              for e in registry['poses']]
    gate = screen(base, shapes, M, origin, scorer, outside_tolerance_px=allowance,
                  outside_fraction=args.outside_fraction)
    ids = gate['retained_indices']
    subset = dict(registry, poses=[registry['poses'][i] for i in ids])
    pieces = run.get('image_pieces') or registry['allocated_pieces']
    placements, quotas = shape_bank(subset, [(p, c) for p, c in pieces])
    bank = build_bank(base, placements, M, origin, scorer, max_host_bytes=12_000_000_000)
    coarse = LayerComposite(bank['base_depth'], bank['base_labels'], bank['depths'],
                            bank['labels'], bank['target'])
    coarse_scores = np.array([coarse.score([i]) for i in range(len(placements))])
    wanted = [tuple(args.translations[i:i + 3]) for i in range(0, len(args.translations), 3)]
    rows = []
    order = np.argsort(-coarse_scores, kind='stable')
    coarse_rank = {int(index): rank for rank, index in enumerate(order, 1)}
    interesting = set()
    for target in wanted:
        for index, placement in enumerate(placements):
            if np.allclose(placement['items'][0][2][:3, 3], target, atol=1e-6):
                interesting.add(index)
    interesting.update(int(i) for i in order[:12])
    native, local, region = {}, {}, {}
    base_layer = None
    if args.local:
        from placement_local_delta import added_region, local_evidence, render_layers
        fixed_native_score(scorer, base, M, origin)
        base_layer = render_layers(scorer, base, M)
    for index in sorted(interesting):
        items = base + list(placements[index]['items'])
        native[index] = fixed_native_score(scorer, items, M, origin)['score']
        if base_layer is not None:
            layer = render_layers(scorer, items, M)
            # How many drawn pixels this candidate can change at all. A pose the
            # body hides contributes nothing to any image objective, which is a
            # different failure from a pose that explains the wrong ink.
            changed = added_region(base_layer, layer, scorer.mask)
            region[index] = int(np.asarray(changed['changed'], bool).sum())
            local[index] = local_evidence(scorer, base_layer, layer, changed)['local_score']
    native_order = sorted(native, key=lambda i: -native[i])
    native_rank = {index: rank for rank, index in enumerate(native_order, 1)}
    local_rank = {index: rank for rank, index in
                  enumerate(sorted(local, key=lambda i: -local[i]), 1)}
    for index in sorted(interesting):
        translation = [float(v) for v in placements[index]['items'][0][2][:3, 3]]
        rows.append(dict(placement=index, translation=translation,
                         coarse_score=float(coarse_scores[index]),
                         coarse_rank=coarse_rank[index], native_score=native[index],
                         native_rank_within_sample=native_rank[index],
                         local_score=local.get(index),
                         local_rank_within_sample=local_rank.get(index),
                         drawn_pixels_the_addition_paints=region.get(index),
                         requested=any(np.allclose(translation, t, atol=1e-6) for t in wanted)))
    rows.sort(key=lambda r: r['coarse_rank'])
    # What the drawing says about the body alone. A candidate that scores below
    # it is being penalised for the piece it adds, which is the shape of failure
    # the exploded-target fix addressed on page 17 and is worth separating from
    # a candidate that simply explains the wrong ink.
    body_only = fixed_native_score(scorer, base, M, origin)['score']
    result = dict(run=str(args.run), registry=str(args.registry), view=args.view,
                  body_only_native_score=float(body_only),
                  mask_source=mask_source, screened_placements=len(placements),
                  quotas={f'{p}:{c}': q for (p, c), q in quotas.items()},
                  natively_scored=len(native), rows=rows,
                  scope='Evaluation-only diagnostic executed after the run.',
                  limitations='Native ranks are within the sampled subset only, not over the '
                              'whole bank; the reference model selects which poses to locate and '
                              'nothing else.')
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2))
    print(f'{"coarse#":>7} {"native#":>7} {"local#":>7} {"coarse":>8} {"native":>8} '
          f'{"local":>8} {"paints":>7}  translation')
    for row in rows:
        mark = ' <-' if row['requested'] else ''
        local_rank_text = ('%7d' % row['local_rank_within_sample']
                           if row['local_rank_within_sample'] else '      -')
        local_text = '%8.5f' % row['local_score'] if row['local_score'] is not None else '       -'
        paints = ('%7d' % row['drawn_pixels_the_addition_paints']
                  if row['drawn_pixels_the_addition_paints'] is not None else '      -')
        print(f'{row["coarse_rank"]:>7} {row["native_rank_within_sample"]:>7} {local_rank_text} '
              f'{row["coarse_score"]:>8.5f} {row["native_score"]:>8.5f} {local_text} {paints}  '
              f'{[round(v, 1) for v in row["translation"]]}{mark}')


if __name__ == '__main__':
    main()
