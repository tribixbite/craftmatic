"""Post-hoc evaluation of a sealed placement-v2 correspondence replay.

This process is the only place that accepts a reference model.  It verifies the
runtime report and every candidate model before scoring; none of its output is
an input to replay or candidate selection.  Scores cover the retained opening
bank only and must not be reported as full-model reconstruction accuracy.
"""
import argparse
import hashlib
import json
from pathlib import Path

from placement_diagnose_alias_poses import (
    canonicalize,
    verified_local_symmetries,
    yaw_equivalent_score,
)
from placement_part_library import PartLibrary
from pose_score import read_parts, score


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _metric(value):
    """Keep the auditable headline fields without large matched-pair payloads."""
    return {key: value.get(key) for key in (
        'matched', 'recon_parts', 'truth_parts', 'precision', 'coverage',
        'inventory_coverage', 'inventory_precision', 'alignment',
        'symmetry_source', 'symmetry_evidence', 'limitations') if key in value}


def _winner_summary(rows, key, runtime_winner):
    cost = min(row[key]['normalized_cost'] for row in rows)
    tied = [row for row in rows if abs(row[key]['normalized_cost'] - cost) < 1e-12]
    ordered = sorted(tied, key=lambda row: row['sha256'])
    selected = ordered[0]
    if runtime_winner['file'] != selected['file'] or runtime_winner['tie_count'] != len(tied):
        raise ValueError(f'Runtime {key} winner/tie census is inconsistent with its records')
    values = [row['structural']['matched'] for row in tied]
    return dict(file=selected['file'], normalized_cost=cost, tie_count=len(tied),
                structural_matched=selected['structural']['matched'],
                strict_matched=selected['strict']['matched'],
                structural_tie_range=[min(values), max(values)],
                tie_members=[row['file'] for row in ordered])


def evaluate(run, truth, out):
    run, truth, out = Path(run), Path(truth), Path(out)
    report_path = run / 'report.json'
    runtime = json.loads(report_path.read_text())
    if runtime.get('truth_used') is not False or runtime.get('runtime_vlm_calls') != 0:
        raise ValueError('Runtime report lacks truth-free zero-VLM provenance')
    if not runtime.get('sources_unchanged'):
        raise ValueError('Runtime report was not sealed with unchanged source hashes')
    if runtime.get('source_hashes_start') != runtime.get('source_hashes_end'):
        raise ValueError('Runtime source hashes differ')
    bank = Path(runtime['candidate_bank'])
    if not bank.is_absolute():
        bank = Path.cwd() / bank
    bank_report = bank / 'results.json'
    if digest(bank_report) != runtime['bank_sha256']:
        raise ValueError('Candidate bank results.json differs from the runtime seal')
    records = runtime.get('records') or []
    if len(records) != runtime.get('candidate_count'):
        raise ValueError('Runtime candidate count does not match its records')
    for record in records:
        if Path(record['file']).name != record['file']:
            raise ValueError('Candidate filenames must be local to the sealed bank')
        if digest(bank / record['file']) != record['sha256']:
            raise ValueError(f"Candidate changed after replay: {record['file']}")

    truth_rows = read_parts(truth)
    library = PartLibrary()
    canonical_truth, aliases = canonicalize(truth_rows, library)
    rows = []
    for record in records:
        candidate = read_parts(bank / record['file'])
        canonical_candidate, found = canonicalize(candidate, library)
        aliases.update(found)
        strict = score(candidate, truth_rows)
        canonical = score(canonical_candidate, canonical_truth)
        structural = yaw_equivalent_score(
            canonical_candidate, canonical_truth, verified_local_symmetries)
        rows.append(dict(
            file=record['file'], sha256=record['sha256'],
            original_rank=record['original_rank'], original_score=record['original_score'],
            part_count=record['part_count'],
            no_seam=dict(normalized_cost=record['selected']['False']['normalized_cost'],
                         camera_index=record['selected']['False']['camera_index']),
            seam=dict(normalized_cost=record['selected']['True']['normalized_cost'],
                      camera_index=record['selected']['True']['camera_index']),
            strict=_metric(strict), canonical_alias=_metric(canonical),
            structural=_metric(structural)))

    original = min(rows, key=lambda row: row['original_rank'])
    top_score = original['original_score']
    original_ties = [row for row in rows if row['original_score'] == top_score]
    structural_values = [row['structural']['matched'] for row in original_ties]
    oracle = max(rows, key=lambda row: (row['structural']['matched'],
                                        row['strict']['matched'], -row['original_rank']))
    no_seam = _winner_summary(rows, 'no_seam', runtime['winners']['False'])
    seam = _winner_summary(rows, 'seam', runtime['winners']['True'])
    result = dict(
        protocol='placement-v2-sealed-posthoc-opening-evaluation-v1',
        scope='Independent evaluation of retained opening candidates only. '
              'No full-model reconstruction claim.',
        runtime_report=str(report_path), runtime_report_sha256=digest(report_path),
        candidate_bank=str(bank), bank_results_sha256=runtime['bank_sha256'],
        truth_path=str(truth), truth_sha256=digest(truth),
        truth_parts=len(truth_rows), candidate_count=len(rows),
        denominator_policy='Coverage denominator is the full reference model; precision denominator '
                           'is each opening candidate. These opening scores are reported separately.',
        original_winner=dict(file=original['file'], original_rank=original['original_rank'],
                             original_score=top_score,
                             structural_matched=original['structural']['matched'],
                             strict_matched=original['strict']['matched'],
                             tie_count=len(original_ties),
                             structural_tie_range=[min(structural_values), max(structural_values)]),
        no_seam_winner=no_seam, seam_winner=seam,
        best_oracle=dict(file=oracle['file'], structural_matched=oracle['structural']['matched'],
                         strict_matched=oracle['strict']['matched'],
                         opening_parts=oracle['part_count'], truth_parts=len(truth_rows),
                         opening_precision=oracle['structural']['precision'],
                         full_truth_coverage=oracle['structural']['coverage']),
        aliases=aliases, alias_provenance=library.provenance, rows=rows)
    payload = json.dumps(result, indent=2) + '\n'
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        raise ValueError('Use a fresh evaluation output path')
    out.write_text(payload)
    seal = digest(out)
    seal_path = out.with_suffix(out.suffix + '.sha256')
    seal_path.write_text(seal + '  ' + out.name + '\n')
    print(json.dumps(dict(out=str(out), sha256=seal, original=result['original_winner'],
                          no_seam=no_seam, seam=seam, oracle=result['best_oracle']), indent=2))
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', type=Path, required=True,
                        help='Completed placement_v2_replay output directory')
    parser.add_argument('--truth', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    evaluate(args.run, args.truth, args.out)
