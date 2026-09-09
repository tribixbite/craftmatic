"""The whole PDF-only pipeline as one command, with no attended step.

Round nine recorded the page-scope decision as the pipeline's one attended step
and measured what it cost (25 of 108 pieces on 41601). Round ten closed it
(`placement_slot_adapter --auto-scope`) and repaired the two association classes
that were producing the refusals, so the chain from a PDF to a driven model has
no human decision left in it. This module is that claim made checkable: every
stage is the existing tool with its own provenance, run in order, and the
journal records each one's command and output hash.

Nothing here reads a reference model. `--truth` is optional and is used only to
SCORE the result afterwards, in a section of the report that the pipeline itself
never sees.

Derived, not chosen:
* the page scope is every page the slot source does not refuse;
* the construction page is the first page of that scope;
* the prescan pages are the next two, because a construction page rarely shows
  a stud row of its own and the driver's prescan already borrows one;
* the opening body is the retained construction with the best bilateral plane
  agreement (`placement_construction_symmetry`), which round nine measured
  reaching the oracle best on 41601 with no reference in the loop;
* the drive scope is every scope page after the construction page.
"""
import argparse
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

PAGE_OPTIONS = [
    '--camera-matrices', '2', '--camera-prior-matrices', '2', '--per-matrix', '6',
    '--refine-limit', '16', '--window', '3', '--tolerance', '0', '--fraction', '0.01',
    '--fallback', '2', '--scales', '1.0', '--containment-multiple', '4.0',
    '--containment-cap', '0.03', '--retry-passes', '1', '--drawing-registration', 'prefer',
    '--drawing-registration-keep', '2', '--drawing-registration-min-iou', '0.6',
    '--repair-anti-studs', '--camera-gate', 'enforce', '--camera-unexplained-max', '1.0',
    '--camera-scale-tolerance', '0.06', '--camera-prescan', '--body-area-ratio', '0.6',
    '--attach-limit', '4', '--attach-coarse-pairs', '256', '--views', '3', '--scale', '1.0',
    '--max-nodes', '200000', '--top-k', '12', '--host-bytes', '12000000000',
    '--closure-rounds', '1', '--max-closure-parents', '128', '--max-poses', '8192',
    '--closure-mode', 'evidence', '--method', 'beam', '--beam', '96',
    '--max-expansions', '2000000', '--improve-rounds', '5', '--improve-from', '4',
    '--restarts', '2', '--perturb', '2', '--seed', '0', '--native-rounds', '3',
    '--native-width', '16', '--native-starts', '3', '--chromatic-metric', 'hue',
    '--exchange-window-order', 'own_agreement', '--compound-width', '0',
    '--compound-mode', 'both', '--compound-budget', '64', '--tie-break', 'pose',
]


def digest(path):
    path = Path(path)
    if not path.is_file():
        return None
    return hashlib.sha256(path.read_bytes()).hexdigest()


def stage(journal, name, command, produces, log):
    """Run one stage unless its product already exists, recording both."""
    produces = Path(produces)
    entry = dict(stage=name, command=[str(part) for part in command], produces=str(produces))
    if produces.exists():
        entry.update(status='reused', sha256=digest(produces))
        journal.append(entry)
        print('[reuse] %s -> %s' % (name, produces), flush=True)
        return entry
    started = time.time()
    log.parent.mkdir(parents=True, exist_ok=True)
    with open(log, 'a', encoding='utf-8') as handle:
        handle.write('\n$ ' + ' '.join(str(part) for part in command) + '\n')
        handle.flush()
        result = subprocess.run([sys.executable] + [str(part) for part in command],
                                stdout=handle, stderr=subprocess.STDOUT, cwd=str(HERE.parents[1]))
    entry.update(status='ran', returncode=result.returncode, seconds=round(time.time() - started, 1),
                 sha256=digest(produces))
    journal.append(entry)
    print('[%s] %s (%.0fs) -> %s' % ('ok' if not result.returncode else 'FAIL', name,
                                     entry['seconds'], produces), flush=True)
    if result.returncode:
        raise SystemExit('Stage failed: %s (see %s)' % (name, log))
    return entry


