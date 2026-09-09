"""Why does an enumerated, screened reference pose never enter a retained assembly?

`placement_retention_audit` splits `mis_selected` into screen, retention and
ranking and reports twenty distinct reference instances - thirteen on 40377 and
seven on 41624 - that are in the page bank, survive the occupancy screen, and
appear in no assembly the run wrote. That is a stage, not a mechanism. This tool
measures the mechanism, on the same artifacts, for each of those instances.

Four candidate mechanisms are measured separately, so a refuted one is refuted
with a number rather than by argument:

1. **Support connectivity.** The beam may add a placement only when it is
   base-anchored or adjacent, in the *witnessed* support graph, to something
   already chosen, and a complete assembly must be connected. A closure pose
   whose only witness was dropped by the occupancy screen is then structurally
   unreachable. Measured as: is the target anchored, and if not, how many hops
   of witnessed support separate it from an anchor inside the screened set.
2. **Coarse ranking and the plateau.** Expansion ranks by the exact per-class
   depth-composite IoU of the *resulting* set. Measured as: the target's own
   single-placement score, its delta from the empty-assembly score, its rank
   overall and inside its own (part, colour) key, and how many candidates share
   its score exactly. A tie band is broken by `np.argsort(..., kind='stable')`,
   which is bank-enumeration order, so a target inside the band is not ranked
   below the beam - it is ordered below it by its index.
3. **Quota and collision.** `shape_bank` replicates a pose once per allocated
   colour and the search enforces an exact per-key quota under pairwise
   collision exclusion. Measured as: is there a legal quota-preserving assembly
   containing the target at all - constructed as a single-placement exchange
   from the assembly the run selected, checked for collision and connectivity.
4. **Bank truncation.** `build_bank` refuses a bank above `max_host_bytes`.
   Measured as: the view's own status, and whether the rasterized placement
   count equals the screened candidate count.

Because a retention fix is only worth what the selection objective does with
it, the tool also answers the question the audit cannot: **would the run have
selected the target if it had been retained?** The one-swap probe scores
`selected - one same-key placement + target` under the same native scorer that
actually selects, and reports the signed difference. A negative difference says
the objective prefers the pose the run chose, and no retention rule recovers the
part.

Evaluation-only. The reference model supplies the target poses and is read
strictly after the run; it selects nothing, and no runtime VLM participates.
"""
import argparse
import json
import sys
from collections import Counter
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))


# ---------------------------------------------------------------------------
# Pure measurement helpers (no GPU, no PDF, unit tested offline)
# ---------------------------------------------------------------------------

def plateau_stats(scores, base_score, tolerance=0.):
    """Structure of a single-addition ranking around the empty-assembly score.

    A candidate whose composite score equals the base score changes no scored
    pixel, so the ranking carries no information about it. The share of such
    candidates is the size of the plateau the beam has to order by something,
    and the only thing it has is the stable sort's bank-index tie-break.
    """
    scores = np.asarray(scores, float)
    if scores.size == 0:
        raise ValueError('No candidate scores to summarise')
    finite = scores[np.isfinite(scores)]
    zero = np.abs(finite - base_score) <= tolerance
    ordered = np.sort(np.unique(finite))[::-1]
    best_ties = int(np.sum(finite == ordered[0]))
    return dict(candidates=int(finite.size),
                distinct_scores=int(ordered.size),
                base_score=float(base_score),
                best_score=float(ordered[0]),
                worst_score=float(finite.min()),
                span=float(ordered[0] - finite.min()),
                best_over_base=float(ordered[0] - base_score),
                zero_delta=int(np.sum(zero)),
                zero_delta_fraction=float(np.mean(zero)),
                best_score_ties=best_ties)


def rank_within(scores, index, mask=None):
    """Rank of `index` under a descending stable sort, exactly as the beam sorts.

    `mask` restricts the comparison to one (part, colour) key. Ties are resolved
    the way `np.argsort(..., kind='stable')` resolves them, so the reported rank
    is the position the search itself would have used.
    """
    scores = np.asarray(scores, float)
    keep = np.ones(scores.size, bool) if mask is None else np.asarray(mask, bool)
    order = [i for i in np.argsort(-scores, kind='stable') if keep[i]]
    return order.index(int(index))


def support_stage(placement, anchored, adjacency):
    """Hops of witnessed support between `placement` and the nearest anchor."""
    anchored = set(int(i) for i in anchored)
    if int(placement) in anchored:
        return dict(anchored=True, support_reachable=True, hops_to_anchor=0,
                    witnessed_neighbours=len(adjacency[int(placement)]))
    seen = {int(placement)}
    frontier = [int(placement)]
    hops = 0
    while frontier:
        hops += 1
        nxt = []
        for node in frontier:
            for other in adjacency[node]:
                if other in seen:
                    continue
                if other in anchored:
                    return dict(anchored=False, support_reachable=True, hops_to_anchor=hops,
                                witnessed_neighbours=len(adjacency[int(placement)]))
                seen.add(other)
                nxt.append(other)
        frontier = nxt
    return dict(anchored=False, support_reachable=False, hops_to_anchor=None,
                witnessed_neighbours=len(adjacency[int(placement)]))


