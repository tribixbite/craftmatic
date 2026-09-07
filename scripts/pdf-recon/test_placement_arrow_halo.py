import unittest
import numpy as np
from placement_arrow_halo import refine_arrow_halo


class HaloTests(unittest.TestCase):
    def fixture(self):
        rgb=np.full((30,40,3),245,np.uint8);core=np.zeros((30,40),bool);core[5:25,20]=True
        rgb[core]=[200,0,0];rgb[5:25,21]=[240,220,220];rgb[5:25,22]=255
        rgb[5:15,3:10]=[200,0,0]
        return dict(rgb=rgb,mask=(rgb!=245).any(2)),dict(arrow_mask=core,arrows=[dict(hue='red')],candidates=[])
    def test_only_seed_connected_background_mixture_removed(self):
        scene,graph=self.fixture();out=refine_arrow_halo(scene,graph)
        self.assertTrue(out['halo_mask'][5:25,21].all())
        self.assertFalse(out['halo_mask'][5:25,22].any())
        self.assertFalse(out['halo_mask'][5:15,3:10].any())
    def test_protected_actual_red_part_abstains_halo(self):
        scene,graph=self.fixture();out=refine_arrow_halo(scene,graph,[[200,0,0]])
        self.assertFalse(out['halo_mask'].any())


if __name__=='__main__':unittest.main()
