"""What the retained alternatives of each committed page actually contain.

Evaluation only. Page-level backtracking can only ever reach an assembly the
page's own search already retained, so the ceiling of every backtracking policy
is a property of those retained sets - measurable from saved artifacts, with no
GPU and no re-search.

For every placement directory a run committed, this reads the ranked
`results.json` the search wrote, scores *every* retained assembly against the
independent reference with the same structural matcher the program's headline
numbers use (`placement_diagnose_alias_poses`), and reports per page:

* the assembly the objective selected and its structural agreement;
* the best-agreeing retained assembly, its rank, and the objective score it was
  passed over by - the *reachable* delta of a perfect page-level backtrack;
* the exact-tie census at the top of the ranking and the structural spread
  inside that tie, because a tie is variance rather than evidence and a
  configuration change re-rolls it;
* the deduplicated alternative count, since two views can retain the same body.

The reference is read to score, never to choose: no output of this module is an
input to any placement, and the run directory it reads is already complete.
"""
import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path

from placement_diagnose_alias_poses import (canonicalize, verified_local_symmetries,
                                            yaw_equivalent_score)
from placement_part_library import PartLibrary
from pose_score import read_parts, score


def retained(directory):
    """The ranked retained assemblies of one placement directory.

    Deduplicated by model text, keeping the first (best-ranked) occurrence: two
    registrations of the same page can retain an identical body, and a
    backtracking budget spent on a byte-identical alternative buys nothing.
    """
    directory = Path(directory)
    meta = json.loads((directory / 'results.json').read_text())
    if meta.get('truth_used') is not False:
        raise ValueError('Placement provenance lacks truth-free declaration')
    rows, seen = [], {}
    for rank, result in enumerate(meta.get('results') or []):
        path = directory / result['file']
        payload = path.read_bytes()
        digest = hashlib.sha256(payload).hexdigest()
        row = dict(rank=rank, file=result['file'], sha256=digest,
                   view=result.get('view'),
                   score=result['evidence']['score'],
                   combined_score=result['evidence'].get('combined_score'),
                   coarse_score=result['coarse']['score'],
                   indices=list(result['coarse']['indices']),
                   duplicate_of=seen.get(digest))
        seen.setdefault(digest, rank)
        rows.append(row)
    return meta, rows


def tie_census(rows):
    """Exact top-score ties among genuinely different retained bodies."""
    distinct = [row for row in rows if row['duplicate_of'] is None]
    if not distinct:
        return dict(width=0, score=None, distinct_bodies=0)
    top = distinct[0]['score']
    tied = [row for row in distinct if row['score'] == top]
    return dict(width=len(tied), score=top, distinct_bodies=len(distinct),
                members=[row['rank'] for row in tied])


def structural(rows, directory, truth_rows, library):
    """Structural agreement of every retained assembly, by rank."""
    directory = Path(directory)
    canonical_truth, aliases = canonicalize(truth_rows, library)
    out = []
    for row in rows:
        recon = read_parts(directory / row['file'])
        canonical_recon, found = canonicalize(recon, library)
        aliases.update(found)
        yaw = yaw_equivalent_score(canonical_recon, canonical_truth, verified_local_symmetries)
        out.append(dict(row, structural=yaw['matched'], recon_parts=yaw['recon_parts'],
                        strict=score(recon, truth_rows)['matched'],
                        canonical_alias=score(canonical_recon, canonical_truth)['matched']))
    return out, aliases


