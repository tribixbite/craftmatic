"""Evaluation-only trajectory table for a driven run.

Reports, per completed checkpoint, how many parts the run emitted and how many
agree with the independent model at raw-strict, authoritative-alias and derived
universal-CAD structural equivalence, plus precision and whole-model coverage.
The reference model is read after the run and never participates in it.
"""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))


def evaluate(placement, truth):
    from placement_diagnose_alias_poses import (canonicalize, legacy_local_symmetries,
                                                verified_local_symmetries, yaw_equivalent_score)
    from placement_part_library import PartLibrary
    from pose_score import read_parts, score
    metadata = json.loads((placement / 'results.json').read_text())
    if metadata.get('truth_used') is not False:
        raise ValueError('Run artifacts lack truth-free provenance')
    library = PartLibrary()
    reference = read_parts(truth)
    canonical_truth, _ = canonicalize(reference, library)
    recon = read_parts(placement / 'model.ldr')
    canonical_recon, _ = canonicalize(recon, library)
    structural = yaw_equivalent_score(canonical_recon, canonical_truth, verified_local_symmetries)
    return dict(emitted=len(recon), strict=score(recon, reference)['matched'],
                canonical=score(canonical_recon, canonical_truth)['matched'],
                structural=structural['matched'], truth_parts=len(reference),
                precision=structural['matched'] / max(1, len(recon)),
                coverage=structural['matched'] / max(1, len(reference)),
                legacy_structural=yaw_equivalent_score(canonical_recon, canonical_truth,
                                                       legacy_local_symmetries)['matched'])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('run', type=Path)
    parser.add_argument('--truth', required=True)
    parser.add_argument('--out', type=Path)
    args = parser.parse_args()
    journal = json.loads((args.run / 'autodrive.json').read_text())
    rows = []
    for step in journal['steps']:
        if not step.get('placement'):
            rows.append(dict(page=step['page'], status=step['status'],
                             reason=(step.get('detail') or {}).get('reason')))
            continue
        row = dict(page=step['page'], status=step['status'],
                   score=(step.get('detail') or {}).get('score'),
                   withheld=(step.get('detail') or {}).get('exploded_withheld'))
        row.update(evaluate(Path(step['placement']), args.truth))
        rows.append(row)
    result = dict(run=str(args.run), truth=args.truth, status=journal['status'], rows=rows,
                  scope='Evaluation-only, executed after the run; the reference model chooses '
                        'nothing at runtime.',
                  limitations='Structural equivalence uses derived universal-CAD symmetry proofs; '
                              'coverage is whole-model placement agreement, not certification.')
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(result, indent=2))
    header = f"{'page':>4} {'status':<26} {'emit':>5} {'struct':>6} {'canon':>5} {'strict':>6} {'prec':>6} {'cov':>6} {'score':>7}"
    print(header)
    for row in rows:
        if 'emitted' not in row:
            print(f"{row['page']:>4} {row['status']:<26} {'-':>5} {'-':>6} {'-':>5} {'-':>6} "
                  f"{'-':>6} {'-':>6} {'-':>7}   {row.get('reason') or ''}")
            continue
        print(f"{row['page']:>4} {row['status']:<26} {row['emitted']:>5} {row['structural']:>6} "
              f"{row['canonical']:>5} {row['strict']:>6} {row['precision']:>6.3f} "
              f"{row['coverage']:>6.3f} {(row['score'] or 0):>7.4f}"
              + (f"   withheld={row['withheld']}" if row.get('withheld') else ''))


if __name__ == '__main__':
    main()
