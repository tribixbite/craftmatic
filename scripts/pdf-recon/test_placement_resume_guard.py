import json, sys, unittest
from pathlib import Path
sys.path.insert(0, 'scripts/pdf-recon')
from placement_autodrive import resume_checkpoints


class ResumeGuardTests(unittest.TestCase):
    def journal(self, config, steps=()):
        return dict(resume_config=config, steps=list(steps))

    def test_a_tuple_option_does_not_block_a_resume(self):
        # `scales` is built as a tuple and read back from the journal as a list.
        saved = dict(pages=[16, 17], options=dict(scales=[1.0], views=3))
        live = dict(pages=[16, 17], options=dict(scales=(1.0,), views=3))
        self.assertEqual(resume_checkpoints(self.journal(saved), live), {})

    def test_a_real_option_change_still_blocks(self):
        saved = dict(pages=[16], options=dict(scales=[1.0], views=3))
        live = dict(pages=[16], options=dict(scales=(1.0,), views=2))
        with self.assertRaises(ValueError):
            resume_checkpoints(self.journal(saved), live)

    def test_a_changed_page_scope_still_blocks(self):
        saved = dict(pages=[16, 17], options=dict(scales=[1.0]))
        live = dict(pages=[16], options=dict(scales=(1.0,)))
        with self.assertRaises(ValueError):
            resume_checkpoints(self.journal(saved), live)

    def test_a_placed_step_without_hashes_is_refused(self):
        config = dict(pages=[16], options={})
        steps = [dict(page=16, status='placed', placement='nowhere')]
        with self.assertRaises(ValueError):
            resume_checkpoints(self.journal(config, steps), dict(config))


if __name__ == '__main__':
    unittest.main()