def swap_sets(selected, target, keys):
    """Quota-preserving one-placement exchanges that introduce `target`.

    The exact per-key cardinality is what makes this the minimal legal edit: a
    target can only enter an assembly by displacing a placement of its own key.
    """
    selected = [int(i) for i in selected]
    target = int(target)
    if target in selected:
        return []
    key = keys[target]
    return [tuple(sorted(selected[:position] + selected[position + 1:] + [target]))
            for position, index in enumerate(selected) if keys[index] == key]


def own_agreement(segments, painted_labels, painted_target, count):
    """Occlusion-free per-candidate agreement: its own pixels against the drawing.

    The incremental composite delta is zero for any candidate whose pixels are
    already painted with the same class by whatever is already placed - including
    by a *wrong* piece standing in the same place - so it collapses to a plateau
    exactly where an exchange needs to discriminate. This quantity is computed on
    the candidate alone and cannot be flattened by the rest of the assembly. It
    is one bincount over the sparse segments `LayerComposite` already builds, so
    it costs nothing to add.
    """
    segments = np.asarray(segments)
    hit = np.asarray(painted_labels) == np.asarray(painted_target)
    return np.bincount(segments[hit], minlength=int(count)).astype(float)


def window_indices(statistic, keys, chosen, outgoing, width):
    """The exchange window: the `width` best same-key candidates under `statistic`.

    Reproduces `native_exchange`'s own selection rule, with the ranking quantity
    left open so two orderings can be compared at an identical render budget.
    """
    statistic = np.asarray(statistic, float)
    order = np.where(np.array([k == keys[outgoing] for k in keys]), statistic, -np.inf)
    order[list(chosen)] = -np.inf
    window = []
    for index in np.argsort(-order, kind='stable'):
        if not np.isfinite(order[index]) or len(window) >= width:
            break
        window.append(int(index))
    return window


def assembly_diversity(assemblies, keys):
    """How many genuinely different hypotheses a retained set actually holds.

    `top_k` retained assemblies are not `top_k` hypotheses when the beam fills
    its width with score ties in one slot. Distinct poses per key and the
    Hamming distance from the best assembly say which of the two it is.
    """
    assemblies = [tuple(sorted(int(i) for i in row)) for row in assemblies]
    if not assemblies:
        return dict(assemblies=0, distinct_poses_per_key={}, frozen_keys=[],
                    hamming_from_best={}, mean_hamming=None)
    best = set(assemblies[0])
    per_key = {}
    for row in assemblies:
        for index in row:
            per_key.setdefault(str(keys[index]), set()).add(index)
    distances = Counter(len(set(row) - best) for row in assemblies)
    return dict(assemblies=len(assemblies),
                distinct_poses_per_key={k: len(v) for k, v in sorted(per_key.items())},
                frozen_keys=sorted(k for k, v in per_key.items() if len(v) == 1),
                hamming_from_best={str(k): v for k, v in sorted(distances.items())},
                mean_hamming=float(np.mean([len(set(row) - best) for row in assemblies])))


# ---------------------------------------------------------------------------
# Run-artifact reconstruction (rebuilds exactly what the search saw)
# ---------------------------------------------------------------------------

