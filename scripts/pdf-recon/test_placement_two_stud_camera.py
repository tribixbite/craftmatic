import unittest
import numpy as np
from placement_two_stud_camera import two_cap_camera


class TwoCapTests(unittest.TestCase):
    def test_known_spacing_recovers_asymmetric_camera_covariance(self):
        for A,B in [(np.array([26.,-11.]),np.array([18.,17.])),(np.array([17.,-16.]),np.array([28.,9.]))]:
            E=.36*(np.outer(A,A)+np.outer(B,B));values,vectors=np.linalg.eigh(E)
            angle=np.degrees(np.arctan2(vectors[1,0],vectors[0,0]));detections=[dict(center=p,axes=np.sqrt(values).tolist(),angle=angle) for p in ([50.,50.],(np.array([50.,50.])+A).tolist())]
            camera=two_cap_camera(detections,20,12);self.assertTrue(camera['ok']);M=np.asarray(camera['matrix'])
            recovered=144*(np.outer(M[:,0],M[:,0])+np.outer(M[:,2],M[:,2]))
            self.assertTrue(np.allclose(recovered,E,atol=1e-8))
    def test_insufficient_caps_abstains(self):self.assertFalse(two_cap_camera([],20,12)['ok'])


if __name__=='__main__':unittest.main()
