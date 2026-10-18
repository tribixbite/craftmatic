"""PDF-allocated same-shape mixed-color pose registry and bounded closure.

No reference models. Never equates a bounded connector closure with exhaustive
pose recall. The registry is reusable by fixed-registration cardinality search.
"""
import argparse,hashlib,json,time
from collections import Counter
from pathlib import Path
import numpy as np
from placement_attach_group import make_assembly
from placement_arrow_contacts import read_items
from placement_pdf_group_evidence import load_allocations


def registry(base,part,closure_rounds=1,max_closure_parents=32,max_poses=4096):
    started=time.perf_counter();assembly=make_assembly(base);poses=[];lookup={};edges=set();anchored=set()
    def add(T):
        key=tuple(np.round(np.asarray(T).flatten(),5))
        if key in lookup:return lookup[key]
        lookup[key]=len(poses);poses.append(np.asarray(T).copy());return len(poses)-1
    # Complete native base-attached candidates under explicitly stated engine
    # settings; no image pruning, even when this exceeds the closure budget.
    initial=assembly.candidates(part,kinds=('CYL','CLP','FGR','GEN'),check_collision=True,check_occlusion=False)
    for candidate in initial:anchored.add(add(candidate['T']))
    base_count=len(poses);single=make_assembly([(part,15,np.eye(4))])
    relative=single.candidates(part,kinds=('CYL','CLP','FGR','GEN'),check_collision=True,check_occlusion=False)
    frontier=list(range(len(poses)));processed=0;limited=False;rounds_done=0
    for _ in range(closure_rounds):
        next_frontier=[]
        for parent in frontier:
            if processed>=max_closure_parents:limited=True;break
            processed+=1
            for candidate in relative:
                T=poses[parent]@candidate['T'];key=tuple(np.round(T.flatten(),5))
                existing=lookup.get(key)
                if existing is not None:
                    if existing!=parent:edges.add(tuple(sorted((parent,existing))))
                    continue
                if len(poses)>=max_poses:limited=True;continue
                if assembly.collides(part,T):continue
                child=add(T);next_frontier.append(child);edges.add(tuple(sorted((parent,child))))
        rounds_done+=1
        if limited:break
        frontier=next_frontier
        if not frontier:break
    return dict(part=part,poses=[T.tolist() for T in poses],base_supported=sorted(anchored),support_edges=sorted(edges),
        base_attached_count=base_count,native_base_candidate_count=len(initial),relative_candidate_count=len(relative),
        closure_parents_processed=processed,closure_rounds_completed=rounds_done,closure_budget_hit=limited,
        closure_exhaustive=False,seconds=time.perf_counter()-started,truth_used=False,
        candidate_settings=dict(kinds=['CYL','CLP','FGR','GEN'],check_collision=True,check_occlusion=False,with_slide=False),
        limitations='Bounded one-parent connector closure; not complete multi-part occupancy/connectivity search. Native voxel collision, no sliding candidates. Support graph is witnessed, not proven complete: disconnected subsets may be false negatives. Base-attached candidates retained without image pruning.')


def color_bank(record,pieces):
    colors=sorted(set(c for p,c in pieces));quotas=Counter(c for p,c in pieces);placements=[]
    for pose_index,T in enumerate(record['poses']):
        for color in colors:placements.append(dict(items=[(record['part'],color,np.asarray(T))],pose_index=pose_index,color=color))
    return placements,dict(quotas)


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--pdf',required=True,type=Path);p.add_argument('--page',required=True,type=int);p.add_argument('--allocation-run',required=True,type=Path);p.add_argument('--base-run',required=True,type=Path);p.add_argument('--out',required=True,type=Path);p.add_argument('--closure-rounds',type=int,default=1);p.add_argument('--max-closure-parents',type=int,default=32);p.add_argument('--max-poses',type=int,default=4096);args=p.parse_args()
    pieces,provenance=load_allocations(args.pdf,args.page,args.allocation_run)
    if len(set(p for p,c in pieces))!=1:raise ValueError('This registry supports one CAD shape with optional multiple colors')
    metadata=json.loads((args.base_run/'results.json').read_text());path=args.base_run/'model.ldr'
    if metadata.get('truth_used') is not False or metadata.get('runtime_vlm_calls')!=0 or metadata.get('pdf_sha256')!=provenance['pdf_sha256']:raise ValueError('Existing-body provenance mismatch')
    result=registry(read_items(path),pieces[0][0],args.closure_rounds,args.max_closure_parents,args.max_poses)
    result.update(provenance,pdf=str(args.pdf),page=args.page,base_source=str(path),base_sha256=hashlib.sha256(path.read_bytes()).hexdigest(),allocated_pieces=pieces,runtime_vlm_calls=0)
    args.out.parent.mkdir(parents=True,exist_ok=True);args.out.write_text(json.dumps(result,indent=2))
    print(json.dumps({k:v for k,v in result.items() if k not in ('poses','support_edges','base_supported','allocation_evidence')}))
