"""Oracle-only ordered repeated-part candidate reachability audit."""
import itertools,json
from pathlib import Path
import numpy as np
from pose_score import read_parts
from placement_diagnose_pair_rank import to_items
from placement_beam import assembly

def check(items,target):
    asm=assembly(items)
    candidates=asm.candidates('2420',kinds=('CYL','CLP','FGR','GEN'),check_collision=False,check_occlusion=False)
    distances=[float(np.max(np.abs(c['T']-target))) for c in candidates]
    indices=[i for i,d in enumerate(distances) if d<1e-4]
    nearest=int(np.argmin(distances)) if distances else None
    return {'raw':len(candidates),'exact_indices':indices,'target_collides':bool(asm.collides('2420',target)),'exact_collision_rejected':[bool(asm.collides('2420',candidates[i]['T'])) for i in indices],'closest_max_transform_error':distances[nearest] if nearest is not None else None,'closest_transform':candidates[nearest]['T'].tolist() if nearest is not None else None}

if __name__=='__main__':
    truth=to_items(read_parts('C:/git/clego/lego_sets/OMR/40377-1.mpd'))
    pair=[p for p in truth if p[0] in ('99780','15571')];plates=[p for p in truth if p[0]=='2420']
    rows=[]
    for i,j in itertools.permutations(range(4),2):
        rows.append({'ordered_indices':[i,j],'first':check(pair,plates[i][2]),'second':check(pair+[plates[i]],plates[j][2])})
    out=Path('output/pdf-placement-diagnosis/ordered-2420-reachability.json')
    out.write_text(json.dumps({'scope':'Oracle reachability only; OMR never supplies runtime choices','results':rows},indent=2));print(out)
