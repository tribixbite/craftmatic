import unittest
import numpy as np
from placement_repeated_coarse import shortlist_pairs


class FakeScorer:
    mask=np.ones((41,61),bool);target_span=np.array([60.,40.]);target_center=np.array([30.,20.]);span_tolerance=.4
    def _project_part(self,part,color,T,projection):
        points=np.array([[-5,-5,0],[5,-5,0],[5,5,0],[-5,5,0]])@T[:3,:3].T@np.asarray(projection).T
        return dict(xy=points,lo=points.min(0),hi=points.max(0))


class CompletePairTests(unittest.TestCase):
    def test_all_unordered_pairs_and_joint_extent(self):
        def piece(x,y):
            T=np.eye(4);T[:2,3]=[x,y];return [('fixture',15,T)]
        base=piece(0,0);placements=[dict(items=piece(-25,-15)),dict(items=piece(25,15)),dict(items=piece(-100,0)),dict(items=piece(100,0))]
        projection=np.array([[1.,0,0],[0,1.,0]])
        selected,report=shortlist_pairs(base,placements,projection,FakeScorer(),limit=20)
        self.assertEqual(report['total_pairs'],6);self.assertEqual(selected[0][:2],(0,1))
        self.assertEqual(report['bbox_compatible_pairs'],1)
        again,_=shortlist_pairs(base,placements,projection,FakeScorer(),limit=20);self.assertEqual(selected,again)

    def test_disabled_not_silently_enabled(self):
        with self.assertRaises(ValueError):shortlist_pairs([],[],None,None,limit=0)


if __name__=='__main__':unittest.main()
