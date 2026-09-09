"""Backtracking: score classes, triggers, derived checkpoints, selection.

The trigger tests run against the program's own completed journals where those
exist, because a synthetic journal proves only that the predicate reads the
fields it was written against. The real ones prove which of four measured chains
each predicate fires on - including the two it must stay silent on.
"""
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from placement_backtrack import (alternatives, assess, branch_metrics, derive_base,
                                 reopen_sites, score_classes, select, signals)

RUNS = Path('output/pdf-placement-beam')
CONSTRUCTION = RUNS / '41601-r8-construction' / 'construction'


def journal(run):
    return json.loads((RUNS / run / 'autodrive.json').read_text())


def placed_step(page, source, px, score, status='placed', retry=None):
    detail = dict(registration_source=source, selected_view_px_per_ldu=px, score=score)
    step = dict(page=page, status=status, detail=detail, placement=f'dir-{page}')
    if retry:
        step['retry_pass'] = retry
    return step


class ScoreClassTest(unittest.TestCase):
    """One representative per exact objective-score class, not per retained body."""

    @unittest.skipUnless(CONSTRUCTION.is_dir(), 'requires the 41601 construction artifacts')
    def test_construction_collapses_thirty_six_bodies_to_two_classes(self):
        census = score_classes(CONSTRUCTION)
        self.assertEqual(census['retained'], 36)
        self.assertEqual(census['distinct_bodies'], 36)
        self.assertEqual([len(entry['members']) for entry in census['classes']], [24, 12])
        self.assertEqual([entry['representative']['rank'] for entry in census['classes']], [0, 24])
        # The classes are exact ties, not near ties: every member shares the score.
        for entry in census['classes']:
            self.assertEqual({member['rank'] for member in entry['members']}
                             & {other['rank'] for other in census['classes'][0]['members']}
                             != set(), entry is census['classes'][0])

    @unittest.skipUnless(CONSTRUCTION.is_dir(), 'requires the 41601 construction artifacts')
    def test_the_driven_class_is_excluded_and_the_next_one_offered(self):
        census, offered = alternatives(CONSTRUCTION)
        self.assertEqual([entry['rank'] for entry in offered], [0, 24])
        taken = census['classes'][0]['representative']['sha256']
        _, remaining = alternatives(CONSTRUCTION, [taken])
        self.assertEqual([entry['rank'] for entry in remaining], [24])
        self.assertEqual(remaining[0]['class_width'], 12)

    def test_a_duplicate_body_is_never_a_branch(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / 'a.ldr').write_text('1 0 0 0 0 1 0 0 0 1 0 0 0 1 3005.dat\n')
            (path / 'b.ldr').write_text('1 0 0 0 0 1 0 0 0 1 0 0 0 1 3005.dat\n')
            (path / 'c.ldr').write_text('1 0 0 8 0 1 0 0 0 1 0 0 0 1 3005.dat\n')
            (path / 'results.json').write_text(json.dumps(dict(
                truth_used=False, runtime_vlm_calls=0, page=3,
                results=[dict(file='a.ldr', view=0, evidence=dict(score=0.5),
                              coarse=dict(indices=[1], score=0.4)),
                         dict(file='b.ldr', view=1, evidence=dict(score=0.5),
                              coarse=dict(indices=[2], score=0.4)),
                         dict(file='c.ldr', view=1, evidence=dict(score=0.4),
                              coarse=dict(indices=[3], score=0.3))])))
            census = score_classes(path)
            self.assertEqual(census['distinct_bodies'], 2)
            self.assertEqual([entry['distinct_bodies'] for entry in census['classes']], [1, 1])
            _, offered = alternatives(path)
            self.assertEqual([entry['file'] for entry in offered], ['a.ldr', 'c.ldr'])

    def test_provenance_is_required_before_any_alternative_is_read(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / 'results.json').write_text(json.dumps(dict(truth_used=True, results=[])))
            with self.assertRaises(ValueError):
                score_classes(path)


