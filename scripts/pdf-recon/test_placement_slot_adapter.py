import unittest
from placement_slot_adapter import adapt,admissible_pages,blocked_rows


def table(members=('4032a','4032b'),pool=True,colors=True):
    return dict(classes=[dict(members=list(members),canonical=sorted(members)[0],shares_capacity_pool=pool,colors_agree=colors,tolerance_ldu=0.01,placement_equivalent=False)])


class MouldClassTests(unittest.TestCase):
    """A proven class may be admitted; nothing else may, and no name is invented."""
    def source(self):return dict(pdf='input.pdf',pdf_sha256='hash',pdf_only=True,truth_used=False,runtime_vlm_calls=0,evidence=[dict(page=3,qty=2,part_choices=[dict(part='3001',color='15')],inventory_slot=0),dict(page=3,qty=1,part_choices=[dict(part='4032a',color='72'),dict(part='4032b',color='72')],inventory_slot=1)],unresolved=[])
    def test_withhold_drives_the_page_without_guessing_a_filename(self):
        result=adapt(self.source(),[3],table(),'withhold')
        self.assertEqual(result['assigned_pieces'],2);self.assertEqual(result['withheld_pieces'],1)
        self.assertEqual([r['part'] for r in result['evidence']],['3001'])
        self.assertEqual(result['withheld_classes'][0]['members'],['4032a','4032b'])
        self.assertEqual(result['withheld_classes'][0]['page'],3)
    def test_canonical_allocates_the_class_and_says_the_name_is_unresolved(self):
        result=adapt(self.source(),[3],table(),'canonical')
        self.assertEqual((result['assigned_pieces'],result['withheld_pieces']),(3,0))
        row=[r for r in result['evidence'] if r.get('mould_class')][0]
        self.assertEqual((row['part'],row['color']),('4032a','72'))
        self.assertEqual(row['mould_class']['members'],['4032a','4032b'])
    def test_an_unproven_or_two_colour_class_still_refuses_the_page(self):
        for unusable in (table(pool=False),table(colors=False),table(members=('4032a','3001')),None):
            with self.assertRaises(ValueError):adapt(self.source(),[3],unusable,'withhold')
    def test_the_default_policy_is_unchanged_and_an_unknown_one_is_an_error(self):
        with self.assertRaises(ValueError):adapt(self.source(),[3],table())
        with self.assertRaises(ValueError):adapt(self.source(),[3],table(),'allocate_anything')


class AdapterTests(unittest.TestCase):
    def source(self):return dict(pdf='input.pdf',pdf_sha256='hash',pdf_only=True,truth_used=False,runtime_vlm_calls=0,inventory_sha256='inventory',checkpoint_sha256='model',evidence=[dict(page=2,qty=2,part_choices=[dict(part='3001',color='15')],inventory_slot=0),dict(page=3,qty=1,part_choices=[dict(part='4032a',color='72'),dict(part='4032b',color='72')],inventory_slot=1)],unresolved=[])
    def test_preserves_identity_quantity_scope_and_hashes_without_pose(self):
        result=adapt(self.source(),[2]);self.assertEqual(result['assigned_pieces'],2);self.assertEqual(result['evidence'][0]['part'],'3001');self.assertEqual(result['checkpoint_sha256'],'model');self.assertEqual(result['allocation_pages'],[2]);self.assertNotIn('T',result['evidence'][0])
    def test_ambiguous_unknown_or_unresolved_scopes_fail(self):
        with self.assertRaises(ValueError):adapt(self.source(),[2,3])
        source=self.source();source['evidence'][0]['part_choices']=[]
        with self.assertRaises(ValueError):adapt(source,[2])
        source=self.source();source['unresolved']=[dict(page=2,qty=1)]
        with self.assertRaises(ValueError):adapt(source,[2])


class AutoScopeTests(unittest.TestCase):
    """The page scope is derivable, so it is not a human decision."""

    def source(self):
        return dict(pdf='input.pdf',pdf_sha256='hash',pdf_only=True,truth_used=False,runtime_vlm_calls=0,
            evidence=[dict(page=2,qty=3,part_choices=[dict(part='3001',color='15')],inventory_slot=0),
                      dict(page=3,qty=2,part_choices=[dict(part='3002',color='15')],inventory_slot=1),
                      dict(page=4,qty=1,part_choices=[dict(part='4032a',color='72'),dict(part='4032b',color='72')],inventory_slot=2),
                      dict(page=4,qty=2,part_choices=[dict(part='3003',color='15')],inventory_slot=3),
                      dict(page=5,qty=4,part_choices=[dict(part='3004',color='15')],inventory_slot=4)],
            unresolved=[dict(page=5,qty=1,unresolved='ambiguous artwork association')])

    def test_a_refused_row_takes_its_whole_page_out_and_says_what_it_costs(self):
        pages,excluded=admissible_pages(self.source())
        self.assertEqual(pages,[2,3])
        self.assertEqual([row['page'] for row in excluded],[4,5])
        self.assertEqual([row['allocated_pieces_lost'] for row in excluded],[3,4])

    def test_a_proven_mould_class_returns_its_page_to_the_scope(self):
        pages,excluded=admissible_pages(self.source(),table(),'withhold')
        self.assertEqual(pages,[2,3,4])
        self.assertEqual([row['page'] for row in excluded],[5])

    def test_the_derived_scope_is_exactly_what_adapt_accepts(self):
        source=self.source()
        pages,_=admissible_pages(source,table(),'withhold')
        adapted=adapt(source,pages,table(),'withhold')
        self.assertEqual(adapted['allocation_pages'],pages)
        self.assertEqual(adapted['assigned_pieces'],7)
        self.assertEqual(adapted['withheld_pieces'],1)

if __name__=='__main__':unittest.main()
