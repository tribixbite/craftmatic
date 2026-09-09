"""Is an allocated colour's absence from the coarse target real, and can withholding help?

Round six measured that 40377 pages 26 and 27 allocate LDraw 191 (Bright Light
Orange) and that **not one pixel** of either page's coarse target is classified
as it, while every other model colour is present. A candidate painting a class
the target does not contain adds nothing to `correct` and nothing to `false`, so
those pages' 1,926 and 4,142 candidates all score exactly zero and the traversal
order among them is arbitrary. Round five's `placement_undrawn_pieces` reported
the opposite on the same pages - nothing withheld, drawn share 6.24 - and this
module settles which quantity each tool measures and what, if anything, the
round-five withholding machinery can do about it.

Three quantities, measured side by side on one page:

* **The run's own target.** `build_bank` classifies the drawing against a
  palette of every model colour, sorted **numerically**, and that array is what
  the coarse composite scores against. Its per-class histogram is the only
  quantity the objective can see.
* **The undrawn rule's classification.** `placement_undrawn_pieces` classifies
  the same drawing against a palette built **allocated colours first**, and
  divides by one piece's minimum silhouette. Same pixels, different palette
  order.
* **The reference poses' own footprints.** What the target says underneath each
  correct pose, which is what decides whether a repaired classifier would
  actually reward the right answer.

The two classifications differ because `palette_labels` discriminates chromatic
entries by **hue alone** and LDraw 19 (Tan) and 191 both convert to hue 20, so
`argmin` breaks a perfect tie by lower palette index; the module therefore also
reports the same drawing under `saturation_tiebreak`, which separates them, and
scores every watched candidate against both targets. Absence measured under one
palette order is not evidence of absence from the drawing.

The rule this module then defines and measures is deliberately the *target's*
question rather than the drawing's: withhold the pieces of an allocated colour
whose share of the **run's own target** falls below `min_share` of one such
piece's silhouette, because the image search cannot be asked to place what its
objective cannot score. Its ceiling is measured, not assumed: the withheld
pieces are handed to `placement_exploded_attach`, the same non-image channel the
round-five `withhold(...)` path uses, and what it places or refuses is reported.

Nothing here changes a run. The reference model is optional, read only after the
measurement, and selects nothing.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

# Share of one piece's minimum silhouette below which an allocated colour counts
# as absent from the target. The same constant `placement_undrawn_pieces` uses,
# so the two rules differ only in which classification they read.
MIN_SHARE = 0.25
# Weight for the opt-in hue tie-break in `palette_labels`. 0.01 is the low end of
# the band that module documents as moving only the tied pair.
TIEBREAK = 0.01


def class_histogram(labels, colors):
    """Pixels per LDraw colour for a 1-based class array, plus the unclassified."""
    labels = np.asarray(labels)
    counts = {int(color): int((labels == index + 1).sum())
              for index, color in enumerate(colors)}
    return counts, int((labels == 0).sum())


def canvas_drawing(scorer, metadata):
    """The rgb/mask the bank classified, reproduced from its own metadata.

    `build_bank` warps the scene onto a canvas that must hold every candidate,
    so a classification computed on the raw scene is not the array the objective
    scored. The warp is a translation and a scale, both recorded.
    """
    import cv2
    low = np.asarray(metadata['canvas_low'], float)
    width, height = (int(v) for v in metadata['canvas_size'])
    scale = float(metadata['scale'])
    affine = np.array([[scale, 0., -low[0]], [0., scale, -low[1]]])
    rgb = cv2.warpAffine(scorer.rgb, affine, (width, height),
                         flags=cv2.INTER_NEAREST, borderValue=(245, 245, 245))
    mask = cv2.warpAffine(scorer.mask.astype(np.uint8), affine, (width, height),
                          flags=cv2.INTER_NEAREST) > 0
    return rgb, mask


def classify(rgb, mask, colors, saturation_tiebreak=0.):
    """`build_bank`'s own classification of a canvas, at an explicit tie-break."""
    from placement_colored_cad import _rgb
    from placement_palette_classes import palette_labels
    palette = np.stack([_rgb(int(c)) for c in colors]).astype(np.uint8)
    labels, valid = palette_labels(rgb, mask, palette,
                                   saturation_tiebreak=saturation_tiebreak)
    labels = labels.copy()
    labels[~valid] = 0
    return labels


