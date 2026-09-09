"""Evaluation-only diagnostic: does a page-local objective separate poses?

The runtime scorer averages colour-class IoU and chamfered edge agreement over
a whole drawing. A page that adds two small plates to a 49-part body changes a
few per cent of the drawn pixels, so two candidates whose additions differ by
less than a stud produce nearly identical whole-drawing scores. This tool
measures that dilution directly, and measures whether restricting the same
evidence to the pixels the additions can actually influence separates them.

Nothing here feeds candidate generation, runtime scoring or selection. The
reference model chooses only *which* enumerated poses to score, exactly as
`placement_diagnose_target_score` does, and no assembly built here is emitted.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from placement_arrow_contacts import read_items
from placement_local_delta import (added_region, local_evidence, render_layers)
from placement_material_scene_score import MaterialFeatureSceneScorer
from placement_mixed_batch_search import fixed_native_score
from placement_diagnose_target_score import build


def panel(rgb, mask, box, scale=3):
    y0, y1, x0, x1 = box
    crop = rgb[y0:y1, x0:x1].copy()
    crop[~mask[y0:y1, x0:x1]] = 245
    return cv2.resize(crop, (crop.shape[1] * scale, crop.shape[0] * scale),
                      interpolation=cv2.INTER_NEAREST)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--run', type=Path, required=True, help='completed placement directory')
    parser.add_argument('--registry', type=Path, required=True)
    parser.add_argument('--recall', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--limit', type=int, default=8)
    parser.add_argument('--candidates', type=int, default=6)
    args = parser.parse_args()

    from placement_run_scene import run_scene

    registry = json.loads(args.registry.read_text())
    recall = json.loads(args.recall.read_text())
    run = json.loads((args.run / 'results.json').read_text())
    if registry.get('truth_used') is not False or run.get('truth_used') is not False:
        raise ValueError('Runtime artifacts lack truth-free provenance')
    base = read_items(Path(registry['base_source']))
    scene, mask_source = run_scene(run, read_items(args.run / 'model.ldr'))
    scorer = MaterialFeatureSceneScorer(scene, plane_depth=True)

    row0 = run['results'][0]
    M = np.asarray(row0['projection'], float)
    origin = np.asarray(row0['origin'], float)

    args.out.mkdir(parents=True, exist_ok=True)

    # The body alone, at the accepted registration: everything a candidate's
    # additions cannot change.
    base_ev = fixed_native_score(scorer, base, M, origin)
    base_layer = render_layers(scorer, base, M)

    rows = []
    entries = []
    for row in run['results'][:args.candidates]:
        if not np.allclose(np.asarray(row['origin'], float), origin, atol=1e-9):
            continue
        entries.append(('runtime:' + row['file'], read_items(args.run / row['file'])))
    for index, (indices, items) in enumerate(build(registry, recall)[:args.limit]):
        entries.append(('reference_equivalent:' + '+'.join(map(str, indices)), base + items))

    for name, items in entries:
        ev = fixed_native_score(scorer, items, M, origin)
        layer = render_layers(scorer, items, M)
        region = added_region(base_layer, layer, scene['mask'])
        local = local_evidence(scorer, base_layer, layer, region)
        rows.append(dict(name=name, whole_score=ev['score'], whole_color=ev['color_score'],
                         whole_edge=ev['edge_score'], **local,
                         region_pixels=int(region['region'].sum()),
                         changed_pixels=int(region['changed'].sum())))
        stem = name.replace(':', '-').replace('.ldr', '')
        box = region['box']
        if box is not None:
            strip = np.concatenate([panel(scene['rgb'], scene['mask'], box),
                                    panel(layer['rgb'], layer['mask'], box),
                                    panel(scorer.last_outline, layer['mask'], box)], axis=1)
            cv2.imwrite(str(args.out / f'{stem}-local.png'), cv2.cvtColor(strip, cv2.COLOR_RGB2BGR))

    report = dict(run=str(args.run), registry=str(args.registry),
                  run_sha256=hashlib.sha256((args.run / 'results.json').read_bytes()).hexdigest(),
                  registration=dict(projection=M.tolist(), origin=origin.tolist()),
                  mask_source=mask_source, target_pixels=int(scorer.mask.sum()),
                  base_whole_score=base_ev['score'], base_whole_edge=base_ev['edge_score'],
                  base_whole_color=base_ev['color_score'], rows=rows,
                  scope='Evaluation-only diagnostic executed after the run.',
                  limitations='Local evidence measured post hoc; reference poses select which '
                              'enumerated bank entries to score and nothing else.')
    (args.out / 'local-delta.json').write_text(json.dumps(report, indent=2))
    order = sorted(rows, key=lambda r: -r['local_score'])
    print(json.dumps(dict(whole_best=max(rows, key=lambda r: r['whole_score'])['name'],
                          local_best=order[0]['name'],
                          rows=[{k: (round(v, 5) if isinstance(v, float) else v)
                                 for k, v in r.items()} for r in rows]), indent=1))


if __name__ == '__main__':
    main()
