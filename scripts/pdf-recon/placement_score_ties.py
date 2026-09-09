"""How often is a page's selection a coin flip between equal-scoring assemblies?

40377 page 19 emits one 25269 quarter tile under either of two proper rotations
a quarter turn apart, scored identically to sixteen significant figures, and
which one it emits redirects the camera path five pages later - page 22 falls
from `drawing_to_drawing` at 1.6916 px/LDU to `body_template` at 1.4863, and its
score from 0.3668 to 0.2529. A chain-level A/B between two configurations is
therefore only as trustworthy as the number of such ties between them.

This counts them from the runs' own `results.json`: how many retained assemblies
share the top image score exactly, and how many sit within a relative epsilon of
it. No rendering, no reference model, no GPU - it reads what the run recorded.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

EPSILONS = (0.0, 1e-12, 1e-9, 1e-6, 1e-4)


def page_ties(placement):
    import hashlib
    placement = Path(placement)
    result = json.loads((placement / 'results.json').read_text())
    if result.get('truth_used') is not False:
        raise ValueError('Run artifacts lack truth-free provenance')
    scores = [float(entry['evidence']['score']) for entry in result['results']]
    if not scores:
        return None
    best = max(scores)
    row = dict(retained=len(scores), best=best)
    for epsilon in EPSILONS:
        threshold = best - abs(best) * epsilon
        row[f'within_{epsilon:g}'] = sum(1 for s in scores if s >= threshold)
    # An equal score is necessary for a coin flip, not sufficient: the same
    # placement can be retained twice. Hashing the tied assemblies' own files
    # separates "two names for one answer" from "two answers, no way to choose".
    digests = []
    for entry, score in zip(result['results'], scores):
        if score < best:
            continue
        path = placement / entry['file']
        if path.is_file():
            digests.append(hashlib.sha256(path.read_bytes()).hexdigest())
    row['tied_at_the_top'] = len(digests)
    row['distinct_tied_models'] = len(set(digests))
    return row


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--run', type=Path, action='append', required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    runs = []
    for run in args.run:
        journal = json.loads((run / 'autodrive.json').read_text())
        if journal.get('truth_used') is not False or journal.get('runtime_vlm_calls') != 0:
            raise ValueError('Run journal lacks truth-free zero-VLM attestation')
        rows = []
        for step in journal['steps']:
            if not step.get('placement'):
                continue
            row = page_ties(step['placement'])
            if row:
                rows.append(dict(page=step['page'], **row))
        runs.append(dict(run=str(run), rows=rows,
                         pages=len(rows),
                         pages_with_an_exact_tie=sum(1 for r in rows if r['within_0'] > 1),
                         pages_with_distinct_tied_models=sum(
                             1 for r in rows if r['distinct_tied_models'] > 1),
                         max_distinct_tied_models=max(
                             (r['distinct_tied_models'] for r in rows), default=0),
                         pages_tied_within_1e_9=sum(1 for r in rows if r['within_1e-09'] > 1),
                         pages_tied_within_1e_4=sum(1 for r in rows if r['within_0.0001'] > 1)))
    record = dict(runs=runs, epsilons=list(EPSILONS), truth_used=False, runtime_vlm_calls=0,
                  certified=False,
                  scope='Reads the image scores each run recorded for its retained assemblies. '
                        'No reference model and no rendering.',
                  limitations='Equal scores are necessary for a coin flip, not sufficient: two '
                              'tied assemblies can be the same placement written twice. The '
                              'counts are of retained assemblies, so a tie the search never '
                              'retained is invisible here.')
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(record, indent=2))
    for run in runs:
        print(run['run'])
        print(f"{'page':>5} {'retained':>9} {'exact':>6} {'distinct':>9} {'1e-6':>6} "
              f"{'1e-4':>6}  best")
        for row in run['rows']:
            print(f"{row['page']:>5} {row['retained']:>9} {row['within_0']:>6} "
                  f"{row['distinct_tied_models']:>9} {row['within_1e-06']:>6} "
                  f"{row['within_0.0001']:>6}  {row['best']:.6f}")
        print(f"  pages {run['pages']}, exact tie at the top "
              f"{run['pages_with_an_exact_tie']}, of which genuinely different assemblies "
              f"{run['pages_with_distinct_tied_models']} (max "
              f"{run['max_distinct_tied_models']} distinct)")
    print(args.out)


if __name__ == '__main__':
    main()
