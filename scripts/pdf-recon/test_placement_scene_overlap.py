import unittest
import numpy as np
from placement_scene_overlap import contained_fragments


class SceneOverlapTest(unittest.TestCase):
    def scenes(self):
        yy,xx=np.mgrid[:80,:100]
        rgb=np.stack((xx*2,yy*2,np.full_like(xx,80)),axis=2).astype(np.uint8)
        outer=dict(xref=1,rgb=rgb,mask=np.ones((80,100),bool),bbox=[0,0,100,80],transform=[100,0,0,80,0,0])
        inner=dict(xref=2,rgb=rgb[20:60,30:80].copy(),mask=np.ones((40,50),bool),
                   bbox=[30,20,80,60],transform=[50,0,0,40,30,20])
        return outer,inner

    def test_matching_contained_crop_is_redundant(self):
        result=contained_fragments(self.scenes())
        self.assertEqual(len(result),1)
        self.assertTrue(result[0]['redundant'])
        self.assertEqual(result[0]['container_xref'],1)

    def test_different_artwork_is_retained_despite_containment(self):
        outer,inner=self.scenes();inner['rgb'][:]=[255,0,0]
        self.assertFalse(contained_fragments([outer,inner])[0]['redundant'])

    def test_separate_layout_remains_an_independent_view(self):
        outer,inner=self.scenes();inner['bbox']=[120,20,170,60];inner['transform'][4]=120
        self.assertEqual(contained_fragments([outer,inner]),[])


if __name__=='__main__':unittest.main()
