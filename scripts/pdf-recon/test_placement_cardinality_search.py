import itertools
import unittest
import numpy as np
from placement_cardinality_search import search_layers


class CardinalityTests(unittest.TestCase):
    def test_depth_occlusion_quota_and_conflicts_match_exhaustive_control(self):
        rng=np.random.default_rng(501)
        for trial in range(10):
            labels=rng.integers(0,3,(7,4,5));depths=rng.random((7,4,5));depths[labels==0]=-np.inf
            target=rng.integers(1,3,(4,5));base=np.full((4,5),-np.inf);empty=np.zeros((4,5),int)
            colors=[1,1,1,1,2,2,2];conflicts=[(0,4),(2,5)]
            result=search_layers(base,empty,depths,labels,colors,{1:2,2:1},target,conflicts=conflicts)
            scores=[]
            for chosen in itertools.combinations(range(7),3):
                if sum(colors[i]==1 for i in chosen)!=2 or any(a in chosen and b in chosen for a,b in conflicts):continue
                d=base.copy();l=empty.copy()
                for i in chosen:
                    take=np.isfinite(depths[i])&(depths[i]>=d);d[take]=depths[i][take];l[take]=labels[i][take]
                scores.append(np.mean([np.sum((target==c)&(l==c))/np.sum((target==c)|(l==c)) for c in (1,2)]))
            self.assertTrue(result['search_exhaustive']);self.assertAlmostEqual(result['score'],max(scores))

    def test_budget_never_claims_exhaustive_and_unsupported_floating_group_rejected(self):
        depths=np.ones((3,2,2));labels=np.ones((3,2,2),int);target=labels[0];base=np.full((2,2),-np.inf);empty=np.zeros((2,2),int)
        result=search_layers(base,empty,depths,labels,[1]*3,{1:2},target,max_nodes=1)
        self.assertFalse(result['search_exhaustive'])
        result=search_layers(base,empty,depths,labels,[1]*3,{1:2},target,base_supported=[0],support_edges=[])
        self.assertIsNone(result['indices'])
        result=search_layers(base,empty,depths,labels,[1]*3,{1:2},target,base_supported=[0],support_edges=[(0,2)])
        self.assertEqual(result['indices'],(0,2))

    def test_exact_depth_tie_is_stable_and_later_layer_can_hide_wrong_color(self):
        base=np.ones((1,2));empty=np.ones((1,2),int)
        depths=np.array([[[2.,2.]],[[2.,2.]],[[3.,3.]]]);labels=np.array([[[1,1]],[[2,2]],[[1,1]]])
        target=np.ones((1,2),int)
        result=search_layers(base,empty,depths,labels,[1,2,1],{1:1,2:1},target)
        self.assertEqual(result['indices'],(1,2));self.assertEqual(result['score'],1.)
        result=search_layers(base,empty,depths[:2],labels[:2],[1,2],{1:1,2:1},target)
        self.assertEqual(result['score'],0.)

    def test_top_k_keeps_equal_optima_instead_of_pruning_after_first(self):
        labels=np.ones((5,1,2),int);depths=np.ones_like(labels,float);target=labels[0]
        result=search_layers(np.full((1,2),-np.inf),np.zeros((1,2),int),depths,labels,[1]*5,{1:2},target,top_k=4)
        self.assertTrue(result['search_exhaustive']);self.assertEqual(len(result['candidates']),4)
        self.assertEqual([r['indices'] for r in result['candidates']],[(0,1),(0,2),(0,3),(0,4)])


if __name__=='__main__':unittest.main()
