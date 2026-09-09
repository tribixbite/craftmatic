"""Evidence-guided closure-parent selection for the page pose bank.

The bounded connector closure expands only `max_closure_parents` of the
base-attached poses, so the order those parents are visited in decides which
second-layer poses exist in the bank at all. Bank order is the enumeration
order of the connector search, which carries no information about the page.

Measured consequence on 40377 page index 17: the parent whose child is the
stacked second `60474` is bank index 3927 of 4147 base-attached poses. With
1,024 parents expanded in bank order the child is unreachable at any pose cap,
which is exactly what the recall diagnostic reported (1 of 2 reference poses
present at 6,844 poses and again at 24,000).

This module ranks the base-attached poses by PDF silhouette evidence at the
page's own refined registration, and returns a permutation for
`ShapeRegistry.close(parent_order=...)`. Two measured quantities per pose:

* `outside_pixels` - rendered pixels falling outside the dilated target
  foreground. A correctly placed opaque part cannot paint pixels the artwork
  does not draw, so overflow beyond the registration's own measured body
  overflow is evidence against the pose.
* `novel_pixels` - rendered pixels inside the target foreground that the
  already-placed body does not itself paint. A part that explains only ink the
  body already explains is invisible in this drawing and is a poor parent for
  the part the page actually adds.

Ordering is not filtering: every base-attached pose remains in the bank and in
the permutation, so a larger budget still reaches the same parents. Changing the
order can add correct children; it cannot make an illegal child legal. The
evidence is PDF pixels plus universal CAD at a PDF-derived registration - no
reference model, set inventory or VLM participates.
"""
import argparse
import hashlib
import json
from pathlib import Path
import cv2
import numpy as np


def _footprint(items, projection, origin, scorer, raster):
    """Rendered pixel coordinates of `items` in the scene's native raster frame."""
    M = np.asarray(projection, float)
    origin = np.asarray(origin, float)
    triangles = []
    for part, color, T in items:
        T = np.asarray(T, float)
        projected = scorer._project_part(part, color, T, M)
        xy = projected['xy'] + M @ T[:3, 3] + origin
        z = projected['vertex_depth'] + projected['camera'] @ T[:3, 3]
        triangles.append(np.concatenate((xy, z[:, :, None]), 2))
    tri = np.concatenate(triangles)
    low = np.floor(tri[:, :, :2].min((0, 1))).astype(int) - 1
    high = np.ceil(tri[:, :, :2].max((0, 1))).astype(int) + 1
    size = high - low
    tri[:, :, :2] -= low
    layer = raster.render_depth(tri[None], np.zeros((1, len(tri), 3), np.uint8),
                               int(size[0]), int(size[1]))
    ys, xs = np.nonzero(layer['mask'][0])
    return xs + low[0], ys + low[1]


def view_evidence(base, poses, colors, projection, origin, scorer, dilation_px=3, raster=None):
    """Per-pose silhouette evidence at one declared registration.

    `poses` are (part, 4x4) pairs and `colors` maps a part to the colour used to
    resolve its CAD; colour changes materials, never the silhouette, and is
    taken from the page allocation so the render matches the search's.
    """
    if dilation_px < 0:
        raise ValueError('Negative dilation')
    if raster is None:
        from placement_cuda_layers import LayerRasterizer
        raster = LayerRasterizer()
    kernel = np.ones((2 * dilation_px + 1, 2 * dilation_px + 1), np.uint8)
    allowed = cv2.dilate(scorer.mask.astype(np.uint8), kernel) > 0
    height, width = allowed.shape
    body_x, body_y = _footprint(base, projection, origin, scorer, raster)
    body = np.zeros((height, width), bool)
    inside = (body_x >= 0) & (body_y >= 0) & (body_x < width) & (body_y < height)
    body[body_y[inside], body_x[inside]] = True
    body_outside = int((~allowed[body_y[inside], body_x[inside]]).sum() + (~inside).sum())
    rows = []
    for part, T in poses:
        gx, gy = _footprint([(part, colors.get(part, 15), T)], projection, origin, scorer, raster)
        within = (gx >= 0) & (gy >= 0) & (gx < width) & (gy < height)
        drawn = np.zeros(len(gx), bool)
        drawn[within] = allowed[gy[within], gx[within]]
        covered = np.zeros(len(gx), bool)
        covered[within] = body[gy[within], gx[within]]
        rows.append(dict(occupied_pixels=int(len(gx)),
                         outside_pixels=int((~drawn).sum()),
                         novel_pixels=int((drawn & ~covered).sum())))
    return dict(rows=rows, body=dict(occupied_pixels=int(len(body_x)),
                                     outside_pixels=body_outside),
                dilation_px=dilation_px, projection=np.asarray(projection, float).tolist(),
                origin=np.asarray(origin, float).tolist())


