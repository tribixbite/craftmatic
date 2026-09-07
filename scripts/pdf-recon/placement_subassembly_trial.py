"""Bounded PDF-only isolated three-part inset assembly experiment.

No set-model truth is imported. A universal catalog-described printed brick
uses an explicit unprinted geometry surrogate; print orientation unresolved.
"""
from pathlib import Path
import hashlib,itertools,json
import cv2
import numpy as np
import pymupdf
from placement_beam import assembly,rotations
from placement_gpu_render import SurfaceScorer
from placement_part_edges import canonical,features,compare
from vector_scene import scene_images,background_mask
from recon_v8 import partrender

OUT=Path('output/pdf-placement-diagnosis/subassembly-three')

if __name__=='__main__':
    OUT.mkdir(parents=True,exist_ok=True)
    pdf=Path('C:/git/clego/lego_sets/PDF/6314914.pdf')
    with pymupdf.open(pdf) as doc:
        scenes=scene_images(doc,doc[4]);scene=next(s for s in scenes if s['xref']==23)
        cv2.imwrite(str(OUT/'native-inset.png'),cv2.cvtColor(scene['rgb'],cv2.COLOR_RGB2BGR))
    # IDs/colors are from the already extracted PDF page-4 inventory. Reordering
    # tests all six possible construction orders; no authored model used.
    parts=[('3710',15,'3710'),('3010',1,'3010'),('3010pb291',1,'3010')]
    M=np.asarray(json.loads(Path('output/pdf-placement-diagnosis/studs/cameras.json').read_text())[-1]['camera']['matrix'])
    scorer=SurfaceScorer(device='cuda',projection=M);scorer.scene(scene['mask'])
    finalists=[];counts=[]
    for order in itertools.permutations(range(3)):
        root=parts[order[0]];middle=parts[order[1]];last=parts[order[2]];pairs=[]
        for R in rotations():
            items=[(root[2],root[1],R)];asm=assembly(items)
            cs=asm.candidates(middle[2],check_collision=True,check_occlusion=False)
            if not cs:continue
            values=scorer.score(items,middle[2],[c['T'] for c in cs])
            for c,value in zip(cs,values):pairs.append((float(value),items+[(middle[2],middle[1],c['T'])]))
        pairs.sort(key=lambda p:-p[0]);complete=[]
        for _,items in pairs[:24]:
            asm=assembly(items);cs=asm.candidates(last[2],check_collision=True,check_occlusion=False)
            if not cs:continue
            scores=scorer.score(items,last[2],[c['T'] for c in cs])
            for c,value in zip(cs,scores):complete.append((float(value),items+[(last[2],last[1],c['T'])]))
        complete.sort(key=lambda p:-p[0])
        for value,items in complete[:20]:finalists.append({'silhouette':value,'order':order,'items':items})
        counts.append({'order':list(order),'pair_candidates':len(pairs),'retained_pairs':min(24,len(pairs)),'complete_candidates':len(complete)})
        print('order',order,'pairs',len(pairs),'complete',len(complete),flush=True)
    target_rgb,target_mask=canonical(scene['rgb'],scene['mask']);target=features(target_rgb,target_mask)
    target_hsv=cv2.cvtColor(target_rgb,cv2.COLOR_RGB2HSV)
    oldP,oldC=partrender.PROJ,partrender.CAM
    try:
        partrender.PROJ=M;partrender.CAM=np.cross(M[0],M[1]);partrender.CAM/=np.linalg.norm(partrender.CAM)
        for i,item in enumerate(finalists):
            path=OUT/f'render-{i:03d}.png';partrender.render(item['items'],path,size=(240,240),min_area=.08)
            rgb=cv2.cvtColor(cv2.imread(str(path)),cv2.COLOR_BGR2RGB)
            rgb,mask=canonical(rgb,background_mask(rgb,tolerance=0));edge,detail=compare(features(rgb,mask),target)
            hsv=cv2.cvtColor(rgb,cv2.COLOR_RGB2HSV)
            def label(x,m):return np.where(m==0,0,np.where(x[:,:,1]<65,1,2))
            labels=label(hsv,mask);tl=label(target_hsv,target_mask)
            union=(mask>0)|(target_mask>0)
            # Yellow printed stripe is excluded from generic base-color scoring;
            # its orientation is reported unresolved rather than guessed.
            printed=(target_hsv[:,:,0]>15)&(target_hsv[:,:,0]<40)&(target_hsv[:,:,1]>90)
            valid=union&~printed
            agreement=float((labels[valid]==tl[valid]).mean())
            item.update(score=.55*edge+.45*agreement,edge=edge,color_agreement=agreement,render=str(path),detail=detail)
    finally:partrender.PROJ,partrender.CAM=oldP,oldC
    finalists.sort(key=lambda r:-r['score']);records=[]
    for i,item in enumerate(finalists[:20]):
        finalitems=[(parts[part_index][0],parts[part_index][1],piece[2]) for part_index,piece in zip(item['order'],item['items'])]
        (OUT/f'group_{i:03d}.ldr').write_text(assembly(finalitems).to_ldr('0 PDF-only isolated subassembly; print geometry surrogate; uncertified'))
        records.append({k:v for k,v in item.items() if k!='items'}|{'transforms':[p[2].tolist() for p in finalitems]})
    report={'scope':'PDF-only isolated inset xref23, page4; no OMR/model truth; bounded search across six orders and24 root orientations','pdf_sha256':hashlib.sha256(pdf.read_bytes()).hexdigest(),'parts':parts,'surrogate':{'3010pb291':'3010','evidence':'StudioPartDefinition2 row2807 describes Brick1x4 with stripe pattern','printed_orientation_certified':False},'counts':counts,'results':records,'limitations':['Only24 best partial pairs per order retained','Printed-brick orientation unresolved with unprinted geometry','Not an atomic attachment to main assembly; no accuracy certification']}
    (OUT/'results.json').write_text(json.dumps(report,indent=2));print(OUT/'results.json')
