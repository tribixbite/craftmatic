"""Evaluation-only population table: why is each reference part not placed?

Rounds one to five each attacked one failure at a time and measured it on the
page that motivated it. That is how a fixture reaches 53 of 90 and stops: the
next lever is chosen from whichever page was last looked at, not from the size
of the class it addresses. This tool answers the prior question — across a whole
driven run, how many of the reference model's parts sit behind each distinct
obstruction — so a channel can be costed before it is built.

Every part of the reference model that the final assembly does not place
correctly is assigned to exactly one primary class:

* `out_of_scope` — no page of this run allocates it, so nothing the run does
  could have placed it. Usually an error inherited from the checkpoint the chain
  started at, or a piece belonging to earlier pages.
* `allocation_blocked` — a page allocates it, but that page was never driven:
  a subassembly construction the driver refuses or excludes, a page whose camera
  was refused, a page with no allocation of its own.
* `unreachable` — a driven page allocates it and its reference pose is absent
  from that page's enumerated bank, so no scorer could have selected it.
* `visibility_limited` — the pose is in the bank, but at that page's own
  accepted camera it paints so little of the drawing that no image objective can
  prefer it over the rivals. The count reported for this test is measured
  against the **complete reference assembly**, not against our own emitted body,
  so "hidden behind our own errors" is excluded by construction.
* `mis_selected` — the pose is in the bank, paints a competitive area, and was
  still not selected. This is the only class a better objective can convert.

The bank test, the alignment and the reference poses all come from the
independent model and are read strictly after the run. Nothing here enters
candidate generation, scoring or selection, and nothing it writes is certified.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

# Below this many painted pixels a piece cannot be distinguished from outline
# noise on these booklets: a 1x1 round tile covers about 510 pixels at 40377's
# late-page cameras, and round five measured the page-23 plate at 75 against the
# complete reference. The ratio test is the primary one; this floor only catches
# a piece whose rivals are also small.
ABSOLUTE_VISIBILITY_FLOOR = 200


def canonical_name(part, library):
    """The universal-CAD canonical stem, matching the evaluation's own aliasing."""
    from placement_diagnose_alias_poses import verified_rename_graph
    renames, _ = verified_rename_graph()
    resolved = library.aliases.get(str(part).lower() + '.dat')
    stem = resolved.stem if resolved else str(part)
    return renames.get(stem, stem)


def painted_pixels(scorer, items, projection, origin):
    """Pixels the LAST item of `items` owns in the render of the whole list.

    Equivalent to `placement_local_delta.added_region`'s `changed` count without
    the separate body-only render: triangle ownership indices above the running
    total of every earlier item belong to the last one. Ordering is load-bearing
    and the caller must append the pose under test last.
    """
    from placement_local_delta import render_layers
    from placement_mixed_batch_search import fixed_native_score
    fixed_native_score(scorer, items, projection, origin)
    layer = render_layers(scorer, items, projection)
    preceding = int(sum(layer['triangle_counts'][:-1]))
    return int((layer['mask'] & (layer['owner'] > preceding)).sum())


def reference_in_reconstruction(truth, alignment):
    """The whole reference model mapped into this page's reconstruction frame."""
    rotation = np.asarray(alignment['rotation'], float)
    translation = np.asarray(alignment['translation'], float)
    inverse, offset = rotation.T, -rotation.T @ translation
    mapped = []
    for name, code, position, frame in truth:
        T = np.eye(4)
        T[:3, :3] = inverse @ frame
        T[:3, 3] = inverse @ position + offset
        mapped.append((str(name), int(code), T))
    return mapped


def page_scorer(step):
    """The scorer, camera and body a completed page actually scored against."""
    from placement_arrow_contacts import read_items
    from placement_material_scene_score import MaterialFeatureSceneScorer
    from placement_run_scene import run_scene
    placement = step / 'placement'
    result = json.loads((placement / 'results.json').read_text())
    if result.get('truth_used') is not False:
        raise ValueError('Runtime artifacts lack truth-free provenance')
    registry = json.loads((step / 'registry-00.json').read_text())
    view = int(result['results'][0].get('view') or 0)
    registration = json.loads((step / 'registration-refined-00.json').read_text())
    view = min(view, len(registration['hypotheses']) - 1)
    accepted = registration['hypotheses'][view]
    scene, mask_source = run_scene(result, read_items(placement / 'model.ldr'))
    scorer = MaterialFeatureSceneScorer(scene, plane_depth=True)
    base = read_items(Path(registry['base_source']))
    selected = read_items(placement / 'model.ldr')
    additions = selected[len(base):]
    return dict(scorer=scorer, projection=np.asarray(accepted['projection'], float),
                origin=np.asarray(accepted['origin'], float), base=base,
                additions=additions, registry=registry, mask_source=mask_source,
                target_pixels=int(np.asarray(scorer.mask, bool).sum()),
                registration_source=accepted.get('registration_source'))


