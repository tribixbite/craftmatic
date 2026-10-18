import unittest
import numpy as np
from matching_trials import canonical, retrieval


class MatchingProtocol(unittest.TestCase):
    def test_identical_reference_is_excluded_even_if_it_would_win(self):
        rows=[{'set':'train','split':'train','part':'a','color':'0','image_sha256':'same','image':'a'},
              {'set':'train','split':'train','part':'b','color':'0','image_sha256':'different','image':'b'},
              {'set':'test','split':'test','part':'a','color':'0','image_sha256':'same','image':'q'}]
        result=retrieval(np.array([[1.,0.],[0.,1.],[1.,0.]]),rows,'test')
        self.assertEqual(result['available'],0)
        self.assertEqual(result['rows'][0]['prediction'],'b')

    def test_test_images_cannot_become_references(self):
        rows=[{'set':'train','split':'train','part':'b','color':'0','image_sha256':'b','image':'b'},
              {'set':'test','split':'test','part':'a','color':'0','image_sha256':'a','image':'a'},
              {'set':'test2','split':'test','part':'a','color':'0','image_sha256':'c','image':'c'}]
        result=retrieval(np.array([[0.,1.],[1.,0.],[1.,0.]]),rows,'test')
        self.assertEqual(result['available'],0)
        self.assertTrue(all(r['prediction']=='b' for r in result['rows']))

    def test_blank_crop_is_not_a_part(self):
        self.assertIsNone(canonical(np.full((32,48,3),255,np.uint8)))


if __name__=='__main__': unittest.main()