class TriggerTest(unittest.TestCase):
    """What fires, and - the load-bearing half - what does not."""

    def test_a_body_template_fallback_alone_is_not_a_contradiction(self):
        steps = [placed_step(16, 'body_template', 1.6918, 0.6372),
                 placed_step(17, 'body_template', 1.6749, 0.5780)]
        self.assertEqual(assess(dict(steps=steps))['firings'], [])

    def test_a_fallback_that_moves_the_camera_scale_fires(self):
        steps = [placed_step(19, 'drawing_to_drawing', 1.6916, 0.5347),
                 placed_step(22, 'body_template', 1.4863, 0.2583)]
        firings = assess(dict(steps=steps))['firings']
        self.assertEqual([(row['trigger'], row['page']) for row in firings],
                         [('registration_collapse', 22)])
        self.assertAlmostEqual(firings[0]['evidence']['scale_change'], -0.1213644, places=6)

    def test_two_refusals_wait_for_the_retry_pass_and_three_do_not(self):
        two = [placed_step(35, None, None, None, status='camera_refused'),
               placed_step(36, None, None, None, status='camera_refused')]
        self.assertEqual(assess(dict(steps=two))['firings'], [])
        three = two + [placed_step(37, None, None, None, status='camera_refused')]
        firings = assess(dict(steps=three))['firings']
        self.assertEqual([(row['trigger'], row['page']) for row in firings],
                         [('refusal_run', 37)])
        self.assertEqual(firings[0]['evidence']['pages'], [35, 36, 37])

    def test_a_retry_page_cannot_trigger_a_reopening(self):
        steps = [placed_step(19, 'drawing_to_drawing', 1.6916, 0.5347),
                 placed_step(26, 'body_template', 1.4825, 0.2371, retry=1)]
        self.assertEqual(assess(dict(steps=steps))['firings'], [])
        self.assertEqual([row['page'] for row in signals(dict(steps=steps))], [19])

    def test_capacity_deficits_compose_as_a_trigger_only_when_requested(self):
        capacity = dict(deficits=[dict(page=4, key=['4070', 72], required=4, available=2)])
        steps = [placed_step(3, 'drawing_to_drawing', 1.1, 0.69)]
        self.assertEqual(assess(dict(steps=steps), capacity=capacity)['firings'], [])
        firings = assess(dict(steps=steps), triggers=('capacity_violation',),
                         capacity=capacity)['firings']
        self.assertEqual([(row['trigger'], row['page']) for row in firings],
                         [('capacity_violation', 4)])

    def test_score_trend_stays_off_because_it_cannot_separate_the_two_chains(self):
        # 40377 page 22 fell 30% in the chain that scored three poses BETTER and
        # 52% in the one that scored worse. Only the second may fire.
        better = [placed_step(19, 'drawing_to_drawing', 1.6916, 0.5327),
                  placed_step(22, 'drawing_to_drawing', 1.6916, 0.3738)]
        worse = [placed_step(19, 'drawing_to_drawing', 1.6916, 0.5347),
                 placed_step(22, 'body_template', 1.4863, 0.2583)]
        self.assertEqual(assess(dict(steps=better), triggers=('score_trend',))['firings'], [])
        self.assertEqual([row['trigger'] for row in
                          assess(dict(steps=worse), triggers=('score_trend',))['firings']],
                         ['score_trend'])

    @unittest.skipUnless((RUNS / '40377-r8-compound-chain' / 'autodrive.json').is_file(),
                         'requires the round-eight compound chain journal')
    def test_the_measured_regression_is_the_one_firing_on_the_real_chains(self):
        compound = assess(journal('40377-r8-compound-chain'))['firings']
        self.assertEqual([(row['trigger'], row['page']) for row in compound],
                         [('registration_collapse', 22)])
        # The chain that kept its registration produces no contradiction at all.
        self.assertEqual(assess(journal('40377-r7-window-det'))['firings'], [])

    @unittest.skipUnless((RUNS / '41601-r8-drive' / 'autodrive.json').is_file(),
                         'requires the 41601 drive journal')
    def test_a_wrong_opening_is_silent_under_every_instrument(self):
        # 3 of 108 correct, and not one downstream signal says so.
        self.assertEqual(assess(journal('41601-r8-drive'),
                                triggers=('registration_collapse', 'refusal_run',
                                          'score_trend'))['firings'], [])

    @unittest.skipUnless((RUNS / '41624-r7-window-det' / 'autodrive.json').is_file(),
                         'requires the 41624 drive journal')
    def test_the_long_refusal_run_is_the_only_firing_on_41624(self):
        firings = assess(journal('41624-r7-window-det'))['firings']
        self.assertEqual([(row['trigger'], row['page']) for row in firings],
                         [('refusal_run', 37)])


