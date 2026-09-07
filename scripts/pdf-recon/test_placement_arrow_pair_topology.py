import unittest
import numpy as np
from placement_arrow_pair_topology import arrow_pair_components


class TopologyTests(unittest.TestCase):
    def graph(self):
        components=[]
        for x,y,w,h in [(5,2,20,8),(5,30,20,8),(26,24,2,2)]:
            mask=np.zeros((45,45),bool);mask[y:y+h,x:x+w]=True
            components.append(dict(mask=mask,area=int(mask.sum()),bbox=[x,y,x+w,y+h]))
        return dict(components=components,arrows=[dict(tail=[10,10],head=[10,30]),dict(tail=[20,10],head=[20,30])])
    def test_two_arrow_agreement_ignores_unlinked_residue(self):
        parts,evidence=arrow_pair_components(self.graph())
        self.assertEqual(evidence['original_head_component'],1);self.assertEqual(evidence['original_tail_component'],0)
        self.assertEqual(evidence['ignored_components'],[2]);self.assertEqual(len(parts),2)
    def test_conflicting_topology_abstains(self):
        graph=self.graph();graph['arrows'][1]=dict(tail=[20,30],head=[20,10])
        with self.assertRaisesRegex(ValueError,'disagree'):arrow_pair_components(graph)


if __name__=='__main__':unittest.main()
