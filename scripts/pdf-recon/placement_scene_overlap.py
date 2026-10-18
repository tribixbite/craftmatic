"""Identify overlapping duplicate PDF artwork fragments by pixels and layout."""
import cv2
import numpy as np


def warp(scene,box,scale):
    a,b,c,d,e,f=scene['transform'];h,w=scene['mask'].shape
    matrix=np.array([[a/w,c/h,e-box[0]],[b/w,d/h,f-box[1]]])*scale
    # PDF transforms map image edges; OpenCV arrays index pixel centers.
    matrix[:,2]+=.5*matrix[:,:2].sum(axis=1)-.5
    size=tuple(np.maximum(1,np.ceil((np.array(box[2:])-box[:2])*scale).astype(int)))
    rgb=cv2.warpAffine(scene['rgb'],matrix,size,flags=cv2.INTER_LINEAR)
    mask=cv2.warpAffine(scene['mask'].astype(np.uint8),matrix,size,flags=cv2.INTER_NEAREST)>0
    return rgb,mask


def contained_fragments(scenes):
    records=[]
    for i,inner in enumerate(scenes):
        ib=np.asarray(inner['bbox']);ia=np.prod(ib[2:]-ib[:2])
        for j,outer in enumerate(scenes):
            if i==j:continue
            ob=np.asarray(outer['bbox']);oa=np.prod(ob[2:]-ob[:2])
            if oa<=ia*1.05 or np.any(ib[:2]<ob[:2]-.5) or np.any(ib[2:]>ob[2:]+.5):continue
            a,am=warp(inner,ib,2.);b,bm=warp(outer,ib,2.)
            valid=am&bm
            coverage=float(valid.sum()/max(1,am.sum()))
            aa=cv2.GaussianBlur(a,(3,3),.6).astype(float)
            bb=cv2.GaussianBlur(b,(3,3),.6).astype(float)
            error=np.max(np.abs(aa-bb),axis=2)
            agreement=float(((error<=35)&valid).sum()/max(1,valid.sum()))
            records.append(dict(fragment_index=i,container_index=j,fragment_xref=inner['xref'],
                container_xref=outer['xref'],foreground_coverage=coverage,pixel_agreement=agreement,
                redundant=coverage>=.9 and agreement>=.9,
                method='Physically contained overlapping XObject, matched PDF affine coordinates and blurred RGB pixels',
                limitations=['Pixel thresholds can abstain on resampling or clipping artifacts']))
    return records
