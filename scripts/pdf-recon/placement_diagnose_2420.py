"""Oracle-only candidate recall on independently verified truth prefix."""
import json
from pathlib import Path
import numpy as np
from pose_score import read_parts
from placement_diagnose_pair_rank import to_items
from placement_beam import assembly

if __name__=='__main__':
    truth=to_items(read_parts('C:/git/clego/lego_sets/OMR/40377-1.mpd')[:4])
    pairs=truth[:2];rows=[]
    for label,items,targets in [('after_pair',pairs,truth[2:4]),('after_first_2420',truth[:3],truth[3:4])]:
        asm=assembly(items)
        raw=asm.candidates('2420',kinds=('CYL','CLP','FGR','GEN'),check_collision=False,check_occlusion=False)
        for p,c,target in targets:
            exact=[(i,r) for i,r in enumerate(raw) if np.allclose(r['T'],target,atol=1e-4)]
            rows.append({'stage':label,'truth_target':target.tolist(),'raw_count':len(raw),'exact_indices':[i for i,r in exact],'exact_collision_rejected':[bool(asm.collides('2420',r['T'])) for i,r in exact],'truth_transform_collision':bool(asm.collides('2420',target)),'min_position_error':min(float(np.max(np.abs(r['T'][:3,3]-target[:3,3]))) for r in raw)})
    out=Path('output/pdf-placement-diagnosis/2420-candidate-recall.json')
    out.write_text(json.dumps({'scope':'Truth-state candidate recall ONLY, never end-to-end model accuracy or runtime truth input','results':rows},indent=2));print(out)
