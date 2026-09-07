"""Pure deterministic visible-color macro IoU; no CAD, poses or reference model.

Palette values are RGB triples, keyed by caller's explicit current part colors.
Foreign print colors are measured separately, never silently assigned a part.
"""
import cv2
import numpy as np


def balanced_color_metric(target_rgb,target_mask,render_rgb,render_mask,allowed_colors,palette):
    colors=list(dict.fromkeys(allowed_colors))
    def lookup(code):
        value=palette.get(code,palette.get(str(code)))
        if value is None:raise ValueError('Missing universal palette color '+str(code))
        return np.asarray(value,np.uint8)
    if not colors:raise ValueError('Current assembly must declare allowed colors')
    p=np.stack([lookup(c) for c in colors]);ph=cv2.cvtColor(p[None],cv2.COLOR_RGB2HSV)[0].astype(float)
    black_present=bool(np.any((ph[:,1]<65)&(ph[:,2]<85)))
    chromatic=ph[:,1]>=65
    def classify(rgb,mask):
        hsv=cv2.cvtColor(np.asarray(rgb,np.uint8),cv2.COLOR_RGB2HSV).astype(float)
        h,s,v=hsv.transpose(2,0,1);mask=np.asarray(mask,bool)
        dark=mask&(s<65)&(v<85)
        labels=np.full(mask.shape,-1,int)
        choices=np.flatnonzero(chromatic)
        if len(choices):
            difference=np.abs(h[:,:,None]-ph[choices,0]);difference=np.minimum(difference,180-difference)
            nearest=np.argmin(difference,axis=2)
            accepted=mask&(s>=65)&(np.min(difference,axis=2)<=20)
            labels[accepted]=choices[nearest[accepted]]
        choices=np.flatnonzero(~chromatic)
        if len(choices):
            difference=np.abs(v[:,:,None]-ph[choices,2]);nearest=np.argmin(difference,axis=2)
            accepted=mask&(s<65)&((v>=85)|black_present)
            labels[accepted]=choices[nearest[accepted]]
        return labels,dark
    target,tdark=classify(target_rgb,target_mask);render,rdark=classify(render_rgb,render_mask)
    valid=np.ones(target.shape,bool) if black_present else ~tdark
    ious={};counts={};supported=[]
    for index,color in enumerate(colors):
        a=(target==index)&valid;b=(render==index)&valid
        intersection=int((a&b).sum());union=int((a|b).sum());count=int(a.sum())
        iou=intersection/max(1,union);ious[str(color)]=iou
        counts[str(color)]={'target':count,'render':int(b.sum()),'intersection':intersection,'union':union}
        if count:supported.append(iou)
    score=float(np.mean(supported)) if supported else 0.
    return dict(score=score,balanced_color_iou=score,color_ious=ious,region_counts=counts,
        unknown_pixels=int((~valid).sum()),target_foreign_color_pixels=int(((target<0)&np.asarray(target_mask,bool)&valid).sum()),
        render_foreign_color_pixels=int(((render<0)&np.asarray(render_mask,bool)&valid).sum()),
        supported_color_count=len(supported),black_part_declared=black_present,
        metric_protocol='Equal mean IoU of target-supported current palette colors; hue tolerance20/180, saturation65, neutral-dark threshold85; foreign print colors separate; no truth input',
        limitations=['Nearby palette hues and multiple neutral colors can remain ambiguous','Lighting and occlusion are approximate; no full-model accuracy certificate'])