def rebuild_view(run, page, view=None):
    """Rebuild one page/view's placement bank byte-identically to the run.

    The reconstruction is self-checked twice: the bank's own host byte count
    must equal the number the run recorded, and the recomputed coarse score of
    the run's own selected candidate must equal the recorded one. Without those
    checks a post-hoc diagnostic silently scores a different question.
    """
    from placement_arrow_contacts import read_items
    from placement_cardinality_bank import build_bank
    from placement_layer_beam import LayerComposite
    from placement_material_scene_score import MaterialFeatureSceneScorer
    from placement_multi_shape_batch import shape_bank
    from placement_page_mask import part_palette, restrict_to_body_component
    import pymupdf
    from vector_scene import scene_images
    step = Path(run) / f'page-{page:03d}'
    registry = json.loads((step / 'registry-00.json').read_text())
    result = json.loads((step / 'placement' / 'results.json').read_text())
    if registry.get('truth_used') is not False or result.get('truth_used') is not False:
        raise ValueError('Run artifacts lack truth-free provenance')
    if result.get('mask_source') not in (None, 'whole_scene', 'largest_component'):
        raise ValueError(f"Unsupported mask source {result.get('mask_source')!r}: the target mask "
                         'would have to be rebuilt to score the same question')
    registration = json.loads(Path(result['registration_source']).read_text())
    view = int(result['results'][0].get('view') or 0) if view is None else int(view)
    record = next(v for v in result['views'] if v.get('view') == view)
    if record.get('status') != 'bounded_search':
        raise ValueError(f"View {view} did not run a bounded search: {record.get('status')}")
    occupancy = json.loads((step / 'placement' / f'view-{view:02d}-occupancy.json').read_text())
    if occupancy.get('input_candidates') != len(registry['poses']):
        raise ValueError('Occupancy record does not index this page bank')
    base = read_items(Path(registry['base_source']))
    with pymupdf.open(registry['pdf']) as doc:
        scene = next(s for s in scene_images(doc, doc[registry['page']])
                     if s['xref'] == result['xref'])
    if result.get('mask_source') == 'largest_component':
        # The run narrowed the target to the body's own image component, so a
        # diagnostic that reads the whole drawing scores a different question.
        palette = part_palette([(str(p), int(c)) for p, c in registry['allocated_pieces']]
                               + [(str(p), int(c)) for p, c, _ in base])
        scene = restrict_to_body_component(scene, [], palette)
    scorer = MaterialFeatureSceneScorer(scene, plane_depth=True)
    hypothesis = registration['hypotheses'][view]
    projection = np.asarray(hypothesis['projection'], float)
    origin = np.asarray(hypothesis['origin'], float)
    ids = list(occupancy['retained_indices'])
    subset = dict(registry, poses=[registry['poses'][i] for i in ids])
    placements, quotas = shape_bank(subset, [tuple(p) for p in result['image_pieces']])
    bank = build_bank(base, placements, projection, origin, scorer, scale=1.,
                      max_host_bytes=int(record['bank_metadata']['host_bank_bytes']))
    if bank['metadata']['host_bank_bytes'] != record['bank_metadata']['host_bank_bytes']:
        raise AssertionError('Rebuilt bank does not match the recorded bank size')
    model = LayerComposite(bank['base_depth'], bank['base_labels'], bank['depths'],
                           bank['labels'], bank['target'])
    selected = next(r for r in result['results'] if r['view'] == view)
    recomputed = model.score(selected['coarse']['indices'])
    if abs(recomputed - selected['coarse']['score']) > 1e-12:
        raise AssertionError('Rebuilt coarse score does not reproduce the recorded one')
    original = [ids[p['pose_index']] for p in placements]
    keys = [p['key'] for p in placements]
    anchored = {i for i, p in enumerate(original) if p in set(registry['base_supported'])}
    witnesses = {tuple(edge) for edge in registry['support_edges']}
    adjacency = [set() for _ in placements]
    for i in range(len(placements)):
        for j in range(i):
            if tuple(sorted((original[i], original[j]))) in witnesses:
                adjacency[i].add(j)
                adjacency[j].add(i)
    return dict(step=step, registry=registry, result=result, view=view, view_record=record,
                occupancy=occupancy, base=base, scorer=scorer, projection=projection,
                origin=origin, ids=ids, placements=placements, quotas=quotas, model=model,
                original=original, keys=keys, anchored=anchored, adjacency=adjacency,
                selected=selected)


def collision_probe(registry):
    """The search's own pairwise exclusion, on bank pose indices."""
    from placement_attach_group import make_assembly
    from placement_colored_cad import colored_triangles
    from placement_part_library import PartLibrary
    poses = [(str(e['part']), np.asarray(e['T'], float)) for e in registry['poses']]
    library = PartLibrary()
    local, boxes, bodies, cache = {}, {}, {}, {}

    def box(index):
        if index not in boxes:
            part, T = poses[index]
            if part not in local:
                vertices = colored_triangles(part, 15, resolver=library.resolve)[
                    'triangles'].reshape(-1, 3)
                low, high = vertices.min(0), vertices.max(0)
                local[part] = np.array([[x, y, z] for x in (low[0], high[0])
                                        for y in (low[1], high[1]) for z in (low[2], high[2])])
            world = local[part] @ T[:3, :3].T + T[:3, 3]
            boxes[index] = (world.min(0), world.max(0))
        return boxes[index]

    def conflict(a, b):
        a, b = sorted((int(a), int(b)))
        if (a, b) not in cache:
            if a == b:
                cache[(a, b)] = True
            elif (box(a)[1] < box(b)[0]).any() or (box(b)[1] < box(a)[0]).any():
                cache[(a, b)] = False
            else:
                if a not in bodies:
                    bodies[a] = make_assembly([(poses[a][0], 15, poses[a][1])])
                cache[(a, b)] = bool(bodies[a].collides(poses[b][0], poses[b][1]))
        return cache[(a, b)]
    return conflict


def connected(group, anchored, adjacency):
    wanted = set(int(i) for i in group)
    seen = wanted & set(anchored)
    todo = list(seen)
    while todo:
        fresh = (adjacency[todo.pop()] & wanted) - seen
        seen.update(fresh)
        todo.extend(fresh)
    return seen == wanted


# ---------------------------------------------------------------------------
# Per-page measurement
# ---------------------------------------------------------------------------

