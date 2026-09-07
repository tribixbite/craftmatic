"""Oracle-only first-pair pruning diagnosis, never called by reconstruction."""
from pathlib import Path
import json
import cv2
import numpy as np
import torch
import torch.nn.functional as F
from scipy.ndimage import distance_transform_edt
from placement_beam import rotations, assembly
from placement_gpu_render import SurfaceScorer
from pose_score import read_parts

OUT=Path('output/pdf-placement-diagnosis')
RUN=Path('output/pdf-placement-beam/40377-bootstrap-v2')


def to_items(parts):
    out=[]
    for part,color,p,R in parts:
        T=np.eye(4);T[:3,3]=p;T[:3,:3]=R;out.append((part,color,T))
    return out


def rendered(scorer,items):
    pts=scorer.fixed_points(items,np.asarray(items[0][2])[:3,3])
    px=pts@scorer.matrix.T
    lo,hi=px.amin(0),px.amax(0)
    px=((px-(lo+hi)/2)*(scorer.size-8)/(hi-lo).max()+(scorer.size-1)/2).round().long().clamp(0,scorer.size-1)
    image=torch.zeros(scorer.size*scorer.size,device=scorer.device)
    image.scatter_reduce_(0,px[:,1]*scorer.size+px[:,0],torch.ones(len(px),device=scorer.device),reduce='amax')
    return F.max_pool2d(image.reshape(1,1,scorer.size,scorer.size),3,1,1)[0,0].cpu().numpy()


if __name__=='__main__':
    truth=to_items(read_parts('C:/git/clego/lego_sets/OMR/40377-1.mpd'))
    anchor=next(p for p in truth if p[0]=='99780')[2]
    second=next(p for p in truth if p[0]=='15571')[2]
    relative=np.linalg.inv(anchor)@second
    scorer=SurfaceScorer(device='cuda')
    target=cv2.imread(str(RUN/'target_002.png'),0)/255
    scorer.target=torch.tensor(target,dtype=torch.float32,device=scorer.device)
    scorer.distance=torch.tensor(cv2.distanceTransform((1-target).astype(np.uint8),cv2.DIST_L2,3),device=scorer.device)
    rows=[]
    for orientation,first in enumerate(rotations()):
        items=[('99780',15,first)];asm=assembly(items)
        cs=asm.candidates('15571',kinds=('CYL','CLP','FGR','GEN'),check_collision=False,check_occlusion=False)
        scores=scorer.score(items,'15571',[c['T'] for c in cs])
        expected=first@relative
        for c,score in zip(cs,scores):
            if asm.collides('15571',c['T']):continue
            rows.append({'score':float(score),'exact_relative_truth':bool(np.allclose(c['T'],expected,atol=1e-4)),'root_orientation':orientation,'T':c['T'].tolist()})
    rows.sort(key=lambda r:-r['score'])
    correct=[{'rank':i+1,**row} for i,row in enumerate(rows) if row['exact_relative_truth']]
    # Prefix rendering scored under each global frame is explicitly oracle evaluation.
    comparisons=[];images=[target]
    for label,items in [('truth_first4',truth[:4]),('truth_first6',truth[:6]),('selected_first4',to_items(read_parts(RUN/'model.ldr'))[:4]),('selected_first6',to_items(read_parts(RUN/'model.ldr')))]:
        best=None
        for G in rotations():
            transformed=[(p,c,G@T) for p,c,T in items]
            score=float(scorer.score(transformed[:-1],transformed[-1][0],[transformed[-1][2]])[0])
            if best is None or score>best[0]:best=(score,transformed)
        comparisons.append({'label':label,'best_score_over24_global_frames':best[0]})
        images.append(rendered(scorer,best[1]))
    canvas=np.full((110,80*len(images)),255,np.uint8)
    for i,(label,image) in enumerate(zip(['target',*[r['label'] for r in comparisons]],images)):
        canvas[:80,i*80:(i+1)*80]=255-(image*255).astype(np.uint8)
        cv2.putText(canvas,label.replace('first','')[:16],(i*80,96),cv2.FONT_HERSHEY_SIMPLEX,.24,0,1)
    cv2.imwrite(str(OUT/'first-prefix-surface-comparison.png'),canvas)
    report={'scope':'Oracle evaluation only; no truth-fed runtime selection','legal_candidates':len(rows),'correct_pair_ranks':correct,'top_candidates':rows[:6],'prefix_comparisons':comparisons}
    (OUT/'first-pair-ranks.json').write_text(json.dumps(report,indent=2))
    print(OUT/'first-pair-ranks.json')
