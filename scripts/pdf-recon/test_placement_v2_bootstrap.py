from pathlib import Path

import numpy as np

from placement_v2_bootstrap import (_cache_key, make_detached_wrapper, replay_root_attempts,
                                    resolve_ambiguous)


def scene_and_graph(component_count=1):
    rgb = np.full((40, 50, 3), 245, np.uint8)
    mask = np.zeros((40, 50), bool)
    body = np.zeros_like(mask); body[15:35, 5:35] = True
    parts = []
    for index in range(component_count):
        item = np.zeros_like(mask); item[2 + index * 5:6 + index * 5, 4:14] = True
        parts.append(dict(mask=item, area=int(item.sum()), bbox=(4, 2, 14, 6)))
    mask |= body
    for item in parts: mask |= item['mask']
    scene = dict(rgb=rgb, mask=mask)
    graph = dict(components=[dict(mask=body, area=int(body.sum()), bbox=(5, 15, 35, 35))] + parts,
                 arrows=[dict(head=[1, 1])])
    return scene, graph


def scored(selected, status='identified'):
    return dict(decision=dict(status=status, selected=selected,
                              margin=.1 if status == 'identified' else 0., ranking=[]))


def test_wrapper_calls_legacy_and_changes_only_named_ambiguity():
    calls = []
    def legacy(*args):
        calls.append(args)
        return dict(count=0, withheld_keys=[], reason='single_drawn_component')
    wrapper = make_detached_wrapper(legacy, {})
    result = wrapper(dict(rgb=np.zeros((2, 2, 3), np.uint8), mask=np.ones((2, 2), bool)),
                     [('2420', 15)], np.array([[1, 0, 0], [0, 1, 0]]),
                     dict(rgb=[]))
    assert result['reason'] == 'single_drawn_component'
    assert len(calls) == 1


def test_cache_key_includes_piece_multiplicity():
    scene, _ = scene_and_graph()
    projection = np.array([[1, 0, 0], [0, 1, 0]])
    one = _cache_key(scene, projection, [('2420', 15), ('15571', 15)])
    two = _cache_key(scene, projection, [('2420', 15), ('2420', 15), ('15571', 15)])
    assert one != two


def test_unique_shape_decision_within_quota_resolves_with_provenance():
    scene, graph = scene_and_graph()
    result = resolve_ambiguous(
        scene, [('2420', 15), ('15571', 15)], np.array([[1, 0, 0], [0, 1, 0]]),
        dict(rgb=[]), dict(count=0, withheld_keys=[], reason='ambiguous_detached_component'), {},
        graph_builder=lambda *a, **k: graph,
        component_scorer=lambda *a, **k: scored('2420:15'))
    assert result['count'] == 1
    assert result['withheld_keys'] == [['2420', 15]]
    assert result['reason'] == 'v2_shape_resolved_detached_component'
    assert result['v2_resolution']['truth_used'] is False


def test_identified_components_exceeding_quota_are_refused():
    scene, graph = scene_and_graph(2)
    result = resolve_ambiguous(
        scene, [('2420', 15), ('15571', 15)], np.array([[1, 0, 0], [0, 1, 0]]),
        dict(rgb=[]), dict(count=0, withheld_keys=[], reason='ambiguous_detached_component'), {},
        graph_builder=lambda *a, **k: graph,
        component_scorer=lambda *a, **k: scored('2420:15'))
    assert result['count'] == 0 and result['withheld_keys'] == []
    assert result['v2_resolution']['reason'] == 'identified_component_exceeds_quota'


def test_one_ambiguous_component_refuses_all_withholding():
    scene, graph = scene_and_graph()
    result = resolve_ambiguous(
        scene, [('2420', 15), ('15571', 15)], np.array([[1, 0, 0], [0, 1, 0]]),
        dict(rgb=[]), dict(count=0, withheld_keys=[], reason='ambiguous_detached_component'), {},
        graph_builder=lambda *a, **k: graph,
        component_scorer=lambda *a, **k: scored(None, 'refused'))
    assert result['count'] == 0
    assert result['v2_resolution']['reason'] == 'component_identity_ambiguous'


def test_identifying_every_remaining_piece_is_refused():
    scene, graph = scene_and_graph()
    result = resolve_ambiguous(
        scene, [('2420', 15)], np.array([[1, 0, 0], [0, 1, 0]]),
        dict(rgb=[]), dict(count=0, withheld_keys=[], reason='ambiguous_detached_component'), {},
        graph_builder=lambda *a, **k: graph,
        component_scorer=lambda *a, **k: scored('2420:15'))
    assert result['count'] == 0
    assert result['v2_resolution']['reason'] == 'every_remaining_piece_would_be_detached'


def test_replay_all_roots_selects_lowest_cost_within_same_scene(tmp_path):
    banks = []
    for index in range(3):
        bank = tmp_path / f'bank-{index}'
        bank.mkdir(); (bank / 'results.json').write_text('{}')
        banks.append(bank)
    construction = dict(attempts=[dict(status='placed', directory=str(bank), root=[str(i), 15])
                                  for i, bank in enumerate(banks)])
    costs = {str(banks[0]): .4, str(banks[1]): .2, str(banks[2]): .3}
    calls = []
    def replay(bank, out, **options):
        calls.append((bank, out, options))
        return dict(page=2, xref=11, mask_source='whole_scene',
                    winners={'True': dict(file='candidate.ldr',
                                          normalized_cost=costs[str(bank)])})
    selected, alternatives = replay_root_attempts(construction, tmp_path / 'replays', replay)
    assert len(calls) == 3
    assert selected['attempt_index'] == 1
    assert len(alternatives) == 1
    assert calls[0][2] == dict(spacing=3, curves=True, refine_translation=True, arrows=True)


def test_replay_does_not_compare_cost_across_different_scenes(tmp_path):
    banks = []
    for index in range(2):
        bank = tmp_path / f'bank-{index}'
        bank.mkdir(); (bank / 'results.json').write_text('{}')
        banks.append(bank)
    construction = dict(attempts=[dict(status='placed', directory=str(bank), root=[str(i), 15])
                                  for i, bank in enumerate(banks)])
    def replay(bank, out, **options):
        index = banks.index(bank)
        return dict(page=2, xref=11 + index, mask_source='whole_scene',
                    winners={'True': dict(file='candidate.ldr',
                                          normalized_cost=(.9, .1)[index])})
    selected, alternatives = replay_root_attempts(construction, tmp_path / 'replays', replay)
    assert len(alternatives) == 2
    assert selected['attempt_index'] == 0
