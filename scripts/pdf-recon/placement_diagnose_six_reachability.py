"""Oracle-only six-part reachability and fixed-registration score diagnosis."""
from pathlib import Path
import hashlib,json
import cv2
import numpy as np
import pymupdf
from pose_score import read_parts
from placement_diagnose_pair_rank import to_items
from placement_diagnose_reachability import check
from placement_gpu_render import SurfaceScorer
from vector_scene import scene_images
from vector_scene_components import component_graph

if __name__=='__main__':
    run=Path('output/pdf-placement-beam/40377-registered-six-v1');out=Path('output/pdf-placement-diagnosis')
    selected=to_items(read_parts(run/'model.ldr'))
    truth=to_items(read_parts('C:/git/clego/lego_sets/OMR/40377-1.mpd'))
    G=selected[0][2]@np.linalg.inv(next(p for p in truth if p[0]=='99780')[2])
    plates=[(p,c,G@T) for p,c,T in truth if p=='2420']
    missing=[item for item in plates if not any(np.allclose(item[2],p[2],atol=1e-4) for p in selected[:4] if p[0]=='2420')]
    rows=[]
    for i,j in [(0,1),(1,0)]:rows.append({'order':[i,j],'first':check(selected[:4],missing[i][2]),'second':check(selected[:4]+[missing[i]],missing[j][2])})
    evidence=json.loads((run/'journal.json').read_text())[1]['target']
    camera=json.loads((run/'camera.json').read_text())['matrix']
    scorer=SurfaceScorer(device='cuda',projection=camera,stud_weight=.5)
    with pymupdf.open('C:/git/clego/lego_sets/PDF/6314914.pdf') as doc:
        scene=next(s for s in scene_images(doc,doc[evidence['source_page']]) if s['xref']==evidence['xref'])
        mask=component_graph(scene)['components'][0]['mask'];scorer.scene(mask,evidence['stud_detections'])
    scores=[]
    for label,items in [('correct6',selected[:4]+missing),('selected6',selected)]:
        for index,origin in enumerate(evidence['registrations']):
            scorer.registration=origin['image_origin'];scorer.stud_weight=0
            surface=float(scorer.score(items[:-1],items[-1][0],[items[-1][2]])[0])
            scorer.stud_weight=.5;combined=float(scorer.score(items[:-1],items[-1][0],[items[-1][2]])[0])
            scores.append({'label':label,'origin':index,'surface':surface,'weighted_stud_contribution':combined-surface,'origin_agreement_bonus':.03*origin['agreement'],'combined':combined+.03*origin['agreement']})
    result={'scope':'Oracle-only reachability and post-hoc score comparison using existing runtime origins. Current renderer code hash disclosed; not an exact replay of unarchived historical source.','renderer_sha256':hashlib.sha256(Path('scripts/pdf-recon/placement_gpu_render.py').read_bytes()).hexdigest(),'missing_transforms':[p[2].tolist() for p in missing],'reachability':rows,'scores':scores}
    path=out/'six-reachability-scores.json';path.write_text(json.dumps(result,indent=2));print(path)
