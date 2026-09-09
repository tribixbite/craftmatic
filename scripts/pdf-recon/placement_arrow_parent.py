"""Arrowhead evidence for choosing which candidate pose a page builds onto.

An instruction arrow points at the connector that receives the exploded piece.
When that receiving connector belongs to a piece the same page is adding - the
usual "one copy already drawn in place, the next copy exploded above it" layout
- the arrowheads name the *parent* pose directly, before any search runs.

That matters because the bounded connector closure expands only a bounded
number of base-attached poses as parents, so a parent outside the budget makes
its children unreachable at any pose cap. Measured on 40377 page index 17, the
parent of the stacked second `60474` is bank index 3927 of 4147 in enumeration
order, and pure silhouette novelty ranks it 1662 because the correct plate is
84% occluded by the already-drawn body in that drawing. The two red arrows on
the same page point straight at its studs.

The measurement is: transform each candidate pose's own male connector data
into the scene, project the receiving cap centres with the page camera, and
assign the detected arrowheads to those caps. Universal CAD connector metadata,
PDF pixels and a PDF-derived camera only - no reference model, set inventory or
VLM participates, and nothing here selects a placement on its own. It is a
ranking signal handed to candidate generation, and it abstains rather than
guessing when a page has no accepted arrow.
"""
import argparse
import json
from pathlib import Path
import sys
import numpy as np
from scipy.optimize import linear_sum_assignment

sys.path.insert(0, str(Path(__file__).resolve().parent))
from placement_arrow_contacts import transformed_connectors


def receiving_caps(part, gender='M'):
    """Local receiving-datum points of one part's connectors.

    A male stud's datum sits at the receiving plane; the cap centre a mating
    part actually touches is that datum displaced back along the axis by the
    stud length, which is the point an arrowhead is drawn against.
    """
    local = transformed_connectors(part, np.eye(4), gender)
    if not local:
        return np.zeros((0, 3))
    positions = np.asarray([c['pos'] for c in local], float)
    axes = np.asarray([c['axis'] for c in local], float)
    lengths = np.asarray([c['length'] for c in local], float)
    return positions - axes * lengths[:, None] if gender == 'M' else positions


def arrowhead_residuals(part, transforms, projection, origin, heads, gender='M'):
    """Assignment residual, in native pixels, of arrowheads to each pose's caps.

    Returns one record per transform. `matched` is False when the part exposes
    no connector of the requested gender or there are more arrowheads than
    distinct caps; those poses abstain instead of scoring zero, so a page whose
    arrows point at the existing body cannot be silently ranked by noise.
    """
    transforms = np.asarray(transforms, float)
    heads = np.asarray(heads, float).reshape(-1, 2)
    caps = receiving_caps(part, gender)
    if not len(transforms):
        return []
    if not len(caps) or not len(heads) or len(heads) > len(caps):
        return [dict(matched=False, residual_px=None,
                     reason='No usable arrowhead/cap pairing for this shape')
                for _ in transforms]
    M = np.asarray(projection, float)
    world = np.einsum('kij,cj->kci', transforms[:, :3, :3], caps) + transforms[:, None, :3, 3]
    pixels = np.einsum('ij,kcj->kci', M, world) + np.asarray(origin, float)
    distances = np.linalg.norm(heads[None, :, None, :] - pixels[:, None, :, :], axis=3)
    rows = []
    for index in range(len(transforms)):
        assignment = linear_sum_assignment(distances[index])
        matched = distances[index][assignment]
        rows.append(dict(matched=True, residual_px=float(np.mean(matched)),
                         worst_px=float(np.max(matched)),
                         caps=[int(c) for c in assignment[1]]))
    return rows


def score_parents(part, poses, projection, origin, arrows, gender='M'):
    """Per-pose arrow residual for every pose of `part`, abstaining elsewhere.

    `poses` are (part, 4x4) pairs as held by the registry, so a mixed-shape page
    scores only the poses whose shape can receive the arrow.
    """
    heads = [a['head'] for a in arrows if not a.get('direction_ambiguous', False)]
    indices = [i for i, (name, _) in enumerate(poses) if str(name) == str(part)]
    rows = [dict(matched=False, residual_px=None, reason='Different shape') for _ in poses]
    if not heads or not indices:
        return rows, dict(arrowheads=len(heads), scored_poses=0,
                          reason='No accepted arrowhead or no pose of this shape')
    scored = arrowhead_residuals(part, [poses[i][1] for i in indices],
                                 projection, origin, heads, gender)
    for i, row in zip(indices, scored):
        rows[i] = row
    residuals = [r['residual_px'] for r in scored if r['matched']]
    return rows, dict(arrowheads=len(heads), scored_poses=len(residuals),
                      best_residual_px=min(residuals) if residuals else None,
                      median_residual_px=float(np.median(residuals)) if residuals else None,
                      receiving_gender=gender, truth_used=False, runtime_vlm_calls=0,
                      certified=False,
                      protocol='Hungarian assignment of accepted PDF arrowheads to each candidate '
                               "pose's own projected receiving connector caps",
                      limitations='Arrowheads are proposals from the conservative arrow classifier; '
                                  'occlusion of a cap is not modelled, the camera is uncertified, '
                                  'and an arrow that points at the existing body rather than at a '
                                  'piece this page adds produces uniformly poor residuals rather '
                                  'than an error. Ranking evidence only; selects nothing.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Arrowhead-to-parent-stud residuals for one '
                                                 "page's candidate poses (diagnostic)")
    parser.add_argument('--registry', type=Path, required=True)
    parser.add_argument('--registration', type=Path, required=True)
    parser.add_argument('--camera', type=Path, default=None)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--gender', choices=('M', 'F'), default='M')
    args = parser.parse_args()
    import pymupdf
    from placement_arrow_contacts import read_items
    from placement_arrow_mask import conservative_components
    from placement_page_mask import part_palette
    from vector_scene import scene_images
    record = json.loads(args.registry.read_text())
    registration = json.loads(args.registration.read_text())
    if record.get('truth_used') is not False or registration.get('truth_used') is not False:
        raise ValueError('Runtime provenance missing')
    base = read_items(Path(record['base_source']))
    palette = part_palette([(str(p), int(c)) for p, c in record['allocated_pieces']]
                           + [(p, int(c)) for p, c, _ in base])
    with pymupdf.open(record['pdf']) as doc:
        scene = next(s for s in scene_images(doc, doc[record['page']])
                     if s['xref'] == registration['xref'])
    graph = conservative_components(scene, protected_colors=palette['rgb'])
    poses = [(str(entry['part']), np.asarray(entry['T'], float)) for entry in record['poses']]
    view = registration['hypotheses'][0]
    report = {}
    for part in record['parts']:
        rows, summary = score_parents(part, poses, view['projection'], view['origin'],
                                      graph['arrows'], args.gender)
        ranked = sorted((i for i, r in enumerate(rows) if r['matched']),
                        key=lambda i: rows[i]['residual_px'])
        report[part] = dict(summary, best=[dict(pose=int(i), residual_px=rows[i]['residual_px'])
                                           for i in ranked[:12]])
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(dict(report=report, arrows=len(graph['arrows']),
                                        registry=str(args.registry), page=record['page'],
                                        heads=[a['head'] for a in graph['arrows']]), indent=2))
    print(json.dumps({part: dict(best_residual_px=value['best_residual_px'],
                                 scored=value['scored_poses'],
                                 top=[b['pose'] for b in value['best'][:8]])
                      for part, value in report.items()}))
