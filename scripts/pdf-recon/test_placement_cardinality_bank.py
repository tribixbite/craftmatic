import json
import unittest
from pathlib import Path
import numpy as np
from placement_cardinality_bank import build_bank
from placement_colored_cad import nativecolor_render
from placement_material_scene_score import MaterialFeatureSceneScorer
from placement_occupancy_screen import screen
from placement_mixed_batch_search import fixed_native_score


class BankTests(unittest.TestCase):
    def test_joint_two_plus_one_matches_cached_depth_composition(self):
        out=Path('output/pdf-placement-diagnosis/cardinality-bank-tests');out.mkdir(exist_ok=True)
        I=np.eye(4);T=np.eye(4);T[:3,3]=[0,-24,0];U=T.copy();U[1,3]=-32
        base=[('3001',1,I),('3001',1,T)];new=[('3020',15,U)]
        M=np.array([[.7,0,-.7],[.35,.7,.35]])
        scene=nativecolor_render(base+new,M,out/'source.png');scorer=MaterialFeatureSceneScorer(scene,plane_depth=True)
        separate=build_bank(base,[dict(items=new)],M,scene['image_origin'],scorer)
        joint=build_bank(base+new,[dict(items=new)],M,scene['image_origin'],scorer)
        d=separate['base_depth'].copy();l=separate['base_labels'].copy();take=np.isfinite(separate['depths'][0])&(separate['depths'][0]>=d)
        d[take]=separate['depths'][0][take];l[take]=separate['labels'][0][take]
        self.assertTrue(np.array_equal(d,joint['base_depth']));self.assertTrue(np.array_equal(l,joint['base_labels']))
        with self.assertRaises(ValueError):build_bank(base,[dict(items=new)],M,scene['image_origin'],scorer,max_host_bytes=1)
        (out/'results.json').write_text(json.dumps(dict(depth_exact=True,material_exact=True,budget_rejection=True,truth_used=False,metadata=separate['metadata']),indent=2))

    def test_occupied_union_rejects_outside_without_requiring_visible_color(self):
        out=Path('output/pdf-placement-diagnosis/cardinality-bank-tests');out.mkdir(exist_ok=True)
        base=[('3001',1,np.eye(4))];T=np.eye(4);T[1,3]=-8;good=[('3020',15,T)]
        far=T.copy();far[0,3]=200;M=np.array([[.7,0,-.7],[.35,.7,.35]])
        scene=nativecolor_render(base+good,M,out/'occupancy-source.png');scorer=MaterialFeatureSceneScorer(scene,plane_depth=True)
        result=screen(base,[dict(items=good),dict(items=[('3020',15,far)]),dict(items=base)],M,scene['image_origin'],scorer)
        self.assertTrue(result['registration_consistent']);self.assertEqual(result['retained_indices'],[0,2])
        self.assertGreater(result['candidates'][1]['outside_pixels'],0)
        (out/'occupancy.json').write_text(json.dumps(result,indent=2))

    def test_fixed_native_score_png_preserves_origin_and_restores_scorer(self):
        out=Path('output/pdf-placement-diagnosis/cardinality-bank-tests');out.mkdir(exist_ok=True)
        items=[('3001',1,np.eye(4))];M=np.array([[.7,0,-.7],[.35,.7,.35]])
        scene=nativecolor_render(items,M,out/'fixed-source.png');scorer=MaterialFeatureSceneScorer(scene,plane_depth=True)
        center=scorer.target_center.copy();origin=np.asarray(scene['image_origin'])+np.array([2.,-1.])
        first=fixed_native_score(scorer,items,M,origin,out/'fixed-selected.png');image=scorer.last_outline.copy()
        second=fixed_native_score(scorer,items,M,origin)
        self.assertEqual(first,second);self.assertTrue(np.array_equal(image,scorer.last_outline));self.assertTrue(np.array_equal(scorer.target_center,center));self.assertTrue(np.allclose(first['image_origin'],origin))


if __name__=='__main__':unittest.main()
