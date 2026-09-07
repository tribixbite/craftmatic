"""Oracle-only test of candidate recall invariance under model gauge/order."""
from pathlib import Path
import json,numpy as np
from pose_score import read_parts
from placement_diagnose_pair_rank import to_items
from placement_diagnose_reachability import check
from placement_beam import assembly

if __name__=='__main__':
    truth=to_items(read_parts('C:/git/clego/lego_sets/OMR/40377-1.mpd'))
    pair=[p for p in truth if p[0] in ('99780','15571')];plates=[p for p in truth if p[0]=='2420']
    seed=to_items(read_parts('output/pdf-placement-beam/40377-registered-four-v1/beam_02.ldr'))
    G=seed[0][2]@np.linalg.inv(next(p for p in pair if p[0]=='99780')[2])
    rows=[];sets={}
    for name,frame in [('omr',np.eye(4)),('runtime',G)]:
        for reverse in [False,True]:
            ps=pair[::-1] if reverse else pair
            ps=[(p,c,frame@T) for p,c,T in ps]
            target1=frame@plates[1][2];target3=frame@plates[3][2]
            rows.append({'frame':name,'order':[p[0] for p in ps],'first':check(ps,target1),'second':check(ps+[('2420',15,target1)],target3)})
            for stage,items in [('pair',ps),('pair_plus_inner',ps+[('2420',15,target1)])]:
                raw=assembly(items).candidates('2420',kinds=('CYL','CLP','FGR','GEN'),check_collision=False,check_occlusion=False)
                canonical={tuple(np.round((np.linalg.inv(frame)@c['T']).reshape(-1),5)) for c in raw}
                sets[(name,reverse,stage)]=canonical
    comparisons=[]
    for stage in ['pair','pair_plus_inner']:
        baseline=sets[('omr',False,stage)]
        for (name,reverse,s),values in sets.items():
            if s!=stage:continue
            comparisons.append({'stage':stage,'frame':name,'reverse_order':reverse,'canonical_raw_transforms':len(values),'missing_vs_baseline':len(baseline-values),'extra_vs_baseline':len(values-baseline)})
    out=Path('output/pdf-placement-diagnosis/candidate-gauge-invariance.json');out.write_text(json.dumps({'target_checks':rows,'entire_raw_set_comparison':comparisons,'canonical_rounding_decimals':5},indent=2));print(out)
