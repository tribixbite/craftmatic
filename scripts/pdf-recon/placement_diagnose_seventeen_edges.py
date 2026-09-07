"""Saved17-part runtime candidate outline ablation, scores before evaluation."""
import json
from pathlib import Path
import numpy as np,pymupdf,cv2
from placement_arrow_contacts import read_items
from placement_arrow_mask import protected_cad_colors,conservative_components
from placement_arrow_halo import refine_arrow_halo
from placement_feature_edges import FeatureEdgeScorer
from placement_part_edges import canonical,features,compare
from vector_scene import scene_images

if __name__=='__main__':
    run=Path('output/pdf-placement-beam/40377-gpu-seventeen-layers-v3');meta=json.loads((run/'results.json').read_text());out=Path('output/pdf-placement-diagnosis/seventeen-outline-ablation');out.mkdir(exist_ok=True)
    with pymupdf.open(meta['pdf']) as doc:scene=scene_images(doc,doc[meta['page']])[0]
    items=read_items(run/'model.ldr');palette=protected_cad_colors([(p,c) for p,c,T in items]);graph=refine_arrow_halo(scene,conservative_components(scene,protected_colors=palette['rgb']),palette['rgb']);scene=dict(scene,mask=graph['clean_mask'])
    scorer=FeatureEdgeScorer(scene);target=features(*canonical(scene['rgb'],scene['mask']));rows=[];pictures={}
    for record in meta['results']:
        filename=record['file'];items=read_items(run/filename);ev=scorer.score(items,np.asarray(record['projection']))
        pe,_=compare(features(*canonical(scorer.last_rgb,scorer.last_mask)),target);oe,_=compare(features(*canonical(scorer.last_outline,scorer.last_mask)),target)
        rows.append(dict(file=filename,original_score=record['evidence']['score'],balanced=ev['score'],photo_edge=float(pe),outline_edge=float(oe),
            scores={str(w):(1-w)*ev['score']+w*float(oe) for w in (0,.25,.5,.75,1)}))
        if filename in ('beam_00.ldr','beam_02.ldr'):
            panels=[canonical(scene['rgb'],scene['mask'])[0],canonical(scorer.last_rgb,scorer.last_mask)[0],canonical(scorer.last_outline,scorer.last_mask)[0]]
            pictures[filename]=np.concatenate(panels,axis=1)
    report=dict(truth_used=False,runtime_vlm_calls=0,pdf_sha256=meta['pdf_sha256'],protocol='Allsaved20runtimecandidates, ownruntimeprojection+fixedphysicalbboxregistration; weights0,.25,.5,.75,1; no labels tune selection',rows=rows,
        rankings={str(w):[r['file'] for r in sorted(rows,key=lambda r:-r['scores'][str(w)])] for w in (0,.25,.5,.75,1)})
    (out/'pdf-only-scores.json').write_text(json.dumps(report,indent=2))
    cv2.imwrite(str(out/'comparison.png'),cv2.cvtColor(cv2.resize(np.concatenate(list(pictures.values())),None,fx=3,fy=3,interpolation=cv2.INTER_NEAREST),cv2.COLOR_RGB2BGR))
    prior=json.loads(Path('output/pdf-placement-diagnosis/40377-gpu-seventeen-layers-v3-alias-poses.json').read_text());lookup={r['file']:r for r in prior['beams']}
    evaluation={w:dict(selected=names[0],structural_matched=lookup[names[0]]['canonical_structural_yaw']['matched']) for w,names in report['rankings'].items()}
    (out/'posthoc-evaluation.json').write_text(json.dumps(evaluation,indent=2));print(json.dumps(evaluation,indent=2))
