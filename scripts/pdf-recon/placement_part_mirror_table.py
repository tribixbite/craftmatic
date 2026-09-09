"""Mirror-symmetry table built from the saved improper-element proofs.

The companion of `placement_part_symmetry_table` for reflections. It answers the
one question a mirror-completion channel has to ask before proposing anything:
can this mould's mirror image be built from this mould at all?

Two things differ from the proper-rotation table and both are deliberate.

* **The vertex tolerance is physical, not exact.** A proper cube rotation
  permutes a part's stored vertex coordinates exactly, so the rotation table can
  demand a zero Hausdorff distance. A reflection does not: LDraw's curved
  primitives store their polygon vertices rounded to a few decimals, and the
  rounding is not itself mirror-symmetric. 4032a, 3941 and 60474 all reflect onto
  themselves to within 0.001 LDU (0.0004 mm) and none of them to within 1e-6.
  The default tolerance is therefore 0.01 LDU, and it is a stated threshold.
* **Only the vertex level exists.** Triangle-set invariance under a reflection is
  essentially never true and would mean nothing if it were: LDraw emits a quad as
  two triangles split along one diagonal, and that diagonal is chiral. Measured
  over all 54 moulds of both fixtures, zero admit a triangle-invariant
  reflection while 47 admit a vertex-invariant one; the seven that do not are
  five printed moulds and the chiral 43722/43723 wedge-plate pair.

Printed moulds are never granted a reflection, on the same principle the
rotation table uses: a print that happens to be symmetric is not a licence to
ignore print handedness in general.

Universal CAD only; nothing here reads a set model or a pose.
"""
import hashlib
import json
import re
from functools import lru_cache
from pathlib import Path

import numpy as np

from placement_part_symmetry_table import PROOF_DIR, is_printed

# 0.01 LDU = 0.004 mm, two orders below LEGO's own clutch clearance and one
# order above the rounding in LDraw's curved primitives.
VERTEX_TOLERANCE_LDU = 0.01
# The evaluation's print detector requires a digit after the print marker, so a
# Studio-lineage name like `3010pzt` reads as unprinted there. Widening that
# regex would change every reported structural score, so this channel carries
# its own stricter test instead: a mirrored print is wrong even when the moulded
# surface is symmetric, and abstaining costs nothing.
PRINT_SUFFIX = re.compile(r'^\d+[a-z]?p[a-z0-9]*$')


def printed(part):
    return is_printed(part) or bool(PRINT_SUFFIX.match(str(part).lower()))


def load_proof(part, directory=PROOF_DIR):
    path = Path(directory) / f'{part}-mirror-symmetry.json'
    if not path.is_file():
        return None
    proof = json.loads(path.read_text())
    if proof.get('truth_used') is not False or proof.get('runtime_vlm_calls') != 0:
        raise ValueError(f'Mirror proof for {part} lacks truth-free zero-VLM provenance')
    if proof['part'] != part:
        raise ValueError(f'Mirror proof for {part} names a different part')
    for name, digest in (proof.get('geometry_files') or {}).items():
        candidate = Path(name)
        if candidate.is_file() and hashlib.sha256(candidate.read_bytes()).hexdigest() != digest:
            raise ValueError(f'Universal CAD for {part} changed since its mirror proof')
    if len(proof['reflections']) != 24:
        raise ValueError(f'Mirror proof for {part} does not enumerate the improper elements')
    if any(row['determinant'] >= 0 for row in proof['reflections']):
        raise ValueError(f'Mirror proof for {part} contains a proper element')
    return proof


@lru_cache(maxsize=None)
def reflections(part, directory=str(PROOF_DIR), tolerance=VERTEX_TOLERANCE_LDU):
    """Improper elements Q under which this mould occupies the same surface.

    A placement (p, R) mirrored by the plane reflection S is then realisable as
    the proper frame `S @ R @ Q` for any returned Q. An empty result means the
    mould is chiral in the tested group and the channel must abstain.
    """
    if printed(part):
        return ()
    proof = load_proof(part, directory)
    if proof is None:
        return ()
    return tuple(np.asarray(row['reflection'], float) for row in proof['reflections']
                 if row['max_vertex_hausdorff_ldu'] <= tolerance)


def table(parts, directory=str(PROOF_DIR), tolerance=VERTEX_TOLERANCE_LDU):
    rows = {}
    for part in sorted(set(map(str, parts))):
        rows[part] = dict(order=len(reflections(part, directory, tolerance)),
                          printed=printed(part),
                          proof=str(Path(directory) / f'{part}-mirror-symmetry.json')
                          if load_proof(part, directory) else None)
    return dict(vertex_tolerance_ldu=tolerance, parts=rows,
                unproven=[p for p, r in rows.items() if r['proof'] is None],
                chiral=[p for p, r in rows.items() if r['proof'] and not r['order']],
                protocol='All 24 improper octahedral elements recorded by '
                         'placement_verify_part_mirrors; vertex-level two-sided Hausdorff '
                         'comparison of the universal CAD; printed moulds never granted one',
                limitations='Reflections off the cube axes are not tested, and a mould with no '
                            'saved proof is treated as chiral. Both make a mirror channel abstain '
                            'rather than propose an unbuildable pose.')
