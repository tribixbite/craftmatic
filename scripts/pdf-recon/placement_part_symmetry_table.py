"""Symmetry table built from saved universal-CAD proofs, not from a hand list.

`placement_verify_part_symmetries.py` records, for every proper cube rotation,
whether a part's universal CAD is invariant as a vertex set and as a full
colored triangle set. This module turns those saved proofs into the local
symmetry group used by structural evaluation, so the evaluator can never grant
an equivalence that has not been measured, nor miss one that has.

Two levels are distinguished and never mixed:

* `vertex` - the rotated part occupies exactly the same surface. Stud logo
  orientation and triangle tessellation are not evaluated, so this is the
  structural, physical-equivalence level. It is what a builder would call the
  same placement.
* `triangle` - additionally the colored triangle set is identical. Any printed
  decoration therefore has to map onto itself.

Printed parts are additionally never granted a non-identity symmetry, even if a
proof allowed one: a print that happens to be symmetric is not a licence to
ignore print orientation in general.

The proofs are re-validated against the current geometry files on load; a
changed part definition invalidates the table rather than silently altering
reported accuracy. Evaluation only - nothing here participates in placement.
"""
import hashlib
import json
import re
from functools import lru_cache
from pathlib import Path
import numpy as np

PROOF_DIR = Path('output/pdf-placement-diagnosis')
# LDraw prints are <number><optional mould letter><p|pb|pr|py|pat><code>, so the
# marker follows a digit possibly separated by one mould-revision letter.
PRINTED = re.compile(r'\d[a-z]?p[a-z]*\d')


def is_printed(part):
    """True for LDraw printed/patterned mould names such as 3010pb291."""
    return bool(PRINTED.search(str(part).lower()))


def load_proof(part, directory=PROOF_DIR):
    path = Path(directory) / f'{part}-full-symmetry.json'
    if not path.is_file():
        return None
    proof = json.loads(path.read_text())
    if proof.get('truth_used') is not False:
        raise ValueError(f'Symmetry proof for {part} lacks truth-free provenance')
    if proof['part'] != part:
        raise ValueError(f'Symmetry proof for {part} names a different part')
    for name, digest in (proof.get('geometry_files') or {}).items():
        candidate = Path(name)
        if candidate.is_file() and hashlib.sha256(candidate.read_bytes()).hexdigest() != digest:
            raise ValueError(f'Universal CAD for {part} changed since its symmetry proof')
    if not any(row['identity'] and row['full_colored_triangle_invariant']
               for row in proof['rotations']):
        raise ValueError(f'Symmetry proof for {part} fails its own identity control')
    return proof


@lru_cache(maxsize=None)
def symmetries(part, level='vertex', directory=str(PROOF_DIR), tolerance=1e-6):
    """Proper rotations under which this part is equivalent at `level`."""
    if level not in ('vertex', 'triangle'):
        raise ValueError('Unknown symmetry level')
    identity = (np.eye(3),)
    if is_printed(part):
        return identity
    proof = load_proof(part, directory)
    if proof is None:
        return identity
    allowed = []
    for row in proof['rotations']:
        if level == 'triangle':
            ok = bool(row['full_colored_triangle_invariant'])
        else:
            ok = row['max_vertex_hausdorff_ldu'] <= tolerance
        if ok:
            allowed.append(np.asarray(row['rotation'], float))
    if not allowed:
        raise ValueError(f'Symmetry proof for {part} allows no rotation at all')
    return tuple(allowed)


def table(parts, level='vertex', directory=str(PROOF_DIR)):
    """Summary of what was proven, for the record alongside any score."""
    rows = {}
    for part in sorted(set(map(str, parts))):
        group = symmetries(part, level, directory)
        rows[part] = dict(order=len(group), printed=is_printed(part),
                          proof=str(Path(directory) / f'{part}-full-symmetry.json')
                          if load_proof(part, directory) else None)
    return dict(level=level, parts=rows,
                unproven=[p for p, r in rows.items() if r['proof'] is None],
                protocol='Proper cube rotations recorded by placement_verify_part_symmetries; '
                         'vertex level compares universal CAD vertex sets, triangle level '
                         'compares full colored triangle sets; printed moulds keep identity only',
                limitations='Embossed stud logo orientation and triangle tessellation are outside '
                            'the vertex level. A part with no saved proof is treated as having no '
                            'symmetry, which understates equivalence rather than overstating it.')