def page_stage(run, page, truth, library, symmetries, tolerance=0.):
    from placement_arrow_contacts import read_items
    from placement_diagnose_alias_poses import canonicalize
    from placement_diagnose_bank_recall import bank_recall
    from placement_mirror_completion import frames_equal
    from placement_mixed_batch_search import fixed_native_score
    from placement_part_symmetry_table import symmetries as proper_symmetries
    from placement_population_table import canonical_name
    from pose_score import read_parts
    view = rebuild_view(run, page)
    registry, result, model = view['registry'], view['result'], view['model']
    keys, original, anchored, adjacency = (view['keys'], view['original'],
                                           view['anchored'], view['adjacency'])
    base_items, _ = canonicalize(read_parts(Path(registry['base_source'])), library)
    recall = bank_recall(registry, truth, base_items, symmetries=symmetries)
    retained = set(view['occupancy']['retained_indices'])
    position = {pose: index for index, pose in enumerate(original)}

    # Which reference targets any written assembly contains, read the same way
    # placement_retention_audit reads them so the two tools agree by construction.
    alignment = recall['alignment']['alignment']
    rotation = np.asarray(alignment['rotation'], float)
    translation = np.asarray(alignment['translation'], float)
    inverse, offset = rotation.T, -rotation.T @ translation
    base_len = len(view['base'])
    in_beam = set()
    for entry in result['results']:
        path = view['step'] / 'placement' / entry['file']
        if not path.is_file():
            continue
        items = [(canonical_name(part, library), int(color), np.asarray(T, float))
                 for part, color, T in read_items(path)]
        for row in recall['rows']:
            target_position = inverse @ np.asarray(row['reference_position'], float) + offset
            target_frame = inverse @ np.asarray(row['reference_frame'], float)
            symmetry = proper_symmetries(row['part'], 'vertex')
            for part, color, T in items[base_len:]:
                if part != row['part'] or color != int(row['color']):
                    continue
                if np.max(np.abs(T[:3, 3] - target_position)) > 1.:
                    continue
                if frames_equal(T[:3, :3], target_frame, symmetry):
                    in_beam.add(row['truth_index'])
                    break

    # Single-addition ranking from the empty assembly: exactly the quantity the
    # beam's first level compares, and the quantity every later level compares
    # incrementally.
    depth, label = model.composite(())
    correct, false = model.counts(label)
    dc, df = model.deltas(depth, label)
    single = np.mean((correct + dc) / np.maximum(1, model.areas + false + df), axis=1)
    base_score = model.score(())
    plateau = plateau_stats(single, base_score, tolerance)

    selected_indices = [int(i) for i in view['selected']['coarse']['indices']]
    selected_native = float(view['selected']['evidence']['score'])
    conflict = collision_probe(registry)
    rows = []
    for row in recall['rows']:
        hits = [position[i] for i in row['bank_indices'] if i in retained
                and keys[position[i]] == (row['part'], int(row['color']))]
        record = dict(part=row['part'], color=int(row['color']), truth_index=row['truth_index'],
                      in_bank=bool(row['bank_indices']), bank_hits=len(row['bank_indices']),
                      survived_screen=bool(hits), screened_placements=hits,
                      in_any_retained_assembly=row['truth_index'] in in_beam)
        record['stage'] = ('lost_before_enumeration' if not record['in_bank'] else
                           'lost_to_occupancy_screen' if not record['survived_screen'] else
                           'in_retained_assembly' if record['in_any_retained_assembly'] else
                           'lost_to_search_retention')
        if record['stage'] == 'lost_to_search_retention':
            probes = []
            for placement in hits:
                key_mask = np.array([k == keys[placement] for k in keys])
                probe = dict(placement=placement, pose=original[placement],
                             painted_pixels=int(model.lengths[placement]),
                             single_score=float(single[placement]),
                             delta_from_base=float(single[placement] - base_score),
                             on_plateau=bool(abs(single[placement] - base_score) <= tolerance),
                             rank_overall=rank_within(single, placement),
                             rank_in_key=rank_within(single, placement, key_mask),
                             key_candidates=int(key_mask.sum()),
                             score_ties=int(np.sum(single == single[placement])))
                probe.update(support_stage(placement, anchored, adjacency))
                # Hypothesis 3, measured rather than argued: is there any legal
                # quota-preserving assembly containing this target at all?
                swaps = []
                for candidate in swap_sets(selected_indices, placement, keys):
                    rest = [i for i in candidate if i != placement]
                    collides = any(conflict(original[placement], original[i]) for i in rest)
                    linked = connected(candidate, anchored, adjacency)
                    entry = dict(indices=list(candidate), collision_free=not collides,
                                 connected=linked, legal=(not collides) and linked)
                    if entry['legal']:
                        items = view['base'] + [item for i in candidate
                                                for item in view['placements'][i]['items']]
                        evidence = fixed_native_score(view['scorer'], items,
                                                      view['projection'], view['origin'])
                        entry['native_score'] = float(evidence['score'])
                        entry['native_delta'] = float(evidence['score'] - selected_native)
                        entry['coarse_score'] = float(model.score(candidate))
                        entry['coarse_delta'] = float(model.score(candidate)
                                                      - view['selected']['coarse']['score'])
                    swaps.append(entry)
                legal = [s for s in swaps if s['legal']]
                probe['swaps'] = swaps
                probe['any_legal_assembly'] = bool(legal)
                probe['best_native_delta'] = (max(s['native_delta'] for s in legal)
                                              if legal else None)
                probe['best_coarse_delta'] = (max(s['coarse_delta'] for s in legal)
                                              if legal else None)
                probes.append(probe)
            record['probes'] = probes
            record['mechanism'] = classify_mechanism(probes)
        rows.append(record)

    assemblies = [r['coarse']['indices'] for r in result['results'] if r['view'] == view['view']]
    return dict(page=page, view=view['view'], bank_poses=len(registry['poses']),
                screened_candidates=len(view['ids']), placements=len(view['placements']),
                bank_status=view['view_record'].get('status'),
                bank_truncated=len(view['placements']) != len(view['ids']),
                quota=int(sum(view['quotas'].values())),
                quotas={f'{p}:{c}': q for (p, c), q in view['quotas'].items()},
                beam=view['view_record'].get('beam'), top_k=view['view_record'].get('top_k'),
                expansions=view['view_record'].get('expansions'),
                budget_hit=view['view_record'].get('budget_hit'),
                anchored_placements=len(anchored),
                witnessed_edges=int(sum(len(a) for a in adjacency) // 2),
                plateau=plateau, selected_native=selected_native,
                selected_coarse=float(view['selected']['coarse']['score']),
                diversity=assembly_diversity(assemblies, keys), targets=rows)


def fix_trial(run, page, truth, library, symmetries, width=16, rounds=4,
              orderings=('incremental', 'own', 'union')):
    """Same-budget exchange trial: does re-ordering the window recover targets?

    The control (`incremental`) is the shipped rule - the window is the `width`
    best same-key candidates by incremental composite delta - started from the
    assembly the run selected, so a control that swaps nothing confirms the run
    really is at that rule's local optimum. The treatments change only which
    `width` candidates are rendered, never how many, so any difference is the
    ordering and not the budget.
    """
    from placement_diagnose_alias_poses import canonicalize
    from placement_diagnose_bank_recall import bank_recall
    from placement_mixed_batch_search import fixed_native_score
    from pose_score import read_parts
    view = rebuild_view(run, page)
    model, keys = view['model'], view['keys']
    count = len(keys)
    base_items, _ = canonicalize(read_parts(Path(view['registry']['base_source'])), library)
    recall = bank_recall(view['registry'], truth, base_items, symmetries=symmetries)
    retained = set(view['occupancy']['retained_indices'])
    position = {pose: index for index, pose in enumerate(view['original'])}
    reference = {}
    for row in recall['rows']:
        hits = [position[i] for i in row['bank_indices'] if i in retained
                and keys[position[i]] == (row['part'], int(row['color']))]
        if hits:
            reference[row['truth_index']] = hits
    agreement = own_agreement(model.seg, model.lab, model.tgt, count)
    conflict = collision_probe(view['registry'])
    original, anchored, adjacency = view['original'], view['anchored'], view['adjacency']

    def native(indices):
        items = view['base'] + [item for i in indices for item in view['placements'][i]['items']]
        return float(fixed_native_score(view['scorer'], items,
                                        view['projection'], view['origin'])['score'])
    start = [int(i) for i in view['selected']['coarse']['indices']]
    reports = {}
    for ordering in orderings:
        chosen = list(start)
        best, renders, trail = native(chosen), 1, []
        for _ in range(rounds):
            improvement = None
            for slot, outgoing in enumerate(chosen):
                rest = chosen[:slot] + chosen[slot + 1:]
                depth, label = model.composite(rest)
                correct, false = model.counts(label)
                dc, df = model.deltas(depth, label)
                incremental = np.mean((correct + dc) / np.maximum(1, model.areas + false + df),
                                      axis=1)
                if ordering == 'incremental':
                    window = window_indices(incremental, keys, chosen, outgoing, width)
                elif ordering == 'own':
                    window = window_indices(agreement, keys, chosen, outgoing, width)
                elif ordering == 'union':
                    window = list(dict.fromkeys(
                        window_indices(incremental, keys, chosen, outgoing, width // 2)
                        + window_indices(agreement, keys, chosen, outgoing, width // 2)))
                else:
                    raise ValueError(f'Unknown window ordering {ordering!r}')
                for incoming in window:
                    if any(conflict(original[incoming], original[other]) for other in rest):
                        continue
                    if not connected(tuple(rest) + (incoming,), anchored, adjacency):
                        continue
                    score = native(rest + [incoming])
                    renders += 1
                    if score > best + 1e-12 and (improvement is None or score > improvement[0]):
                        improvement = (score, slot, incoming)
            if improvement is None:
                break
            best, slot, incoming = improvement
            trail.append(dict(slot=slot, incoming=incoming, native_score=best))
            chosen[slot] = incoming
        found = sorted(index for index, hits in reference.items()
                       if any(h in chosen for h in hits))
        reports[ordering] = dict(indices=sorted(chosen), native_score=best,
                                 native_gain=best - native(start), renders=renders, trail=trail,
                                 reference_targets_in_assembly=found,
                                 reference_targets_found=len(found))
    return dict(page=page, view=view['view'], width=width, rounds=rounds,
                start=sorted(start), start_native=native(start),
                screened_reference_targets=sorted(reference),
                screened_reference_target_count=len(reference),
                page_reference_targets=len(recall['rows']), orderings=reports,
                truth_used_at_runtime=False, runtime_vlm_calls=0, certified=False,
                scope='Evaluation-only trial. The reference model names the targets afterwards; '
                      'every ordering is computed from the run\'s own bank and drawing and could '
                      'run at runtime unchanged.',
                limitations='One page, one view, started from the assembly the run selected rather '
                            'than re-driven from the beam, so it measures what a better exchange '
                            'window recovers from that point and not what a re-driven chain would '
                            'produce. Steepest descent keeps its greedy character: a target the '
                            'native objective ranks below some other pose is still not taken.')


def double_probe(run, page, truth, library, symmetries, width=8, max_renders=48):
    """Is a target with no legal ONE-swap reachable by a legal TWO-placement one?

    `page_stage`'s `no_legal_assembly` verdict is a statement about the minimal
    quota-preserving edit, not about the assembly space: a closure pose is legal
    only together with the placement that witnesses its support, and a pose that
    collides with the piece in its place needs that piece replaced in the same
    move. Both are two-placement edits, both stay quota-preserving, and both have
    a small guided partner set - so whether they exist is a measurement, not an
    argument.

    Reachability is not the interesting half. The run takes a move only when it
    raises the objective that actually selects, so this also native-scores every
    legal compound assembly and reports the signed difference from the assembly
    the run chose. A reachable target whose best compound assembly scores lower
    is not recovered by building the move; it is a second instance of round
    seven's headline, in a class that had not been measured for it.

    Evaluation-only: the reference model names the targets afterwards and selects
    nothing. The enumeration itself reads only the run's own artifacts and would
    run unchanged at runtime.
    """
    from placement_compound_exchange import compound_assemblies
    from placement_diagnose_alias_poses import canonicalize
    from placement_diagnose_bank_recall import bank_recall
    from placement_mixed_batch_search import fixed_native_score
    from pose_score import read_parts
    view = rebuild_view(run, page)
    model, keys = view['model'], view['keys']
    original, anchored, adjacency = view['original'], view['anchored'], view['adjacency']
    base_items, _ = canonicalize(read_parts(Path(view['registry']['base_source'])), library)
    recall = bank_recall(view['registry'], truth, base_items, symmetries=symmetries)
    retained = set(view['occupancy']['retained_indices'])
    position = {pose: index for index, pose in enumerate(original)}
    agreement = own_agreement(model.seg, model.lab, model.tgt, len(keys))
    bank_conflict = collision_probe(view['registry'])

    def conflict(a, b):
        """The search's own predicate, on bank positions rather than pose ids."""
        return bank_conflict(original[int(a)], original[int(b)])

    def linked(group):
        return connected(group, anchored, adjacency)

    selected = [int(i) for i in view['selected']['coarse']['indices']]
    selected_native = float(view['selected']['evidence']['score'])
    renders, rows = 0, []
    for row in recall['rows']:
        hits = [position[i] for i in row['bank_indices'] if i in retained
                and keys[position[i]] == (row['part'], int(row['color']))]
        if not hits:
            continue
        record = dict(part=row['part'], color=int(row['color']), truth_index=row['truth_index'],
                      screened_placements=hits,
                      # A target the run already placed needs no edit at all, and
                      # counting it as structural would inflate the class: its
                      # `swap_sets` is empty for the same reason a compound move
                      # is - it is already in the assembly.
                      already_selected=any(h in selected for h in hits),
                      single_swap_legal=False,
                      compound_assemblies=0, best_native_delta=None, best_group=None,
                      renders=0, reports=[])
        if record['already_selected']:
            rows.append(record)
            continue
        for placement in hits:
            for candidate in swap_sets(selected, placement, keys):
                rest = [i for i in candidate if i != placement]
                if not any(conflict(placement, i) for i in rest) and linked(candidate):
                    record['single_swap_legal'] = True
        if record['single_swap_legal']:
            # The one-swap already reaches it; the compound move is not the
            # question for this instance and its renders belong elsewhere.
            rows.append(record)
            continue
        for placement in hits:
            groups, report = compound_assemblies(selected, placement, keys, adjacency, conflict,
                                                 linked, agreement, width, mode='both',
                                                 quotas=view['quotas'])
            report['placement'] = int(placement)
            record['reports'].append(report)
            record['compound_assemblies'] += len(groups)
            for group in groups:
                if renders >= max_renders:
                    break
                items = view['base'] + [item for i in group
                                        for item in view['placements'][i]['items']]
                score = float(fixed_native_score(view['scorer'], items, view['projection'],
                                                 view['origin'])['score'])
                renders += 1
                record['renders'] += 1
                delta = score - selected_native
                if record['best_native_delta'] is None or delta > record['best_native_delta']:
                    record['best_native_delta'] = delta
                    record['best_group'] = [int(i) for i in group]
        rows.append(record)
    structural = [r for r in rows if not r['single_swap_legal'] and not r['already_selected']]
    return dict(page=page, view=view['view'], width=width, max_renders=max_renders,
                selected=sorted(selected), selected_native=selected_native,
                screened_reference_targets=len(rows),
                structural_targets=len(structural),
                compound_reachable=sum(1 for r in structural if r['compound_assemblies']),
                compound_improves=sum(1 for r in structural
                                      if (r['best_native_delta'] or 0) > 0),
                total_renders=renders, targets=rows,
                truth_used_at_runtime=False, runtime_vlm_calls=0, certified=False,
                limitations='One page, one view, enumerated from the assembly the run selected '
                            'rather than from a re-drive, and the partner set is capped at '
                            '`width` per generator, so an unreachable verdict is bounded by that '
                            'width. A positive native delta says the move would be taken from '
                            'this start, not that a re-driven chain reaches the same start.')


def classify_mechanism(probes):
    """Name the binding constraint for one lost target, from its own numbers."""
    if not probes:
        return 'no_screened_placement'
    if not any(p['support_reachable'] for p in probes):
        return 'support_unreachable'
    if not any(p['any_legal_assembly'] for p in probes):
        return 'no_legal_assembly'
    deltas = [p['best_native_delta'] for p in probes if p['best_native_delta'] is not None]
    if deltas and max(deltas) > 0:
        return 'search_missed_a_better_assembly'
    if any(p['on_plateau'] for p in probes):
        return 'objective_prefers_another_pose_target_on_plateau'
    return 'objective_prefers_another_pose'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--run', type=Path, required=True)
    parser.add_argument('--truth', required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--pages', type=int, nargs='*', default=None)
    parser.add_argument('--fix-trial', type=int, default=None,
                        help='Run the same-budget exchange-window trial on this page instead '
                             'of the population measurement')
    parser.add_argument('--fix-width', type=int, default=16)
    parser.add_argument('--fix-rounds', type=int, default=4)
    parser.add_argument('--double-probe', type=int, default=None,
                        help='Measure, on this page, whether the targets with no legal one-swap '
                             'are reachable by a legal quota-preserving TWO-placement exchange, '
                             "and whether such an assembly raises the run's own native score")
    parser.add_argument('--double-width', type=int, default=8)
    parser.add_argument('--double-renders', type=int, default=48)
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
    names = {str(part) for part, *_ in truth}
    if args.double_probe is not None:
        registry = json.loads((args.run / f'page-{args.double_probe:03d}' /
                               'registry-00.json').read_text())
        wanted = names | {str(entry['part']) for entry in registry['poses']}
        symmetries = {part: list(part_symmetries(part, 'vertex')) for part in wanted}
        probe = double_probe(args.run, args.double_probe, truth, library, symmetries,
                             width=args.double_width, max_renders=args.double_renders)
        probe.update(run=str(args.run), truth=args.truth)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(probe, indent=2))
        print(f"page {probe['page']} view {probe['view']} screened targets "
              f"{probe['screened_reference_targets']} structural {probe['structural_targets']} "
              f"compound-reachable {probe['compound_reachable']} "
              f"improves {probe['compound_improves']} renders {probe['total_renders']}")
        for row in probe['targets']:
            if row['single_swap_legal'] or row['already_selected']:
                continue
            print(f"  ti {row['truth_index']:>3} {row['part']:>10}:{row['color']:<4} "
                  f"assemblies {row['compound_assemblies']:>3} "
                  f"best native delta {row['best_native_delta']}")
        print(args.out)
        return
    if args.fix_trial is not None:
        registry = json.loads((args.run / f'page-{args.fix_trial:03d}' /
                               'registry-00.json').read_text())
        wanted = names | {str(entry['part']) for entry in registry['poses']}
        symmetries = {part: list(part_symmetries(part, 'vertex')) for part in wanted}
        trial = fix_trial(args.run, args.fix_trial, truth, library, symmetries,
                          width=args.fix_width, rounds=args.fix_rounds)
        trial.update(run=str(args.run), truth=args.truth)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(trial, indent=2))
        print(f"page {trial['page']} view {trial['view']} width {trial['width']} "
              f"screened reference targets {trial['screened_reference_target_count']} "
              f"of {trial['page_reference_targets']}")
        for ordering, report in trial['orderings'].items():
            print(f"  {ordering:>12}: native {report['native_score']:.9f} "
                  f"({report['native_gain']:+.6f}) renders {report['renders']:>4} "
                  f"targets {report['reference_targets_found']}"
                  f"/{trial['screened_reference_target_count']} "
                  f"{report['reference_targets_in_assembly']}")
        print(args.out)
        return
    pages, failures = [], []
    for step in journal['steps']:
        if not step.get('placement'):
            continue
        if args.pages and step['page'] not in args.pages:
            continue
        registry = json.loads((args.run / f"page-{step['page']:03d}" /
                               'registry-00.json').read_text())
        wanted = names | {str(entry['part']) for entry in registry['poses']}
        symmetries = {part: list(part_symmetries(part, 'vertex')) for part in wanted}
        try:
            pages.append(page_stage(args.run, step['page'], truth, library, symmetries))
        except Exception as exc:                                  # noqa: BLE001
            failures.append(dict(page=step['page'], error=f'{type(exc).__name__}: {exc}'))
    # Distinct reference instances, never per-page opportunities: a target the
    # allocation offers on three pages would otherwise count three times.
    instances = {}
    for row in pages:
        for target in row['targets']:
            current = instances.setdefault(target['truth_index'],
                                           dict(part=target['part'], color=target['color'],
                                                in_bank=False, survived_screen=False,
                                                in_any_retained_assembly=False,
                                                mechanisms={}, pages=[]))
            current['in_bank'] |= target['in_bank']
            current['survived_screen'] |= target['survived_screen']
            current['in_any_retained_assembly'] |= target['in_any_retained_assembly']
            current['pages'].append(row['page'])
            if target.get('mechanism'):
                current['mechanisms'][str(row['page'])] = target['mechanism']
    lost = {k: v for k, v in instances.items()
            if v['survived_screen'] and not v['in_any_retained_assembly']}
    mechanism_counts = Counter()
    for value in lost.values():
        # A target offered on several pages is one instance; its mechanism is the
        # weakest constraint any of those pages hit, because relaxing that one is
        # what a fix would have to do.
        order = ['search_missed_a_better_assembly', 'objective_prefers_another_pose',
                 'objective_prefers_another_pose_target_on_plateau', 'no_legal_assembly',
                 'support_unreachable', 'no_screened_placement']
        present = [m for m in order if m in value['mechanisms'].values()]
        mechanism_counts[present[0] if present else 'unclassified'] += 1
    totals = dict(distinct_reference_targets=len(instances),
                  in_bank=sum(1 for v in instances.values() if v['in_bank']),
                  survived_screen=sum(1 for v in instances.values() if v['survived_screen']),
                  in_any_retained_assembly=sum(1 for v in instances.values()
                                               if v['in_any_retained_assembly']),
                  screened_and_in_no_retained_assembly=len(lost),
                  mechanisms=dict(mechanism_counts))
    record = dict(run=str(args.run), truth=args.truth, totals=totals, pages=pages,
                  lost_instances={str(k): v for k, v in sorted(lost.items())},
                  failed_pages=failures,
                  truth_used_at_runtime=False, runtime_vlm_calls=0, certified=False,
                  scope='Evaluation-only post-hoc audit. The page bank, the occupancy screen and '
                        "the retained assemblies are rebuilt from the run's own artifacts and "
                        'self-checked against the recorded bank size and coarse score; the '
                        'reference model supplies the target poses and selects nothing.',
                  limitations='Rebuilt for the view the run selected only, so a target reachable '
                              'through another view is reported lost here. The one-swap probe is '
                              'the minimal quota-preserving edit of the selected assembly, so a '
                              'target that needs two simultaneous swaps to become better is '
                              'reported as objective-preferred when it is really unreachable by '
                              'this probe. Pages whose target mask is not the whole scene are '
                              'skipped rather than approximated, and appear in failed_pages. '
                              'Mechanism names are the binding constraint measured on these '
                              'artifacts, not a proof that no other constraint also binds.')
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(record, indent=2))
    print(f"{'page':>5} {'view':>4} {'bank':>6} {'kept':>6} {'quota':>5} {'plateau':>8} "
          f"{'zero%':>6} {'asm':>4} {'frozen':>6} {'lost':>4}")
    for row in pages:
        lost_here = sum(1 for t in row['targets'] if t['stage'] == 'lost_to_search_retention')
        print(f"{row['page']:>5} {row['view']:>4} {row['bank_poses']:>6} "
              f"{row['screened_candidates']:>6} {row['quota']:>5} "
              f"{row['plateau']['zero_delta']:>8} "
              f"{100 * row['plateau']['zero_delta_fraction']:>5.1f}% "
              f"{row['diversity']['assemblies']:>4} "
              f"{len(row['diversity']['frozen_keys']):>6} {lost_here:>4}")
    print(json.dumps(totals, indent=1))
    for key, value in sorted(lost.items()):
        print(f"  ti {key:>3} {value['part']:>9}:{value['color']:<4} "
              f"pages {value['pages']} {value['mechanisms']}")
    print(args.out)


if __name__ == '__main__':
    main()
