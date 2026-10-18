import unittest
import numpy as np
from vector_scene import background_mask,scene_fragments
from vector_scene_components import component_graph


class ComponentsTest(unittest.TestCase):
    def test_arrows_enclosed_background_must_not_bridge_parts(self):
        rgb=np.full((80,60,3),(200,230,250),dtype=np.uint8)
        rgb[5:20,10:50]=255;rgb[60:75,10:50]=255
        rgb[18:63,20:23]=(230,0,0);rgb[18:63,40:43]=(230,0,0)
        scene=dict(rgb=rgb,mask=background_mask(rgb))
        self.assertEqual(len(scene_fragments(scene)),2)
        self.assertFalse(scene_fragments(scene)[0]['mask'][40,30])

    def test_white_part_interior_is_preserved(self):
        rgb=np.full((30,30,3),(200,230,250),dtype=np.uint8)
        rgb[5:25,5:25]=0;rgb[7:23,7:23]=255
        scene=dict(rgb=rgb,mask=background_mask(rgb))
        self.assertTrue(scene_fragments(scene)[0]['mask'][15,15])

    def test_down_arrow_has_down_head(self):
        rgb=np.full((80,60,3),(200,230,250),dtype=np.uint8)
        rgb[10:55,29:32]=(230,0,0)
        for y in range(50,65):
            half=max(1,(65-y)//2);rgb[y,30-half:31+half]=(230,0,0)
        graph=component_graph(dict(rgb=rgb,mask=background_mask(rgb)))
        self.assertEqual(len(graph['arrows']),1)
        self.assertGreater(graph['arrows'][0]['direction'][1],0)


if __name__=='__main__':unittest.main()
