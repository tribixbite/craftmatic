"""Complete isolated inset mate search, scored only after all three pieces.

The input PDF inset supplies white plate / plain blue / striped blue layer
order. Universal printed alias geometry is resolved from LDraw header evidence.
No OMR/model input is used. Finalists remain uncertified hypotheses.
"""
import itertools,json,hashlib
from pathlib import Path
import cv2,numpy as np,pymupdf
from placement_beam import assembly,rotations
from placement_gpu_render import SurfaceScorer
from placement_colored_cad import colored_triangles,nativecolor_render
from placement_part_library import PartLibrary
from placement_part_edges import canonical,features,compare
from vector_scene import scene_images

OUT=Path('output/pdf-placement-diagnosis/subassembly-complete')

if __name__=='__main__':
    OUT.mkdir(parents=True,exist_ok=True);library=PartLibrary()
    parts=[('3710',15),('3010',1),('3010pb291',1)];boxes={};geometry_files={}
    for p,c in parts:
        data=colored_triangles(p,c,resolver=library.resolve);vertices=data['triangles'].reshape(-1,3)
        lo,hi=vertices.min(0),vertices.max(0);boxes[p]=np.array(list(itertools.product(*zip(lo,hi))));geometry_files.update(data['files'])
    with pymupdf.open('C:/git/clego/lego_sets/PDF/6314914.pdf') as doc:scene=next(s for s in scene_images(doc,doc[4]) if s['xref']==23)
    yy,xx=np.where(scene['mask']);native_extent=np.array([np.ptp(xx)+1,np.ptp(yy)+1])
    M=np.asarray(json.loads(Path('output/pdf-placement-diagnosis/studs/cameras.json').read_text())[-1]['camera']['matrix'])
    scorer=SurfaceScorer(device='cuda',projection=M);scorer.scene(scene['mask'])
    base=[('3710',15,np.eye(4))];asm=assembly(base)
    first=asm.candidates('3010',check_collision=True,check_occlusion=False)
    finals=[];raw_total=0;legal_total=0;fit_total=0
    for fi,candidate in enumerate(first):
        fixed=base+[('3010',1,candidate['T'])];current=assembly(fixed)
        seconds=current.candidates('3010',check_collision=False,check_occlusion=False)
        raw_total+=len(seconds)
        legal=[c['T'] for c in seconds if not current.collides('3010',c['T'])];legal_total+=len(legal)
        if not legal:continue
        Ts=np.asarray(legal)
        fixedpoints=np.concatenate([boxes[p]@T[:3,:3].T+T[:3,3] for p,c,T in fixed])
        newpoints=np.einsum('vj,nij->nvi',boxes['3010pb291'],Ts[:,:3,:3])+Ts[:,:3,3,None].transpose(0,2,1)
        pts=np.concatenate([np.broadcast_to(fixedpoints,(len(Ts),*fixedpoints.shape)),newpoints],axis=1)
        for R in rotations():
            projected=pts@(M@R[:3,:3]).T;extent=projected.max(1)-projected.min(1)
            indices=np.flatnonzero(np.all(np.abs(extent-native_extent)<=4+.10*native_extent,axis=1))
            if not len(indices):continue
            fit_total+=len(indices)
            moved=[(p,c,R@T) for p,c,T in fixed];last=[R@Ts[i] for i in indices]
            scores=scorer.score(moved,'3010',last)
            for T,score in zip(last,scores):finals.append({'surface':float(score),'items':moved+[('3010pb291',1,T)]})
        if fi%40==0:print('first',fi,'/',len(first),'complete',legal_total,'bboxretained',fit_total,flush=True)
    finals.sort(key=lambda r:-r['surface']);finals=finals[:200]
    targetrgb,targetmask=canonical(scene['rgb'],scene['mask']);target=features(targetrgb,targetmask);thsv=cv2.cvtColor(targetrgb,cv2.COLOR_RGB2HSV)
    for i,record in enumerate(finals):
        image=nativecolor_render(record['items'],M,OUT/f'color-{i:03d}.png',resolver=library.resolve)
        rgb,mask=canonical(image['rgb'],image['mask']);hsv=cv2.cvtColor(rgb,cv2.COLOR_RGB2HSV)
        edge,detail=compare(features(rgb,mask),target)
        def classify(rgb,hsv,mask):
            return np.where(mask==0,0,np.where((hsv[:,:,0]>15)&(hsv[:,:,0]<40)&(hsv[:,:,1]>90),3,np.where(rgb.mean(2)<70,4,np.where(hsv[:,:,1]<65,1,2))))
        a,b=classify(rgb,hsv,mask),classify(targetrgb,thsv,targetmask);union=(mask>0)|(targetmask>0)
        agreement=float((a[union]==b[union]).mean());pattern=float(((a==3)&(b==3)).sum()/max(1,((a==3)|(b==3)).sum()))
        record.update(score=.4*edge+.35*agreement+.25*pattern,edge=edge,color_agreement=agreement,pattern_iou=pattern,render=str(OUT/f'color-{i:03d}.png'))
    finals.sort(key=lambda r:-r['score']);report=[]
    for i,record in enumerate(finals[:20]):
        # Output through geometry equivalents avoids silent missing-part cache
        # writes; retain the actual printed identity in the emitted text.
        surrogate=[('3010' if p=='3010pb291' else p,c,T) for p,c,T in record['items']]
        text=assembly(surrogate).to_ldr('0 PDF-only complete isolated inset; explicit printed alias; uncertified')
        lines=text.splitlines();lines[-1]=lines[-1].removesuffix('3010.dat')+'3010pb291.dat'
        (OUT/f'group_{i:03d}.ldr').write_text('\n'.join(lines)+'\n')
        report.append({k:v for k,v in record.items() if k!='items'}|{'transforms':[T.tolist() for p,c,T in record['items']]})
    (OUT/'results.json').write_text(json.dumps({'scope':'Complete3piece one-order mate chains; nativePDFinset determines layer order; no truth input','first_candidates':len(first),'raw_complete':raw_total,'legal_complete':legal_total,'rotated_bbox_compatible':fit_total,'colored_finalists':len(finals),'native_extent':native_extent.tolist(),'geometry_provenance':geometry_files,'parts':parts,'results':report,'limitations':['Centeredlayoutnotassumed; onlycompletebboxwithin10percent+4px','Top200completed surface hypotheses receive colored scoring','Stillisolatedgroup; attachmenttofullmodelunresolved']},indent=2));print(OUT/'results.json')
