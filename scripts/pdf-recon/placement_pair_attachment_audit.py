"""Runtime-only whole-group legal attachment support by member index."""
import json
from pathlib import Path
import numpy as np
from placement_arrow_contacts import read_items
from placement_beam import assembly

if __name__=='__main__':
    groupdir=Path('output/pdf-placement-diagnosis/plate-pair');basepath=Path('output/pdf-placement-beam/40377-gpu-eleven-v1/model.ldr')
    base=assembly(read_items(basepath));groups=[]
    for filename in ('group_000.ldr','group_001.ldr'):
        group=read_items(groupdir/filename);rows=[]
        for index,(part,color,T) in enumerate(group):
            candidates=base.candidates(part,kinds=('CYL','CLP','FGR','GEN'),check_collision=True,check_occlusion=False)
            legal=0
            for candidate in candidates:
                G=candidate['T']@np.linalg.inv(T)
                if not any(base.collides(p,G@pose) for p,c,pose in group):legal+=1
            rows.append(dict(anchor_index=index,part=part,member_candidates=len(candidates),whole_group_legal=legal))
        groups.append(dict(group=filename,anchors=rows))
    report=dict(truth_used=False,runtime_vlm_calls=0,base_source=str(basepath),groups=groups,limitations=['Connector/collision library support only; does not establish PDF placement accuracy'])
    (groupdir/'attachment-support.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
