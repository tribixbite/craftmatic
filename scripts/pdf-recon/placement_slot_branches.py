"""Enumerate every identity branch of an ambiguous PDF slot assignment.

The slot adapter deliberately refuses a page whose inventory record maps to
more than one CAD variant, because silently choosing one would publish a mold
identity the PDF does not establish. Refusing also removes the page from the
build entirely, which is worse: on 40377 it drops a whole page of geometry over
one 4032a/4032b element.

This emits one ordinary allocation directory per combination of the ambiguous
choices, all of them recorded, so the runtime can place every branch and let
PDF pixel evidence rank them. Nothing here selects a branch, and a branch that
wins on image evidence is still an uncertified mold hypothesis.
"""
import argparse
import copy
import hashlib
import itertools
import json
from pathlib import Path
from placement_slot_adapter import adapt


def branches(source, pages, max_branches=8):
    pages = sorted(set(map(int, pages)))
    if not pages or any(p < 0 for p in pages):
        raise ValueError('Explicit nonnegative page scope required')
    if source.get('pdf_only') is not True or source.get('truth_used') is not False \
            or source.get('runtime_vlm_calls') != 0:
        raise ValueError('Slot source lacks deterministic PDF-only provenance')
    if any(entry['page'] in pages for entry in source.get('unresolved', [])):
        raise ValueError('Scope contains a callout with no inventory slot at all')
    ambiguous, options = [], []
    for index, entry in enumerate(source['evidence']):
        if entry['page'] not in pages:
            continue
        choices = sorted({(str(c['part']), str(c['color'])) for c in entry.get('part_choices', [])})
        if not choices:
            raise ValueError(f"Unmapped inventory identity on page {entry['page']}")
        if len(choices) == 1:
            continue
        ambiguous.append(index)
        options.append(choices)
    total = 1
    for choice in options:
        total *= len(choice)
    if total > max_branches:
        raise ValueError(f'{total} identity branches exceed the explicit limit {max_branches}')
    results = []
    for combination in itertools.product(*options) if options else [()]:
        resolved = copy.deepcopy(source)
        selection = []
        for index, (part, color) in zip(ambiguous, combination):
            entry = resolved['evidence'][index]
            entry['part_choices'] = [dict(part=part, color=color)]
            selection.append(dict(page=entry['page'], inventory_slot=entry.get('inventory_slot'),
                                  qty=entry['qty'], part=part, color=color,
                                  alternatives=sorted({(str(c['part']), str(c['color']))
                                                       for c in source['evidence'][index]
                                                       .get('part_choices', [])})))
        adapted = adapt(resolved, pages)
        adapted['identity_branch'] = dict(index=len(results), of=total, selection=selection,
                                          ambiguous_records=len(ambiguous))
        adapted['limitations'] = list(adapted['limitations']) + [
            'One branch of an ambiguous inventory identity; the PDF does not establish the mold.',
            'Every branch must be retained downstream until image evidence ranks them.']
        results.append(adapted)
    return results


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--pages', required=True, type=int, nargs='+')
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--max-branches', type=int, default=8)
    args = parser.parse_args()
    payload = args.source.read_bytes()
    source = json.loads(payload)
    if hashlib.sha256(Path(source['pdf']).read_bytes()).hexdigest() != source['pdf_sha256']:
        raise ValueError('Actual PDF hash mismatch')
    produced = branches(source, args.pages, args.max_branches)
    args.out.mkdir(parents=True, exist_ok=False)
    (args.out / 'slot-source.json').write_bytes(payload)
    index = []
    for adapted in produced:
        directory = args.out / f"branch-{adapted['identity_branch']['index']:02d}"
        directory.mkdir()
        adapted.update(slot_source=str(args.source.resolve()),
                       slot_source_sha256=hashlib.sha256(payload).hexdigest(),
                       verified_artifacts={})
        (directory / 'global-assignment.json').write_text(json.dumps(adapted, indent=2))
        manifest = {k: adapted[k] for k in
                    ('pdf', 'pdf_sha256', 'pdf_only', 'truth_used', 'runtime_vlm_calls',
                     'allocation_pages', 'inventory_sha256', 'checkpoint_sha256',
                     'slot_source', 'slot_source_sha256', 'verified_artifacts')}
        manifest['identity_branch'] = adapted['identity_branch']
        manifest['branch_enumerator_sha256'] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        (directory / 'manifest.json').write_text(json.dumps(manifest, indent=2))
        index.append(dict(directory=str(directory), branch=adapted['identity_branch'],
                          assigned_pieces=adapted['assigned_pieces']))
    (args.out / 'branches.json').write_text(json.dumps(
        dict(pages=args.pages, branches=index, source=str(args.source),
             source_sha256=hashlib.sha256(payload).hexdigest(), truth_used=False,
             runtime_vlm_calls=0, certified=False), indent=2))
    print(json.dumps(dict(branches=len(index), pages=args.pages,
                          selections=[b['branch']['selection'] for b in index])))
