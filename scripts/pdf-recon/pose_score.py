"""Conservative full-pose diagnostic: exact ID + color + 1 LDU + rotation.

No grid rounding, reflected alignment, part substitutions, or reusable matches.
Global proper rigid transforms are inferred from matching part frames. This
does not account for part symmetries; it is deliberately stricter than visible
geometry equivalence and is NOT a calibrated perceptual score.
"""
from collections import Counter, defaultdict
import json
from pathlib import Path
import sys
import numpy as np
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import maximum_bipartite_matching


def read_parts(path):
    sys.path.insert(0, 'C:/git/clego')
    from flatten_io_model2 import resolve_flat_lines
    path = Path(path)
    if path.suffix.lower() == '.io':
        raise ValueError('Use a verified LDraw-color flatten; .io color space is ambiguous')
    text = path.read_text(encoding='utf-8-sig', errors='replace')
    return [(str(ref).lower().removesuffix('.dat'), int(c), np.array([x, y, z]),
             np.asarray(rot, dtype=float).reshape(3, 3))
            for t, c, x, y, z, rot, ref in resolve_flat_lines(text) if t == 'part']


def score(recon, truth, pos_tol=1.0, rot_tol=1e-4):
    if not recon or not truth:
        return {'matched': 0, 'coverage': 0.0, 'precision': 0.0}
    groups = defaultdict(list)
    for i, (part, color, pos, rot) in enumerate(truth):
        groups[(part, color)].append(i)
    # Vote on full rigid transforms implied by equal part frames. A rigid
    # rotation of the whole model is harmless; a reflection is never allowed.
    votes, hypotheses = Counter(), {}
    for part, color, rp, rr in recon:
        if abs(np.linalg.det(rr)) < 1e-8:
            continue
        for i in groups[(part, color)]:
            _, _, tp, tr = truth[i]
            rotation = tr @ np.linalg.inv(rr)
            if not np.allclose(rotation.T @ rotation, np.eye(3), atol=rot_tol):
                continue
            if np.linalg.det(rotation) < 0.999:
                continue
            offset = tp - rotation @ rp
            key = tuple(np.round(rotation, 4).flat) + tuple(np.round(offset / pos_tol))
            votes[key] += 1
            hypotheses.setdefault(key, (rotation, offset))
    best, best_transform = 0, None
    for key, _ in votes.most_common(128):
        rotation, offset = hypotheses[key]
        ri, ti = [], []
        for j, (part, color, pos, rot) in enumerate(recon):
            p, r = rotation @ pos + offset, rotation @ rot
            for i in groups[(part, color)]:
                if (np.max(np.abs(p - truth[i][2])) <= pos_tol + 1e-8
                        and np.allclose(r, truth[i][3], atol=rot_tol, rtol=0)):
                    ri.append(j)
                    ti.append(i)
        graph = csr_matrix((np.ones(len(ri)), (ri, ti)), shape=(len(recon), len(truth)))
        matched = int(np.sum(maximum_bipartite_matching(graph, perm_type='column') >= 0))
        if matched > best:
            best = matched
            best_transform = {'rotation': rotation.tolist(), 'translation': offset.tolist()}
    rc, tc = Counter((r[0], r[1]) for r in recon), Counter((t[0], t[1]) for t in truth)
    inventory_match = sum((rc & tc).values())
    return {'matched': best, 'truth_parts': len(truth), 'recon_parts': len(recon),
            'coverage': best / len(truth), 'precision': best / len(recon),
            'inventory_coverage': inventory_match / len(truth),
            'inventory_precision': inventory_match / len(recon),
            'pos_tolerance_ldu': pos_tol, 'rotation_tolerance': rot_tol,
            'allows_mirror': False, 'alignment': best_transform,
            'limitations': 'Strict frame equivalence; part symmetries not quotiented; top 128 alignment hypotheses'}


if __name__ == '__main__':
    recon_path, truth_path, output_path = map(Path, sys.argv[1:4])
    result = score(read_parts(recon_path), read_parts(truth_path))
    result.update(recon=str(recon_path), truth=str(truth_path))
    output_path.write_text(json.dumps(result, indent=2))
    print(output_path)