def target_absent(target, colors, pieces, projection, min_share=MIN_SHARE, resolver=None):
    """Allocated colours the run's own coarse target contains too little of.

    The predicate is `placement_undrawn_pieces`' - a colour's ink against one
    piece of that colour's smallest silhouette - read off the target array the
    objective actually scores rather than off a fresh classification of the
    drawing. Returns the per-colour rows and the (part, colour) keys a
    withholding rule would take.
    """
    if not 0.0 < min_share < 1.0:
        raise ValueError('Minimum share must be a fraction between zero and one')
    from placement_exploded_page import silhouette_area_range
    pieces = [(str(part), int(color)) for part, color in pieces]
    if not pieces:
        raise ValueError('A page with no allocated piece has no colour to judge')
    counts, _unclassified = class_histogram(target, colors)
    rows, withheld = [], []
    for color in sorted({color for _part, color in pieces}):
        if color not in counts:
            raise ValueError(f'Allocated colour {color} is not in the bank palette')
        needed = min(silhouette_area_range(part, color, projection, resolver)[0]
                     for part, other in pieces if other == color)
        share = counts[color] / needed if needed > 0 else float('inf')
        absent = share < min_share
        rows.append(dict(color=color, target_pixels=counts[color],
                         single_piece_min_pixels=needed, target_share=share, absent=absent,
                         pieces=[list(p) for p in pieces if p[1] == color]))
        if absent:
            withheld.extend(p for p in pieces if p[1] == color)
    return rows, [list(p) for p in withheld]


def withholding_verdict(pieces, withheld, arrows):
    """Can the shipped withholding machinery accept this split, and why not.

    Two independent gates, both in shipped code and both load-bearing here:
    `placement_undrawn_pieces` refuses a split leaving fewer than two image
    pieces, and `placement_multi_shape_search` raises outright when pieces are
    withheld on a page with no accepted arrows to place them.
    """
    keys = [(str(p), int(c)) for p, c in withheld]
    kept = [list(p) for p in pieces if (str(p[0]), int(p[1])) not in set(keys)]
    reasons = []
    if not keys:
        reasons.append('no allocated colour is absent from the target')
    if keys and len(kept) < 2:
        reasons.append(f'withholding leaves {len(kept)} image pieces, and the shipped rule '
                       'refuses fewer than two')
    if keys and not arrows:
        reasons.append('the page has no accepted arrowhead, and the search refuses withheld '
                       'pieces without arrows to place them')
    return dict(image_pieces=kept, withheld=[list(k) for k in keys],
                applicable=bool(keys) and len(kept) >= 2 and bool(arrows),
                refusals=reasons)


def composite_metric(base_depth, base_labels, depths, labels, chosen, target):
    """`placement_cardinality_search`'s own coarse objective, on one assembly.

    Mean per-class IoU over the classes the target contains; a candidate painting
    a class absent from the target can only occlude a correctly labelled pixel,
    never add one, which is what makes the objective one-sided here.
    """
    target = np.asarray(target)
    classes = [int(c) for c in np.unique(target) if c > 0]
    if not classes:
        raise ValueError('Target has no scored material classes')
    depth = np.asarray(base_depth).copy()
    label = np.asarray(base_labels).copy()
    for index in sorted(chosen):
        take = np.isfinite(depths[index]) & (depths[index] >= depth)
        depth[take] = depths[index][take]
        label[take] = labels[index][take]
    return float(np.mean([np.sum((target == c) & (label == c))
                          / max(1, np.sum((target == c) | (label == c))) for c in classes]))


def agreement(labels, target):
    """The traversal priority: agreeing pixels, counted, over scored target ink."""
    target = np.asarray(target)
    return float(np.sum((np.asarray(labels) == target) & (target > 0)))


