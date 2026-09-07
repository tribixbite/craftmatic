"""Synthetic universal-geometry checks, no real-set poses or training."""
from pathlib import Path
import json
import unittest
import cv2
import numpy as np
import torch
from placement_gpu_render import SurfaceScorer, part_points

OUT=Path('output/pdf-placement-diagnosis')
MEASUREMENTS={}


def transform(x=0,y=0,z=0):
    T=np.eye(4);T[:3,3]=[x,y,z]
    return T


def synthetic_mask(parts):
    """Independent CPU projection of full surface samples at 2 px/LDU."""
    projected=[]
    for part,T in parts:
        points=np.asarray(part_points(part),dtype=float)@T[:3,:3].T+T[:3,3]
        projected.append(np.column_stack((points[:,0]-points[:,2], .5*points[:,0]+points[:,1]+.5*points[:,2])))
    xy=np.concatenate(projected)*2
    xy=np.rint(xy-xy.min(0)+12).astype(int)
    image=np.zeros((xy[:,1].max()+13,xy[:,0].max()+13),np.uint8)
    image[xy[:,1],xy[:,0]]=1
    # Sample spacing is 4 LDU; a 9-pixel close fills its projected gaps.
    return cv2.morphologyEx(image,cv2.MORPH_CLOSE,np.ones((9,9),np.uint8))


class SurfaceScorerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(2)
        cls.cpu=SurfaceScorer(device='cpu')
        cls.gpu=SurfaceScorer(device='cuda') if torch.cuda.is_available() else None
        cls.base=[('3001',4,transform())]
        cls.ts=[transform(y=-24),transform(x=200),transform(z=160),transform(y=-80)]
        cls.mask=synthetic_mask([('3001',transform()),('3001',cls.ts[0])])
        OUT.mkdir(parents=True,exist_ok=True)
        cv2.imwrite(str(OUT/'synthetic-stacked.png'),cls.mask*255)
        cls.cpu.scene(cls.mask)
        cls.scores=cls.cpu.score(cls.base,'3001',cls.ts)
        MEASUREMENTS['cpu_scores']=cls.scores.tolist()

    def test_stacked_layout_beats_separated_layouts(self):
        self.assertEqual(int(np.argmax(self.scores)),0)
        self.assertGreater(self.scores[0]-max(self.scores[1:]),.03)

    def test_unknown_pixels_neither_reward_nor_penalize_geometry(self):
        unknown=np.zeros_like(self.mask)
        h,w=unknown.shape
        unknown[h//3:2*h//3,w//3:2*w//3]=1
        erased=self.mask.copy();erased[unknown>0]=0
        scorers=[SurfaceScorer(device='cpu') for _ in range(2)]
        scores=[]
        for scorer,mask in zip(scorers,[self.mask,erased]):
            scorer.scene(mask,unknown=unknown)
            scores.append(scorer.score(self.base,'3001',self.ts))
        np.testing.assert_allclose(scores[0],scores[1],atol=1e-7,rtol=0)

    def test_candidate_order_does_not_change_scores(self):
        order=[2,0,3,1]
        actual=self.cpu.score(self.base,'3001',[self.ts[i] for i in order],batch_size=2)
        np.testing.assert_allclose(actual,self.scores[order],atol=1e-7,rtol=0)

    def test_common_world_translation_preserves_scores(self):
        shift=np.array([100.,-80.,200.])
        base=[('3001',4,transform(*shift))]
        ts=[]
        for T in self.ts:
            shifted=T.copy();shifted[:3,3]+=shift;ts.append(shifted)
        actual=self.cpu.score(base,'3001',ts)
        MEASUREMENTS['translated_scores']=actual.tolist()
        np.testing.assert_allclose(actual,self.scores,atol=1e-6,rtol=0)

    def test_target_translation_and_resolution_preserve_ranking(self):
        enlarged=cv2.resize(self.mask,None,fx=2,fy=2,interpolation=cv2.INTER_NEAREST)
        enlarged=np.pad(enlarged,((43,12),(19,60)))
        scorer=SurfaceScorer(device='cpu');scorer.scene(enlarged)
        actual=scorer.score(self.base,'3001',self.ts)
        MEASUREMENTS['scaled_target_scores']=actual.tolist()
        self.assertEqual(int(np.argmax(actual)),0)
        np.testing.assert_allclose(actual,self.scores,atol=.02,rtol=0)

    def test_cpu_gpu_and_repeat_agree(self):
        if self.gpu is None:self.skipTest('CUDA unavailable')
        self.gpu.scene(self.mask)
        first=self.gpu.score(self.base,'3001',self.ts)
        second=self.gpu.score(self.base,'3001',self.ts)
        MEASUREMENTS['gpu_scores']=first.tolist()
        MEASUREMENTS['gpu_repeat_max_difference']=float(np.max(np.abs(first-second)))
        MEASUREMENTS['cpu_gpu_max_difference']=float(np.max(np.abs(first-self.scores)))
        MEASUREMENTS['cuda_peak_allocated_bytes']=torch.cuda.max_memory_allocated()
        np.testing.assert_array_equal(first,second)
        np.testing.assert_allclose(first,self.scores,atol=1e-6,rtol=0)

    def test_fixed_registration_does_not_refit_wrong_world_positions(self):
        matrix=2*np.array([[1.,0.,-1.],[.5,1.,.5]])
        world=np.concatenate([np.asarray(part_points('3001')),
                              np.asarray(part_points('3001'))+self.ts[0][:3,3]])
        origin=12-(world@matrix.T).min(0)
        scorer=SurfaceScorer(device='cpu',projection=matrix)
        scorer.scene(self.mask);scorer.registration=origin
        correct=float(scorer.score(self.base,'3001',[self.ts[0]])[0])
        shift=np.array([100.,-80.,200.])
        shifted=self.ts[0].copy();shifted[:3,3]+=shift
        base=[('3001',4,transform(*shift))]
        wrong=float(scorer.score(base,'3001',[shifted])[0])
        scorer.registration=origin-matrix@shift
        compensated=float(scorer.score(base,'3001',[shifted])[0])
        self.assertGreater(correct,.5)
        self.assertLess(wrong,.01)
        self.assertAlmostEqual(correct,compensated,places=6)

    def test_positive_stud_constraints_agree_across_devices(self):
        matrix=2*np.array([[1.,0.,-1.],[.5,1.,.5]])
        world=np.concatenate([np.asarray(part_points('3001')),
                              np.asarray(part_points('3001'))+self.ts[0][:3,3]])
        origin=12-(world@matrix.T).min(0)
        # Independently specified 2x4 top stud caps of the upper brick.
        caps=np.array([[x,-28,z] for x in (-30,-10,10,30) for z in (-10,10)])
        observations=[{'center':p.tolist()} for p in caps@matrix.T+origin]
        cpu=SurfaceScorer(device='cpu',projection=matrix,stud_weight=.5)
        cpu.scene(self.mask,observations);cpu.registration=origin
        first=cpu.score(self.base,'3001',self.ts)
        self.assertEqual(int(np.argmax(first)),0)
        cpu.stud_weight=0
        baseline=cpu.score(self.base,'3001',self.ts)
        self.assertGreater(first[0]-baseline[0],.3)
        if self.gpu is not None:
            gpu=SurfaceScorer(device='cuda',projection=matrix,stud_weight=.5)
            gpu.scene(self.mask,observations);gpu.registration=origin
            second=gpu.score(self.base,'3001',self.ts)
            np.testing.assert_allclose(second,first,atol=2e-5,rtol=0)
            np.testing.assert_array_equal(second,gpu.score(self.base,'3001',self.ts))


if __name__=='__main__':
    suite=unittest.defaultTestLoader.loadTestsFromTestCase(SurfaceScorerTests)
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    MEASUREMENTS.update(scope='Synthetic universal-part geometry only; not model accuracy or training',tests_run=result.testsRun,failures=len(result.failures),errors=len(result.errors),skipped=len(result.skipped))
    OUT.mkdir(parents=True,exist_ok=True)
    (OUT/'gpu-render-tests.json').write_text(json.dumps(MEASUREMENTS,indent=2))
    raise SystemExit(not result.wasSuccessful())
