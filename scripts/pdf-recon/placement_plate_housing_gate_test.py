"""Universal plate stacks, side contacts, and cached crossing controls."""
import argparse
import json
from pathlib import Path
import numpy as np
from placement_plate_housing_gate import PlateHousingGate,has_proper_crossing
from placement_mesh_overlap_audit import mesh,proper_surface_crossings
from placement_arrow_contacts import transformed_connectors,read_items
from placement_beam import assembly


def run(runtime,out):
    out.mkdir(parents=True,exist_ok=True);gate=PlateHousingGate();records=[]
    for basepart,smallpart in [('3031','3023b'),('3020','3023b'),('3031','3020')]:
        base=[(basepart,4,np.eye(4))];candidates=assembly(base).candidates(smallpart,check_collision=True,check_occlusion=False)
        legal=[c for c in candidates if np.allclose(c['T'][:3,:3],np.eye(3)) and c['T'][1,3]<0]
        # Spatially separated placements exercise center, edge, and offset
        # multi-stud mating cases without importing any set layout.
        indices=sorted(set(np.linspace(0,len(legal)-1,min(4,len(legal))).astype(int)))
        for i in indices:
            pair=base+[(smallpart,4,legal[i]['T'])];a,b=[mesh(p,gate.library) for p in pair]
            exact=proper_surface_crossings(a,b);fast=has_proper_crossing(a,b)
            assert fast==(exact['unique_crossing_points']>0)
            records.append(dict(kind='upright_universal_mate',parts=[basepart,smallpart],T=legal[i]['T'].tolist(),
                crossing=fast,gate_pass=gate.check(pair)))
    # Side attachment is evaluated as a control, but intentionally outside
    # the gate's thin-plate-pair scope.
    base=[('4070',4,np.eye(4))];targets=[c for c in transformed_connectors('4070',np.eye(4),'M') if abs(c['axis'][1])<.1 and c['radius']==6]
    side=[]
    for candidate in assembly(base).candidates('3023b',check_collision=True,check_occlusion=False):
        T=candidate['T'];females=transformed_connectors('3023b',T,'F')
        if any(np.linalg.norm(f['pos']-m['pos'])<1e-5 and np.dot(f['axis'],m['axis'])>.999 for f in females for m in targets):side.append(candidate)
    assert side
    for candidate in side[:2]:
        pair=base+[('3023b',4,candidate['T'])];a,b=[mesh(p,gate.library) for p in pair]
        records.append(dict(kind='universal_side_mate_outside_gate_scope',parts=['4070','3023b'],
            crossing=has_proper_crossing(a,b),gate_pass=gate.check(pair),T=candidate['T'].tolist()))
    selected=read_items(runtime/'model.ldr')[:2];assert not gate.check(selected)
    before=len(gate.cache);assert not gate.check(selected) and len(gate.cache)==before
    G=np.eye(4);G[:3,:3]=np.array([[0,0,1],[0,1,0],[-1,0,0]]);G[:3,3]=[31,17,-23]
    assert not gate.check([(p,c,G@T) for p,c,T in selected]) and len(gate.cache)==before
    result=dict(controls=records,selected_runtime_pair_rejected=True,cache_repeat_and_global_frame_invariant=True,
        gate=gate.evidence(),truth_used=False,baseline_unchanged=True)
    (out/'results.json').write_text(json.dumps(result,indent=2));print(json.dumps(records));print(gate.evidence()['eligible'])
    assert all(not r['crossing'] and r['gate_pass'] for r in records if r['kind']=='upright_universal_mate')


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--runtime',type=Path,required=True);p.add_argument('--out',type=Path,required=True);a=p.parse_args();run(a.runtime,a.out)
