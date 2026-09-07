import unittest
from placement_continue import plan_page


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


if __name__=='__main__':unittest.main()
