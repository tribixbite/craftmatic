import unittest
from placement_slot_adapter import adapt


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


if __name__=='__main__':unittest.main()
