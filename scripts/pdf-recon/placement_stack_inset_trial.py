"""PDF inset straight-stack structural hypothesis; complete-group scoring.

The native inset visually proposes three aligned rectangular layers. Enumerate
all six layer orders and 24 proper frames. This is an explicit limited grammar,
not a generic assembler. Printed geometry is an explicit unprinted surrogate.
"""
from pathlib import Path
import itertools,json
import cv2
import numpy as np
import pymupdf
from placement_beam import assembly,rotations
from placement_part_edges import canonical,features,compare
from vector_scene import scene_images,background_mask
from recon_v8 import partrender
from recon_v3.common import get_part_dims

if __name__=='__main__':
    out=Path('output/pdf-placement-diagnosis/subassembly-stack');out.mkdir(parents=True,exist_ok=True)
    parts=[('3710',15,'3710'),('3010',1,'3010'),('3010pb291',1,'3010')]
    with pymupdf.open('C:/git/clego/lego_sets/PDF/6314914.pdf') as doc:scene=next(s for s in scene_images(doc,doc[4]) if s['xref']==23)
    targetrgb,targetmask=canonical(scene['rgb'],scene['mask']);target=features(targetrgb,targetmask);thsv=cv2.cvtColor(targetrgb,cv2.COLOR_RGB2HSV)
    M=np.asarray(json.loads(Path('output/pdf-placement-diagnosis/studs/cameras.json').read_text())[-1]['camera']['matrix'])
    records=[];oldP,oldC=partrender.PROJ,partrender.CAM
    try:
        partrender.PROJ=M;partrender.CAM=np.cross(M[0],M[1]);partrender.CAM/=np.linalg.norm(partrender.CAM)
        for order in itertools.permutations(range(3)):
            local=[];height=0.
            for n,index in enumerate(order):
                p,c,g=parts[index];hp=get_part_dims(g)[1]
                if n:height-=hp*8
                T=np.eye(4);T[1,3]=height;local.append((p,c,g,T))
            for R in rotations():
                items=[(g,c,R@T) for p,c,g,T in local];index=len(records);path=out/f'render-{index:03d}.png'
                partrender.render(items,path,size=(240,240),min_area=.08)
                rgb=cv2.cvtColor(cv2.imread(str(path)),cv2.COLOR_BGR2RGB);rgb,mask=canonical(rgb,background_mask(rgb,tolerance=0))
                edge,detail=compare(features(rgb,mask),target);hsv=cv2.cvtColor(rgb,cv2.COLOR_RGB2HSV)
                def labels(x,m):return np.where(m==0,0,np.where(x[:,:,1]<65,1,2))
                printmask=(thsv[:,:,0]>15)&(thsv[:,:,0]<40)&(thsv[:,:,1]>90)
                valid=((mask>0)|(targetmask>0))&~printmask
                color=float((labels(hsv,mask)[valid]==labels(thsv,targetmask)[valid]).mean())
                finalitems=[(p,c,R@T) for p,c,g,T in local]
                records.append({'order':list(order),'score':.55*edge+.45*color,'edge':edge,'color_agreement':color,'render':str(path),'items':finalitems})
    finally:partrender.PROJ,partrender.CAM=oldP,oldC
    records.sort(key=lambda r:-r['score']);report=[]
    for i,r in enumerate(records[:20]):
        (out/f'group_{i:03d}.ldr').write_text(assembly(r['items']).to_ldr('0 Explicit straight-stack grammar; PDF-only; print geometry surrogate; uncertified'))
        report.append({k:v for k,v in r.items() if k!='items'}|{'transforms':[p[2].tolist() for p in r['items']]})
    (out/'results.json').write_text(json.dumps({'scope':'Complete isolated3part straight-stack grammar, all6orders and24frames; no model truth','parts':parts,'candidate_count':len(records),'results':report,'limitations':['Printedfaceorientation andplain/printedlayerassignment remain unresolved without printedCAD','Grammar assumes identicalfootprint centeredstack from nativeinset; cannotgeneralizearbitrarysubassemblies']},indent=2));print(out/'results.json')
