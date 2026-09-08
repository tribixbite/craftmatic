import unittest
import numpy as np
from placement_pdf_color_constraints import signature,constrain_scores


def icon(value,background=(178,215,242)):
    image=np.full((40,50,3),background,np.uint8);image[5:35,5:45]=value
    image[5:35:7,5:45]=50;return image


class ColorConstraintTests(unittest.TestCase):
    def test_white_black_cross_matches_rejected_without_identity_input(self):
        white=icon(245);black=icon(65);whitebom=icon(239,(211,237,252));blackbom=icon(62,(211,237,252))
        matrix,evidence=constrain_scores([white,black],[blackbom,whitebom],np.ones((2,2)))
        self.assertTrue(np.isneginf(matrix[0,0]));self.assertTrue(np.isneginf(matrix[1,1]))
        self.assertEqual(matrix[0,1],1);self.assertEqual(matrix[1,0],1);self.assertEqual(len(evidence['rejected']),2)

    def test_white_paper_gray_and_chromatic_parts_abstain(self):
        for image in [icon(245,(255,255,255)),icon(150),icon((20,90,190))]:self.assertFalse(signature(image)['confident'])


if __name__=='__main__':unittest.main()
