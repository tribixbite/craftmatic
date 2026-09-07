"""Arrowhead evidence against physically coincident incoming female contacts.

Uses universal connector positions and recipient stud cap depth. It does not
choose the shortest arrow displacement. Missing matching contacts explicitly
abstain because connector libraries can be incomplete.
"""
import argparse
import json
from pathlib import Path
import sys
from functools import lru_cache
import numpy as np
from scipy.optimize import linear_sum_assignment
sys.path.insert(0,'C:/git/clego')
from recon_v8.assembly import part_conns


def transformed_connectors(part,T,gender):
    T=np.asarray(T,float);result=[]
    for c in part_conns(part):
        if c.get('kind')!='CYL' or c.get('gender')!=gender:continue
        axis=T[:3,:3]@np.asarray(c['axis']);axis/=max(1e-8,np.linalg.norm(axis))
        result.append(dict(pos=T[:3,:3]@np.asarray(c['pos'])+T[:3,3],axis=axis,
            radius=float(c.get('radius',0)),length=float(c.get('length',0)),gid=c.get('gid')))
    return result


@lru_cache(maxsize=4096)
def _cached_connectors(part,transform_bytes,gender):
    return transformed_connectors(part,np.frombuffer(transform_bytes,dtype=np.float64).reshape(4,4),gender)


def _contact_result(heads,targets,female_count):
    if len(targets)<len(heads):
        return dict(supported=False,reason='Insufficient incoming-female/recipient-male contacts',
                    contacts=targets,arrow_count=len(heads),candidate_female_count=female_count)
    pixels=np.asarray([t['pixel'] for t in targets])
    distances=np.linalg.norm(heads[:,None,:]-pixels[None,:,:],axis=2)
    rows,cols=linear_sum_assignment(distances)
    residual=float(np.mean(distances[rows,cols]))
    adjusted=float(np.mean(np.maximum(0.,distances[rows,cols]-3.)))
    return dict(supported=True,mean_head_error_px=residual,tolerance_adjusted_error_px=adjusted,
        score=float(np.exp(-adjusted/4.)),contacts=targets,
        matches=[dict(arrow=int(i),contact=int(j),error_px=float(distances[i,j])) for i,j in zip(rows,cols)],certified=False)


def batch_score_contact_targets(items,part,transforms,projection,origin,arrows,tolerance_ldu=2,
                                incoming_gender='F',enforce_direction=False):
    """Vectorized coincidence checks; assignment only for supported candidates."""
    transforms=np.asarray(transforms,float)
    if not len(transforms):return []
    heads=np.asarray([a['head'] for a in arrows if not a.get('direction_ambiguous',False)],float)
    if not len(heads):return [dict(supported=False,reason='No arrow heads') for _ in transforms]
    if incoming_gender not in ('F','M'):raise ValueError('Incoming gender must be F or M')
    female=_cached_connectors(part,np.eye(4).tobytes(),incoming_gender)
    male=[];owners=[]
    for owner,(p,c,T) in enumerate(items):
        current=_cached_connectors(p,np.asarray(T,dtype=np.float64).tobytes(),'M' if incoming_gender=='F' else 'F')
        male.extend(current);owners.extend([owner]*len(current))
    if not female or not male:return [_contact_result(heads,[],len(female)) for _ in transforms]
    fp=np.asarray([c['pos'] for c in female]);fa=np.asarray([c['axis'] for c in female]);fr=np.asarray([c['radius'] for c in female])
    mp=np.asarray([c['pos'] for c in male]);ma=np.asarray([c['axis'] for c in male]);mr=np.asarray([c['radius'] for c in male])
    caps=mp-ma*np.asarray([c['length'] for c in male])[:,None] if incoming_gender=='F' else mp.copy()
    pixels=caps@np.asarray(projection).T+origin
    radius=np.abs(fr[:,None]-mr[None,:])<=2
    results=[]
    for begin in range(0,len(transforms),512):
        ts=transforms[begin:begin+512]
        positions=np.einsum('kij,fj->kfi',ts[:,:3,:3],fp)+ts[:,None,:3,3]
        axes=np.einsum('kij,fj->kfi',ts[:,:3,:3],fa)
        axes/=np.maximum(1e-8,np.linalg.norm(axes,axis=2,keepdims=True))
        distances=np.linalg.norm(positions[:,:,None,:]-mp[None,None,:,:],axis=3)
        dots=np.einsum('kfi,mi->kfm',axes,ma)
        coincidence=(distances<=tolerance_ldu)&(dots>=.95)&radius[None,:,:]
        if enforce_direction:
            vectors=[np.asarray(a['direction'],float) for a in arrows if not a.get('direction_ambiguous',False) and 'direction' in a]
            if not vectors:return [dict(supported=False,reason='No insertion direction evidence') for _ in transforms]
            direction=np.mean([v/max(1e-8,np.linalg.norm(v)) for v in vectors],axis=0)
            direction/=max(1e-8,np.linalg.norm(direction))
            insertion=(axes@np.asarray(projection).T)*(1 if incoming_gender=='F' else -1)
            insertion/=np.maximum(1e-8,np.linalg.norm(insertion,axis=2,keepdims=True))
            coincidence&=((insertion@direction)>=.8660254)[:,:,None]
        for index,valid in enumerate(coincidence):
            targets=[]
            for mi in np.flatnonzero(valid.any(axis=0)):
                fi=int(np.flatnonzero(valid[:,mi])[0]);pixel=pixels[mi]
                if any(np.linalg.norm(pixel-np.asarray(t['pixel']))<.5 for t in targets):continue
                targets.append(dict(owner=owners[mi],female_index=fi,contact_world=mp[mi].tolist(),
                    cap_world=caps[mi].tolist(),pixel=pixel.tolist(),coincidence_ldu=float(distances[index,fi,mi])))
            results.append(_contact_result(heads,targets,len(female)))
    return results