def bank_agreement(labels, target, chunk=256):
    """The shipped traversal priority for every candidate, chunked for memory."""
    target = np.asarray(target)
    scored = target > 0
    values = np.empty(len(labels), float)
    for start in range(0, len(labels), chunk):
        block = np.asarray(labels[start:start + chunk])
        values[start:start + chunk] = ((block == target) & scored).sum(axis=(1, 2))
    return values


def ranks_of(values, indices):
    """Rank of each index under descending `values`, ties by candidate order."""
    order = np.argsort(-np.asarray(values), kind='stable')
    rank = {int(index): position for position, index in enumerate(order, 1)}
    return {int(index): rank[int(index)] for index in indices}


def _watched_rows(bank, target, watched, kinds):
    """Per-candidate agreement, footprint histogram and composite delta."""
    target = np.asarray(target)
    base = composite_metric(bank['base_depth'], bank['base_labels'],
                            bank['depths'], bank['labels'], (), target)
    base_depth = np.asarray(bank['base_depth'])
    rows = []
    for index in watched:
        painted = np.asarray(bank['labels'][index]) > 0
        # What survives the depth test against the body already emitted. A pose
        # entirely behind it changes no pixel of the composite, so the image
        # objective cannot score it at all - a different failure from a pose
        # whose colour is misclassified, and the two are separable only here.
        visible = np.isfinite(bank['depths'][index]) & (bank['depths'][index] >= base_depth)
        values, counts = np.unique(target[painted], return_counts=True)
        rows.append(dict(kind=kinds[index], placement=int(index),
                         painted=int(painted.sum()),
                         visible_over_body=int((visible & painted).sum()),
                         agreement=agreement(bank['labels'][index], target),
                         target_classes_under_footprint={int(v): int(c)
                                                         for v, c in zip(values, counts)},
                         composite_with_this_pose=composite_metric(
                             bank['base_depth'], bank['base_labels'], bank['depths'],
                             bank['labels'], (index,), target)))
    for row in rows:
        row['composite_delta'] = row['composite_with_this_pose'] - base
    return base, rows


def one_placement_per_key(placements):
    """One candidate per distinct (part, colour), which fixes the bank palette.

    `build_bank`'s palette is the sorted colour set of the base plus the
    candidates, and its canvas always contains the whole drawing mask, so the
    target's *foreground* histogram does not depend on how many candidates are
    in the bank - only on which colours are. Keeping one placement per key is
    therefore an exact shortcut for the histogram and the absence verdict, and
    is refused for anything that reads a candidate's own pixels.
    """
    seen, kept = set(), []
    for entry in placements:
        part, color, _T = entry['items'][0]
        key = (str(part), int(color))
        if key in seen:
            continue
        seen.add(key)
        kept.append(entry)
    return kept


