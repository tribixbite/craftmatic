"""Post-hoc true/wrong geometry scoring at runtime-derived view proposals."""
import hashlib,json
from pathlib import Path
import cv2
import numpy as np
import pymupdf
import torch
from pose_score import read_parts
from placement_diagnose_pair_rank import to_items
from placement_view_registration import register_views
from placement_gpu_render import SurfaceScorer
from placement_unknown_regions import unknown_regions,filter_unknown_studs
from placement_studs import detect_studs
from vector_scene import scene_images
from vector_scene_components import component_graph
from recon_v8.partrender import part_tris

if __name__=='__main__':
    out=Path('output/pdf-placement-diagnosis/color-views');out.mkdir(parents=True,exist_ok=True)
    run=Path('output/pdf-placement-beam/40377-registered-six-v1')
    selected=to_items(read_parts(run/'model.ldr'));truth=to_items(read_parts('C:/git/clego/lego_sets/OMR/40377-1.mpd')[:6])
    G=selected[0][2]@np.linalg.inv(next(p for p in truth if p[0]=='99780')[2])
    trueitems=[(p,c,G@T) for p,c,T in truth];trueitems.sort(key=lambda p:0 if p[0]=='99780' else 1)
    M=np.asarray(json.loads((run/'camera.json').read_text())['matrix'])
    with pymupdf.open('C:/git/clego/lego_sets/PDF/6314914.pdf') as doc:
        scene=scene_images(doc,doc[4])[0];scene=dict(scene,mask=component_graph(scene)['components'][0]['mask'])
        views=register_views(scene,selected[:2],M,out/'proposal-cache')
    unknown,_=unknown_regions(scene['rgb'],scene['mask'],[15])
    studs,_=filter_unknown_studs(detect_studs(scene['rgb'],scene['mask']),unknown)
    scorer=SurfaceScorer(device='cuda',projection=M,stud_weight=.5);scorer.scene(scene['mask'],studs,unknown=unknown)
    rows=[];best={}
    for label,items in [('true6',trueitems),('wrong6',selected)]:
        for vi,view in enumerate(views):
            matrix=np.asarray(view['projection']);scorer.matrix=torch.tensor(matrix,dtype=torch.float32,device='cuda')
            for oi,origin in enumerate(view['origins']):
                scorer.registration=origin['image_origin'];scorer.stud_weight=0
                surface=float(scorer.score(items[:-1],items[-1][0],[items[-1][2]])[0]);scorer.stud_weight=.5
                combined=float(scorer.score(items[:-1],items[-1][0],[items[-1][2]])[0])+.03*origin['score']
                record={'label':label,'view':vi,'origin_index':oi,'surface':surface,'combined':combined}
                rows.append(record)
                if label not in best or combined>best[label][0]:best[label]=(combined,items,matrix,np.asarray(origin['image_origin']),record)
    tiles=[]
    for label,(score,items,matrix,origin,record) in best.items():
        mask=np.zeros(scene['mask'].shape,np.uint8)
        for part,color,T in items:
            tris=part_tris(part)@T[:3,:3].T+T[:3,3]
            pixels=np.rint(tris@matrix.T+origin).astype(np.int32)
            for tri in pixels:cv2.fillConvexPoly(mask,tri,1)
        native=scene['rgb'].copy();native[~scene['mask']]=255
        color=np.array([0,220,0] if label=='true6' else [240,0,0])
        native[mask>0]=(.65*native[mask>0]+.35*color).astype(np.uint8)
        contours,_=cv2.findContours(mask,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE);cv2.drawContours(native,contours,-1,tuple(map(int,color)),1)
        tile=cv2.resize(native,None,fx=3,fy=3,interpolation=cv2.INTER_NEAREST)
        cv2.putText(tile,f'{label} score {score:.3f}',(3,18),cv2.FONT_HERSHEY_SIMPLEX,.5,(0,0,0),1)
        tiles.append(tile)
    if tiles:cv2.imwrite(str(out/'overlay.png'),cv2.cvtColor(np.concatenate(tiles,axis=1),cv2.COLOR_RGB2BGR))
    origstuds=detect_studs(scene['rgb'],scene['mask']);centers=np.asarray([s['center'] for s in origstuds]);distances=np.linalg.norm(np.diff(centers,axis=0),axis=1)
    result={'scope':'Evaluation only. Proposals use runtime pair plus PDF; independent true assembly is scored only afterward. Best oracle view never feeds reconstruction.','views':views,'scores':rows,'best':{k:v[-1] for k,v in best.items()},'page4_sorted_center_spacings':distances.tolist(),'projection_stud_axis_lengths':(np.linalg.norm(M[:,[0,2]],axis=0)*20).tolist(),'renderer_sha256':hashlib.sha256(Path('scripts/pdf-recon/placement_gpu_render.py').read_bytes()).hexdigest()}
    (out/'results.json').write_text(json.dumps(result,indent=2));print(out/'results.json')
