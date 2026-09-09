"""Does the undrawn-colour rule change when the body's colours compete?

`placement_undrawn_pieces` measures a colour's drawn ink with a palette built
from the page's *allocated* colours alone. `palette_labels` assigns each pixel to
the nearest entry, so a page allocating one colour has no competitor and
classifies the whole drawing as that colour - the rule then cannot fire there by
construction. That is not hypothetical: 40377 pages 26 and 27 each allocate only
bright light orange, and the placement bank, whose palette carries every model
colour, classifies **zero** of their drawing pixels as it.

This replays the rule over a completed run both ways - allocated palette only,
and allocated plus the body's own colours - and reports where the verdict
changes. Both readings are runtime-legal: the body's colours are ours, and no
reference model, inventory or VLM participates.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


def page_rows(run, page):
    from placement_arrow_contacts import read_items
    from placement_run_scene import run_scene
    from placement_undrawn_pieces import undrawn
    import numpy as np
    step = Path(run) / f'page-{page:03d}'
    placement = step / 'placement'
    registry = json.loads((step / 'registry-00.json').read_text())
    result = json.loads((placement / 'results.json').read_text())
    if registry.get('truth_used') is not False or result.get('truth_used') is not False:
        raise ValueError('Run artifacts lack truth-free provenance')
    registration = json.loads((step / 'registration-refined-00.json').read_text())
    view = min(int(result['results'][0].get('view') or 0), len(registration['hypotheses']) - 1)
    projection = np.asarray(registration['hypotheses'][view]['projection'], float)
    scene, _ = run_scene(result, read_items(placement / 'model.ldr'))
    pieces = [(str(p), int(c)) for p, c in registry['allocated_pieces']]
    body_colors = sorted({int(c) for _p, c, _T in read_items(Path(registry['base_source']))})
    alone = undrawn(scene, pieces, projection)
    withcontext = undrawn(scene, pieces, projection, context_colors=body_colors)
    return dict(page=page, allocated=[list(p) for p in pieces], body_colors=body_colors,
                allocated_palette=alone, with_body_palette=withcontext,
                verdict_changed=alone['withheld_keys'] != withcontext['withheld_keys'])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--run', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    journal = json.loads((args.run / 'autodrive.json').read_text())
    if journal.get('truth_used') is not False or journal.get('runtime_vlm_calls') != 0:
        raise ValueError('Run journal lacks truth-free zero-VLM attestation')
    rows = [page_rows(args.run, step['page']) for step in journal['steps'] if step.get('placement')]
    record = dict(run=str(args.run), rows=rows,
                  pages=len(rows), verdicts_changed=sum(1 for r in rows if r['verdict_changed']),
                  truth_used=False, runtime_vlm_calls=0, certified=False,
                  scope='Replays a shipped opt-in rule over a completed run under two classifier '
                        'palettes. Nothing here changes a run or reads a reference model.',
                  limitations='Occlusion is still indistinguishable from absence, and the body '
                              'colour list is the emitted body\'s, so a body missing a colour '
                              'cannot supply it as a competitor.')
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(record, indent=2))
    print(f"{'page':>5} {'colour':>7} {'alone':>10} {'withbody':>10} {'needed':>8}  verdict")
    for row in rows:
        for alone, ctx in zip(row['allocated_palette']['colors'], row['with_body_palette']['colors']):
            changed = ' CHANGED' if alone['absent'] != ctx['absent'] else ''
            print(f"{row['page']:>5} {alone['color']:>7} {alone['drawn_share']:>10.3f} "
                  f"{ctx['drawn_share']:>10.3f} {alone['single_piece_min_pixels']:>8} "
                  f" absent {alone['absent']}->{ctx['absent']}{changed}")
    print(f"pages {record['pages']}, verdicts changed {record['verdicts_changed']}")
    print(args.out)


if __name__ == '__main__':
    main()