def run(pdf, inventory_run, out, truth=None, roots=3, mould_policy='withhold'):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    log = out / 'pipeline.log'
    journal = []
    slots = out / 'slots'
    stage(journal, 'slot assignment',
          [HERE / 'global_pdf_slot_assignment.py', pdf, '--allocation-run', inventory_run,
           '--out', slots, '--color-constraints', '--panel-geometry'],
          slots / 'slot-assignment.json', log)
    moulds = out / 'mould-classes.json'
    stage(journal, 'mould equivalence',
          [HERE / 'placement_mould_equivalence.py', '--slots', slots / 'slot-assignment.json',
           '--out', moulds], moulds, log)
    allocation = out / 'allocation'
    stage(journal, 'auto-scoped allocation',
          [HERE / 'placement_slot_adapter.py', '--source', slots / 'slot-assignment.json',
           '--auto-scope', '--mould-classes', moulds, '--mould-policy', mould_policy,
           '--out', allocation], allocation / 'global-assignment.json', log)
    scope = json.loads((allocation / 'global-assignment.json').read_text())['allocation_pages']
    if len(scope) < 2:
        raise SystemExit('Derived scope is too small to drive: %s' % scope)
    construction_page, drive_pages = scope[0], scope[1:]
    construction = out / 'construction'
    stage(journal, 'construction',
          [HERE / 'placement_construct_body.py', '--pdf', pdf, '--allocation-run', allocation,
           '--page', construction_page, '--out', construction, '--roots', roots,
           '--prescan-pages'] + [str(page) for page in drive_pages[:2]] + PAGE_OPTIONS,
          construction / 'construction.json', log)
    symmetry = out / 'construction-symmetry.json'
    stage(journal, 'opening selection (symmetry, truth-free)',
          [HERE / 'placement_construction_symmetry.py', construction / 'construction',
           '--out', symmetry], symmetry, log)
    base = out / 'opening'
    if not base.exists():
        import placement_backtrack as backtrack
        pick = json.loads(symmetry.read_text())['symmetry_reranked']
        census, _ = backtrack.alternatives(construction / 'construction')
        member = None
        for index, entry in enumerate(census['classes']):
            for row in entry['members']:
                if row['file'] == pick['file']:
                    member = dict(row, score=entry['score'], score_class=index,
                                  class_width=len(entry['members']),
                                  class_distinct_bodies=entry['distinct_bodies'])
        if member is None:
            raise SystemExit('The symmetry pick is not in the construction census')
        backtrack.derive_base(construction / 'construction', member, base,
                              dict(selector='placement_construction_symmetry (plane agreement)',
                                   plane_fraction=pick['plane_fraction'],
                                   plane_matched=pick['plane_matched'],
                                   plane_eligible=pick['plane_eligible'],
                                   truth_used=False, runtime_vlm_calls=0))
        journal.append(dict(stage='opening', status='ran', produces=str(base),
                            selected=pick['file'], sha256=digest(base / 'model.ldr')))
        print('[ok] opening -> %s (%s)' % (base, pick['file']), flush=True)
    else:
        journal.append(dict(stage='opening', status='reused', produces=str(base),
                            sha256=digest(base / 'model.ldr')))
    drive = out / 'drive'
    stage(journal, 'drive',
          [HERE / 'placement_autodrive.py', '--pdf', pdf, '--allocation-run', allocation,
           '--base-run', base, '--out', drive, '--pages'] + [str(page) for page in drive_pages]
          + PAGE_OPTIONS, drive / 'autodrive.json', log)
    report = dict(pdf=str(pdf), inventory_run=str(inventory_run), out=str(out),
                  attended_steps=0, truth_used_at_runtime=False, runtime_vlm_calls=0,
                  certified=False, scope_pages=scope, construction_page=construction_page,
                  drive_pages=drive_pages, stages=journal,
                  limitations=['The inventory run supplies the printed BOM; identity, allocation, '
                               'scope, opening and drive are derived from the PDF alone.',
                               'No certification of the emitted model; scoring below is '
                               'evaluation-only and never re-enters the pipeline.'])
    if truth:
        from pose_score import read_parts
        from placement_diagnose_alias_poses import (canonicalize, verified_local_symmetries,
                                                    yaw_equivalent_score)
        from placement_part_library import PartLibrary
        library = PartLibrary()
        reference, _ = canonicalize(read_parts(truth), library)
        journal_data = json.loads((drive / 'autodrive.json').read_text())
        final = journal_data.get('last_checkpoint')
        opening, _ = canonicalize(read_parts(base / 'model.ldr'), library)
        scored = dict(truth=str(truth), truth_pieces=len(reference),
                      opening_structural=int(yaw_equivalent_score(
                          opening, reference, verified_local_symmetries)['matched']))
        if final and Path(final).is_file():
            emitted, _ = canonicalize(read_parts(final), library)
            scored.update(final_model=final, emitted=len(emitted),
                          final_structural=int(yaw_equivalent_score(
                              emitted, reference, verified_local_symmetries)['matched']))
            scored['driver_contribution'] = scored['final_structural'] - scored['opening_structural']
        report['evaluation'] = scored
    (out / 'pipeline.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report.get('evaluation', dict(scope_pages=len(scope))), indent=1))
    print(out / 'pipeline.json')
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--pdf', type=Path, required=True)
    parser.add_argument('--inventory-run', type=Path, required=True,
                        help='Directory holding the printed inventory (inventory.json)')
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--truth', default=None, help='Evaluation only; never read by the pipeline')
    parser.add_argument('--roots', type=int, default=3)
    parser.add_argument('--mould-policy', default='withhold')
    args = parser.parse_args()
    run(args.pdf, args.inventory_run, args.out, args.truth, args.roots, args.mould_policy)


if __name__ == '__main__':
    main()