def measure_page(run, page, truth, library, symmetries, render=True):
    """Reference targets of one driven page, with bank presence and visibility."""
    from placement_diagnose_bank_recall import bank_recall
    from placement_diagnose_alias_poses import canonicalize
    from pose_score import read_parts
    step = Path(run) / f'page-{page:03d}'
    registry = json.loads((step / 'registry-00.json').read_text())
    if registry.get('truth_used') is not False or registry.get('runtime_vlm_calls') != 0:
        raise ValueError('Registry provenance lacks truth-free zero-VLM attestation')
    base_items, _ = canonicalize(read_parts(Path(registry['base_source'])), library)
    recall = bank_recall(registry, truth, base_items, symmetries=symmetries)
    rows = recall['rows']
    if not render or not rows:
        return recall, rows, None
    context = page_scorer(step)
    scorer, M, origin = context['scorer'], context['projection'], context['origin']
    mapped = reference_in_reconstruction(truth, recall['alignment']['alignment'])
    # What the run's own choice paints, one addition at a time: the rival area a
    # correct pose has to compete with on this page.
    selected_painted = [painted_pixels(scorer, context['base'] + [item], M, origin)
                        for item in context['additions']]
    for row in rows:
        pose = mapped[row['truth_index']]
        complete = [entry for index, entry in enumerate(mapped) if index != row['truth_index']]
        row['painted_against_our_body'] = painted_pixels(scorer, context['base'] + [pose], M, origin)
        row['painted_against_complete_reference'] = painted_pixels(scorer, complete + [pose], M, origin)
    summary = dict(selected_painted=selected_painted,
                   base_parts=len(context['base']),
                   additions=[(canonical_name(p, library), int(c)) for p, c, _ in context['additions']],
                   target_pixels=context['target_pixels'],
                   mask_source=context['mask_source'],
                   registration_source=context['registration_source'],
                   bank_poses=len(registry['poses']))
    return recall, rows, summary


def allocation_by_page(allocation_run, library):
    """Canonical (part, colour) multiset each page's parts strip allocates."""
    payload = json.loads((Path(allocation_run) / 'global-assignment.json').read_text())
    if payload.get('truth_used') is not False or payload.get('runtime_vlm_calls') != 0:
        raise ValueError('Allocation provenance lacks truth-free zero-VLM attestation')
    pages = {}
    for entry in payload['evidence']:
        if entry.get('part') is None:
            continue
        key = (canonical_name(entry['part'], library), int(entry['color']))
        bucket = pages.setdefault(int(entry['page']), {})
        bucket[key] = bucket.get(key, 0) + int(entry.get('qty', 1))
    return pages