def batch_score_insertion_targets(items,part,transforms,projection,origin,arrows,tolerance_ldu=2):
    """Direction-aware F→M and M→F contacts, selected only by PDF arrow fit."""
    groups=[batch_score_contact_targets(items,part,transforms,projection,origin,arrows,tolerance_ldu,
                incoming_gender=gender,enforce_direction=True) for gender in ('F','M')]
    result=[]
    for female,male in zip(*groups):
        choices=[]
        for gender,evidence in zip(('F','M'),(female,male)):
            if evidence.get('supported'):
                choices.append(dict(evidence,incoming_gender=gender,recipient_gender='M' if gender=='F' else 'F',
                    target_kind='stud_cap' if gender=='F' else 'socket_plane',direction_enforced=True))
        if choices:result.append(max(choices,key=lambda r:r['score']))
        else:result.append(dict(supported=False,reason='No direction-consistent contact support',
                               female_to_male=female,male_to_female=male))
    return result


def score_contact_targets(items,part,T,projection,origin,arrows,tolerance_ldu=2):
    """Return contact support and arrowhead residual, or explicit abstention.

    Female connector datum must coincide with a recipient male connector.
    LDCad stud male datum is at the receiving plane; cap center is datum minus
    its axis times cylinder length (verified by universal part geometry).
    """
    heads=np.asarray([a['head'] for a in arrows if not a.get('direction_ambiguous',False)],float)
    if not len(heads):return dict(supported=False,reason='No arrow heads')
    female=transformed_connectors(part,T,'F');targets=[]
    for owner,(p,c,oldT) in enumerate(items):
        for male in transformed_connectors(p,oldT,'M'):
            for fi,f in enumerate(female):
                distance=float(np.linalg.norm(f['pos']-male['pos']))
                if distance>tolerance_ldu or abs(f['radius']-male['radius'])>2 or f['axis']@male['axis']<.95:continue
                cap=male['pos']-male['axis']*male['length']
                pixel=np.asarray(projection)@cap+origin
                if any(np.linalg.norm(pixel-np.asarray(t['pixel']))<.5 for t in targets):continue
                targets.append(dict(owner=owner,female_index=fi,contact_world=male['pos'].tolist(),
                    cap_world=cap.tolist(),pixel=pixel.tolist(),coincidence_ldu=distance))
    if len(targets)<len(heads):
        return dict(supported=False,reason='Insufficient incoming-female/recipient-male contacts',
                    contacts=targets,arrow_count=len(heads),candidate_female_count=len(female))
    pixels=np.asarray([t['pixel'] for t in targets])
    distances=np.linalg.norm(heads[:,None,:]-pixels[None,:,:],axis=2)
    rows,cols=linear_sum_assignment(distances)
    residual=float(np.mean(distances[rows,cols]))
    # 3px tolerance covers native antialiasing and visible arrow tips which
    # stop just short of a stud cap, without accepting a full plate-depth shift.
    adjusted=float(np.mean(np.maximum(0.,distances[rows,cols]-3.)))
    return dict(supported=True,mean_head_error_px=residual,tolerance_adjusted_error_px=adjusted,
        score=float(np.exp(-adjusted/4.)),contacts=targets,
        matches=[dict(arrow=int(i),contact=int(j),error_px=float(distances[i,j])) for i,j in zip(rows,cols)],
        certified=False)


