"""Optional HSV likelihood over bounded diffuse lighting alternatives.

Produces soft evidence, never a hard part-color or pose certificate. The
legacy classifier is unchanged. Illumination is estimated per color/pixel,
so shadows may fit several materials and remain explicitly ambiguous.
"""
import cv2
import numpy as np


def color_likelihood(rgb,mask,palette):
    palette=np.asarray(palette,np.uint8);rgb=np.asarray(rgb,np.uint8)
    if not 0<len(palette)<255:raise ValueError('Expected1..254 palette entries')
    observed=cv2.cvtColor(rgb,cv2.COLOR_RGB2HSV).astype(float)
    originals=cv2.cvtColor(palette[None],cv2.COLOR_RGB2HSV)[0].astype(float)
    mask=np.asarray(mask,bool);cost=np.full((*mask.shape,len(palette)),np.inf,np.float32)
    # Universal bounded lighting controls; not fitted to any reconstruction.
    for gain in (.3,.5,.7,.9,1.1):
        for ambient in (0.,20.,40.,60.):
            lit=np.clip(gain*palette.astype(float)+ambient,0,255).astype(np.uint8)
            sample=cv2.cvtColor(lit[None],cv2.COLOR_RGB2HSV)[0].astype(float)
            dh=np.abs(observed[:,:,None,0]-sample[None,None,:,0]);dh=np.minimum(dh,180-dh)
            hue_reliable=(observed[:,:,None,1]>=20)&(sample[None,None,:,1]>=20)
            dc=np.where(hue_reliable,(dh/12.)**2,0.)
            dc+=((observed[:,:,None,1]-sample[None,None,:,1])/28.)**2
            dc+=((observed[:,:,None,2]-sample[None,None,:,2])/45.)**2
            cost=np.minimum(cost,dc)
    # Saturated observations cannot use an achromatic palette's undefined hue.
    cost+=((observed[:,:,None,1]>=65)&(originals[None,None,:,1]<20))*4.
    unnormalized=np.exp(-cost/2);probability=unnormalized/np.maximum(1e-12,unnormalized.sum(2,keepdims=True))
    accepted=mask&(observed[:,:,2]>=30)&(cost.min(2)<=9.)
    probability*=accepted[:,:,None]
    order=np.sort(probability,axis=2);margin=order[:,:,-1]-(order[:,:,-2] if len(palette)>1 else 0)
    labels=np.where(accepted,np.argmax(probability,axis=2)+1,0).astype(np.uint8)
    return dict(probability=probability,labels=labels,valid=accepted,ambiguous=accepted&(margin<.2),
        margin=margin,cost=cost,protocol='Minimum HSV residual across gain .3..1.1 and neutral ambient0..60; soft normalized evidence; margin<.2 ambiguous')
