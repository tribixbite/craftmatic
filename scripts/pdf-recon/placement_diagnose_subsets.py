"""Oracle-only authored-order ambiguity audit for repeated parts."""
import itertools,json
from pathlib import Path
import cv2
import numpy as np
import torch
from pose_score import read_parts
from placement_beam import rotations
from placement_gpu_render import SurfaceScorer
from placement_diagnose_pair_rank import to_items,rendered

if __name__=='__main__':
    out=Path('output/pdf-placement-diagnosis');run=Path('output/pdf-placement-beam/40377-camera-bootstrap-v1')
    truth=to_items(read_parts('C:/git/clego/lego_sets/OMR/40377-1.mpd'))
    pair=[p for p in truth if p[0] in ('99780','15571')];plates=[p for p in truth if p[0]=='2420']
    if len(plates)!=4:raise ValueError('Expected exactly four distinct truth instances')
    M=json.loads((out/'studs/cameras.json').read_text())[-1]['camera']['matrix']
    scorer=SurfaceScorer(device='cuda',projection=M)
    target=cv2.imread(str(run/'target_002.png'),0)/255
    scorer.target=torch.tensor(target,dtype=torch.float32,device='cuda')
    scorer.distance=torch.tensor(cv2.distanceTransform((1-target).astype(np.uint8),cv2.DIST_L2,3),device='cuda')
    rows=[];images=[target]
    for n in [1,2]:
        group=[]
        for subset in itertools.combinations(range(4),n):
            items=pair+[plates[i] for i in subset];best=None
            for G in rotations():
                moved=[(p,c,G@T) for p,c,T in items]
                score=float(scorer.score(moved[:-1],moved[-1][0],[moved[-1][2]])[0])
                if best is None or score>best[0]:best=(score,moved,G)
            record={'plate_indices':list(subset),'positions':[plates[i][2][:3,3].tolist() for i in subset],'score':best[0],'global_frame':best[2].tolist()}
            group.append((record,best[1]))
        group.sort(key=lambda p:-p[0]['score'])
        rows.append({'parts':2+n,'best':group[0][0],'subsets':[r for r,_ in group]})
        images.append(rendered(scorer,group[0][1]))
    canvas=np.full((105,240),255,np.uint8)
    for i,(label,im) in enumerate(zip(['target','best3','best4'],images)):
        canvas[:80,i*80:(i+1)*80]=255-(im*255).astype(np.uint8)
        cv2.putText(canvas,label,(i*80,96),cv2.FONT_HERSHEY_SIMPLEX,.3,0,1)
    cv2.imwrite(str(out/'oracle-subset-comparison.png'),canvas)
    (out/'oracle-subset-comparison.json').write_text(json.dumps({'scope':'Oracle only: any subset of the four independently authored OMR 2420 instances; no assumption that OMR step order matches PDF','results':rows},indent=2))