def measure(run, page, truth=None, min_share=MIN_SHARE, tiebreak=TIEBREAK, light=False,
            view=None, outside_fraction=0.01, position_tolerance=1.0, host_bytes=12_000_000_000):
    """One page's absent-class measurement, withholding verdict and ceiling."""
    from placement_arrow_contacts import read_items
    from placement_arrow_mask import conservative_components
    from placement_cardinality_bank import build_bank
    from placement_exploded_attach import attach_detached
    from placement_material_scene_score import MaterialFeatureSceneScorer
    from placement_multi_shape_batch import shape_bank
    from placement_occupancy_screen import screen
    from placement_page_mask import part_palette
    from placement_run_scene import run_scene
    from placement_undrawn_pieces import undrawn

    run = Path(run)
    step = run / f'page-{page:03d}'
    placement = step / 'placement'
    registry = json.loads((step / 'registry-00.json').read_text())
    result = json.loads((placement / 'results.json').read_text())
    if registry.get('truth_used') is not False or result.get('truth_used') is not False:
        raise ValueError('Run artifacts lack truth-free provenance')
    registration = json.loads((step / 'registration-refined-00.json').read_text())
    chosen_view = int(result['results'][0].get('view') or 0) if view is None else view
    chosen_view = min(chosen_view, len(registration['hypotheses']) - 1)
    hypothesis = registration['hypotheses'][chosen_view]
    M = np.asarray(hypothesis['projection'], float)
    origin = np.asarray(hypothesis['origin'], float)

    base_source = Path(registry['base_source'])
    base = read_items(base_source)
    scene, mask_source = run_scene(result, read_items(placement / 'model.ldr'))
    pieces = [(str(part), int(color)) for part, color in registry['allocated_pieces']]
    # The arrows the driver would have to place a withheld piece with: measured
    # on the same scene and CAD palette `placement_autodrive` uses.
    palette = part_palette(list(pieces) + [(str(part), int(color)) for part, color, _ in base])
    graph = conservative_components(scene, protected_colors=palette['rgb'])
    arrows = graph['arrows']

    scorer = MaterialFeatureSceneScorer(scene, plane_depth=True)
    shapes = [dict(items=[(str(entry['part']), 15, np.asarray(entry['T'], float))])
              for entry in registry['poses']]
    gate = screen(base, shapes, M, origin, scorer,
                  outside_tolerance_px=int(hypothesis.get('outside_pixels') or 0),
                  outside_fraction=outside_fraction)
    subset = dict(registry, poses=[registry['poses'][i] for i in gate['retained_indices']])
    image_pieces = result.get('image_pieces') or registry['allocated_pieces']
    placements, _quotas = shape_bank(subset, [(p, c) for p, c in image_pieces])
    screened = len(placements)
    if light:
        if truth is not None:
            raise ValueError('The light bank keeps one candidate per key, so it cannot locate '
                             'reference poses; drop --light to evaluate')
        placements = one_placement_per_key(placements)
    bank = build_bank(base, placements, M, origin, scorer, max_host_bytes=host_bytes)
    colors = [int(c) for c in bank['metadata']['colors']]
    target = np.asarray(bank['target'])

    # 1. What the objective sees, and what the same pixels say under the other
    #    two palette orders the program uses.
    rgb, mask = canvas_drawing(scorer, bank['metadata'])
    allocated_first = list(dict.fromkeys([int(c) for _p, c in pieces]
                                         + [c for c in colors]))
    # Keys are strings so the printed table and the JSON read the same way.
    as_text = lambda counts: {str(color): int(count) for color, count in counts.items()}
    orders = dict(
        run_numerically_sorted=as_text(class_histogram(target, colors)[0]),
        undrawn_allocated_first=as_text(class_histogram(
            classify(rgb, mask, allocated_first), allocated_first)[0]),
        run_order_with_saturation_tiebreak=as_text(class_histogram(
            classify(rgb, mask, colors, saturation_tiebreak=tiebreak), colors)[0]))

    # 2. The rule, on the quantity the objective can see, and the shipped rule on
    #    its own quantity - the two numbers that appeared to contradict.
    rows, withheld = target_absent(target, colors, pieces, M, min_share=min_share)
    body_colors = sorted({int(color) for _p, color, _T in base})
    shipped = undrawn(scene, pieces, M, min_share=min_share, context_colors=body_colors)
    verdict = withholding_verdict(pieces, withheld, arrows)

    # 3. The non-image channel's ceiling, run rather than asserted.
    placed = []
    if withheld and arrows:
        placed, attachment = attach_detached(list(base), [(p, c) for p, c in withheld],
                                             registry['poses'], M, origin, arrows)
        placed = list(placed)
        # `attach_detached` abstains only when NO pose is contact-supported, so a
        # pose supported by almost nothing is still placed. Surfacing the score
        # and the arrowhead error is what separates the two: the documented good
        # case on page index 17 is 0.51 px at score 1.0.
        scored = [step for step in attachment['steps'] if step.get('status') == 'placed']
        attachment = dict(attachment, placed=len(placed), arrows=len(arrows),
                          best_score=max((step['score'] for step in scored), default=None),
                          worst_mean_head_error_px=max((step['mean_head_error_px']
                                                        for step in scored), default=None))
    elif withheld:
        # `placement_exploded_attach` needs an arrowhead to score against, and
        # `placement_multi_shape_search` refuses the split outright without one.
        attachment = dict(status='abstained', reason='no_accepted_arrow', arrows=0, placed=0)
    else:
        attachment = dict(status='not_attempted', reason='no absent colour to withhold',
                          arrows=len(arrows), placed=0)

    record = dict(
        run=str(run), page=int(page), view=chosen_view, mask_source=mask_source,
        xref=result.get('xref'), bank_colors=colors,
        allocated_pieces=[list(p) for p in pieces],
        screened_placements=screened, bank_candidates=len(placements),
        light_bank=bool(light), registry_poses=len(registry['poses']),
        accepted_arrows=len(arrows),
        target_foreground_pixels=int((target > 0).sum()),
        target_unclassified_pixels=int((target == 0).sum() - (~mask).sum()),
        class_histograms=orders,
        absent_colors=[row['color'] for row in rows if row['absent']],
        target_rule=dict(min_share=min_share, colors=rows, withheld=withheld),
        shipped_undrawn_rule=dict(withheld_keys=[list(k) for k in shipped['withheld_keys']],
                                  reason=shipped['reason'],
                                  colors=[{k: row[k] for k in
                                           ('color', 'drawn_pixels', 'single_piece_min_pixels',
                                            'drawn_share', 'absent')}
                                          for row in shipped['colors']]),
        withholding=verdict, non_image_channel=attachment,
        truth_used=truth is not None, truth_used_at_runtime=False,
        runtime_vlm_calls=0, certified=False,
        protocol='The run\'s own screened bank, camera and target, rebuilt from its artifacts. '
                 'Class histograms are the same canvas classified under three palette orders; '
                 'the withholding rule reads the run\'s target, the shipped rule its own '
                 'allocated-first classification. The non-image channel is executed, not assumed.',
        limitations='Absence is measured under one classifier. Because `palette_labels` '
                    'separates chromatic entries by hue alone, two colours sharing a hue tie and '
                    'argmin resolves the tie by palette position, so a zero count is evidence '
                    'about the labelling as much as about the drawing - which is why all three '
                    'orders are reported. Composite deltas are per single pose against the '
                    'emitted body, not a full assembly, and rank a placement rather than prove '
                    'the combinational search would keep it.')

    if truth is None:
        return record

    # Evaluation-only, strictly after the measurement above.
    from placement_diagnose_alias_poses import canonicalize
    from placement_diagnose_bank_recall import bank_recall
    from placement_mirror_completion import frames_equal
    from placement_part_library import PartLibrary
    from placement_part_symmetry_table import symmetries as part_symmetries
    from placement_population_table import canonical_name
    from pose_score import read_parts

    library = PartLibrary()
    reference, _ = canonicalize(read_parts(truth), library)
    base_items, _ = canonicalize(read_parts(base_source), library)
    names = {str(part) for part, *_ in reference} | {str(e['part']) for e in registry['poses']}
    symmetry_table = {part: list(part_symmetries(part, 'vertex')) for part in names}
    recall = bank_recall(registry, reference, base_items, symmetries=symmetry_table)
    alignment = recall['alignment']['alignment']
    rotation = np.asarray(alignment['rotation'], float)
    translation = np.asarray(alignment['translation'], float)
    inverse, offset = rotation.T, -rotation.T @ translation
    targets = [dict(part=entry['part'], color=int(entry['color']),
                    truth_index=entry['truth_index'], present=bool(entry['present']),
                    position=inverse @ np.asarray(entry['reference_position'], float) + offset,
                    frame=inverse @ np.asarray(entry['reference_frame'], float))
               for entry in recall['rows']]
    selected = [(canonical_name(part, library), int(color), np.asarray(T, float))
                for part, color, T in read_items(placement / 'model.ldr')][len(base):]
    reference_indices, selected_indices = {}, []
    for index, entry in enumerate(placements):
        part, _color, T = entry['items'][0]
        name = canonical_name(part, library)
        symmetry = part_symmetries(name, 'vertex')
        for entry_target in targets:
            if entry_target['part'] != name:
                continue
            if np.max(np.abs(T[:3, 3] - entry_target['position'])) > position_tolerance:
                continue
            if frames_equal(T[:3, :3], entry_target['frame'], symmetry):
                reference_indices.setdefault(entry_target['truth_index'], index)
        for other, _c, other_T in selected:
            if other != name:
                continue
            if np.max(np.abs(T[:3, 3] - other_T[:3, 3])) > position_tolerance:
                continue
            if frames_equal(T[:3, :3], other_T[:3, :3], symmetry):
                selected_indices.append(index)
    # The ceiling the withholding rule could actually reach: how many of the
    # page's distinct reference instances the non-image channel placed exactly.
    attached_rows, attached_correct = [], set()
    for part, color, T in placed:
        name = canonical_name(part, library)
        symmetry = part_symmetries(name, 'vertex')
        matched = None
        for entry_target in targets:
            if entry_target['part'] != name or int(entry_target['color']) != int(color):
                continue
            if np.max(np.abs(np.asarray(T)[:3, 3] - entry_target['position'])) > position_tolerance:
                continue
            if frames_equal(np.asarray(T)[:3, :3], entry_target['frame'], symmetry):
                matched = entry_target['truth_index']
                break
        if matched is not None:
            attached_correct.add(matched)
        attached_rows.append(dict(part=name, color=int(color),
                                  translation=[float(v) for v in np.asarray(T)[:3, 3]],
                                  matched_truth_index=matched))

    kinds = {}
    for index in selected_indices:
        kinds[index] = 'selected_by_the_run'
    for truth_index, index in reference_indices.items():
        kinds[index] = f'reference:{truth_index}'
    watched = sorted(kinds)
    repaired = classify(rgb, mask, colors, saturation_tiebreak=tiebreak)
    base_today, rows_today = _watched_rows(bank, target, watched, kinds)
    base_repaired, rows_repaired = _watched_rows(bank, repaired, watched, kinds)
    # Whether repairing the classifier would move the traversal towards the
    # reference poses, over the whole screened bank rather than the watched set.
    for rows, array in ((rows_today, target), (rows_repaired, repaired)):
        values = bank_agreement(bank['labels'], array)
        ranking = ranks_of(values, watched)
        zeros = int((values == 0).sum())
        for row in rows:
            row['agreement_rank'] = ranking[row['placement']]
            row['candidates_with_zero_agreement'] = zeros
            # When every candidate scores zero the rank is the stable sort's
            # candidate order, not evidence; saying so is the difference between
            # a measurement and a number.
            row['agreement_rank_is_arbitrary'] = zeros == len(values)
    record['evaluation'] = dict(
        truth=str(truth), reference_targets=len(targets),
        reference_truth_indices=[t['truth_index'] for t in targets],
        # Enumerated at all, before the occupancy screen: the pose set the
        # non-image channel searches over is the whole registry, not the screen's
        # survivors, so this is that channel's own recall ceiling.
        enumerated_in_registry=[t['truth_index'] for t in targets if t['present']],
        located_in_screened_bank=sorted(reference_indices),
        non_image_attached=attached_rows,
        non_image_correct_truth_indices=sorted(attached_correct),
        non_image_correct=len(attached_correct),
        body_only_composite=dict(today=base_today, with_tiebreak=base_repaired),
        rows_today=rows_today, rows_with_tiebreak=rows_repaired,
        note='The reference model is read only to locate poses already enumerated by the run. '
             'It selects nothing and no runtime code reads it.')
    return record


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--run', type=Path, required=True, help='Driver run directory')
    parser.add_argument('--page', type=int, action='append', required=True,
                        help='Page index; repeatable')
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--truth', default=None, help='Reference model, evaluation-only')
    parser.add_argument('--min-share', type=float, default=MIN_SHARE)
    parser.add_argument('--tiebreak', type=float, default=TIEBREAK)
    parser.add_argument('--view', type=int, default=None)
    parser.add_argument('--light', action='store_true',
                        help='One candidate per (part, colour): exact for the histogram and the '
                             'absence verdict, and refused with --truth')
    args = parser.parse_args()

    pages = [measure(args.run, page, truth=args.truth, min_share=args.min_share,
                     tiebreak=args.tiebreak, light=args.light, view=args.view)
             for page in args.page]
    record = dict(run=str(args.run), pages=pages,
                  pages_measured=len(pages),
                  pages_with_an_absent_allocated_colour=sum(1 for p in pages if p['absent_colors']),
                  pages_withholding_applicable=sum(1 for p in pages if p['withholding']['applicable']),
                  distinct_reference_targets=sum(p.get('evaluation', {}).get('reference_targets', 0)
                                                 for p in pages),
                  non_image_placements=sum(p['non_image_channel'].get('placed', 0) for p in pages),
                  non_image_correct=sum(p.get('evaluation', {}).get('non_image_correct', 0)
                                        for p in pages),
                  truth_used=args.truth is not None, truth_used_at_runtime=False,
                  runtime_vlm_calls=0, certified=False,
                  limitations=pages[0]['limitations'] if pages else 'No page measured')
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(record, indent=2))
    for page in pages:
        print(f"=== page {page['page']} view {page['view']} "
              f"({page['screened_placements']} screened, {page['bank_candidates']} in bank, "
              f"{page['accepted_arrows']} arrows)")
        print(f"{'colour':>7} {'run target':>11} {'undrawn':>9} {'tiebreak':>9} "
              f"{'one piece':>10} {'share':>8}  absent")
        allocated = {int(c) for _p, c in page['allocated_pieces']}
        histograms = page['class_histograms']
        rows = {row['color']: row for row in page['target_rule']['colors']}
        for color in [int(c) for c in page['bank_colors']]:
            row = rows.get(color)
            key = str(color)
            print(f"{color:>7} {histograms['run_numerically_sorted'][key]:>11} "
                  f"{histograms['undrawn_allocated_first'][key]:>9} "
                  f"{histograms['run_order_with_saturation_tiebreak'][key]:>9} "
                  + (f"{row['single_piece_min_pixels']:>10.0f} {row['target_share']:>8.3f}  "
                     f"{row['absent']}" if row else
                     f"{'-':>10} {'-':>8}  not allocated"))
        print(f"  withholding applicable: {page['withholding']['applicable']} "
              f"{page['withholding']['refusals']}")
        channel = page['non_image_channel']
        print(f"  non-image channel: {channel['status']} placed {channel.get('placed', 0)} "
              f"({page['accepted_arrows']} arrows"
              + (f", best score {channel['best_score']:.3g}, worst arrowhead error "
                 f"{channel['worst_mean_head_error_px']:.1f} px"
                 if channel.get('best_score') is not None else
                 f", {channel.get('reason')}") + ')')
        evaluation = page.get('evaluation')
        if evaluation:
            print(f"  reference targets {evaluation['reference_targets']}, enumerated "
                  f"{len(evaluation['enumerated_in_registry'])}, located "
                  f"{len(evaluation['located_in_screened_bank'])} in the screened bank, "
                  f"non-image channel correct {evaluation['non_image_correct']} of "
                  f"{len(evaluation['non_image_attached'])} attached")
            zeros = evaluation['rows_today'][0]['candidates_with_zero_agreement']
            zeros_tb = evaluation['rows_with_tiebreak'][0]['candidates_with_zero_agreement']
            print(f"  candidates at zero agreement: {zeros} today, {zeros_tb} with the tie-break")
            print(f"  {'kind':<22} {'painted':>8} {'visible':>8} {'agree':>7} {'rank':>6} "
                  f"{'agree+tb':>9} {'rank+tb':>8} {'delta':>10} {'delta+tb':>10}")
            for today, repaired in zip(evaluation['rows_today'],
                                       evaluation['rows_with_tiebreak']):
                print(f"  {today['kind']:<22} {today['painted']:>8} "
                      f"{today['visible_over_body']:>8} {today['agreement']:>7.0f} "
                      f"{today['agreement_rank']:>6} {repaired['agreement']:>9.0f} "
                      f"{repaired['agreement_rank']:>8} {today['composite_delta']:>10.5f} "
                      f"{repaired['composite_delta']:>10.5f}")
    print(f"pages {record['pages_measured']}, absent-colour pages "
          f"{record['pages_with_an_absent_allocated_colour']}, withholding applicable "
          f"{record['pages_withholding_applicable']}, non-image placements "
          f"{record['non_image_placements']}")
    print(args.out)


if __name__ == '__main__':
    main()
