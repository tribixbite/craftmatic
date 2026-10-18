"""Count runtime-derived whole-group candidates before expensive pair images."""
import json,time
from pathlib import Path
from placement_attach_group import make_assembly,group_transforms
from placement_arrow_contacts import read_items

if __name__=='__main__':
    basepath=Path('output/pdf-placement-beam/40377-gpu-thirteen-v1/model.ldr');grouppath=Path('output/pdf-placement-diagnosis/allocated-pair-page7/group_000.ldr')
    solids={'3010pb291':'3010'};base=make_assembly(read_items(basepath),solids);group=read_items(grouppath);cache={};count=0;legal=0;start=time.time();placements=[]
    for G,anchor in group_transforms(base,group,cache,solids,True):
        count+=1
        if not any(base.collides(solids.get(p,p),G@T) for p,c,T in group):
            legal+=1;placements.append(dict(anchor_index=anchor,items=[(p,c,(G@T).tolist()) for p,c,T in group]))
    result=dict(truth_used=False,base=str(basepath),group=str(grouppath),member_candidate_counts={p:len(v) for p,v in cache.items()},unique_group_transforms=count,whole_group_legal=legal,unordered_pairs_before_paircollision=legal*(legal-1)//2,views24_total_before_paircollision=12*legal*(legal-1),seconds=time.time()-start)
    out=Path('output/pdf-placement-diagnosis/page7-pair-preflight.json');out.write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
    import hashlib
    cache_record=dict(truth_used=False,runtime_vlm_calls=0,pdf_sha256=json.loads(grouppath.with_name('results.json').read_text())['pdf_sha256'],base_source=str(basepath),base_sha256=hashlib.sha256(basepath.read_bytes()).hexdigest(),group_source=str(grouppath),group_sha256=hashlib.sha256(grouppath.read_bytes()).hexdigest(),placements=placements)
    out.with_name('page7-legal-placements.json').write_text(json.dumps(cache_record))
