"""Native white plate/clip outline ablation; no independent model input."""
import json
from pathlib import Path
import numpy as np,pymupdf,cv2
from scipy.optimize import linear_sum_assignment
from placement_feature_edges import FeatureEdgeScorer
from placement_arrow_contacts import transformed_connectors
from placement_arrow_mask import protected_cad_colors,conservative_components
from placement_arrow_pair_topology import arrow_pair_components
from placement_multirow_camera import row_camera_hypotheses
from placement_part_edges import canonical,features,compare
from placement_beam import rotations
from vector_scene import scene_images

if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('--halo',action='store_true');args=parser.parse_args()
    evidence=json.loads(Path('output/pdf-placement-diagnosis/allocated-pair-page10/evidence/results.json').read_text());group=evidence['pair_groups'][0];parts=group['parts']
    out=Path('output/pdf-placement-diagnosis/page10-feature-edges'+('-halo' if args.halo else ''));out.mkdir(exist_ok=True)
    with pymupdf.open(evidence['pdf']) as doc:scene=next(s for s in scene_images(doc,doc[evidence['source_page']]) if s['xref']==group['source_xref'])
    camera=next(s['camera'] for s in evidence['scenes'] if s['xref']==group['source_xref']);M=np.asarray(camera['matrix'])
    palette=protected_cad_colors(parts);graph=conservative_components(scene,protected_colors=palette['rgb'])
    if args.halo:
        from placement_arrow_halo import refine_arrow_halo
        graph=refine_arrow_halo(scene,graph,palette['rgb']);(out/'halo.json').write_text(json.dumps(graph['halo_evidence'],indent=2))
    components,_=arrow_pair_components(graph);detections=row_camera_hypotheses(scene)['detections'];rows=[];images={};targets={}
    for ci,component in enumerate(components):
        current=dict(scene,mask=component['mask']);target,mask=canonical(scene['rgb'],component['mask']);targets[ci]=target;targetfeatures=features(target,mask);scorer=FeatureEdgeScorer(current)
        x0,y0,x1,y1=component['bbox'];studs=np.array([d['center'] for d in detections if x0<=d['center'][0]<x1 and y0<=d['center'][1]<y1])
        for pi,(part,color) in enumerate(parts):
            for ri,R in enumerate(rotations()):
                ev=scorer.score([(part,color,R)],M)
                if ev.get('bbox_rejected'):continue
                photo,pm=canonical(scorer.last_rgb,scorer.last_mask);outline,om=canonical(scorer.last_outline,scorer.last_mask)
                pe,_=compare(features(photo,pm),targetfeatures);oe,_=compare(features(outline,om),targetfeatures)
                caps=transformed_connectors(part,R,'M');predicted=np.array([M@(c['pos']-c['axis']*c['length'])+ev['image_origin'] for c in caps if 5<=c['radius']<=7 and 2<=c['length']<=5])
                caperror=None
                if len(studs) and len(predicted)>=len(studs):
                    distances=np.linalg.norm(studs[:,None,:]-predicted[None,:,:],axis=2);ii,jj=linear_sum_assignment(distances);caperror=float(distances[ii,jj].mean())
                row=dict(component=ci,part=part,rotation_index=ri,transform=R.tolist(),photo_edge=float(pe),outline_edge=float(oe),balanced=ev['score'],cap_center_error=caperror,
                    scores={str(w):.5*(ev['score']+(1-w)*pe+w*oe) for w in (0,.25,.5,.75,1)})
                rows.append(row);images[(ci,part,ri)]=(photo,outline)
    summaries=[];panels=[]
    for ci in range(2):
        for w in (0,.25,.5,.75,1):
            candidates=[r for r in rows if r['component']==ci];best=max(candidates,key=lambda r:r['scores'][str(w)])
            summaries.append(dict(component=ci,weight=w,selected=best))
            photo,outline=images[(ci,best['part'],best['rotation_index'])];panel=np.concatenate([targets[ci],photo,outline],axis=1)
            panel=cv2.copyMakeBorder(panel,24,0,0,0,cv2.BORDER_CONSTANT,value=(255,255,255));cv2.putText(panel,f'component{ci} weight{w} {best["part"]} R{best["rotation_index"]}',(3,17),cv2.FONT_HERSHEY_SIMPLEX,.45,(0,0,0),1);panels.append(panel)
    cv2.imwrite(str(out/'ablation.png'),cv2.cvtColor(np.concatenate(panels),cv2.COLOR_RGB2BGR))
    report=dict(truth_used=False,runtime_vlm_calls=0,pdf_sha256=evidence['pdf_sha256'],camera=camera,rows=rows,summaries=summaries,protocol='Fixed ellipse camera, all allocated part/component identities and24properrotations; explicit outline weights0,.25,.5,.75,1; cap residual diagnostics only')
    (out/'results.json').write_text(json.dumps(report,indent=2));print(json.dumps([dict(component=r['component'],weight=r['weight'],part=r['selected']['part'],rotation=r['selected']['rotation_index'],score=r['selected']['scores'][str(r['weight'])],caperror=r['selected']['cap_center_error']) for r in summaries],indent=2))