def build(run, truth_path, allocation_run, render=True, visibility_ratio=0.25):
    from placement_diagnose_alias_poses import (canonicalize, verified_local_symmetries,
                                                yaw_equivalent_matching)
    from placement_part_library import PartLibrary
    from placement_part_symmetry_table import symmetries as part_symmetries
    from pose_score import read_parts
    run = Path(run)
    journal = json.loads((run / 'autodrive.json').read_text())
    if journal.get('truth_used') is not False or journal.get('runtime_vlm_calls') != 0:
        raise ValueError('Run journal lacks truth-free zero-VLM attestation')
    library = PartLibrary()
    truth, _ = canonicalize(read_parts(truth_path), library)
    placed = [step for step in journal['steps'] if step.get('placement')]
    if not placed:
        raise ValueError('The run placed no page')
    final = Path(placed[-1]['placement']) / 'model.ldr'
    recon, _ = canonicalize(read_parts(final), library)
    matched, pairs, transform = yaw_equivalent_matching(recon, truth, verified_local_symmetries)
    correct = {index for _, index in pairs}
    wanted = sorted({str(part) for part, *_ in truth}
                    | {str(part) for part, *_ in recon})
    symmetries = {part: list(part_symmetries(part, 'vertex')) for part in wanted}
    allocations = allocation_by_page(allocation_run, library) if allocation_run else {}
    blocked = {}
    for step in journal['steps']:
        if step.get('placement'):
            continue
        for key in allocations.get(step['page'], {}):
            blocked.setdefault(key, []).append((step['page'], step['status']))

    targets, pages, control = {}, [], []
    for step in placed:
        recall, rows, context = measure_page(run, step['page'], truth, library, symmetries, render)
        for row in rows:
            row['page'] = step['page']
            # The false-positive control for the visibility class: a reference
            # instance this run DID place correctly, measured the same way. If
            # correct placements paint as little as the failures, low painted
            # area does not separate them and the class means nothing.
            if row['truth_index'] in correct:
                control.append(dict(page=step['page'], part=row['part'], color=row['color'],
                                    present_in_bank=row['present'],
                                    painted_against_complete_reference=row.get(
                                        'painted_against_complete_reference'),
                                    painted_against_our_body=row.get('painted_against_our_body')))
            # A reference instance can be a target of more than one page, because
            # the allocation quota is per part and colour. The page that actually
            # placed something for it is the informative one, and failing that the
            # first page that could have.
            targets.setdefault(row['truth_index'], []).append(row)
        row = dict(page=step['page'], status=step['status'],
                   reference_targets=recall['reference_targets'],
                   present_in_bank=recall['present'])
        row.update(context or {})
        pages.append(row)
    painted_by_page = {row['page']: row for row in pages}

    rows = []
    for index, (part, color, position, _frame) in enumerate(truth):
        if index in correct:
            continue
        candidates = targets.get(index, [])
        entry = dict(truth_index=index, part=str(part), color=int(color),
                     reference_position=[float(v) for v in position])
        key = (str(part), int(color))
        if not candidates:
            if key in blocked:
                entry.update(primary_class='allocation_blocked', blocked_pages=blocked[key])
            else:
                entry.update(primary_class='out_of_scope')
            rows.append(entry)
            continue
        # A reference instance can be a target of several pages, because the bank
        # test is per part and colour while the allocation quota is not per
        # instance. The page that actually emitted a piece of that identity is
        # the one whose evidence decided this instance's fate; only when no page
        # did is the strongest opportunity the informative one.
        attempted = [row for row in candidates
                     if key in (painted_by_page[row['page']].get('additions') or [])]
        # Latest, not strongest: the run carried the piece forward until the last
        # page that emitted its identity, so that page is where the instance was
        # finally lost. Choosing the page with the most painted area instead
        # would report the best opportunity the run ever had, which flatters it.
        best = max(attempted or candidates, key=lambda row: (row['present'], row['page']))
        page_row = painted_by_page[best['page']]
        rivals = page_row.get('selected_painted') or []
        rival = max(rivals) if rivals else None
        # The quantity the run's own objective actually saw is the pose's painted
        # area against the body it was scored on, not against the finished model.
        # The complete-reference number answers a different question - whether the
        # piece is hidden by the viewpoint or only by our own wrong parts - and it
        # is meaningless on a page whose body is a small fraction of the model.
        painted = best.get('painted_against_our_body')
        complete = best.get('painted_against_complete_reference')
        target_pixels = page_row.get('target_pixels')
        entry.update(page=best['page'], present_in_bank=best['present'],
                     bank_hits=len(best['bank_indices']),
                     painted_against_our_body=painted,
                     painted_against_complete_reference=complete,
                     rival_painted=rival,
                     evidence_share_of_drawing=(None if painted is None or not target_pixels
                                                else painted / target_pixels),
                     pages_allocating=[row['page'] for row in candidates])
        if not best['present']:
            entry['primary_class'] = 'unreachable'
        elif painted is None:
            entry['primary_class'] = 'unmeasured'
        elif painted < ABSOLUTE_VISIBILITY_FLOOR or (rival and painted < visibility_ratio * rival):
            entry['primary_class'] = 'visibility_limited'
        else:
            entry['primary_class'] = 'mis_selected'
        rows.append(entry)

    counts = {}
    for row in rows:
        counts[row['primary_class']] = counts.get(row['primary_class'], 0) + 1
    # The cross-tab keeps the two independent obstructions visible: a pose can be
    # both absent from the bank and invisible, and a precedence order hides that.
    cross = {}
    for row in rows:
        if 'present_in_bank' not in row:
            continue
        painted = row.get('painted_against_our_body')
        visible = None if painted is None else painted >= ABSOLUTE_VISIBILITY_FLOOR
        cross[f"bank={row['present_in_bank']} visible={visible}"] = \
            cross.get(f"bank={row['present_in_bank']} visible={visible}", 0) + 1
    # Whether the complete-reference control means anything on this fixture. It
    # buries an early page's addition under the whole finished model, so it is
    # only informative once the body is most of the model - which is testable
    # from the control itself rather than assumed from the page number.
    control_complete = [row['painted_against_complete_reference'] for row in control
                        if row.get('painted_against_complete_reference') is not None]
    control_valid = bool(control_complete) and min(control_complete) >= ABSOLUTE_VISIBILITY_FLOOR
    body_fraction = [row['base_parts'] / len(truth) for row in pages if 'base_parts' in row]
    return dict(run=str(run), truth=str(truth_path), allocation_run=str(allocation_run),
                truth_parts=len(truth), emitted=len(recon), correct=matched,
                coverage=matched / len(truth), precision=matched / max(1, len(recon)),
                global_alignment=transform, classes=counts, bank_visibility_cross_tab=cross,
                visibility_ratio=visibility_ratio,
                absolute_visibility_floor=ABSOLUTE_VISIBILITY_FLOOR,
                correctly_placed_control=control,
                correctly_placed_painted=sorted(
                    row['painted_against_our_body'] for row in control
                    if row.get('painted_against_our_body') is not None),
                complete_reference_control=dict(
                    painted=sorted(control_complete), applicable=control_valid,
                    body_fraction_of_model=body_fraction,
                    note='A correctly placed reference instance must itself paint a usable area '
                         'against the complete reference model for that measurement to separate '
                         'anything. Where it does not, the finished model buries every addition at '
                         "the page's own camera and the control is reported as inapplicable."),
                pages=pages, rows=rows,
                scope='Evaluation-only, executed after the run. The reference model supplies the '
                      'targets, the alignment and the poses measured; none of it participates in '
                      'candidate generation, scoring or selection, and nothing here is certified.',
                limitations='Visibility is measured against the complete reference assembly at the '
                            "page's own accepted camera and mask, so it excludes occlusion by our "
                            'own errors but still depends on that camera being right. A reference '
                            'instance allocated by several pages is reported at the page whose bank '
                            'holds it. Reference file order is not PDF step order, so a target '
                            'attributed to one page can genuinely belong to another.')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--run', type=Path, required=True)
    parser.add_argument('--truth', required=True)
    parser.add_argument('--allocation-run', type=Path)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--no-render', action='store_true',
                        help='Skip every GPU measurement; classes collapse to bank presence')
    parser.add_argument('--visibility-ratio', type=float, default=0.25)
    args = parser.parse_args()
    result = build(args.run, args.truth, args.allocation_run, not args.no_render,
                   args.visibility_ratio)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2))
    print(f"correct {result['correct']}/{result['truth_parts']} "
          f"({result['coverage']:.3f}), emitted {result['emitted']}")
    for name, count in sorted(result['classes'].items(), key=lambda kv: -kv[1]):
        print(f'  {name:<20} {count:>3}')
    print('  cross-tab', json.dumps(result['bank_visibility_cross_tab']))
    painted = result['correctly_placed_painted']
    if painted:
        print(f'  control: {len(painted)} correctly placed reference targets paint '
              f'{painted[0]}-{painted[-1]} px against their own page body, median '
              f'{painted[len(painted) // 2]}')
    complete = result['complete_reference_control']
    print(f"  complete-reference control applicable={complete['applicable']} "
          f"(correct targets paint {complete['painted']})")
    print(f"{'part':<12} {'col':>4} {'page':>5} {'bank':>5} {'ourbody':>8} {'rival':>7} "
          f"{'share':>7} {'complete':>8}  class")
    for row in result['rows']:
        share = row.get('evidence_share_of_drawing')
        print(f"{row['part']:<12} {row['color']:>4} {str(row.get('page','-')):>5} "
              f"{str(row.get('present_in_bank','-')):>5} "
              f"{str(row.get('painted_against_our_body','-')):>8} "
              f"{str(row.get('rival_painted','-')):>7} "
              f"{('%.4f' % share) if share is not None else '-':>7} "
              f"{str(row.get('painted_against_complete_reference','-')):>8}  {row['primary_class']}")
    print(args.out)


if __name__ == '__main__':
    main()
