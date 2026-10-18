"""Orthographic camera hypotheses from both isolated known-part artworks.

All allocated identity/component mappings and24 proper part frames are tested.
Physical scale comes from CAD bounds, never external model poses. Coarse
continuous-angle grid followed by local grid refinement; ambiguity retained.
"""
import numpy as np


def infer_cad_pair_camera(scene,graph,parts):
    from placement_arrow_pair_topology import arrow_pair_components
    from placement_gpu_colored_scene_score import GpuColoredSceneScorer
    from placement_part_edges import canonical,features,compare
    from placement_beam import rotations
    components,topology=arrow_pair_components(graph)
    if len(parts)!=2:raise ValueError('Exactly two allocated part identities required')
    scorers=[GpuColoredSceneScorer(dict(scene,mask=c['mask']),max_projection_cache=128) for c in components]
    targets=[features(*canonical(scene['rgb'],c['mask'])) for c in components];Rs=rotations();records=[];seen=set();renders=0
    def evaluate(azimuth,elevation):
        nonlocal renders
        key=(round(float(azimuth),5),round(float(elevation),5))
        if key in seen or not 5<=azimuth<=85 or not 10<=elevation<=80:return
        seen.add(key);az,el=np.radians([azimuth,elevation])
        unit=np.array([[np.cos(az),0,-np.sin(az)],[np.sin(az)*np.sin(el),np.cos(el),np.cos(az)*np.sin(el)]])
        fits={}
        for ci,scorer in enumerate(scorers):
            for pi,(part,color) in enumerate(parts):
                options=[]
                for ri,R in enumerate(Rs):
                    projected=scorer._project_part(part,color,R,unit);span=projected['hi']-projected['lo'];target=scorer.target_span
                    scale=float(span@target/max(1e-8,span@span));M=unit*scale
                    ev=scorer.score([(part,color,R)],M);renders+=1
                    if ev.get('bbox_rejected'):continue
                    edge,_=compare(features(*canonical(scorer.last_rgb,scorer.last_mask)),targets[ci])
                    options.append(dict(score=.5*(float(edge)+ev['score']),edge=float(edge),color=ev['score'],scale=scale,rotation_index=ri))
                options.sort(key=lambda r:-r['score']);fits[(ci,pi)]=options[:4]
        for mapping in ((0,1),(1,0)):
            for first in fits[(0,mapping[0])]:
                for second in fits[(1,mapping[1])]:
                    scaleerror=abs(np.log(first['scale']/second['scale']));scale=(first['scale']+second['scale'])/2
                    score=(first['score']+second['score'])/2-.3*scaleerror
                    records.append(dict(azimuth=float(azimuth),elevation=float(elevation),matrix=(unit*scale).tolist(),scale=scale,scale_log_error=scaleerror,
                        score=score,component_part_indices=list(mapping),component_fits=[first,second],method='Both-part CAD artwork camera fit'))
    for az in (15,30,45,60,75):
        for el in (20,35,50,65):evaluate(az,el)
    if not records:return dict(ok=False,reason='No CAD/artwork camera hypotheses')
    for offsets in ((-7.5,-2.5,0,2.5,7.5),(-2.5,-1.25,0,1.25,2.5)):
        best=max(records,key=lambda r:r['score'])
        for da in offsets:
            for de in offsets:evaluate(best['azimuth']+da,best['elevation']+de)
    records.sort(key=lambda r:-r['score']);best=records[0];alternatives=[];angles=set()
    for row in records:
        key=(row['azimuth'],row['elevation'],tuple(row['component_part_indices']))
        if key in angles:continue
        angles.add(key);alternatives.append(row)
        if len(alternatives)>=12:break
    return dict(best,ok=True,weak_evidence=True,angle_hypotheses=len(seen),renders=renders,alternatives=alternatives[1:],truth_used=False,runtime_vlm_calls=0,
        limitations=['Finite azimuth/elevation grid plus local refinement may miss another optimum','Planar parts can leave orientation/camera ambiguity','Each part supplies a physical-scale estimate; shared-scale disagreement explicitly penalized','No full-assembly poses or reference model are calibration inputs'])


if __name__=='__main__':
    import argparse,json,hashlib
    from pathlib import Path
    import pymupdf
    from vector_scene import scene_images
    from placement_arrow_mask import protected_cad_colors,conservative_components
    p=argparse.ArgumentParser();p.add_argument('evidence',type=Path);p.add_argument('--out',type=Path,required=True);a=p.parse_args()
    data=json.loads(a.evidence.read_text());group=data['pair_groups'][0];parts=[(p,int(c)) for p,c in group['parts']]
    with pymupdf.open(data['pdf']) as doc:scene=next(s for s in scene_images(doc,doc[data['source_page']]) if s['xref']==group['source_xref'])
    palette=protected_cad_colors(parts)
    if not palette['complete']:raise ValueError('Missing CAD print palette')
    result=infer_cad_pair_camera(scene,conservative_components(scene,protected_colors=palette['rgb']),parts)
    result.update(pdf_sha256=data['pdf_sha256'],source_page=data['source_page'],source_xref=group['source_xref'],allocation_sha256=data['allocation_sha256'])
    a.out.parent.mkdir(parents=True,exist_ok=True);a.out.write_text(json.dumps(result,indent=2));print(json.dumps({k:result.get(k) for k in ('ok','score','scale_log_error','azimuth','elevation','angle_hypotheses','renders')}))
