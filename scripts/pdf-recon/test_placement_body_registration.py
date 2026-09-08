import json,unittest
from pathlib import Path
import numpy as np
from placement_body_registration import register
from placement_colored_cad import nativecolor_render,_rgb
from placement_part_library import PartLibrary
from placement_palette_classes import palette_labels


class BodyRegistrationTests(unittest.TestCase):
    def test_known_visible_red_print_cannot_disappear_from_scoring(self):
        out=Path('output/pdf-placement-diagnosis/body-registration-controls');out.mkdir(exist_ok=True)
        M=np.array([[1.,0,-1.],[.5,1.,.5]])*1.5;T=np.eye(4);items=[('3245cpb117',1,T)]
        scene=nativecolor_render(items,M,out/'source.png',resolver=PartLibrary().resolve)
        target,_=palette_labels(scene['rgb'],scene['mask'],np.asarray([_rgb(1),_rgb(4)],np.uint8))
        if int((target==2).sum())<8:
            T[:3,:3]=np.diag([-1.,1.,-1.]);scene=nativecolor_render(items,M,out/'source.png',resolver=PartLibrary().resolve)
            target,_=palette_labels(scene['rgb'],scene['mask'],np.asarray([_rgb(1),_rgb(4)],np.uint8))
        self.assertGreaterEqual(int((target==2).sum()),8)
        result=register(scene,items,M)
        invisible=[r for r in result['hypotheses'] if r['source_material_pixels'].get('4',0)<8]
        self.assertTrue(invisible);self.assertLessEqual(max(r['score'] for r in invisible),.500001)
        self.assertGreater(result['hypotheses'][0]['source_material_pixels']['4'],8)
        (out/'results.json').write_text(json.dumps(dict(target_red_pixels=int((target==2).sum()),max_hidden_red_score=max(r['score'] for r in invisible),best=result['hypotheses'][0],truth_used=False),indent=2))


if __name__=='__main__':unittest.main()