def read_items(path):
    result=[]
    for line in Path(path).read_text().splitlines():
        f=line.split()
        if len(f)>=15 and f[0]=='1':
            T=np.eye(4);T[:3,3]=list(map(float,f[2:5]));T[:3,:3]=np.asarray(list(map(float,f[5:14]))).reshape(3,3)
            result.append((f[14].removesuffix('.dat'),int(f[1]),T))
    return result


def diagnostic(out):
    import pymupdf
    from vector_scene import scene_images
    from vector_scene_components import component_graph
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    source=Path('output/pdf-placement-vector/exploded-step')
    saved=json.loads((source/'results.json').read_text())
    camera=np.asarray(json.loads(Path('output/pdf-placement-beam/40377-pair-camera-v1/results.json').read_text())['camera']['matrix'])
    doc=pymupdf.open('C:/git/clego/lego_sets/PDF/6314914.pdf');scene=scene_images(doc,doc[3])[0]
    arrows=component_graph(scene)['arrows'];rows=[]
    for index,row in enumerate(saved['results']):
        path=source/f'proposal_{index:03d}.ldr';items=read_items(path);p,c,T=items[-1]
        evidence=score_contact_targets(items[:-1],p,T,camera,np.asarray(row['evidence']['image_origin']),arrows)
        rows.append(dict(proposal=index,transform=T.tolist(),contact_evidence=evidence))
    # Synthetic arrowheads exactly at three universal cap centers; a translated
    # candidate must lose coincident contact support, irrespective arrow length.
    base=np.eye(4);incoming=np.eye(4);incoming[1,3]=-8
    origin=np.array([100.,100.]);M=np.array([[1.,0,-1.],[.5,1,.5]])
    caps=[np.asarray(c['pos'])-np.asarray(c['axis'])*c['length'] for c in part_conns('2420') if c.get('gender')=='M' and c.get('radius')==6]
    synthetic=[dict(head=(M@cap+origin).tolist()) for cap in caps]
    exact=score_contact_targets([('2420',15,base)],'2420',incoming,M,origin,synthetic)
    moved=incoming.copy();moved[1,3]+=16
    shifted=score_contact_targets([('2420',15,base)],'2420',moved,M,origin,synthetic)
    result=dict(protocol='PDF arrows and runtime proposals; universal connector geometry; no model truth',
        synthetic=dict(exact=exact,translated_depth=shifted),proposals=rows)
    (out/'results.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    assert exact['supported'] and exact['mean_head_error_px']<1e-8
    assert not shifted['supported']


def batch_selftest(out):
    import time
    from placement_part_edges import cube_rotations
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    base=np.eye(4);M=np.array([[1.,0,-1.],[.5,1.,.5]]);origin=np.array([100.,100.])
    caps=[np.asarray(c['pos'])-np.asarray(c['axis'])*c['length'] for c in part_conns('2420') if c.get('gender')=='M' and c.get('radius')==6]
    arrows=[dict(head=(M@cap+origin).tolist()) for cap in caps[:2]]
    rng=np.random.default_rng(4914);rotations=cube_rotations();transforms=[]
    for i in range(192):
        T=rotations[int(rng.integers(24))].copy();T[:3,3]=rng.choice([-20.,-8.,0.,8.,16.,20.],size=3)
        transforms.append(T)
    for y in (-10.,-8.,-6.,0.,8.,16.):
        T=np.eye(4);T[1,3]=y;transforms.append(T)
    items=[('2420',15,base)]
    serial=[score_contact_targets(items,'2420',T,M,origin,arrows) for T in transforms]
    batched=batch_score_contact_targets(items,'2420',transforms,M,origin,arrows)
    def equivalent(a,b):
        if isinstance(a,dict):return a.keys()==b.keys() and all(equivalent(a[k],b[k]) for k in a)
        if isinstance(a,list):return len(a)==len(b) and all(equivalent(x,y) for x,y in zip(a,b))
        if isinstance(a,(float,int)) and not isinstance(a,bool):return bool(np.isclose(a,b,atol=1e-9,rtol=1e-9))
        return a==b
    matches=[equivalent(a,b) for a,b in zip(serial,batched)]
    many=np.tile(np.asarray(transforms),(50,1,1))
    start=time.perf_counter();results=batch_score_contact_targets(items,'2420',many,M,origin,arrows);elapsed=time.perf_counter()-start
    result=dict(random_and_boundary_cases=len(transforms),matching_cases=sum(matches),
        supported_cases=sum(r['supported'] for r in batched),benchmark_candidates=len(many),
        benchmark_seconds=elapsed,benchmark_supported=sum(r['supported'] for r in results),
        protocol='Synthetic universal part poses; deterministic RNG4914; no set truth')
    (out/'batch-selftest.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    assert all(matches),[i for i,m in enumerate(matches) if not m]


def insertion_selftest(out):
    import pymupdf
    from vector_scene import scene_images
    from vector_scene_components import component_graph
    from placement_exploded_step import ExplodedStepScorer
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    M=np.array([[1.,0,-1.],[.5,1.,.5]]);origin=np.array([100.,100.]);base=np.eye(4)
    controls=[]
    for gender,y in [('F',-8.),('M',8.)]:
        receiver=transformed_connectors('2420',base,'M' if gender=='F' else 'F')
        receiver=[c for c in receiver if c['radius']==6]
        heads=[c['pos']-c['axis']*c['length'] if gender=='F' else c['pos'] for c in receiver]
        direction=M@np.array([0.,1. if gender=='F' else -1.,0.])
        arrows=[dict(head=(M@p+origin).tolist(),direction=direction.tolist()) for p in heads]
        T=np.eye(4);T[1,3]=y;wrong=T.copy();wrong[1,3]=-y
        evidence=batch_score_insertion_targets([('2420',15,base)],'2420',[T,wrong],M,origin,arrows)
        controls.append(dict(incoming_gender=gender,evidence=evidence))
        assert evidence[0]['supported'] and evidence[0]['mean_head_error_px']<1e-8
        assert evidence[0]['incoming_gender']==gender
        assert not evidence[1]['supported']
    source=Path('output/pdf-placement-beam/40377-contacts-six-v1/model.ldr');items=read_items(source)
    camera=np.asarray(json.loads(Path('output/pdf-placement-beam/40377-pair-camera-v1/results.json').read_text())['camera']['matrix'])
    doc=pymupdf.open('C:/git/clego/lego_sets/PDF/6314914.pdf');real=[]
    for page in (2,3):
        scene=scene_images(doc,doc[page])[0];scorer=ExplodedStepScorer(scene,camera,items[:2],out/f'p{page}-registration')
        arrangements=[(items[:2]+[items[3]],items[2]),(items[:3],items[3])] if page==2 else [(items[:5],items[5])]
        for order,(built,incoming) in enumerate(arrangements):
            p,c,T=incoming
            for index,registration in enumerate(scorer.origins):
                result=batch_score_insertion_targets(built,p,[T],camera,registration,scorer.graph['arrows'])[0]
                real.append(dict(page=page,order=order,origin_index=index,image_origin=registration.tolist(),contact=result))
    result=dict(synthetic=controls,runtime_pdf_proposals=real,runtime_source=str(source),truth_used=False)
    (out/'insertion-selftest.json').write_text(json.dumps(result,indent=2),encoding='utf-8')


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--out',type=Path,required=True)
    args=parser.parse_args();diagnostic(args.out);batch_selftest(args.out);insertion_selftest(args.out)
