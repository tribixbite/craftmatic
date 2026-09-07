"""Complete remaining2+1 allocation search using full-triple PDF evidence."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import numpy as np
import pymupdf
from placement_layer_triple_screen import shortlist_triples,TRIPLE_KERNEL
from placement_cuda_layers import LayerRasterizer
from placement_gpu_colored_scene_score import GpuColoredSceneScorer
from placement_arrow_contacts import read_items
from placement_multistage_inset_trial import solid_equivalent
from placement_part_library import PartLibrary
from placement_beam import assembly
from placement_group_equivalence import geometry_key
from vector_scene import scene_images


def kernel_test():
    cp=LayerRasterizer().cp;kernel=cp.RawKernel(TRIPLE_KERNEL,'score_pairs',options=('--std=c++11',))
    labels=np.zeros((4,3,5),np.uint8);z=np.zeros(labels.shape,np.float32)
    labels[0,1,1:3]=[1,2];z[0,1,1:3]=1
    labels[1,1,4]=1;z[1,1,4]=2
    labels[2,1,2]=2;z[2,1,2]=3
    labels[3,1,2]=1;z[3,1,2]=4 # singleton changes a visible target class.
    target=np.array([[1,2]],np.uint8);ones=np.ones_like(target,np.uint8)
    result=cp.empty(1,cp.float32)
    kernel((1,),(256,),(cp.asarray(z.view(np.uint32)),cp.asarray(labels),cp.asarray([[0,1,2]],np.int32),cp.asarray([[1,1]],np.int32),
        cp.asarray(target),cp.asarray(ones),cp.asarray(ones),cp.asarray([1,1],np.int32),result,
        np.int32(1),np.int32(15),np.int32(5),np.int32(2),np.int32(1),np.int32(2),np.int32(2)))
    value=float(cp.asnumpy(result)[0]);expected=.8*(1/3+0)/2+.2*2/3
    assert abs(value-expected)<1e-6
    return dict(score=value,cpu_expected=expected,complete_triple_visibility=True)


def camera_frame(M):
    M=np.asarray(M);normal=np.cross(M[0],M[1]);normal/=np.linalg.norm(normal)
    return np.vstack((M,normal))


def run(stage1,out,keep_bases=4,screen_keep=512):
    out.mkdir(parents=True,exist_ok=True);test=kernel_test()
    record=json.loads((stage1/'results.json').read_text());assert record['truth_used'] is False
    pdf=Path(record['pdf']);assert hashlib.sha256(pdf.read_bytes()).hexdigest()==record['pdf_sha256']
    group=next(g for g in record['graph']['groups'] if len(g.get('sequence',[]))>1)
    last_xref=group['ordered_xrefs'][-1]
    with pymupdf.open(pdf) as doc:scene=next(s for s in scene_images(doc,doc[record['source_page']]) if s['xref']==last_xref)
    camera1=np.asarray(record['cameras'][str(record['source_xref'])]['matrix'])
    camera2=np.asarray(record['cameras'][str(last_xref)]['matrix'])
    scorer=GpuColoredSceneScorer(scene,plane_depth=True);library=PartLibrary();shape_cache={};seen=set();selected=[]
    best=record['results'][0]['evidence']['score']
    for row in record['results']:
        if row['evidence']['score']<best-.05:continue
        items=read_items(stage1/row['file']);key=geometry_key(items,library.resolve,shape_cache)
        if key in seen:continue
        seen.add(key);selected.append((row,items))
        if len(selected)>=keep_bases:break
    ranked=[];reports=[];aliases={}
    for base_index,(row,base) in enumerate(selected):
        remaining=Counter((p,int(c)) for p,c in row['remaining_allocations'])
        repeat=[pc for pc,n in remaining.items() if n==2];single=[pc for pc,n in remaining.items() if n==1]
        if len(repeat)!=1 or len(single)!=1 or sum(remaining.values())!=3:raise ValueError('Expected remaining allocation multiplicity2+1')
        rotation=np.linalg.solve(camera_frame(camera1),camera_frame(np.asarray(row['projection'])))
        if not np.allclose(rotation.T@rotation,np.eye(3),atol=1e-5):raise ValueError('Transferred camera gauge is not rigid')
        projection=camera2@rotation
        def surrogate(items):
            result=[]
            for p,c,T in items:
                solid,receipt=solid_equivalent(p,c,library)
                if receipt:aliases[p]=receipt
                result.append((solid,c,T))
            return result
        current=assembly(surrogate(base));banks=[]
        for part,color in (repeat[0],single[0]):
            solid,receipt=solid_equivalent(part,color,library)
            if receipt:aliases[part]=receipt
            candidates=current.candidates(solid,check_collision=True,check_occlusion=False)
            banks.append([dict(items=[(part,color,c['T'])],anchor_index=c.get('anchor',0)) for c in candidates])
        print('base',base_index,'candidatebanks',list(map(len,banks)),flush=True)
        shortlist,summary=shortlist_triples(base,banks[0],banks[1],projection,scorer,limit=screen_keep)
        legal=0
        for i,j,k,coarse in shortlist:
            incoming=banks[0][i]['items']+banks[0][j]['items']+banks[1][k]['items']
            check=assembly([]);collision=False
            for p,c,T in surrogate(incoming):
                if check.parts and check.collides(p,T):collision=True;break
                check.add(p,c,T)
            if collision:continue
            legal+=1;items=base+incoming;ev=scorer.score(items,projection)
            if not ev.get('bbox_rejected'):ranked.append(dict(items=items,evidence=ev,projection=projection,base_index=base_index,coarse=coarse))
        reports.append(dict(base_index=base_index,source=row['file'],base_score=row['evidence']['score'],
            remaining_allocations=list(remaining.items()),candidate_banks=list(map(len,banks)),screen=summary,legal_fullscores=legal))
        print('base',base_index,'legal',legal,'best',max((r['evidence']['score'] for r in ranked),default=None),flush=True)
    ranked.sort(key=lambda r:-r['evidence']['score']);results=[]
    for i,row in enumerate(ranked[:20]):
        name=f'group_{i:03d}.ldr';lines=['0 PDF complete multistage group; uncertified']
        for p,c,T in row['items']:lines.append('1 '+str(c)+' '+' '.join(f'{v:g}' for v in [*T[:3,3],*T[:3,:3].ravel()])+' '+p+'.dat')
        (out/name).write_text('\n'.join(lines)+'\n')
        if i==0:scorer.score(row['items'],row['projection'],out/'selected.png')
        results.append(dict(file=name,base_index=row['base_index'],projection=row['projection'].tolist(),evidence=row['evidence'],coarse=row['coarse']))
    report=dict(pdf=str(pdf),pdf_sha256=record['pdf_sha256'],source_page=record['source_page'],source_xref=last_xref,
        stage1_source=str(stage1),stage1_hash=hashlib.sha256((stage1/'results.json').read_bytes()).hexdigest(),
        truth_used=False,runtime_vlm_calls=0,part_ids_derived_from_pdf=True,certified=False,
        kernel_test=test,stage1_hypotheses=reports,connector_aliases=aliases,results=results,
        limitations=['At most four distinct stage1 geometries within0.05 score retained.',
            'Remaining pieces independently attach to stage1; chained-only placement excluded.',
            'Top512 complete triples per stage1 receive collisions and native scoring.',
            'Same-panel camera relation is a hypothesis; no truth or placement certificate.'])
    (out/'results.json').write_text(json.dumps(report,indent=2))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--stage1',type=Path,required=True);p.add_argument('--out',type=Path,required=True)
    a=p.parse_args();run(a.stage1,a.out)
