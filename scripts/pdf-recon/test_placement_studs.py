import unittest
import cv2
import numpy as np
from placement_studs import detect_studs


class StudTests(unittest.TestCase):
    def test_two_ellipses_have_correct_centers(self):
        rgb=np.full((200,240,3),255,np.uint8)
        cv2.ellipse(rgb,(65,65),(18,9),27,0,360,(10,10,10),2)
        cv2.ellipse(rgb,(155,125),(13,20),10,0,360,(10,10,10),-1)
        found=detect_studs(rgb,np.ones((200,240),bool))
        self.assertEqual(len(found),2)
        for p,expected in zip(found,[(65,65),(155,125)]):self.assertLess(np.linalg.norm(np.array(p['center'])-expected),1)

    def test_foreground_mask_excludes_features(self):
        rgb=np.full((100,100,3),255,np.uint8)
        cv2.ellipse(rgb,(50,50),(18,9),0,0,360,(0,0,0),2)
        self.assertEqual(detect_studs(rgb,np.zeros((100,100),bool)),[])

    def test_rectangle_is_not_an_ellipse(self):
        rgb=np.full((100,100,3),255,np.uint8)
        cv2.rectangle(rgb,(20,20),(70,55),(0,0,0),2)
        self.assertEqual(detect_studs(rgb,np.ones((100,100),bool)),[])


if __name__=='__main__':unittest.main()
