"""Deterministic ellipse proposals from dark PDF artwork contours.

These are image features, not certified studs: circular holes and decorations
may also qualify. Native-image coordinates are returned without set inventory.
"""
import json
from pathlib import Path
import cv2
import numpy as np


def detect_studs(rgb, mask):
    gray=cv2.cvtColor(np.asarray(rgb,np.uint8),cv2.COLOR_RGB2GRAY)
    mask=np.asarray(mask,bool)
    if mask.shape!=gray.shape:raise ValueError('mask shape differs from RGB')
    proposals=[]
    for threshold in (70,110,150):
        binary=((gray<threshold)&mask).astype(np.uint8)
        contours,_=cv2.findContours(binary,cv2.RETR_LIST,cv2.CHAIN_APPROX_NONE)
        for contour in contours:
            if len(contour)<12:continue
            (cx,cy),(a,b),angle=cv2.fitEllipse(contour)
            if min(a,b)<4 or max(a,b)>max(gray.shape)*.35 or max(a,b)/min(a,b)>3.2:continue
            if not (0<=round(cy)<gray.shape[0] and 0<=round(cx)<gray.shape[1]) or not mask[round(cy),round(cx)]:continue
            points=contour[:,0].astype(float)-[cx,cy]
            theta=np.radians(angle);R=np.array([[np.cos(theta),np.sin(theta)],[-np.sin(theta),np.cos(theta)]])
            local=points@R.T
            radius=np.sqrt((local[:,0]/(a/2))**2+(local[:,1]/(b/2))**2)
            residual=float(np.mean(np.abs(radius-1)))
            area=cv2.contourArea(contour);ratio=area/(np.pi*a*b/4)
            if residual>.075 or not .75<ratio<1.15:continue
            # Require contour coverage around the ellipse rather than a short arc.
            bins=np.unique(np.floor((np.arctan2(local[:,1]/b,local[:,0]/a)+np.pi)*12/(2*np.pi)).astype(int).clip(0,11))
            if len(bins)<10:continue
            proposals.append({'center':[cx,cy],'axes':[a,b],'angle':angle,'residual':residual,'confidence':float(max(0,1-residual/.075)),'threshold':threshold,'interpretation':'ellipse proposal; not verified stud'})
    kept=[]
    for p in sorted(proposals,key=lambda p:-p['confidence']):
        if any(np.linalg.norm(np.array(p['center'])-q['center'])<max(3,.15*max(p['axes'])) for q in kept):continue
        kept.append(p)
    return sorted(kept,key=lambda p:(p['center'][1],p['center'][0]))


if __name__=='__main__':
    import pymupdf
    from vector_scene import scene_images
    from vector_scene_components import component_graph
    out=Path('output/pdf-placement-diagnosis/studs');out.mkdir(parents=True,exist_ok=True)
    records=[];views=[]
    with pymupdf.open('C:/git/clego/lego_sets/PDF/6314914.pdf') as doc:
        for page,xref in [(2,13),(3,17)]:
            scene=next(s for s in scene_images(doc,doc[page]) if s['xref']==xref)
            graph=component_graph(scene)
            for index,component in enumerate(graph['components']):
                if page==3 and index>0:continue
                detections=detect_studs(scene['rgb'],component['mask'])
                view=scene['rgb'].copy();view[~component['mask']]=255
                for n,p in enumerate(detections):
                    cv2.ellipse(view,(tuple(p['center']),tuple(p['axes']),p['angle']),(255,0,255),2)
                    cv2.putText(view,str(n),tuple(np.array(p['center'],int)),cv2.FONT_HERSHEY_SIMPLEX,.4,(255,0,0),1)
                cv2.imwrite(str(out/f'p{page}-xref{xref}-c{index}.png'),cv2.cvtColor(view,cv2.COLOR_RGB2BGR))
                records.append({'page':page,'xref':xref,'component':index,'detections':detections})
                h,w=view.shape[:2];scale=min(440/w,440/h);view=cv2.resize(view,(round(w*scale),round(h*scale)))
                tile=np.full((480,460,3),255,np.uint8);tile[30:30+view.shape[0],:view.shape[1]]=view
                cv2.putText(tile,f'p{page} c{index} n={len(detections)}',(4,20),cv2.FONT_HERSHEY_SIMPLEX,.5,(0,0,0),1);views.append(tile)
    cv2.imwrite(str(out/'contact-sheet.png'),cv2.cvtColor(np.concatenate(views,axis=1),cv2.COLOR_RGB2BGR))
    (out/'detections.json').write_text(json.dumps({'scope':'PDF-only ellipse proposals; manual verification pending','records':records},indent=2))
