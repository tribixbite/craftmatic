"""Post-hoc direct-step output and mating diagnostics, no truth selection."""
from pathlib import Path
import json
import numpy as np
from pose_score import read_parts,score
from placement_diagnose_pair_rank import to_items
from placement_beam import assembly

if __name__=='__main__':
    run=Path('output/pdf-placement-vector/exploded-step');truth=read_parts('C:/git/clego/lego_sets/OMR/40377-1.mpd');rows=[]
    for path in sorted(run.glob('proposal_*.ldr')):
        parts=read_parts(path);rows.append({'file':path.name,'score':score(parts,truth),'stable_five_score':score(parts[:5],truth)})
    selected=to_items(read_parts(run/'proposal_000.ldr'));asm=assembly(selected[:5]);bad=selected[5][2]
    ta=next(p for p in to_items(truth) if p[0]=='99780')[2];G=selected[0][2]@np.linalg.inv(ta)
    trueplates=[G@p[2] for p in to_items(truth) if p[0]=='2420']
    missing=next(T for T in trueplates if not any(np.allclose(T,p[2]) for p in selected[:5] if p[0]=='2420'))
    candidates=asm.candidates('2420',check_collision=True,check_occlusion=False)
    mating=[]
    for label,target in [('selected_wrong',bad),('correct_missing',missing)]:
        matches=[c for c in candidates if np.allclose(c['T'],target,atol=1e-4)]
        info={'label':label,'transform':target.tolist(),'collision_overlap':list(map(float,asm.collision('2420',target))),'matches':[]}
        for c in matches:
            wc,cp=c['a'],c['b'];axis=target[:3,:3]@np.asarray(cp['axis']);pos=target[:3,:3]@np.asarray(cp['pos'])+target[:3,3]
            info['matches'].append({'owner':int(wc.owner),'fixed_gender':wc.gender,'moving_gender':cp['gender'],'fixed_axis':np.asarray(wc.axis).tolist(),'moving_axis':axis.tolist(),'axis_dot':float(np.dot(axis,wc.axis)),'connector_distance':float(np.linalg.norm(pos-wc.pos)),'fixed_position':np.asarray(wc.pos).tolist(),'moving_position':pos.tolist()})
        mating.append(info)
    result={'scope':'Independent full-truth evaluation only; contact scores describe engine legality, not physical certification','selected':rows[0],'oracle_best':max(rows,key=lambda r:r['score']['matched']),'full_correct_proposal_ranks':[i+1 for i,r in enumerate(rows) if r['score']['matched']==6],'results':rows,'mating':mating}
    out=Path('output/pdf-placement-diagnosis/direct-output-evaluation.json');out.write_text(json.dumps(result,indent=2));print(out)
