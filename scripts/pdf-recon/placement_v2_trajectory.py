"""Separate post-run whole-checkpoint pose evaluation of a v2 continuation.

Every checkpoint is matched one-to-one after a single global rigid alignment.
No fragment-wise alignment, no scores returned to the runtime solver.
"""
import argparse
import hashlib
import json
from pathlib import Path


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def verify_run(directory):
    directory = Path(directory)
    record = json.loads((directory / 'continue.json').read_text())
    if (record.get('truth_used') is not False or record.get('runtime_vlm_calls') != 0
            or not record.get('sources_unchanged') or record.get('sources_start') != record.get('sources_end')):
        raise ValueError('Continuation is not sealed reference-free runtime output')
    drive = record.get('autodrive')
    if not drive or record.get('autodrive_error'):
        raise ValueError('Continuation did not finish successfully')
    if digest(record['pdf']) != record['pdf_sha256']:
        raise ValueError('PDF changed after the run')
    opening = Path(record['opening_publication'])
    opening_meta = json.loads((opening / 'results.json').read_text())
    receipt = opening_meta['selection_v2']
    if digest(opening / 'model.ldr') != receipt['selected_candidate_sha256']:
        raise ValueError('Opening model changed after publication')
    checkpoints = [dict(page=record['opening_page'], stage='opening', model=opening/'model.ldr',
                        tie_count=receipt['tie_count'])]
    for step in drive['steps']:
        if step['status'] != 'placed':
            continue
        placement = Path(step['placement'])
        for name, expected in step['checkpoint_hashes'].items():
            if digest(placement / name) != expected:
                raise ValueError(f'Checkpoint changed: {placement / name}')
        checkpoints.append(dict(page=step['page'], stage='continuation', model=placement/'model.ldr',
                                tie_count=step.get('detail', {}).get('v2_tie_count')))
    return record, checkpoints


def evaluate(directory, truth, out):
    record, checkpoints = verify_run(directory)
    # Runtime provenance is checked before importing evaluators or reading truth.
    from pose_score import read_parts, score
    from placement_part_library import PartLibrary
    from placement_diagnose_alias_poses import canonicalize, verified_local_symmetries, yaw_equivalent_score
    library = PartLibrary()
    reference = read_parts(truth)
    canonical_truth, _ = canonicalize(reference, library)
    rows = []
    for checkpoint in checkpoints:
        model = read_parts(checkpoint['model'])
        canonical_model, _ = canonicalize(model, library)
        strict = score(model, reference)
        alias = score(canonical_model, canonical_truth)
        structural = yaw_equivalent_score(canonical_model, canonical_truth, verified_local_symmetries)
        rows.append(dict(page=checkpoint['page'], stage=checkpoint['stage'],
                         model=str(checkpoint['model']), model_sha256=digest(checkpoint['model']),
                         emitted=len(model), strict=strict['matched'], alias=alias['matched'],
                         structural=structural['matched'], precision=structural['precision'],
                         full_model_coverage=structural['coverage'], tie_count=checkpoint['tie_count']))
    result = dict(run=str(directory), run_sha256=digest(Path(directory)/'continue.json'),
                  truth=str(truth), truth_sha256=digest(truth), truth_parts=len(reference), rows=rows,
                  final=rows[-1], opening_structural=rows[0]['structural'],
                  driver_contribution=rows[-1]['structural']-rows[0]['structural'],
                  scope_pages=record['pages'],
                  limitation='Bounded continuation, legacy proposals plus new selector. '
                             'Full-model denominator retained; not a completed-booklet accuracy claim.',
                  runtime_vlm_calls=0, truth_used_at_runtime=False)
    out = Path(out)
    if out.exists():
        raise ValueError('Use a new evaluation output path')
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', type=Path, required=True)
    parser.add_argument('--truth', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    evaluate(args.run, args.truth, args.out)
