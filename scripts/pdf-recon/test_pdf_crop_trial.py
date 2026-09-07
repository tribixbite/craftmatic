import unittest
import numpy as np
from pdf_crop_trial import crop_items,artwork_pixels,unique_quantities


class CropProtocol(unittest.TestCase):
    def test_identical_overprinted_quantity_is_one_callout(self):
        rgb=np.full((100,100,3),255,np.uint8)
        rgb[25:45,20:60]=80
        q={'bbox':(20,49,30,60),'qty':1}
        result=crop_items(rgb,[],[q,dict(q)],(255,255,255),scale=1)
        self.assertEqual(len(result),1)
        self.assertIn('bbox',result[0])

    def test_distinct_positions_and_quantities_are_preserved(self):
        quantities=[{'bbox':(20,49,30,60),'qty':1},
                    {'bbox':(21,49,31,60),'qty':1},
                    {'bbox':(20,49,30,60),'qty':2}]
        self.assertEqual(list(unique_quantities(quantities)),quantities)

    def test_final_matcher_pixels_also_exclude_text(self):
        rgb=np.full((100,100,3),255,np.uint8)
        rgb[10:20,10:20]=0
        rgb[40:60,30:70]=80
        clean=artwork_pixels(rgb,[(10,10,20,20,'15')],(255,255,255),scale=1)
        self.assertTrue(np.all(clean[10:20,10:20]==255))
        self.assertTrue(np.all(clean[40:60,30:70]==80))

    def test_morphology_preserves_artwork_baseline_coordinates(self):
        rgb=np.full((100,100,3),255,np.uint8)
        rgb[25:50,20:60]=0
        q={'bbox':(20,48.7,30,60),'qty':1}
        result=crop_items(rgb,[],[q],(255,255,255),scale=1)
        self.assertEqual(result[0]['bbox'],[20,25,60,50])

    def test_text_and_lower_row_are_not_part_artwork(self):
        rgb=np.full((160,160,3),255,np.uint8)
        rgb[20:35,20:35]=0 # numeral above
        rgb[47:62,20:60]=80 # actual part above quantity
        rgb[100:125,20:65]=0 # another lower row's artwork
        q={'bbox':(20,66,30,76),'qty':2}
        result=crop_items(rgb,[(20,20,35,35,'17')],[q],(255,255,255),scale=1)
        box=result[0]['bbox']
        self.assertGreaterEqual(box[1],46)
        self.assertLessEqual(box[3],64)

    def test_two_quantity_labels_cannot_claim_same_component(self):
        rgb=np.full((100,100,3),255,np.uint8)
        rgb[30:50,20:60]=0
        quantities=[{'bbox':(20,55,30,65),'qty':1},{'bbox':(22,55,32,65),'qty':2}]
        result=crop_items(rgb,[],quantities,(255,255,255),scale=1)
        self.assertTrue(all('bbox' not in r for r in result))

    def test_no_artwork_is_explicitly_unresolved(self):
        result=crop_items(np.full((100,100,3),255,np.uint8),[],[{'bbox':(20,55,30,65),'qty':1}],(255,255,255),scale=1)
        self.assertIn('unresolved',result[0])


if __name__=='__main__': unittest.main()
