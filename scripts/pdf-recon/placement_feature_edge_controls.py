"""Universal-part synthetic orientation controls for fixed equal edge/color weight."""
from pathlib import Path
import json
import cv2,numpy as np
from placement_colored_cad import nativecolor_render
from placement_feature_edges import FeatureEdgeScorer
from placement_part_edges import canonical,features,compare

if __name__=='__main__':
    out=Path('output/pdf-placement-diagnosis/feature-edge-controls');out.mkdir(exist_ok=True);records=[]
    M=np.array([[1.35,0,-.9],[.55,1.34,.82]])
    for part in ('3023b','11476'):
        R=np.eye(4);rendered=nativecolor_render([(part,15,R)],M,out/f'{part}-seed.png')
        source=FeatureEdgeScorer(dict(rgb=rendered['rgb'],mask=rendered['mask']));source.score([(part,15,R)],M)
        # Slight blur separates the input image from exact raster pixels.
        targetrgb=cv2.GaussianBlur(source.last_outline,(3,3),.45);targetmask=source.last_mask.copy()
        scorer=FeatureEdgeScorer(dict(rgb=targetrgb,mask=targetmask));target=features(*canonical(targetrgb,targetmask));scores=[]
        for name,rotation in [('upright',np.eye(3)),('underside',np.diag([-1.,-1.,1.]))]:
            T=np.eye(4);T[:3,:3]=rotation;ev=scorer.score([(part,15,T)],M,out/f'{part}-{name}.png')
            edge,_=compare(features(*canonical(scorer.last_outline,scorer.last_mask)),target);scores.append(dict(name=name,balanced=ev['score'],edge=float(edge),equal_weight_score=.5*(ev['score']+edge)))
        records.append(dict(part=part,scores=scores));assert scores[0]['equal_weight_score']>scores[1]['equal_weight_score']
    result=dict(truth_used=False,scope='Universal CAD synthetic known orientations only; no set-specific training or pose truth',edge_weight=.5,records=records)
    (out/'results.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
