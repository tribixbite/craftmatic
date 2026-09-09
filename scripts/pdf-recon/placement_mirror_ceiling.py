"""How many failures could mirror completion have reached, page by page?

The channel can only reflect a piece that is already placed, so its ceiling is
not "how symmetric is the model" but "how many of the pieces a page gets wrong
have a partner the run had already placed *at that page*". This measures exactly
that, on the run's own per-page bodies and its own allocations, with the
reference model used only to say afterwards whether a proposal was right.

Reported for every driven page:

* the mirror plane detected from that page's base body alone, and its agreement;
* every admitted proposal - reflected, non-colliding, connector-engaged - for the
  page's allocated pieces;
* how many of the page's reference targets those proposals hit, which is the
  conversion ceiling;
* how many admitted proposals hit nothing, which is the false-positive rate the
  channel would have to be gated against.

Evaluation-only. The proposals themselves are generated from runtime-legal
inputs; the scoring against the reference model happens strictly afterwards.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))


def page_ceiling(run, page, truth, library, symmetries, minimum_fraction=0.5,
                 position_tolerance=1.0):
    from placement_arrow_contacts import read_items
    from placement_diagnose_alias_poses import canonicalize
    from placement_diagnose_bank_recall import bank_recall
    from placement_mirror_completion import detect_plane, frames_equal, propose
    from placement_part_symmetry_table import symmetries as proper_symmetries
    from placement_population_table import canonical_name
    from pose_score import read_parts
    step = Path(run) / f'page-{page:03d}'
    registry = json.loads((step / 'registry-00.json').read_text())
    if registry.get('truth_used') is not False or registry.get('runtime_vlm_calls') != 0:
        raise ValueError('Registry provenance lacks truth-free zero-VLM attestation')
    base_source = Path(registry['base_source'])
    base_items, _ = canonicalize(read_parts(base_source), library)
    recall = bank_recall(registry, truth, base_items, symmetries=symmetries)
    body = [(canonical_name(part, library), int(color), np.asarray(T, float))
            for part, color, T in read_items(base_source)]
    plane = detect_plane(body, minimum_fraction)
    row = dict(page=page, base_parts=len(body), plane=plane,
               reference_targets=recall['reference_targets'])
    outstanding = [(canonical_name(part, library), int(color))
                   for part, color in registry['allocated_pieces']]
    # The reference poses of this page's targets, in reconstruction coordinates.
    alignment = recall['alignment']['alignment']
    rotation = np.asarray(alignment['rotation'], float)
    translation = np.asarray(alignment['translation'], float)
    inverse, offset = rotation.T, -rotation.T @ translation
    targets = []
    for entry in recall['rows']:
        position = inverse @ np.asarray(entry['reference_position'], float) + offset
        frame = inverse @ np.asarray(entry['reference_frame'], float)
        targets.append(dict(part=entry['part'], color=int(entry['color']),
                            truth_index=entry['truth_index'], position=position, frame=frame,
                            present_in_bank=entry['present'], hit=False))
    # A page's own symmetric pair is allocated together, so at the moment the
    # page runs neither partner is placed and an across-page channel proposes
    # nothing. The within-page channel is the one that can fire: once the search
    # has committed one piece of the page correctly, the other's pose follows.
    # `mirror_source` is therefore the base body plus this page's own additions
    # that agree with the reference - which is the run's real state, not an
    # assumption that the page went perfectly.
    additions = [(canonical_name(part, library), int(color), np.asarray(T, float))
                 for part, color, T in read_items(step / 'placement' / 'model.ldr')][len(body):]
    correct_additions = []
    for part, color, T in additions:
        symmetry = proper_symmetries(part, 'vertex')
        for target in targets:
            if target['part'] != part or target['color'] != color or target.get('already_placed'):
                continue
            if np.max(np.abs(T[:3, 3] - target['position'])) > position_tolerance:
                continue
            if frames_equal(T[:3, :3], target['frame'], symmetry):
                target['already_placed'] = True
                correct_additions.append((part, color, T))
                break
    row['correct_additions'] = len(correct_additions)
    row['emitted_additions'] = len(additions)
    row['wrong_targets'] = sum(1 for target in targets if not target.get('already_placed'))
    row['targets'] = [dict(part=t['part'], color=t['color'], truth_index=t['truth_index'],
                           present_in_bank=t['present_in_bank'], mirror_hit=t['hit'],
                           already_placed=bool(t.get('already_placed'))) for t in targets]
    if not plane or not plane.get('accepted'):
        row.update(status='plane_refused', proposals=0, admitted=0, hit=0,
                   false_positive_proposals=0, missed_targets=row['wrong_targets'])
        return row
    mirror_source = body + correct_additions
    result = propose(mirror_source, outstanding, plane, position_tolerance)
    admitted = [proposal for proposal in result['proposals'] if proposal['admitted']]
    for proposal in admitted:
        T = np.asarray(proposal['transform'], float)
        symmetry = proper_symmetries(proposal['part'], 'vertex')
        proposal['reference_hit'] = None
        for target in targets:
            if target['part'] != proposal['part'] or target['color'] != proposal['color']:
                continue
            if np.max(np.abs(T[:3, 3] - target['position'])) > position_tolerance:
                continue
            if frames_equal(T[:3, :3], target['frame'], symmetry):
                proposal['reference_hit'] = target['truth_index']
                target['hit'] = True
                break
    outstanding_targets = [t for t in targets if not t.get("already_placed")]
    row.update(status='measured', proposals=len(result['proposals']), admitted=len(admitted),
               admitted_rows=admitted,
               wrong_targets=len(outstanding_targets),
               hit=sum(1 for target in outstanding_targets if target['hit']),
               missed_targets=sum(1 for target in outstanding_targets if not target['hit']),
               false_positive_proposals=sum(1 for p in admitted if p['reference_hit'] is None),
               targets=[dict(part=t['part'], color=t['color'], truth_index=t['truth_index'],
                             present_in_bank=t['present_in_bank'], mirror_hit=t['hit'],
                             already_placed=bool(t.get('already_placed'))) for t in targets],
               decisions=[dict(part=d['part'], color=d['color'], quota=d['quota'],
                               distinct_admitted=d['distinct_admitted'],
                               determined=d['determined']) for d in result['decisions']])
    return row


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--run', type=Path, required=True)
    parser.add_argument('--truth', required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--minimum-fraction', type=float, default=0.5)
    args = parser.parse_args()
    from placement_diagnose_alias_poses import canonicalize
    from placement_part_library import PartLibrary
    from placement_part_symmetry_table import symmetries as part_symmetries
    from pose_score import read_parts
    journal = json.loads((args.run / 'autodrive.json').read_text())
    if journal.get('truth_used') is not False or journal.get('runtime_vlm_calls') != 0:
        raise ValueError('Run journal lacks truth-free zero-VLM attestation')
    library = PartLibrary()
    truth, _ = canonicalize(read_parts(args.truth), library)
    wanted = sorted({str(part) for part, *_ in truth})
    rows = []
    for step in journal['steps']:
        if not step.get('placement'):
            continue
        registry = json.loads((args.run / f"page-{step['page']:03d}" /
                               'registry-00.json').read_text())
        names = sorted(wanted + [str(entry['part']) for entry in registry['poses']])
        symmetries = {part: list(part_symmetries(part, 'vertex')) for part in set(names)}
        rows.append(page_ceiling(args.run, step['page'], truth, library, symmetries,
                                 args.minimum_fraction))
    # Per-page hits double count: the channel re-proposes the same missing piece
    # on every later page whose allocation still names its identity, so summing
    # the page column reports opportunities rather than parts. 40377's five
    # admitted proposals are four hits on **two** distinct reference instances.
    distinct_hits = {proposal['reference_hit'] for row in rows
                     for proposal in row.get('admitted_rows', [])
                     if proposal.get('reference_hit') is not None}
    distinct_wrong = {target['truth_index'] for row in rows for target in row.get('targets', [])
                      if not target['already_placed']}
    totals = dict(pages=len(rows),
                  planes_accepted=sum(1 for row in rows if (row['plane'] or {}).get('accepted')),
                  reference_targets=sum(row['reference_targets'] for row in rows),
                  wrong_target_opportunities=sum(row.get('wrong_targets', 0) for row in rows),
                  distinct_wrong_targets=len(distinct_wrong),
                  admitted=sum(row.get('admitted', 0) for row in rows),
                  hit_opportunities=sum(row.get('hit', 0) for row in rows),
                  distinct_reference_instances_hit=len(distinct_hits),
                  false_positive_proposals=sum(row.get('false_positive_proposals', 0)
                                               for row in rows))
    record = dict(run=str(args.run), truth=args.truth, totals=totals, rows=rows,
                  truth_used_at_runtime=False, runtime_vlm_calls=0, certified=False,
                  scope='Proposals are generated from the run\'s own base body, allocation and '
                        'universal CAD; the reference model scores them afterwards and selects '
                        'nothing.',
                  limitations='The ceiling is per page and assumes the page\'s own base body, so a '
                              'page whose body is already wrong cannot mirror a correct partner it '
                              'never had. Mirror-mould pairs are not proposed, and only '
                              'axis-aligned planes are searched.')
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(record, indent=2))
    print(f"{'page':>5} {'base':>5} {'plane':>18} {'agree':>6} {'targets':>8} {'wrong':>6} "
          f"{'admit':>6} {'hit':>4} {'falsepos':>9}")
    for row in rows:
        plane = row['plane'] or {}
        if not plane.get('accepted'):
            best = (plane.get('best') or {})
            print(f"{row['page']:>5} {row['base_parts']:>5} {'refused':>18} "
                  f"{(best.get('fraction') or 0):>6.3f} {row['reference_targets']:>8} "
                  f"{'-':>6} {'-':>6} {'-':>4} {'-':>9}")
            continue
        print(f"{row['page']:>5} {row['base_parts']:>5} "
              f"{'axis %d @ %.1f' % (plane['axis'], plane['offset']):>18} "
              f"{plane['fraction']:>6.3f} {row['reference_targets']:>8} "
              f"{row['wrong_targets']:>6} {row['admitted']:>6} "
              f"{row['hit']:>4} {row['false_positive_proposals']:>9}")
    print(json.dumps(totals))
    print(args.out)


if __name__ == '__main__':
    main()