def combine(views, allowance=0):
    """Fuse per-view evidence: best overflow and best novelty across the views.

    A pose is `feasible` when some considered view keeps its overflow within the
    allowance that view's own body overflow already licenses. Feasible poses are
    ordered before infeasible ones, and within each group by novel coverage.
    Used for reporting; the parent order itself merges per-view *ranks*, because
    pixel residuals from two different camera hypotheses are not comparable.
    """
    if not views:
        raise ValueError('No view evidence supplied')
    count = len(views[0]['rows'])
    if any(len(view['rows']) != count for view in views):
        raise ValueError('Views disagree on the number of poses')
    merged = []
    for index in range(count):
        per_view = [view['rows'][index] for view in views]
        limits = [max(int(allowance), int(view['body']['outside_pixels'])) for view in views]
        feasible = any(row['outside_pixels'] <= limit for row, limit in zip(per_view, limits))
        merged.append(dict(index=index, feasible=bool(feasible),
                           outside_pixels=min(row['outside_pixels'] for row in per_view),
                           novel_pixels=max(row['novel_pixels'] for row in per_view),
                           occupied_pixels=max(row['occupied_pixels'] for row in per_view)))
    return merged


def merge_ranks(orders, count):
    """Merge several per-view parent orders by each pose's best position.

    A pose any considered registration nominates early is expanded early. Ranks
    are comparable across views in a way raw pixel residuals are not, and ties
    keep bank order so the result stays deterministic.
    """
    best = [len(orders[0]) if orders else 0] * count
    for order in orders:
        for position, index in enumerate(order):
            best[index] = min(best[index], position)
    return sorted(range(count), key=lambda index: (best[index], index))


def parent_order(merged, shapes=None):
    """Permutation of pose indices: feasible first, best arrow fit, most novel ink.

    Each shape is ordered independently and the shapes are then interleaved
    round robin, because bank order groups every pose of one shape before the
    next: a global sort or a raw prefix lets one shape consume the whole parent
    budget and leaves another page shape with no second-layer poses at all.
    Ties fall back to bank order, so the result is deterministic and reduces to
    the previous behaviour when no evidence discriminates.
    """
    def key(row):
        return (not row['feasible'],
                row['arrow_residual_px'] if row.get('arrow_residual_px') is not None else np.inf,
                -row['novel_pixels'], row['outside_pixels'], row['index'])

    if not shapes:
        return [row['index'] for row in sorted(merged, key=key)]
    groups = {}
    for row in merged:
        groups.setdefault(shapes[row['index']], []).append(row)
    ranked = [sorted(rows, key=key) for _, rows in sorted(groups.items())]
    order = []
    for position in range(max(len(rows) for rows in ranked)):
        for rows in ranked:
            if position < len(rows):
                order.append(rows[position]['index'])
    return order


