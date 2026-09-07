import unittest
import cv2
import numpy as np
from placement_unknown_regions import unknown_regions,filter_unknown_studs

PALETTE={15:(255,255,255),1:(0,85,191),0:(0,0,0)}


class UnknownRegionTests(unittest.TestCase):
    def image(self):
        rgb=np.full((70,100,3),255,np.uint8)
        rgb[10:40,10:40]=(0,85,191)
        rgb[20:26,20:26]=0
        rgb[45:60,60:85]=0
        return rgb,np.ones((70,100),bool)

    def test_foreign_face_and_enclosed_dark_hole(self):
        rgb,mask=self.image();unknown,diag=unknown_regions(rgb,mask,[15],PALETTE)
        self.assertTrue(unknown[15,15]);self.assertTrue(unknown[22,22])
        self.assertFalse(unknown[50,70]);self.assertFalse(unknown[60,20])
        self.assertEqual(diag['enclosed_dark_pixels'],36)

    def test_allowed_blue_is_preserved(self):
        rgb,mask=self.image();unknown,_=unknown_regions(rgb,mask,[15,1],PALETTE)
        self.assertFalse(unknown.any())

    def test_masks_and_stud_filter(self):
        rgb,mask=self.image();mask[:15]=False
        unknown,_=unknown_regions(rgb,mask,[15],PALETTE)
        self.assertFalse(unknown[:15].any())
        kept,diag=filter_unknown_studs([{'center':[20,20]},{'center':[70,50]}],unknown)
        self.assertEqual(len(kept),1);self.assertEqual(diag['excluded_detection_indices'],[0])

    def test_empty_inventory_does_not_reject(self):
        rgb,mask=self.image();unknown,_=unknown_regions(rgb,mask,[],PALETTE)
        self.assertFalse(unknown.any())


if __name__=='__main__':unittest.main()
