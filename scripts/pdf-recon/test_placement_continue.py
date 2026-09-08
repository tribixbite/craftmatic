import unittest
import tempfile
from pathlib import Path
from placement_continue import plan_page,resume_checkpoints,file_hash


class ContinuePlanTest(unittest.TestCase):
    def fixture(self):
        return dict(source_page=7,scenes=[dict(kind='main_scene',xref=71)],
                    parts=[('a',1)]*4,pair_groups=[dict(kind='exploded_pair',multiplier=2,source_xref=65)])

    def test_supported_repetition_preserves_pdf_image_identity(self):
        action=plan_page(self.fixture())
        self.assertEqual((action['kind'],action['copies'],action['target_xref'],action['group_xref']),
                         ('repeated_exploded_pair',2,71,65))

    def test_identity_gap_blocks_even_apparently_supported_structure(self):
        self.assertEqual(plan_page(self.fixture(),[dict(page=7,qty=1)])['kind'],'unsupported')

    def test_ambiguous_main_and_unsupported_copies_do_not_dispatch(self):
        evidence=self.fixture();evidence['scenes'].append(dict(kind='main_scene',xref=72))
        self.assertEqual(plan_page(evidence)['kind'],'unsupported')
        evidence=self.fixture();evidence['pair_groups'][0]['multiplier']=3
        self.assertEqual(plan_page(evidence)['kind'],'unsupported')

    def test_resume_reuses_only_contiguous_unchanged_completed_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)
            for name in ('model.ldr','results.json'):(path/name).write_text(name)
            config=dict(first=9,last=10,pdf_sha256='pdf',allocation_sha256='alloc',version=1)
            step=dict(page=9,placement=str(path),checkpoint_hashes={n:file_hash(path/n) for n in ('model.ldr','results.json')})
            record=dict(resume_config=config,steps=[step,dict(page=10,status='failed')])
            self.assertEqual(resume_checkpoints(record,config),{9:path})
            with self.assertRaises(ValueError):resume_checkpoints(record,dict(config,allocation_sha256='changed'))
            step['page']=10
            with self.assertRaises(ValueError):resume_checkpoints(record,config)
            step['page']=9;(path/'model.ldr').write_text('mutated')
            with self.assertRaises(ValueError):resume_checkpoints(record,config)

    def test_legacy_or_unhashed_checkpoint_cannot_be_silently_resumed(self):
        config=dict(first=1)
        with self.assertRaises(ValueError):resume_checkpoints(dict(steps=[]),config)
        with self.assertRaises(ValueError):
            resume_checkpoints(dict(resume_config=config,steps=[dict(page=1,placement='unused')]),config)

    def test_numbered_constructor_requires_explicit_layout_and_bounded_scope(self):
        evidence=self.fixture();evidence['parts']=[('a',1)]*6;evidence['pair_groups']=[]
        group=dict(kind='inset_group',copy_count=1,sequence=[dict(number=1),dict(number=2)],ordered_xrefs=[10,11])
        layout=dict(groups=[group])
        self.assertEqual(plan_page(evidence)['kind'],'unsupported')
        action=plan_page(evidence,layout=layout)
        self.assertEqual(action['kind'],'numbered_three_plus_three')
        self.assertEqual(action['target_xref'],71)
        self.assertEqual(action['stage_size_hypothesis'],3)
        group['copy_count']=2
        self.assertEqual(plan_page(evidence,layout=layout)['kind'],'unsupported')
        group['copy_count']=1;evidence['parts'].pop()
        self.assertEqual(plan_page(evidence,layout=layout)['kind'],'unsupported')


if __name__=='__main__':unittest.main()
