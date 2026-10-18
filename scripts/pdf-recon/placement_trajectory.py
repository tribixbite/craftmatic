"""Evaluation-only trajectory table for a driven run.

Reports, per completed checkpoint, how many parts the run emitted and how many
agree with the independent model at raw-strict, authoritative-alias and derived
universal-CAD structural equivalence, plus precision and whole-model coverage.
The reference model is read after the run and never participates in it.

Every row also carries its own **tie exposure**: how many retained assemblies
share that page's top image score exactly, and how many of those are genuinely
different models. A chain-level A/B is only as trustworthy as that number, and
until round seven no chain table in this program reported it. Round six's
parent-budget chain reproduces round five exactly through page 19 and then
diverges - not because of the budget, but because page 19 emits one 25269
quarter tile under either of two proper rotations a quarter turn apart, scored
identically to sixteen significant figures, and page 22 inherits whichever side
won. Exact ties among different assemblies occur on 7 of 13 driven 40377 pages
and 15 of 27 on 41624, up to twelve ways. Drive an A/B with `--tie-break pose`
and read the `tied` column before believing a delta.
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


def tie_exposure(placement):
    """This page's exposure to a coin flip, from its own recorded scores.

    `distinct_tied_models` is the count that matters: several retained rows can
    share a score because they *are* the same assembly reached twice, which is
    not a fork. Reported as zeros rather than omitted when the run recorded no
    usable scores, so a row never silently claims an exposure of none.
    """
    from placement_score_ties import page_ties
    try:
        row = page_ties(placement) or {}
    except (OSError, ValueError, KeyError):
        return dict(tied_at_top=None, distinct_tied_models=None, pose_tie_break=None)
    metadata = json.loads((Path(placement) / 'results.json').read_text())
    exchanges = [report for view in metadata.get('views') or []
                 for report in (view.get('native_exchange') or [])]
    return dict(tied_at_top=row.get('within_0'),
                distinct_tied_models=row.get('distinct_tied_models'),
                pose_tie_break=(bool(exchanges[0].get('pose_tie_break'))
                                if exchanges and 'pose_tie_break' in exchanges[0] else None))


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
        row.update(tie_exposure(step['placement']))
        rows.append(row)
    result = dict(run=str(args.run), truth=args.truth, status=journal['status'], rows=rows,
                  scope='Evaluation-only, executed after the run; the reference model chooses '
                        'nothing at runtime.',
                  limitations='Structural equivalence uses derived universal-CAD symmetry proofs; '
                              'coverage is whole-model placement agreement, not certification.')
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(result, indent=2))
    header = (f"{'page':>4} {'status':<26} {'emit':>5} {'struct':>6} {'canon':>5} {'strict':>6} "
              f"{'prec':>6} {'cov':>6} {'score':>7} {'tied':>5}")
    print(header)
    for row in rows:
        if 'emitted' not in row:
            print(f"{row['page']:>4} {row['status']:<26} {'-':>5} {'-':>6} {'-':>5} {'-':>6} "
                  f"{'-':>6} {'-':>6} {'-':>7} {'-':>5}   {row.get('reason') or ''}")
            continue
        tied = row.get('distinct_tied_models')
        print(f"{row['page']:>4} {row['status']:<26} {row['emitted']:>5} {row['structural']:>6} "
              f"{row['canonical']:>5} {row['strict']:>6} {row['precision']:>6.3f} "
              f"{row['coverage']:>6.3f} {(row['score'] or 0):>7.4f} "
              f"{('-' if tied is None else tied):>5}"
              + (f"   withheld={row['withheld']}" if row.get('withheld') else ''))
    exposed = sum(1 for row in rows if (row.get('distinct_tied_models') or 0) > 1)
    print(f"pages with an exact tie among genuinely different assemblies: {exposed} "
          f"of {sum(1 for row in rows if 'emitted' in row)}")


if __name__ == '__main__':
    main()
