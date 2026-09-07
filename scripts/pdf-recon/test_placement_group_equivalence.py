import unittest
from unittest.mock import patch
import numpy as np
from placement_group_equivalence import geometry_key,triangle_digest


class GroupEquivalenceTest(unittest.TestCase):
    def test_same_vertices_different_faces_are_not_equal(self):
        a=np.array([[[0.,0,0],[2,0,0],[2,1,0]],[[0,0,0],[2,1,0],[0,1,0]]])
        b=np.array([[[0.,0,0],[2,0,0],[0,1,0]],[[2,0,0],[2,1,0],[0,1,0]]])
        self.assertEqual(triangle_digest(a),triangle_digest(a[::-1,::-1,:]))
        self.assertNotEqual(triangle_digest(a),triangle_digest(b))

    @patch('placement_group_equivalence.colored_triangles')
    def test_proper_global_frame_and_item_order_do_not_change_group(self,parse):
        parse.return_value=dict(triangles=np.array([[[0.,0,0],[2,0,0],[0,3,1]]]),colors=np.array([16]))
        a=np.eye(4);b=np.eye(4);b[:3,3]=[7,11,19]
        global_frame=np.array([[0.,0,1,37],[0,1,0,-22],[-1,0,0,4],[0,0,0,1]])
        original=[('a',1,a),('b',2,b)]
        changed=[('b',2,global_frame@b),('a',1,global_frame@a)]
        self.assertEqual(geometry_key(original,None,{}),geometry_key(changed,None,{}))
        b[0,3]+=1
        self.assertNotEqual(geometry_key(original,None,{}),geometry_key(changed,None,{}))

    @patch('placement_group_equivalence.colored_triangles')
    def test_part_and_color_are_preserved(self,parse):
        parse.return_value=dict(triangles=np.array([[[0.,0,0],[2,0,0],[0,3,1]]]),colors=np.array([16]))
        key=lambda p,c:geometry_key([(p,c,np.eye(4))],None,{})
        self.assertNotEqual(key('a',1),key('b',1))
        self.assertNotEqual(key('a',1),key('a',2))


if __name__=='__main__':unittest.main()
