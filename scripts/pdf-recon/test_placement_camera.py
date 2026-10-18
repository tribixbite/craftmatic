import unittest
import numpy as np
from placement_camera import infer_camera, infer_camera_robust, infer_camera_row


class CameraTests(unittest.TestCase):
    def test_single_row_ellipse_recovers_unseen_axis(self):
        for yaw in [32,57]:
            y,p=np.radians([yaw,33]);M=1.4*np.array([[np.cos(y),0,-np.sin(y)],[np.sin(y)*np.sin(p),np.cos(p),np.cos(y)*np.sin(p)]])
            E=144*M[:,[0,2]]@M[:,[0,2]].T;v,w=np.linalg.eigh(E);angle=np.degrees(np.arctan2(w[1,0],w[0,0]))
            pts=np.arange(4)[:,None]*20*M[:,0]+[80,70]
            detections=[{'center':c.tolist(),'axes':np.sqrt(v).tolist(),'angle':angle} for c in pts]
            inferred=infer_camera_row(detections);self.assertTrue(inferred['ok'],inferred)
            np.testing.assert_allclose(inferred['matrix'],M,atol=1e-6)
    def test_robust_grid_keeps_distractors_as_outliers(self):
        plane=np.array([[1.,-1.3],[.8,.6]])
        cov=144*plane@plane.T;values,vectors=np.linalg.eigh(cov)
        axes=np.sqrt(values);angle=np.degrees(np.arctan2(vectors[1,0],vectors[0,0]))
        xy=np.array([[0,0],[1,0],[2,0],[0,1],[1,1],[2,1]])@plane.T*20+[80,90]
        xy=np.concatenate((xy,[[13.1,22.9],[177.4,93.2],[50.7,190.3]]))
        detections=[{'center':p.tolist(),'axes':axes.tolist(),'angle':angle} for p in xy]
        result=infer_camera_robust(detections)
        self.assertTrue(result['ok'],result)
        self.assertEqual(result['inlier_indices'],list(range(6)))
        self.assertEqual(result['outlier_indices'],[6,7,8])
        np.testing.assert_allclose(np.asarray(result['matrix'])[:,[0,2]],plane,atol=.01)

    def test_robust_grid_separates_offset_plane(self):
        plane=np.array([[1.,-1.3],[.8,.6]])
        covariance=144*plane@plane.T
        values,vectors=np.linalg.eigh(covariance)
        angle=np.degrees(np.arctan2(vectors[1,0],vectors[0,0]))
        grid=np.array([[0,0],[1,0],[2,0],[0,1],[1,1],[2,1]])
        xy=grid@plane.T*20+[80,90]
        second=(grid[:3]+[.31,.27])@plane.T*20+[80,90]
        detections=[{'center':p.tolist(),'axes':np.sqrt(values).tolist(),'angle':angle} for p in np.concatenate((xy,second))]
        result=infer_camera_robust(detections)
        self.assertTrue(result['ok'],result)
        self.assertEqual(result['inlier_indices'],list(range(6)))
        self.assertEqual(result['outlier_indices'],[6,7,8])

    def test_insufficient_evidence_explicit(self):
        self.assertFalse(infer_camera([])['ok'])

    def test_asymmetric_orthographic_noisy_grid(self):
        rng=np.random.default_rng(72)
        for yaw,pitch in [(35,25),(48,32),(58,40)]:
            y,p=np.radians([yaw,pitch])
            M=np.array([[np.cos(y),0,-np.sin(y)],[np.sin(y)*np.sin(p),np.cos(p),np.cos(y)*np.sin(p)]])*1.4
            plane=M[:,[0,2]];cov=144*plane@plane.T
            values,vectors=np.linalg.eigh(cov)
            axes=np.sqrt(values);angle=np.degrees(np.arctan2(vectors[1,0],vectors[0,0]))
            points=np.array([[0,0],[1,0],[2,0],[0,1],[1,1],[2,1]])@plane.T*20+[90,130]
            points+=rng.normal(0,.08,points.shape)
            detections=[{'center':point.tolist(),'axes':axes.tolist(),'angle':angle} for point in points]
            result=infer_camera(detections)
            self.assertTrue(result['ok'],result)
            got=np.asarray(result['matrix'])
            np.testing.assert_allclose(got, M,atol=.025,rtol=0)
            np.testing.assert_allclose(got@got.T,np.eye(2)*np.trace(got@got.T)/2,atol=1e-8)


if __name__=='__main__':unittest.main()