def rank_parents(base, bank, pieces, hypotheses, scorer, dilation_px=3, allowance=0,
                 views=2, raster=None, arrows=()):
    """Evidence-ranked parent permutation for a freshly built `ShapeRegistry`.

    Only the base-attached prefix is ranked, because those are the only poses
    the first closure round can expand. When the page has accepted arrowheads,
    `placement_arrow_parent` supplies the dominant key: an arrow points at the
    connector receiving the next piece, so a pose whose own studs sit under the
    arrowheads is the parent the drawing is describing. Silhouette novelty is
    the fallback and the tie-break, and it is weak exactly where the parent is
    occluded by the body already drawn around it.
    """
    from placement_arrow_parent import score_parents
    colors = {}
    for part, color in pieces:
        colors.setdefault(str(part), int(color))
    poses = bank.poses[:bank.base_attached_count]
    shapes = [str(part) for part, _ in poses]
    per_view, arrow_views, orders = [], [], []
    for hypothesis in hypotheses[:max(1, views)]:
        evidence = view_evidence(base, poses, colors, hypothesis['projection'],
                                 hypothesis['origin'], scorer, dilation_px, raster)
        per_view.append(evidence)
        residuals = [None] * len(poses)
        summaries = {}
        if arrows:
            for part in sorted(set(shapes)):
                rows, summary = score_parents(part, poses, hypothesis['projection'],
                                              hypothesis['origin'], arrows)
                summaries[part] = summary
                for index, row in enumerate(rows):
                    if row['matched']:
                        residuals[index] = row['residual_px']
        arrow_views.append(dict(residuals=residuals, shapes=summaries))
        limit = max(int(allowance), int(evidence['body']['outside_pixels']))
        rows = [dict(row, index=index, feasible=row['outside_pixels'] <= limit,
                     arrow_residual_px=residuals[index])
                for index, row in enumerate(evidence['rows'])]
        orders.append(parent_order(rows, shapes))
    merged = combine(per_view, allowance)
    for row in merged:
        seen = [view['residuals'][row['index']] for view in arrow_views
                if view['residuals'][row['index']] is not None]
        row['arrow_residual_px'] = min(seen) if seen else None
    order = merge_ranks(orders, len(poses))
    matched = sum(1 for row in merged if row['arrow_residual_px'] is not None)
    return order, dict(views=[{k: v for k, v in view.items() if k != 'rows'}
                              for view in per_view],
                       arrow_summaries=[view['shapes'] for view in arrow_views],
                       arrowheads=len(arrows), arrow_scored_poses=matched,
                       ranked_poses=len(order), feasible=sum(1 for r in merged if r['feasible']),
                       novel_pixels_top=[merged[i]['novel_pixels'] for i in order[:16]],
                       arrow_residual_top=[merged[i]['arrow_residual_px'] for i in order[:16]],
                       merged=merged, allowance=int(allowance),
                       truth_used=False, runtime_vlm_calls=0, certified=False,
                       protocol='Per-shape ordering by accepted-arrowhead assignment residual to '
                                "each pose's own receiving connector caps, then native-raster "
                                'silhouette overflow and body-novel ink at the page registration; '
                                'shapes interleaved round robin',
                       limitations='Ordering only, never filtering: the bank keeps every '
                                   'base-attached pose. Overflow, novelty and arrow residuals are '
                                   'necessary-style cues at an uncertified registration, not proof '
                                   'that a highly ranked parent is correctly placed. A page whose '
                                   'arrows point at the existing body rather than at a piece it '
                                   'adds gets uniformly poor residuals and falls back to novelty. '
                                   'Only the first closure round is guided; deeper rounds keep '
                                   'discovery order.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Rank a page bank\'s closure parents by PDF '
                                                 'silhouette evidence (diagnostic entry point)')
    parser.add_argument('--registry', type=Path, required=True,
                        help='Registry JSON whose base-attached prefix is ranked')
    parser.add_argument('--registration', type=Path, required=True,
                        help='Containment-refined registration JSON for the same page')
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--views', type=int, default=2)
    parser.add_argument('--dilation-px', type=int, default=3)
    parser.add_argument('--camera', type=Path, default=None,
                        help="The page's camera.json, so the target mask matches the run's "
                             '(a largest-component mask excludes exploded pieces)')
    args = parser.parse_args()
    import pymupdf
    from placement_arrow_contacts import read_items
    from placement_material_scene_score import MaterialFeatureSceneScorer
    from placement_arrow_mask import conservative_components
    from placement_multi_shape_batch import ShapeRegistry
    from placement_page_mask import part_palette, restrict_to_body_component
    from vector_scene import scene_images
    record = json.loads(args.registry.read_text())
    registration = json.loads(args.registration.read_text())
    for value in (record, registration):
        if value.get('truth_used') is not False or value.get('runtime_vlm_calls') != 0:
            raise ValueError('Runtime provenance missing')
    if registration['base_sha256'] != record['base_sha256']:
        raise ValueError('Registration/body mismatch')
    base_path = Path(record['base_source'])
    if hashlib.sha256(base_path.read_bytes()).hexdigest() != record['base_sha256']:
        raise ValueError('Existing body changed on disk')
    base = read_items(base_path)
    with pymupdf.open(record['pdf']) as doc:
        scene = next(s for s in scene_images(doc, doc[record['page']])
                     if s['xref'] == registration['xref'])
    mask_source = 'whole_drawing'
    if args.camera is not None:
        camera = json.loads(args.camera.read_text())
        entry = next(s for s in camera['native_scenes'] if s['xref'] == registration['xref'])
        mask_source = entry.get('mask_source') or mask_source
    pairs = ([(str(p), int(c)) for p, c in record['allocated_pieces']]
             + [(part, int(color)) for part, color, _ in base])
    palette = part_palette(pairs)
    arrows = conservative_components(scene, protected_colors=palette['rgb'])['arrows']
    if mask_source == 'largest_component':
        scene = restrict_to_body_component(scene, pairs, palette)
    scorer = MaterialFeatureSceneScorer(scene, plane_depth=True)
    bank = ShapeRegistry(base, [(p, c) for p, c in record['allocated_pieces']])
    if bank.base_attached_count != record['base_attached_count']:
        raise ValueError('Rebuilt base-attached bank differs from the saved registry')
    order, report = rank_parents(base, bank, record['allocated_pieces'],
                                 registration['hypotheses'], scorer,
                                 dilation_px=args.dilation_px, views=args.views, arrows=arrows)
    report.update(registry=str(args.registry), registration=str(args.registration),
                  order=order, page=record['page'], pdf=record['pdf'],
                  pdf_sha256=record['pdf_sha256'])
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2))
    print(json.dumps(dict(ranked_poses=report['ranked_poses'], feasible=report['feasible'],
                          first_16=order[:16], novel_top=report['novel_pixels_top'])))
