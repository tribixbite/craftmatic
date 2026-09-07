import json
from pathlib import Path
import unittest
from placement_parts_list import load_parts_list


class PartsListTests(unittest.TestCase):
    def test_merges_inventory_without_accepting_pose_fields(self):
        folder=Path('output/pdf-placement-diagnosis/parts-list-tests')
        folder.mkdir(parents=True,exist_ok=True)
        path=folder/'parts.json'
        path.write_text(json.dumps([dict(part='3001.dat',color=4,qty=2),dict(part='3001',color=4,qty=1)]))
        self.assertEqual(load_parts_list(path)['records'],[dict(part='3001',color=4,qty=3)])
        invalid=folder/'pose-rejected.json'
        invalid.write_text(json.dumps([dict(part='3001',color=4,qty=1,position=[0,0,0])]))
        with self.assertRaisesRegex(ValueError,'poses are forbidden'):load_parts_list(invalid)


if __name__=='__main__':unittest.main()
