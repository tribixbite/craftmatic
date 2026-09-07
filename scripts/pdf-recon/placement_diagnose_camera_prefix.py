"""Evaluation-only true/wrong prefix rendering under PDF-inferred camera."""
from pathlib import Path
import json
import cv2
import numpy as np
import torch
from pose_score import read_parts
from placement_beam import rotations
from placement_gpu_render import SurfaceScorer
from placement_diagnose_pair_rank import to_items,rendered

if __name__=='__main__':
    out=Path('output/pdf-placement-diagnosis')
    run=Path('output/pdf-placement-beam/40377-camera-bootstrap-v1')
    camera=json.loads((out/'studs/cameras.json').read_text())[-1]['camera']['matrix']
    scorer=SurfaceScorer(device='cuda',projection=camera)
    target=cv2.imread(str(run/'target_002.png'),0)/255
    scorer.target=torch.tensor(target,dtype=torch.float32,device='cuda')
    scorer.distance=torch.tensor(cv2.distanceTransform((1-target).astype(np.uint8),cv2.DIST_L2,3),device='cuda')
    rows=[];images=[target]
    for label,parts in [('truth4',read_parts('C:/git/clego/lego_sets/OMR/40377-1.mpd')[:4]),('selected4',read_parts(run/'page_002_beams/beam_00.ldr'))]:
        best=None
        for G in rotations():
            items=[(p,c,G@T) for p,c,T in to_items(parts)]
            score=float(scorer.score(items[:-1],items[-1][0],[items[-1][2]])[0])
            if best is None or score>best[0]:best=(score,items,G)
        rows.append({'label':label,'best_score_over24':best[0],'best_global_frame':best[2].tolist()})
        images.append(rendered(scorer,best[1]))
    canvas=np.full((105,240),255,np.uint8)
    for i,(label,im) in enumerate(zip(['target','truth4','selected4'],images)):
        canvas[:80,i*80:(i+1)*80]=255-(im*255).astype(np.uint8)
        cv2.putText(canvas,label,(i*80,96),cv2.FONT_HERSHEY_SIMPLEX,.3,0,1)
    cv2.imwrite(str(out/'camera-prefix-comparison.png'),canvas)
    (out/'camera-prefix-comparison.json').write_text(json.dumps({'scope':'Oracle evaluation only; camera is PDF-derived; truth used after reconstruction','projection':camera,'comparisons':rows},indent=2))
