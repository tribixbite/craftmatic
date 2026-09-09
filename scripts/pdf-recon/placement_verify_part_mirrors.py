"""Which reflections is a mould's universal CAD invariant under?

A mirror-completion channel proposes the reflection of an already-placed piece
about the model's own symmetry plane. That reflection is only a *legal LEGO
placement of the same mould* when the mould itself has a mirror symmetry: a
plain brick has one, a left-hand wedge does not, and for the wedge the mirror
image is a different part number entirely.

The proper-rotation proofs `placement_verify_part_symmetries` records cannot
answer this, because a reflection is not a rotation. This records the other
half of the octahedral group. For each of the 24 improper elements Q (each is
-R for a proper cube rotation R, since negation flips the determinant of a 3x3
matrix), it measures whether the part's vertex set and its full coloured
triangle set map onto themselves.

The consequence used downstream: if the part admits an improper Q, the mirror of
a placement (p, R) about a plane with reflection S is realised by the **proper**
frame S R Q, because det(S R Q) = (-1)(+1)(-1) = +1. Without such a Q the mirror
image cannot be built from the same mould and the channel must abstain.

Universal CAD only. No set model, inventory or pose is read.
"""
import argparse
import json
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

from placement_beam import rotations
from placement_colored_cad import colored_triangles
from placement_part_library import PartLibrary


def improper_elements():
    """The 24 improper elements of the octahedral group, as -R for proper R."""
    return [-T[:3, :3] for T in rotations()]


def verify(part):
    parsed = colored_triangles(part, 15, resolver=PartLibrary().resolve)
    triangles, colors = parsed['triangles'], parsed['colors']
    points = np.unique(triangles.reshape(-1, 3), axis=0)
    tree = cKDTree(points)

    def keys(ts):
        return sorted((int(color), tuple(sorted(tuple(np.round(v, 6)) for v in tri)))
                      for color, tri in zip(colors, ts))

    baseline = keys(triangles)
    rows = []
    for Q in improper_elements():
        mapped = points @ Q.T
        distance = max(float(tree.query(mapped)[0].max()),
                       float(cKDTree(mapped).query(points)[0].max()))
        rows.append(dict(reflection=Q.tolist(),
                         determinant=float(np.linalg.det(Q)),
                         max_vertex_hausdorff_ldu=distance,
                         full_colored_triangle_invariant=keys(triangles @ Q.T) == baseline))
    if not all(row['determinant'] < 0 for row in rows):
        raise ValueError('An improper element with non-negative determinant was enumerated')
    return dict(part=part, truth_used=False, runtime_vlm_calls=0,
                method='All 24 improper octahedral elements, sorted-vertex six-decimal LDU '
                       'comparison of the full coloured triangle set and a two-sided vertex '
                       'Hausdorff distance',
                geometry_files=parsed['files'], reflections=rows,
                limitations='Only octahedral reflections are tested. A mould whose mirror symmetry '
                            'lies off the cube axes is reported as having none, which makes the '
                            'channel abstain rather than propose a wrong pose.')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('parts', nargs='+')
    parser.add_argument('--directory', type=Path, default=Path('output/pdf-placement-diagnosis'))
    args = parser.parse_args()
    args.directory.mkdir(parents=True, exist_ok=True)
    for part in args.parts:
        result = verify(part)
        out = args.directory / f'{part}-mirror-symmetry.json'
        out.write_text(json.dumps(result, indent=2))
        vertex = sum(1 for row in result['reflections'] if row['max_vertex_hausdorff_ldu'] <= 1e-6)
        triangle = sum(1 for row in result['reflections'] if row['full_colored_triangle_invariant'])
        print(f'{part:<12} vertex-invariant reflections {vertex:>3}  '
              f'triangle-invariant {triangle:>3}  {out}')


if __name__ == '__main__':
    main()
