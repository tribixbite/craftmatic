"""Mirror completion: propose the reflection of a piece we already trust.

The population table says the largest class of failure on both fixtures is a
reference pose that was never *enumerated* - 26 of 63 in-scope failures - not one
that was enumerated and mis-ranked. A channel that only re-ranks the bank cannot
touch those. This one proposes poses the bank does not contain, from evidence
that does not require the piece to be visible in any drawing.

The evidence is the model's own bilateral symmetry. Most LEGO models, and a
BrickHeadz in particular, are near-mirror-symmetric about a vertical plane, so a
piece whose partner is confidently placed has a fully determined pose: reflect
the partner. Nothing about the drawing is consulted, which is exactly the point -
an occluded piece's mirror twin may be in plain view, and even when neither is
visible the geometric constraint stands.

Three things keep it honest, and each is measured rather than asserted:

* **The plane is detected from the placed body, never assumed.** Candidate
  offsets are the exact midpoints implied by pairs of same-mould same-colour
  placements, so the search is over a finite evidence-derived set. The channel
  abstains when no plane explains enough of the body.
* **The mould must admit the reflection.** `placement_part_mirror_table` records
  which improper octahedral elements a mould's universal CAD is invariant under.
  Without one, the mirror image is not buildable from that mould and the channel
  abstains rather than emitting a reflected part. Printed moulds never qualify.
* **The proposal is gated physically, not visually.** It must not collide with
  the body and it must engage at least one connector, using the same predicates
  `recon_v8.assembly` and `placement_seated_contact` use everywhere else.

Runtime-legal: the body, the allocation quota and universal CAD are the only
inputs. The `--truth` mode is a separate, post-hoc scoring of what was proposed.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

POSITION_TOLERANCE_LDU = 1.0
ROTATION_TOLERANCE = 1e-4


def reflection_matrix(axis):
    S = np.eye(3)
    S[axis, axis] = -1.0
    return S


def mirror_transform(T, axis, offset, Q):
    """The placement (T) reflected about `x_axis = offset`, realised properly.

    `Q` is an improper element the mould is invariant under, so the resulting
    frame `S R Q` has determinant (-1)(+1)(-1) = +1 and names a buildable pose.
    """
    T = np.asarray(T, float)
    S = reflection_matrix(axis)
    out = np.eye(4)
    out[:3, :3] = S @ T[:3, :3] @ Q
    position = T[:3, 3].copy()
    position[axis] = 2.0 * offset - position[axis]
    out[:3, 3] = position
    return out


def frames_equal(a, b, symmetries, tolerance=ROTATION_TOLERANCE):
    return any(np.allclose(a, b @ G, atol=tolerance, rtol=0) for G in symmetries)


def detect_plane(items, minimum_fraction=0.5, position_tolerance=POSITION_TOLERANCE_LDU,
                 minimum_eligible=8):
    """The best axis-aligned mirror plane the placed body itself implies.

    Only axis-aligned planes are searched. That is not a convenience: every pose
    in the reconstruction carries a cube-rotation frame, so a model whose true
    mirror plane is axis-aligned keeps an axis-aligned plane under whatever cube
    rotation the reconstruction frame differs by.

    Eligibility is reported separately from agreement. A mould with no admitted
    reflection cannot be mirrored at all, so counting it as disagreement would
    let a handful of chiral or printed parts veto a real plane.
    """
    from placement_part_mirror_table import reflections
    from placement_part_symmetry_table import symmetries as proper_symmetries
    items = [(str(part), int(color), np.asarray(T, float)) for part, color, T in items]
    eligible = [index for index, (part, _, _) in enumerate(items) if reflections(part)]
    # A handful of parts can agree with almost any plane by accident: 41624's
    # three-part opening body reaches agreement 1.000 on a plane that means
    # nothing. Below this many eligible parts the measurement has no power and
    # the channel abstains instead of reporting a perfect score.
    if len(eligible) < minimum_eligible:
        return dict(accepted=False, best=None, eligible=len(eligible), parts=len(items),
                    minimum_eligible=minimum_eligible,
                    reason='too few mirror-eligible parts for the plane test to have power')
    best = None
    for axis in range(3):
        coordinates = [T[axis, 3] for _, _, T in items]
        offsets = set()
        for i in eligible:
            for j in eligible:
                if items[i][:2] != items[j][:2]:
                    continue
                offsets.add(round((coordinates[i] + coordinates[j]) / 2.0, 3))
        for offset in sorted(offsets):
            matched, self_mapped = [], 0
            for index in eligible:
                part, color, T = items[index]
                mirrored = [mirror_transform(T, axis, offset, Q) for Q in reflections(part)]
                symmetry = proper_symmetries(part, 'vertex')
                hit = None
                for other, (opart, ocolor, oT) in enumerate(items):
                    if (opart, ocolor) != (part, color):
                        continue
                    for candidate in mirrored:
                        if np.max(np.abs(candidate[:3, 3] - oT[:3, 3])) > position_tolerance:
                            continue
                        if frames_equal(candidate[:3, :3], oT[:3, :3], symmetry):
                            hit = other
                            break
                    if hit is not None:
                        break
                if hit is not None:
                    matched.append(index)
                    self_mapped += 1 if hit == index else 0
            fraction = len(matched) / len(eligible)
            record = dict(axis=axis, offset=float(offset), matched=len(matched),
                          eligible=len(eligible), parts=len(items), fraction=fraction,
                          self_mapped=self_mapped)
            if best is None or (fraction, -abs(offset)) > (best['fraction'], -abs(best['offset'])):
                best = record
    if best is None or best['fraction'] < minimum_fraction:
        return dict(accepted=False, best=best, minimum_fraction=minimum_fraction)
    best.update(accepted=True, minimum_fraction=minimum_fraction,
                normal=[1.0 if k == best['axis'] else 0.0 for k in range(3)])
    return best


def occupied(items, transform, part, color, symmetries, position_tolerance):
    for opart, ocolor, oT in items:
        if (str(opart), int(ocolor)) != (str(part), int(color)):
            continue
        oT = np.asarray(oT, float)
        if np.max(np.abs(oT[:3, 3] - transform[:3, 3])) > position_tolerance:
            continue
        if frames_equal(transform[:3, :3], oT[:3, :3], symmetries):
            return True
    return False


def propose(body, outstanding, plane, position_tolerance=POSITION_TOLERANCE_LDU):
    """Mirrored poses for outstanding pieces, gated by collision and seating.

    `outstanding` is the remaining allocation quota as a list of (part, colour).
    Every proposal names the placed piece it is the reflection of, so a wrong
    proposal is traceable to the placement that generated it.
    """
    from placement_part_mirror_table import reflections
    from placement_part_symmetry_table import symmetries as proper_symmetries
    from placement_seated_contact import engaged_mates
    from recon_v8.assembly import Assembly
    body = [(str(part), int(color), np.asarray(T, float)) for part, color, T in body]
    quota = {}
    for part, color in outstanding:
        quota[(str(part), int(color))] = quota.get((str(part), int(color)), 0) + 1
    assembly = Assembly()
    for part, color, T in body:
        assembly.add(part, color, T)
    axis, offset = plane['axis'], plane['offset']
    rows = []
    for index, (part, color, T) in enumerate(body):
        key = (part, color)
        if key not in quota:
            continue
        variants = reflections(part)
        if not variants:
            continue
        symmetry = proper_symmetries(part, 'vertex')
        seen = []
        for Q in variants:
            candidate = mirror_transform(T, axis, offset, Q)
            if occupied(body, candidate, part, color, symmetry, position_tolerance):
                continue
            if any(np.max(np.abs(candidate[:3, 3] - other[:3, 3])) <= position_tolerance
                   and frames_equal(candidate[:3, :3], other[:3, :3], symmetry)
                   for other in seen):
                continue
            seen.append(candidate)
            collides = bool(assembly.collides(part, candidate))
            seating = engaged_mates(body, [(part, color, candidate)])
            rows.append(dict(part=part, color=color, source_index=index,
                             source_position=[float(v) for v in T[:3, 3]],
                             transform=candidate.tolist(),
                             position=[float(v) for v in candidate[:3, 3]],
                             collides=collides, engaged=int(seating['engaged']),
                             added_connectors=int(seating['added_connectors']),
                             admitted=bool(not collides and seating['engaged'] > 0)))
    admitted = [row for row in rows if row['admitted']]
    # One admitted proposal for a piece is a determination; several are a choice
    # this channel has no evidence to make, and it says so rather than guessing.
    by_piece = {}
    for row in admitted:
        by_piece.setdefault((row['part'], row['color']), []).append(row)
    decisions = []
    for (part, color), group in sorted(by_piece.items()):
        unique = []
        for row in group:
            if not any(np.max(np.abs(np.asarray(row['position']) -
                                     np.asarray(other['position']))) <= position_tolerance
                       for other in unique):
                unique.append(row)
        decisions.append(dict(part=part, color=color, quota=quota[(part, color)],
                              distinct_admitted=len(unique),
                              determined=len(unique) <= quota[(part, color)],
                              proposals=unique))
    return dict(plane=plane, quota={f'{p}:{c}': q for (p, c), q in quota.items()},
                proposals=rows, admitted=len(admitted), decisions=decisions)


def score_against_reference(decisions, truth, alignment, position_tolerance=POSITION_TOLERANCE_LDU):
    """Post-hoc: does a proposed pose coincide with a reference placement?

    Evaluation only. Runs after the proposals exist and changes none of them.
    """
    from placement_part_symmetry_table import symmetries as proper_symmetries
    rotation = np.asarray(alignment['rotation'], float)
    translation = np.asarray(alignment['translation'], float)
    rows = []
    for decision in decisions:
        for proposal in decision['proposals']:
            T = np.asarray(proposal['transform'], float)
            position = rotation @ T[:3, 3] + translation
            frame = rotation @ T[:3, :3]
            symmetry = proper_symmetries(proposal['part'], 'vertex')
            hit = None
            for index, (part, color, tp, tR) in enumerate(truth):
                if str(part) != proposal['part'] or int(color) != proposal['color']:
                    continue
                if np.max(np.abs(position - tp)) > position_tolerance:
                    continue
                if frames_equal(frame, tR, symmetry):
                    hit = index
                    break
            rows.append(dict(part=proposal['part'], color=proposal['color'],
                             determined=decision['determined'],
                             distinct_admitted=decision['distinct_admitted'],
                             engaged=proposal['engaged'], correct=hit is not None,
                             truth_index=hit))
    determined = [row for row in rows if row['determined']]
    return dict(rows=rows, proposals=len(rows), correct=sum(1 for r in rows if r['correct']),
                determined_proposals=len(determined),
                determined_correct=sum(1 for r in determined if r['correct']),
                scope='Evaluation-only. The reference model is read after the proposals exist and '
                      'selects nothing.')


def main():
    from placement_arrow_contacts import read_items
    parser = argparse.ArgumentParser()
    parser.add_argument('--body', type=Path, required=True, help='Placed model to mirror from')
    parser.add_argument('--outstanding', nargs='*', default=[],
                        help='Remaining allocation as part:colour tokens')
    parser.add_argument('--outstanding-from-run', type=Path,
                        help="Read the driver journal's carried unplaced pieces instead")
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--truth', help='Independent model, for post-hoc scoring only')
    parser.add_argument('--minimum-fraction', type=float, default=0.5)
    args = parser.parse_args()
    body = read_items(args.body)
    outstanding = [tuple(token.split(':')) for token in args.outstanding]
    if args.outstanding_from_run:
        journal = json.loads((args.outstanding_from_run / 'autodrive.json').read_text())
        if journal.get('truth_used') is not False or journal.get('runtime_vlm_calls') != 0:
            raise ValueError('Run journal lacks truth-free zero-VLM attestation')
        carried = [step for step in journal['steps'] if step.get('unplaced_pieces_carried')]
        if carried:
            outstanding += [tuple(piece) for piece in carried[-1]['unplaced_pieces_carried']]
    from placement_part_library import PartLibrary
    from placement_population_table import canonical_name
    library = PartLibrary()
    outstanding = [(canonical_name(part, library), int(color)) for part, color in outstanding]
    body = [(canonical_name(part, library), color, T) for part, color, T in body]
    plane = detect_plane(body, args.minimum_fraction)
    record = dict(body=str(args.body), plane=plane, outstanding=outstanding,
                  truth_used=False, runtime_vlm_calls=0, certified=False)
    if plane and plane.get('accepted'):
        record.update(propose(body, outstanding, plane))
        if args.truth:
            from placement_diagnose_alias_poses import canonicalize
            from pose_score import read_parts, score
            truth, _ = canonicalize(read_parts(args.truth), library)
            recon, _ = canonicalize(read_parts(args.body), library)
            alignment = score(recon, truth)['alignment']
            if alignment is None:
                raise ValueError('No proper rigid alignment is implied by the placed body')
            record['reference_score'] = score_against_reference(record['decisions'], truth,
                                                               alignment)
            record['reference_score']['truth'] = args.truth
    record['limitations'] = (
        'Axis-aligned planes only; a mould with no saved mirror proof is treated as chiral; '
        'mirror-mould pairs (a left and right hand of different part numbers) are not proposed. '
        'A proposal is gated on collision and connector engagement, which is a physical '
        'necessary condition and not a proof of correctness.')
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(record, indent=2))
    if not plane or not plane.get('accepted'):
        print(f'plane refused: {json.dumps((plane or {}).get("best"))}')
    else:
        print(f"plane axis={plane['axis']} offset={plane['offset']:.3f} "
              f"matched {plane['matched']}/{plane['eligible']} eligible "
              f"({plane['fraction']:.3f}) of {plane['parts']} parts")
        print(f"proposals {len(record['proposals'])}, admitted {record['admitted']}")
        for decision in record['decisions']:
            print(f"  {decision['part']}:{decision['color']} quota {decision['quota']} "
                  f"distinct admitted {decision['distinct_admitted']} "
                  f"determined={decision['determined']}")
        if record.get('reference_score'):
            r = record['reference_score']
            print(f"  post-hoc: {r['correct']}/{r['proposals']} proposals correct, "
                  f"{r['determined_correct']}/{r['determined_proposals']} of the determined ones")
    print(args.out)


if __name__ == '__main__':
    main()
