"""Oracle evaluation of direct page stable-component scoring, no lookahead."""
import json
from pathlib import Path
import numpy as np
import pymupdf
from pose_score import read_parts
from placement_diagnose_pair_rank import to_items
from placement_gpu_render import SurfaceScorer
from placement_studs import detect_studs
from vector_scene import scene_images
from vector_scene_components import component_graph

if __name__=='__main__':
    out=Path('output/pdf-placement-diagnosis');run=Path('output/pdf-placement-beam/40377-registered-six-v1')
    selected=to_items(read_parts(run/'model.ldr'));truth=to_items(read_parts('C:/git/clego/lego_sets/OMR/40377-1.mpd'))
    G=selected[0][2]@np.linalg.inv(next(p for p in truth if p[0]=='99780')[2])
    plates=[(p,c,G@T) for p,c,T in truth if p=='2420'];missing=[p for p in plates if not any(np.allclose(p[2],q[2],atol=1e-4) for q in selected[:4] if q[0]=='2420')]
    evidence=json.loads((run/'journal.json').read_text())[0]['target'];M=json.loads((run/'camera.json').read_text())['matrix']
    with pymupdf.open('C:/git/clego/lego_sets/PDF/6314914.pdf') as doc:
        scene=next(s for s in scene_images(doc,doc[3]) if s['xref']==17)
        mask=component_graph(scene)['components'][0]['mask'];studs=detect_studs(scene['rgb'],mask)
    scorer=SurfaceScorer(device='cuda',projection=M,stud_weight=.5);scorer.scene(mask,studs)
    rows=[]
    groups=[('correct4',selected[:4]),('wrong5',selected[:5])]+[(f'correct5_option{i}',selected[:4]+[p]) for i,p in enumerate(missing)]
    for label,items in groups:
        for i,origin in enumerate(evidence['registrations']):
            scorer.registration=origin['image_origin'];scorer.stud_weight=0
            surface=float(scorer.score(items[:-1],items[-1][0],[items[-1][2]])[0]);scorer.stud_weight=.5
            combined=float(scorer.score(items[:-1],items[-1][0],[items[-1][2]])[0])+.03*origin['agreement']
            rows.append({'label':label,'origin_index':i,'surface':surface,'combined':combined})
    best={label:max([r for r in rows if r['label']==label],key=lambda r:r['combined']) for label,_ in groups}
    result={'scope':'Oracle-only diagnostic at original PDF page3 xref17 stable component; no future-page image; first4 from runtime output verified only after inference','camera':M,'best':best,'scores':rows,'stud_count':len(studs),'correct5_added_transforms':[p[2].tolist() for p in missing]}
    (out/'direct-five-scoring.json').write_text(json.dumps(result,indent=2))
