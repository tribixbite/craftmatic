"""Bounded PDF-only opening bootstrap with generic detached-shape resolution.

This wrapper derives the opening and two camera-prescan pages from an autonomous
allocation.  It calls the unchanged legacy construction generator, intercepting
only its explicit ``ambiguous_detached_component`` result.  The replacement
uses the generic PDF/CAD matcher in :mod:`placement_v2_detached`, then replays
and publishes the finite opening bank through the v2 correspondence selector.
It remains a bridge over the legacy generator, not the complete v2 architecture.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import shutil

import numpy as np

from placement_v2_detached import (DEFAULT_MIN_MARGIN, MIN_BODY_FRACTION,
                                   _score_component)


HERE = Path(__file__).resolve().parent


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def source_hashes():
    # Replay owns its transitive scorer/render/curve/display snapshot.  Union it
    # with the bootstrap, resolver, publisher, and legacy generator bridge.
    from placement_v2_replay import source_hashes as replay_source_hashes
    hashes = replay_source_hashes()
    names = ('placement_v2_bootstrap.py', 'placement_v2_detached.py',
             'placement_v2_proposals.py', 'placement_v2_continue.py',
             'placement_construct_body.py', 'placement_exploded_page.py',
             'placement_autonomous_run.py', 'placement_autodrive.py')
    hashes.update({name: digest(HERE / name) for name in names})
    return hashes


def _cache_key(scene, projection, pieces):
    image = np.ascontiguousarray(scene['rgb'])
    mask = np.ascontiguousarray(scene['mask'], dtype=np.uint8)
    content = hashlib.sha256(image.tobytes() + mask.tobytes()).hexdigest()
    matrix = tuple(np.round(np.asarray(projection, float), 10).ravel())
    # Multiplicity is part of the decision because it sets identity quotas.
    keys = tuple(sorted((str(part), int(color)) for part, color in pieces))
    return content, matrix, keys


def resolve_ambiguous(scene, pieces, projection, palette, original, cache,
                      graph_builder=None, component_scorer=None,
                      spacing=3, min_margin=DEFAULT_MIN_MARGIN):
    """Resolve only an old explicit ambiguity; otherwise preserve its result."""
    if original.get('reason') != 'ambiguous_detached_component':
        return original
    key = _cache_key(scene, projection, pieces)
    if key in cache:
        return copy.deepcopy(cache[key])
    from placement_arrow_mask import conservative_components
    graph_builder = graph_builder or conservative_components
    component_scorer = component_scorer or _score_component
    graph = graph_builder(scene, protected_colors=palette['rgb'])
    components = graph.get('components') or []
    meaningful = []
    if components:
        threshold = MIN_BODY_FRACTION * components[0]['area']
        meaningful = [component for component in components[1:]
                      if component['area'] >= threshold]
    distinct = list(dict.fromkeys((str(part), int(color)) for part, color in pieces))
    rows = [component_scorer(scene, component, distinct, [np.asarray(projection, float)],
                             int(spacing), float(min_margin))
            for component in meaningful]
    base = dict(original)
    provenance = dict(protocol='Generic native-component PDF/CAD edge correspondence over '
                                      'allocated identities and cube rotations',
                      components=rows, cache_key_sha256=hashlib.sha256(repr(key).encode()).hexdigest(),
                      truth_used=False, runtime_vlm_calls=0, certified=False)
    if not graph.get('arrows'):
        provenance.update(status='refused', reason='no_accepted_arrow')
    elif not rows:
        provenance.update(status='refused', reason='no_meaningful_detached_component')
    elif any(row['decision']['status'] != 'identified' for row in rows):
        provenance.update(status='refused', reason='component_identity_ambiguous')
    else:
        selected = [row['decision']['selected'] for row in rows]
        quotas = {}
        for part, color in pieces:
            item = f'{part}:{int(color)}'
            quotas[item] = quotas.get(item, 0) + 1
        counts = {item: selected.count(item) for item in set(selected)}
        if any(count > quotas.get(item, 0) for item, count in counts.items()):
            provenance.update(status='refused', reason='identified_component_exceeds_quota',
                              selected=selected, quotas=quotas)
        elif len(selected) >= len(pieces):
            provenance.update(status='refused', reason='every_remaining_piece_would_be_detached',
                              selected=selected, quotas=quotas)
        else:
            withheld = [item.rsplit(':', 1) for item in selected]
            withheld = [[part, int(color)] for part, color in withheld]
            provenance.update(status='resolved', reason='all_components_uniquely_identified',
                              selected=selected, quotas=quotas)
            base.update(count=len(withheld), withheld=selected, withheld_keys=withheld,
                        reason='v2_shape_resolved_detached_component',
                        protocol=provenance['protocol'], v2_resolution=provenance)
            cache[key] = copy.deepcopy(base)
            return base
    base.update(count=0, withheld=[], withheld_keys=[], v2_resolution=provenance)
    cache[key] = copy.deepcopy(base)
    return base


def make_detached_wrapper(original, cache):
    """Preserve the legacy detector except for its named ambiguous outcome."""
    def wrapped(scene, pieces, projection, palette=None, require_arrow=True):
        result = original(scene, pieces, projection, palette, require_arrow)
        if result.get('reason') != 'ambiguous_detached_component':
            return result
        if palette is None:
            from placement_page_mask import part_palette
            palette = part_palette(pieces)
        return resolve_ambiguous(scene, pieces, projection, palette, result, cache)
    return wrapped


def page_options_lab():
    """The frozen autonomous PAGE_OPTIONS with only its declared metric changed."""
    import placement_autodrive
    from placement_autonomous_run import PAGE_OPTIONS
    values = list(PAGE_OPTIONS)
    index = values.index('--chromatic-metric')
    values[index + 1] = 'lab'
    parser = argparse.ArgumentParser(add_help=False)
    placement_autodrive.add_page_options(parser)
    args = parser.parse_args(values)
    options = placement_autodrive.build_options(args)
    placement_autodrive.apply_palette_options(options)
    return options


def _validated_allocation(allocation_run, pdf):
    path = Path(allocation_run) / 'global-assignment.json'
    record = json.loads(path.read_text())
    if record.get('truth_used') is not False or record.get('runtime_vlm_calls') != 0:
        raise ValueError('Allocation lacks truth-free zero-VLM provenance')
    if record.get('pdf_sha256') != digest(pdf):
        raise ValueError('Allocation PDF hash does not match --pdf')
    pages = record.get('allocation_pages')
    if (not isinstance(pages, list) or len(pages) < 1
            or not all(isinstance(page, int) for page in pages)
            or len(set(pages)) != len(pages)):
        raise ValueError('allocation_pages must be a nonempty unique integer list')
    return record, path


def replay_root_attempts(construction, out, replay_run):
    """Replay every successful root bank and select without crossing scenes."""
    rows = []
    for attempt_index, attempt in enumerate(construction.get('attempts') or []):
        if attempt.get('status') != 'placed' or not attempt.get('directory'):
            continue
        bank = Path(attempt['directory'])
        if not (bank / 'results.json').is_file():
            raise ValueError(f'Placed root has no candidate bank: {bank}')
        replay_dir = out / f'root-{attempt_index:02d}-replay'
        report = replay_run(bank, replay_dir, spacing=3, curves=True,
                            refine_translation=True, arrows=True)
        winner = report['winners']['True']
        scene = (int(report['page']), int(report['xref']), str(report['mask_source']))
        rows.append(dict(attempt_index=attempt_index, root=attempt.get('root'),
                         candidate_bank=bank, replay_directory=replay_dir,
                         scene_id=scene, winner=winner,
                         v2_normalized_cost=float(winner['normalized_cost'])))
    if not rows:
        raise RuntimeError('Construction produced no successful root candidate banks')
    groups = {}
    for row in rows:
        groups.setdefault(row['scene_id'], []).append(row)
    alternatives = []
    for scene, members in groups.items():
        selected = min(members, key=lambda row: (row['v2_normalized_cost'],
                                                  row['attempt_index'],
                                                  str(row['candidate_bank'])))
        alternatives.append(dict(scene_id=scene, selected=selected, attempts=members))
    # Native costs are comparable only within a scene.  The earliest construction
    # attempt identifies the primary scene when legacy scene extraction differs.
    primary = min(alternatives, key=lambda group: min(
        row['attempt_index'] for row in group['attempts']))
    return primary['selected'], alternatives


def run(pdf, out, allocation_run=None, roots=3,
        _construct=None, _replay=None, _publish=None, _onramp=None):
    pdf, out = Path(pdf), Path(out)
    if out.exists():
        raise ValueError('Use a fresh bootstrap output directory')
    out.mkdir(parents=True)
    sources_start = source_hashes()
    (out / 'sources').mkdir()
    for name in sources_start:
        shutil.copyfile(HERE / name, out / 'sources' / name)
    if allocation_run is None:
        if _onramp is None:
            from placement_autonomous_run import run as _onramp
        _onramp(pdf, None, out / 'onramp', truth=None, roots=int(roots),
                 mould_policy='withhold', stop_after='allocation')
        allocation_run = out / 'onramp' / 'allocation'
        allocation_source = 'autonomous_pdf_onramp'
    else:
        allocation_run = Path(allocation_run)
        allocation_source = 'verified_cache_receipt'
    allocation, allocation_path = _validated_allocation(allocation_run, pdf)
    pages = allocation['allocation_pages']
    opening_page, prescan_pages = pages[0], pages[1:3]
    options = page_options_lab()
    if _construct is None:
        from placement_construct_body import construct as _construct
    if _replay is None:
        from placement_v2_replay import run as _replay
    if _publish is None:
        from placement_v2_continue import publish_selection as _publish
    import placement_exploded_page
    legacy = placement_exploded_page.detached_pieces
    cache = {}
    placement_exploded_page.detached_pieces = make_detached_wrapper(legacy, cache)
    try:
        status, detail, bank = _construct(pdf, opening_page, allocation_run,
                                          out / 'construction-build', options,
                                          int(roots), prescan_pages)
    finally:
        placement_exploded_page.detached_pieces = legacy
    if status != 'constructed' or bank is None:
        raise RuntimeError(f'Opening construction failed: {status}')
    selected_root, scene_alternatives = replay_root_attempts(detail, out, _replay)
    published = _publish(selected_root['candidate_bank'],
                         selected_root['replay_directory'], out / 'selected')
    sources_end = source_hashes()
    report = dict(
        protocol='bounded-legacy-construction-v2-detached-bootstrap-v1',
        pdf=str(pdf.resolve()), pdf_sha256=digest(pdf),
        allocation_run=str(allocation_run), allocation_source=allocation_source,
        allocation_receipt=dict(path=str(allocation_path), sha256=digest(allocation_path),
                                expected_pdf_sha256=digest(pdf),
                                recorded_pdf_sha256=allocation['pdf_sha256'], verified=True),
        opening_page=opening_page, prescan_pages=prescan_pages, roots=int(roots),
        page_options_label='placement_autonomous_run.PAGE_OPTIONS with chromatic_metric=lab',
        construction=str(bank), construction_status=status,
        detached_cache_entries=len(cache),
        root_replays=[dict(attempt_index=row['attempt_index'], root=row['root'],
                           candidate_bank=str(row['candidate_bank']),
                           replay_directory=str(row['replay_directory']),
                           scene_id=list(row['scene_id']),
                           v2_normalized_cost=row['v2_normalized_cost'],
                           winner=row['winner']['file'])
                      for group in scene_alternatives for row in group['attempts']],
        scene_alternatives=[dict(scene_id=list(group['scene_id']),
                                 selected_attempt=group['selected']['attempt_index'],
                                 selected_cost=group['selected']['v2_normalized_cost'],
                                 comparable_attempts=[row['attempt_index']
                                                      for row in group['attempts']])
                            for group in scene_alternatives],
        selected_root_attempt=selected_root['attempt_index'],
        selected_scene_id=list(selected_root['scene_id']),
        published_opening=str(published.directory), selected_file=published.selected_file,
        v2_normalized_cost=published.v2_normalized_cost, v2_tie_count=published.tie_count,
        sources_start=sources_start, sources_end=sources_end,
        sources_unchanged=sources_start == sources_end,
        truth_used=False, runtime_vlm_calls=0, certified=False,
        limitations=['Legacy construction generator and finite candidate bank remain binding',
                     'Detached identity uses a single drawing and inherited camera proposals',
                     'Published opening is not a full reconstruction or architecture validation'])
    if not report['sources_unchanged']:
        raise RuntimeError('Bootstrap sources changed during run')
    (out / 'bootstrap.json').write_text(json.dumps(report, indent=2, default=str) + '\n')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pdf', type=Path, required=True)
    parser.add_argument('--allocation-run', type=Path,
                        help='Optional verified allocation cache; omitted runs the PDF-only on-ramp')
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--roots', type=int, default=3)
    args = parser.parse_args()
    result = run(args.pdf, args.out, args.allocation_run, args.roots)
    print(json.dumps(dict(status='completed_uncertified', opening_page=result['opening_page'],
                          selected=result['selected_file'], output=str(args.out / 'bootstrap.json'))))
