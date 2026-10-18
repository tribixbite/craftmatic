"""Weak two-cap camera hypotheses bound to actual universal part connectors.

Part identity is supported by fixed-scale CAD/artwork matching across both
isolated components, not assumed from the allocation's order.
"""
import numpy as np


def two_cap_camera(detections,spacing,diameter):
    if len(detections)!=2:return dict(ok=False,reason='Exactly two isolated cap detections required')
    centers=np.asarray([d['center'] for d in detections]);A=centers[1]-centers[0]
    if A[0]<0:A=-A
    cov=[]
    for d in detections:
        a=np.radians(d['angle']);R=np.array([[np.cos(a),-np.sin(a)],[np.sin(a),np.cos(a)]])
        cov.append(R@np.diag(np.asarray(d['axes'])**2)@R.T)
    E=np.mean(cov,axis=0);remaining=E/(diameter/spacing)**2-np.outer(A,A);values,vectors=np.linalg.eigh(remaining)
    if values[1]<=0:return dict(ok=False,reason='Ellipse incompatible with known spacing')
    B=vectors[:,1]*np.sqrt(values[1]);residual=abs(float(values[0]))/values[1]
    if A[1]>=0:
        if B[0]>0:B=-B
        Mx,Mz=A/spacing,B/spacing
    else:
        if B[0]<0:B=-B
        Mx,Mz=B/spacing,-A/spacing
    if min(Mx[1],Mz[1])<0:return dict(ok=False,reason='No upright sign convention')
    C=np.outer(Mx,Mx)+np.outer(Mz,Mz);v,w=np.linalg.eigh(C);My=w[:,0]*np.sqrt(max(0,v[1]-v[0]))
    if My[1]<0:My=-My
    return dict(ok=residual<.25,matrix=np.column_stack((Mx,My,Mz)).tolist(),rank1_residual=residual,known_spacing_ldu=spacing,known_cap_diameter_ldu=diameter,detected_studs=2,method='Two isolated ellipse centers plus actual universal part connector spacing',weak_evidence=True)


def infer_component_pair_camera(scene,graph,parts):
    from placement_arrow_pair_topology import arrow_pair_components
    from placement_arrow_contacts import transformed_connectors
    from placement_studs import detect_studs
    from placement_gpu_colored_scene_score import GpuColoredSceneScorer
    from placement_part_edges import canonical,features,compare
    from placement_beam import rotations
    try:components,topology=arrow_pair_components(graph)
    except ValueError as exc:return dict(ok=False,reason=str(exc))
    hypotheses=[];geometry=[];attempts=[]
    for part,color in parts:
        caps=[c for c in transformed_connectors(part,np.eye(4),'M') if 5<=c['radius']<=7 and 2<=c['length']<=5]
        if len(caps)!=2:continue
        spacing=float(np.linalg.norm(caps[0]['pos']-caps[1]['pos']));diameter=float(caps[0]['radius']+caps[1]['radius'])
        if spacing<=0:continue
        geometry.append(dict(part=part,color=color,spacing=spacing,diameter=diameter,connector_positions=[c['pos'].tolist() for c in caps]))
    from placement_multirow_camera import row_camera_hypotheses
    full_detections=row_camera_hypotheses(scene)['detections']
    for ci,component in enumerate(components):
        # Detect on original artwork: removing an overlaid arrow can break a
        # stud ellipse. Component bounding boxes only associate detections.
        x0,y0,x1,y1=component['bbox']
        detections=[d for d in full_detections if x0<=d['center'][0]<x1 and y0<=d['center'][1]<y1]
        for g in geometry:
            camera=two_cap_camera(detections,g['spacing'],g['diameter'])
            attempts.append(dict(component=ci,part=g['part'],detections=detections,camera=camera))
            if camera.get('ok'):hypotheses.append(dict(camera=camera,component=ci,part=g['part'],color=g['color'],geometry_evidence=g,detections=detections))
    if not hypotheses:return dict(ok=False,reason='No isolated two-cap component matched a two-cap universal part',geometry_evidence=geometry,attempts=attempts)
    Rlist=rotations();ranked=[]
    for hypothesis in hypotheses:
        M=np.asarray(hypothesis['camera']['matrix']);fits=[]
        for ci,component in enumerate(components):
            current=dict(scene,mask=component['mask']);scorer=GpuColoredSceneScorer(current);target=features(*canonical(current['rgb'],current['mask']));partfits=[]
            for part,color in parts:
                best=0.
                for R in Rlist:
                    ev=scorer.score([(part,color,R)],M)
                    if ev.get('bbox_rejected'):continue
                    edge,_=compare(features(*canonical(scorer.last_rgb,scorer.last_mask)),target)
                    best=max(best,.5*(float(edge)+ev['score']))
                partfits.append(best)
            fits.append(partfits)
        assigned=hypothesis['component'];pi=next(i for i,p in enumerate(parts) if p[0]==hypothesis['part'])
        # Bind the source cap component to the CAD spacing provider; score the
        # remaining identity against the other component independently.
        support=(fits[assigned][pi]+fits[1-assigned][1-pi])/2
        swapped=(fits[assigned][1-pi]+fits[1-assigned][pi])/2
        ranked.append(dict(**hypothesis,artwork_support=support,artwork_fits=fits,identity_margin=support-swapped))
    ranked.sort(key=lambda r:-r['artwork_support']);best=ranked[0]
    return dict(best['camera'],ok=best['identity_margin']>.05,artwork_support=best['artwork_support'],identity_margin=best['identity_margin'],source_component=best['component'],source_part=best['part'],geometry_evidence=best['geometry_evidence'],
        alternatives=[dict(matrix=r['camera']['matrix'],part=r['part'],component=r['component'],artwork_support=r['artwork_support'],rank1_residual=r['camera']['rank1_residual']) for r in ranked[1:]],
        limitations=['Two detections give weak calibration with no row-spacing redundancy','Component-part identity is approximate CAD/artwork evidence','Both component artwork fits required; no reference model pose used'])