def page_report(directory, truth_rows, library):
    meta, rows = retained(directory)
    scored, aliases = structural(rows, directory, truth_rows, library)
    distinct = [row for row in scored if row['duplicate_of'] is None]
    selected = scored[0] if scored else None
    best = max(distinct, key=lambda row: (row['structural'], -row['rank'])) if distinct else None
    census = tie_census(scored)
    tied = [row for row in distinct if row['score'] == census['score']]
    return dict(
        directory=str(directory), page=meta.get('page'), shapes=meta.get('shapes'),
        image_pieces=meta.get('image_pieces'), withheld=meta.get('withheld_pieces'),
        retained=len(scored), distinct_bodies=len(distinct),
        selected=dict(rank=selected['rank'], structural=selected['structural'],
                      score=selected['score'], strict=selected['strict'],
                      canonical_alias=selected['canonical_alias']) if selected else None,
        oracle_best=dict(rank=best['rank'], structural=best['structural'], score=best['score'],
                         strict=best['strict'], canonical_alias=best['canonical_alias'],
                         score_gap=selected['score'] - best['score']) if best else None,
        reachable_delta=(best['structural'] - selected['structural']) if best else 0,
        top_tie=dict(census, structural=sorted({row['structural'] for row in tied}),
                     structural_counts=dict(Counter(row['structural'] for row in tied))),
        structural_histogram=dict(sorted(Counter(row['structural']
                                                 for row in distinct).items())),
        alternatives=[dict(rank=row['rank'], score=row['score'], structural=row['structural'],
                           strict=row['strict'], view=row['view'],
                           duplicate_of=row['duplicate_of']) for row in scored],
        aliases=aliases)


def run_report(run, truth_path, library=None):
    """Every committed placement of a completed drive, in journal order."""
    run = Path(run)
    library = library or PartLibrary()
    truth_rows = read_parts(truth_path)
    journal = json.loads((run / 'autodrive.json').read_text())
    pages = []
    for step in journal['steps']:
        if step.get('status') != 'placed' or not step.get('placement'):
            continue
        directory = Path(step['placement'])
        if not (directory / 'results.json').is_file():
            continue
        report = page_report(directory, truth_rows, library)
        report.update(journal_page=step['page'], retry_pass=step.get('retry_pass'),
                      registration_source=(step.get('detail') or {}).get('registration_source'))
        pages.append(report)
    reachable = sum(page['reachable_delta'] for page in pages)
    final = pages[-1]['selected']['structural'] if pages else None
    return dict(run=str(run), truth=str(truth_path), pages=pages,
                totals=dict(placed_pages=len(pages),
                            final_selected_structural=final,
                            final_page_oracle_structural=(pages[-1]['oracle_best']['structural']
                                                          if pages else None),
                            pages_with_a_better_alternative=sum(1 for page in pages
                                                                if page['reachable_delta'] > 0),
                            summed_page_reachable_delta=reachable,
                            pages_ending_in_a_tie=sum(1 for page in pages
                                                      if page['top_tie']['width'] > 1),
                            widest_tie=max((page['top_tie']['width'] for page in pages),
                                           default=0)),
                scope=('Independent reference evaluation of already-completed runs. The reference '
                       'scores retained assemblies and never selects one; nothing here is an input '
                       'to a placement.'),
                limitations=[
                    'A per-page delta is measured against the body that page actually started '
                    'from, so the deltas are not additive across pages: taking a better '
                    'alternative changes every later page\'s bank.',
                    'Structural agreement grants declared unprinted symmetries and authoritative '
                    'filename aliases; raw strict counts are reported beside it.',
                    'Only assemblies the search retained are visible here; a pose no candidate '
                    'carried is out of reach of any backtracking policy.'],
                truth_used=True, certified=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', type=Path, help='A completed autodrive directory')
    parser.add_argument('--dir', type=Path, action='append', default=[],
                        help='A single placement directory (a construction, for instance)')
    parser.add_argument('--truth', required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    library = PartLibrary()
    payload = dict(truth=args.truth, truth_used=True, certified=False)
    if args.run:
        payload['drive'] = run_report(args.run, args.truth, library)
    if args.dir:
        truth_rows = read_parts(args.truth)
        payload['directories'] = [page_report(directory, truth_rows, library)
                                  for directory in args.dir]
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, indent=2))
    print(args.out)


if __name__ == '__main__':
    main()
