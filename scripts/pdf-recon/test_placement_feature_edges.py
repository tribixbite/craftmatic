import unittest
import numpy as np
from placement_feature_edges import visible_edges


class FeatureEdges(unittest.TestCase):
    def test_coplanar_triangle_tessellation_not_visible(self):
        mask=np.ones((12,12),bool);depth=np.ones((12,12));owner=np.ones((12,12),int);owner[:,6:]=2
        normals=np.array([[0,0,1],[0,0,1]])
        edges=visible_edges(mask,depth,owner,normals)
        self.assertFalse(edges[2:10,2:10].any())
    def test_visible_crease_and_depth_break(self):
        mask=np.ones((12,12),bool);depth=np.ones((12,12));owner=np.ones((12,12),int);owner[:,6:]=2
        edges=visible_edges(mask,depth,owner,np.array([[0,0,1],[1,0,0]]))
        self.assertTrue(edges[2:10,6].all())
        depth[:,6:]+=4
        edges=visible_edges(mask,depth,owner,np.array([[0,0,1],[0,0,1]]))
        self.assertTrue(edges[2:10,6].all())


if __name__=='__main__':unittest.main()