class DerivedCheckpointTest(unittest.TestCase):
    @unittest.skipUnless(CONSTRUCTION.is_dir(), 'requires the 41601 construction artifacts')
    def test_the_alternative_becomes_the_model_and_the_first_recorded_view(self):
        _, offered = alternatives(CONSTRUCTION)
        member = offered[1]
        with tempfile.TemporaryDirectory() as directory:
            derived = derive_base(CONSTRUCTION, member, Path(directory) / 'base',
                                  dict(parent_branch=0))
            self.assertEqual((derived / 'model.ldr').read_text(),
                             (CONSTRUCTION / member['file']).read_text())
            meta = json.loads((derived / 'results.json').read_text())
            self.assertEqual(meta['results'][0]['file'], member['file'])
            self.assertEqual(len(meta['results']),
                             len(json.loads((CONSTRUCTION / 'results.json').read_text())
                                 ['results']))
            self.assertEqual(meta['backtrack']['taken_rank'], member['rank'])
            self.assertIs(meta['truth_used'], False)
            self.assertEqual(meta['runtime_vlm_calls'], 0)

    @unittest.skipUnless(CONSTRUCTION.is_dir(), 'requires the 41601 construction artifacts')
    def test_a_derived_checkpoint_seeds_drawing_registration_from_its_own_view(self):
        from placement_drawing_registration import registration_of_run
        _, offered = alternatives(CONSTRUCTION)
        member = offered[1]
        with tempfile.TemporaryDirectory() as directory:
            derived = derive_base(CONSTRUCTION, member, Path(directory) / 'base', {})
            seed, why = registration_of_run(derived)
            self.assertIsNone(why)
            original, _ = registration_of_run(CONSTRUCTION)
            self.assertEqual(seed['page'], original['page'])
            # Different retained view => a different accepted projection.
            self.assertNotEqual(seed['projection'], original['projection'])


class SelectionTest(unittest.TestCase):
    def branch(self, index, placed, pieces, failures, collapses, score):
        return dict(index=index, metrics=dict(
            placed_pages=placed, pieces_emitted=pieces, camera_failures=failures,
            registration_collapses=collapses, mean_page_score=score))

    def test_more_of_the_booklet_placed_outranks_a_higher_mean_score(self):
        branches = [self.branch(0, 10, 40, 2, 1, 0.62), self.branch(1, 12, 44, 2, 0, 0.41)]
        chosen, order = select(branches)
        self.assertEqual((chosen['index'], order), (1, [1, 0]))
        # The control rule reproduces today's behaviour.
        self.assertEqual(select(branches, 'objective')[0]['index'], 0)
        self.assertEqual(select(branches, 'first')[0]['index'], 0)

    def test_ties_resolve_to_the_earlier_branch_deterministically(self):
        branches = [self.branch(0, 10, 40, 1, 0, 0.5), self.branch(1, 10, 40, 1, 0, 0.5)]
        self.assertEqual(select(branches)[1], [0, 1])

    def test_metrics_count_an_inherited_prefix_and_the_retry_pass(self):
        record = dict(steps=[placed_step(20, 'drawing_to_drawing', 1.2, 0.4),
                             placed_step(21, None, None, None, status='camera_refused'),
                             dict(placed_step(21, 'drawing_to_drawing', 1.2, 0.3), retry_pass=1)],
                      status='completed_requested_pages_uncertified')
        metrics = branch_metrics(record, inherited_pages=5, inherited_pieces=30)
        self.assertEqual((metrics['placed_pages'], metrics['main_pass_placed'],
                          metrics['retry_placed'], metrics['camera_failures']), (7, 1, 1, 1))
        self.assertEqual(metrics['pieces_emitted'], 30)


class ReopenOrderTest(unittest.TestCase):
    def branch(self):
        return dict(base='BASE', journal=dict(steps=[
            placed_step(3, 'drawing_to_drawing', 1.1, 0.6),
            placed_step(4, None, None, None, status='camera_refused'),
            placed_step(6, 'drawing_to_drawing', 1.1, 0.5)]))

    def test_each_policy_orders_the_same_sites_differently(self):
        branch = self.branch()
        self.assertEqual([page for page, _ in reopen_sites(branch, 'base-first')], [None, 3, 6])
        self.assertEqual([page for page, _ in reopen_sites(branch, 'nearest')], [6, 3, None])
        self.assertEqual([page for page, _ in reopen_sites(branch, 'earliest')], [3, 6, None])
        with self.assertRaises(ValueError):
            reopen_sites(branch, 'whatever')


if __name__ == '__main__':
    unittest.main()
