import unittest
import numpy as np
from placement_balanced_color_metric import balanced_color_metric


class BalancedColors(unittest.TestCase):
    def test_dark_saturated_blue_remains_blue(self):
        target=np.array([[[20,75,190],[240,240,240],[0,0,0]]],np.uint8)
        pred=np.array([[[3,20,55],[120,120,120],[240,240,240]]],np.uint8)
        mask=np.ones((1,3),bool)
        r=balanced_color_metric(target,mask,pred,mask,[1,15],{1:[0,85,191],15:[255,255,255]})
        self.assertEqual(r['score'],1);self.assertEqual(r['unknown_pixels'],1)

    def test_macro_prevents_large_region_swamping_small(self):
        rgb=np.zeros((10,10,3),np.uint8);rgb[:]=[0,80,190];rgb[0]=255
        wrong=rgb.copy();wrong[0]=[0,80,190];mask=np.ones((10,10),bool)
        r=balanced_color_metric(rgb,mask,wrong,mask,[1,15],{1:[0,85,191],15:[255,255,255]})
        self.assertAlmostEqual(r['score'],.45)

    def test_black_actual_part_not_ignored_and_print_separate(self):
        rgb=np.array([[[0,0,0],[255,220,0],[240,240,240]]],np.uint8);mask=np.ones((1,3),bool)
        r=balanced_color_metric(rgb,mask,rgb,mask,[0,15],{0:[0,0,0],15:[255,255,255]})
        self.assertEqual(r['unknown_pixels'],0);self.assertEqual(r['score'],1)
        self.assertEqual(r['target_foreign_color_pixels'],1)


if __name__=='__main__':unittest.main()
